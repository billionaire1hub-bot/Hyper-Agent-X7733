import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";
import { isPublicHttpUrl } from "./discovery.js";
import { dailyPitchCount, loadOutreachState } from "./outreach-session.js";

const PUBLIC_URL_TTL_SECONDS = 90 * 24 * 60 * 60;
const ACTIVATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const WAKE_TIMEOUT_MS = 4000;
const MIN_KICK_TTL_SECONDS = 120;

/** One continuation wake per outreach interval, whatever the inbound traffic looks like. */
const kickTtlSeconds = () => Math.max(MIN_KICK_TTL_SECONDS, config.outreach.intervalSeconds);

/**
 * The address the protocol reaches this agent on. It is either configured in
 * the environment or observed from the first inbound request, which is what
 * happens when the chat URL is saved on the Virtuals Protocol dashboard.
 */
function trustedHosts() {
  const values = [
    config.publicBaseUrl,
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
  ];
  return new Set(
    values
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).host.toLowerCase();
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );
}

export function publicUrlFromRequest(req) {
  const get = (name) => (typeof req?.get === "function" ? req.get(name) : "");
  const host = String(get("host") || "").trim().toLowerCase();
  if (!host || !trustedHosts().has(host)) return null;
  const forwarded = String(get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = forwarded || (typeof req?.protocol === "string" ? req.protocol : "https");
  if (proto !== "https") return null;
  const url = `https://${host}`;
  return isPublicHttpUrl(url) ? url : null;
}

export async function loadPublicUrl() {
  if (config.publicBaseUrl) return { url: config.publicBaseUrl, source: "env" };
  const stored = await store.get(storeHelpers.publicUrl()).catch(() => null);
  const url = typeof stored?.url === "string" ? stored.url : "";
  return url ? { url, source: "observed" } : { url: "", source: "none" };
}

export async function savePublicUrl(url) {
  await store
    .set(storeHelpers.publicUrl(), { url, observedAt: new Date().toISOString() }, { ttlSeconds: PUBLIC_URL_TTL_SECONDS })
    .catch(() => null);
  return url;
}

/**
 * Records the URL the protocol is currently calling. A new or changed URL is
 * the signal that the chat URL was just saved or updated on the platform, and
 * it is what starts the outbound discovery loop.
 */
export async function observePublicUrl(req) {
  const configured = config.publicBaseUrl;
  const observed = publicUrlFromRequest(req);
  const stored = await store.get(storeHelpers.publicUrl()).catch(() => null);

  if (configured) {
    const changed = stored?.url !== configured;
    if (changed) {
      await savePublicUrl(configured);
      await recordActivation(configured, "env");
    }
    return { url: configured, source: "env", changed };
  }

  const current = stored?.url
    ? { url: stored.url, source: "observed" }
    : { url: "", source: "none" };

  if (!observed) return { url: current.url, source: current.source, changed: false };

  if (current.url !== observed) {
    await savePublicUrl(observed);
    await recordActivation(observed, "observed");
    logger.info("public chat url observed", { url: observed });
    return { url: observed, source: "observed", changed: true };
  }

  return { url: observed, source: "observed", changed: false };
}

async function recordActivation(url, source) {
  const previous = (await store.get(storeHelpers.activationState()).catch(() => null)) || {};
  const state = {
    url,
    source,
    firstSeenAt: previous.url === url ? previous.firstSeenAt : new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    activations: previous.url === url ? Number(previous.activations || 0) : Number(previous.activations || 0) + 1,
  };
  await store
    .set(storeHelpers.activationState(), state, { ttlSeconds: ACTIVATION_TTL_SECONDS })
    .catch(() => null);
  return state;
}

export async function activationStatus() {
  const current = await loadPublicUrl();
  const [state, kick] = await Promise.all([
    store.get(storeHelpers.activationState()).catch(() => null),
    store.get(storeHelpers.outreachKick()).catch(() => null),
  ]);
  const entry = state || {};
  return {
    publicBaseUrl: current.url || null,
    publicBaseUrlSource: current.source,
    urlConfigured: Boolean(current.url),
    firstSeenAt: entry.firstSeenAt || null,
    lastSeenAt: entry.lastSeenAt || null,
    activations: Number(entry.activations || 0),
    nextWakeEligibleAt: kick?.at ? new Date(Date.parse(kick.at) + kickTtlSeconds() * 1000).toISOString() : null,
    lastWakeAt: kick?.at || null,
    lastWakeReason: kick?.reason || null,
  };
}

/**
 * Wakes the outreach cycle through this deployment's own HTTP endpoint. The
 * cycle then runs inside its own serverless invocation, which keeps the work
 * inside the platform request budget instead of the request that noticed the
 * activation.
 */
export async function wakeOutreachCycle(url, { reason = "activation", force = true } = {}) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) return { ok: false, skipped: "no_public_url" };
  if (!config.cronSecret) return { ok: false, skipped: "cron_secret_missing" };
  const query = `reason=${encodeURIComponent(reason)}${force ? "&force=1" : ""}`;
  const target = `${base}/api/cron/outreach?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WAKE_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      headers: { "x-cron-secret": config.cronSecret },
      signal: controller.signal,
    });
    const body = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, reason, body: body.slice(0, 400) };
  } catch (error) {
    return { ok: false, status: null, reason, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A cycle is due when the campaign is on, the interval since the last attempt
 * has elapsed and today's pitch budget still has room. The outreach state is
 * read straight from the shared store so this module stays a leaf: importing
 * the outreach strategy layer here would close a dependency cycle.
 */
export function outreachCycleDue(state, now = Date.now()) {
  if (!config.outreach.enabled) return false;
  const last = Date.parse(String(state?.lastAttemptAt || ""));
  if (Number.isFinite(last) && now - last < config.outreach.intervalSeconds * 1000) return false;
  return state === null || dailyPitchCount(state, new Date(now)) < config.outreach.dailyCap;
}

/**
 * Keeps the campaign self-waking between the platform cron slots: any inbound
 * request (a Virtuals probe, an agent-card fetch, a peer reply) re-arms the
 * discovery cycle once it is due, throttled to one wake per interval. A wake
 * that the deployment could not reach re-arms immediately; one the server
 * answered is left alone so a misconfigured secret cannot make every request
 * pay the wake timeout.
 */
export async function maybeWakeOutreach({ reason = "traffic", now = Date.now() } = {}) {
  if (!config.outreach.enabled) return { ok: false, skipped: "outreach_disabled" };
  if (!config.cronSecret) return { ok: false, skipped: "cron_secret_missing" };
  const [{ url }, state] = await Promise.all([loadPublicUrl(), loadOutreachState()]);
  if (!url) return { ok: false, skipped: "no_public_url" };
  if (!outreachCycleDue(state, now)) return { ok: false, skipped: "not_due" };

  const armed = await store
    .set(
      storeHelpers.outreachKick(),
      { at: new Date(now).toISOString(), reason },
      { ttlSeconds: kickTtlSeconds(), onlyIfAbsent: true }
    )
    .catch(() => false);
  if (!armed) return { ok: false, skipped: "wake_already_armed" };

  const wake = await wakeOutreachCycle(url, { reason, force: false });
  if (!wake.ok && wake.status === null) await store.del(storeHelpers.outreachKick()).catch(() => null);
  logger.info("outreach continuation wake", { ok: wake.ok, status: wake.status || null, reason });
  return wake;
}
