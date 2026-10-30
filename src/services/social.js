import { config, isVercel } from "../config.js";
import { logger } from "../lib/logger.js";
import { acquireLock, releaseLock, store, storeHelpers } from "../lib/store.js";
import { aiConfigured } from "./ai.js";
import { generateArticle, pickArticleTheme } from "./articles.js";
import { getJobRecord, isStaleProcessing, JOB_STATUS, listPendingJobs } from "./jobs.js";
import { oauth1Configured, oauth2UserConfigured, postThread, verifyXCredentials, xConfigured } from "./x.js";

const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 300;

export const socialEnabled = () => config.social.enabled;

const nowIso = () => new Date().toISOString();
const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

const emptyState = () => ({
  lastAttemptAt: null,
  lastPublishedAt: null,
  lastError: null,
  lastArticle: null,
  recent: [],
  day: dayKey(),
  dayCount: 0,
  totalPublished: 0,
});

const normalizeState = (raw) => ({ ...emptyState(), ...(raw && typeof raw === "object" ? raw : {}) });

export async function loadSocialState() {
  return normalizeState(await store.get(storeHelpers.socialState()));
}

export async function saveSocialState(state) {
  await store.set(storeHelpers.socialState(), state, { ttlSeconds: STATE_TTL_SECONDS });
  return state;
}

export function dailyCount(state, date = new Date()) {
  if (!state || state.day !== dayKey(date)) return 0;
  return Math.max(0, Number(state.dayCount) || 0);
}

export function nextRunAt(state, intervalMinutes = config.social.intervalMinutes, now = Date.now()) {
  if (!state?.lastAttemptAt) return new Date(now).toISOString();
  const base = Date.parse(state.lastAttemptAt);
  if (!Number.isFinite(base)) return new Date(now).toISOString();
  return new Date(base + intervalMinutes * 60_000).toISOString();
}

/**
 * The loop only publishes while no ACP job is mid-execution. Stale processing
 * records (killed invocations) do not block it forever.
 */
export async function checkAgentIdle({ limit = 20 } = {}) {
  let pending = [];
  try {
    pending = await listPendingJobs();
  } catch (error) {
    logger.warn("social idle check could not read pending jobs", { message: error.message });
    return { idle: true, jobsChecked: 0, degraded: true };
  }

  for (const jobId of pending.slice(0, limit)) {
    const record = await getJobRecord(jobId).catch(() => null);
    if (!record) continue;
    if (record.status === JOB_STATUS.PROCESSING && !isStaleProcessing(record)) {
      return { idle: false, jobId, jobsChecked: pending.length };
    }
  }
  return { idle: true, jobsChecked: pending.length };
}

const failure = (state, error) => {
  state.lastError = {
    code: error?.code || "SOCIAL_CYCLE_FAILED",
    message: error?.message || "Unknown error",
    at: nowIso(),
  };
};

/**
 * One full publish cycle: idle gate → interval/cap gate → live research →
 * synthesis → thread post. Always resolves with a status object; never throws
 * into the caller so the ACP server cannot be taken down by a social failure.
 */
export async function runSocialCycle({ reason = "interval", force = false } = {}) {
  if (!config.social.enabled) {
    return { status: "disabled", reason: "SOCIAL_AUTOPOST is false", reasonSource: reason };
  }
  if (!aiConfigured()) {
    return { status: "disabled", reason: "AI_NOT_CONFIGURED", reasonSource: reason };
  }
  if (!xConfigured()) {
    return { status: "disabled", reason: "X_NOT_CONFIGURED", reasonSource: reason };
  }

  const lockToken = await acquireLock(storeHelpers.socialLock(), LOCK_TTL_SECONDS);
  if (!lockToken) {
    return { status: "skipped", reason: "ANOTHER_CYCLE_ACTIVE", reasonSource: reason };
  }

  let state = emptyState();
  try {
    state = await loadSocialState();

    const intervalMs = config.social.intervalMinutes * 60_000;
    if (!force && state.lastAttemptAt) {
      const due = Date.parse(nextRunAt(state));
      if (Number.isFinite(due) && Date.now() < due) {
        return { status: "skipped", reason: "INTERVAL_NOT_ELAPSED", nextRunAt: new Date(due).toISOString(), reasonSource: reason };
      }
    }

    if (!force && dailyCount(state) >= config.social.maxPostsPerDay) {
      return {
        status: "skipped",
        reason: "DAILY_CAP_REACHED",
        publishedToday: dailyCount(state),
        maxPostsPerDay: config.social.maxPostsPerDay,
        reasonSource: reason,
      };
    }

    const idle = await checkAgentIdle();
    if (!idle.idle) {
      return { status: "skipped", reason: "ACP_JOB_ACTIVE", jobId: idle.jobId, reasonSource: reason };
    }

    state.lastAttemptAt = nowIso();
    await saveSocialState(state);

    const theme = pickArticleTheme(state.totalPublished + state.dayCount);
    let article;
    try {
      article = await generateArticle({
        theme,
        maxLength: config.social.maxThreadLength,
        maxTokens: config.social.articleMaxTokens,
      });
    } catch (error) {
      failure(state, error);
      await saveSocialState(state).catch(() => {});
      logger.warn("social article generation failed", {
        theme,
        code: error.code,
        message: error.message,
      });
      return {
        status: "failed",
        theme,
        error: { code: error.code || "ARTICLE_FAILED", message: error.message },
        reasonSource: reason,
      };
    }

    const posting = await postThread(article.tweets);
    const tweetIds = posting.posted.map((tweet) => tweet.id);
    const published = posting.posted.length > 0;

    if (!published) {
      failure(state, new Error(posting.error?.message || "X rejected the thread"));
      await saveSocialState(state).catch(() => {});
      return {
        status: "failed",
        theme,
        error: posting.error || { code: "X_POST_FAILED", message: "Thread was not published." },
        reasonSource: reason,
      };
    }

    const publishedAt = nowIso();
    state.lastPublishedAt = publishedAt;
    state.lastError = posting.ok ? null : { code: posting.error?.code || "X_PARTIAL_THREAD", message: posting.error?.message || "Thread stopped early", at: publishedAt };
    state.day = dayKey();
    state.dayCount = dailyCount(state) + 1;
    state.totalPublished = (Number(state.totalPublished) || 0) + 1;
    state.lastArticle = {
      theme,
      title: article.title,
      tweets: article.tweets,
      engine: article.engine,
      sentiment: article.sentiment,
      confidence: article.confidence,
      tweetIds,
      firstTweetUrl: posting.posted[0]?.url || null,
      publishedAt,
      partial: !posting.ok,
      sources: article.sources,
    };
    state.recent = [state.lastArticle, ...(Array.isArray(state.recent) ? state.recent : [])].slice(0, 10);
    await saveSocialState(state);

    logger.info("social thread published", {
      theme,
      tweets: tweetIds.length,
      partial: !posting.ok,
      engine: article.engine,
    });

    return {
      status: posting.ok ? "published" : "partial",
      theme,
      title: article.title,
      tweets: article.tweets,
      tweetIds,
      url: posting.posted[0]?.url || null,
      engine: article.engine,
      sentiment: article.sentiment,
      partial: !posting.ok,
      error: posting.error,
      reasonSource: reason,
    };
  } catch (error) {
    logger.warn("social cycle failed", { code: error.code, message: error.message });
    try {
      failure(state, error);
      await saveSocialState(state);
    } catch {
      // state persistence is best-effort; the cycle already failed
    }
    return {
      status: "failed",
      error: { code: error.code || "SOCIAL_CYCLE_FAILED", message: error.message },
      reasonSource: reason,
    };
  } finally {
    await releaseLock(storeHelpers.socialLock(), lockToken);
  }
}

export async function socialStatus({ verify = false } = {}) {
  let state = emptyState();
  try {
    state = await loadSocialState();
  } catch (error) {
    logger.warn("social status could not read state", { message: error.message });
  }

  const status = {
    enabled: config.social.enabled,
    intervalMinutes: config.social.intervalMinutes,
    tickMinutes: config.social.tickMinutes,
    maxPostsPerDay: config.social.maxPostsPerDay,
    maxThreadLength: config.social.maxThreadLength,
    aiConfigured: aiConfigured(),
    x: {
      configured: xConfigured(),
      mode: oauth1Configured() ? "oauth1" : oauth2UserConfigured() ? "oauth2-user" : "none",
    },
    lastAttemptAt: state.lastAttemptAt,
    lastPublishedAt: state.lastPublishedAt,
    lastError: state.lastError,
    lastArticle: state.lastArticle,
    publishedToday: dailyCount(state),
    totalPublished: Number(state.totalPublished) || 0,
    nextRunAt: nextRunAt(state),
    recent: Array.isArray(state.recent) ? state.recent.slice(0, 5) : [],
  };

  if (verify && status.x.configured) {
    try {
      status.x.account = await verifyXCredentials();
    } catch (error) {
      status.x.error = error.message;
    }
  }

  return status;
}

let timer = null;

/**
 * Starts the autonomous loop for long-running hosts. On Vercel the loop is
 * driven by the cron endpoint instead, because serverless instances do not
 * keep timers alive. Timers are unref'd so they never hold the process open and
 * never block request handling.
 */
export function startSocialLoop() {
  if (timer) return { started: false, reason: "ALREADY_RUNNING" };
  if (isVercel) {
    logger.info("social autopost runs via Vercel cron (/api/cron/social)");
    return { started: false, reason: "VERCEL_CRON" };
  }
  if (!config.social.enabled) {
    logger.info("social autopost disabled (set SOCIAL_AUTOPOST=true to enable)");
    return { started: false, reason: "DISABLED" };
  }

  const run = () => {
    runSocialCycle({ reason: "interval" }).catch((error) => {
      logger.warn("social loop iteration crashed", { message: error.message });
    });
  };

  setTimeout(run, 60_000).unref?.();
  timer = setInterval(run, config.social.tickMinutes * 60_000);
  timer.unref?.();

  logger.info("social autopost loop started", {
    intervalMinutes: config.social.intervalMinutes,
    tickMinutes: config.social.tickMinutes,
    maxPostsPerDay: config.social.maxPostsPerDay,
  });
  return { started: true, intervalMinutes: config.social.intervalMinutes };
}

export function stopSocialLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
