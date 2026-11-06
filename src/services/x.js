import crypto from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";

const API = config.social.xApiBase;

/** RFC 5849 percent-encoding (encodeURIComponent plus !'()*). */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

const oauth1 = config.social.oauth1;

export const oauth1Configured = () =>
  Boolean(oauth1.consumerKey && oauth1.consumerSecret && oauth1.accessToken && oauth1.accessSecret);

export const oauth2UserConfigured = () => Boolean(config.social.oauth2UserToken);

/** True when the OAuth 2.0 confidential-client trio can mint fresh access tokens. */
export const oauth2RefreshConfigured = () => {
  const { clientId, clientSecret, refreshToken } = config.social.oauth2;
  return Boolean(clientId && clientSecret && refreshToken);
};

/** True only for credential families that can create posts. */
export const xConfigured = () => oauth1Configured() || oauth2UserConfigured() || oauth2RefreshConfigured();

/**
 * OAuth 1.0a HMAC-SHA1 header for the X API v2. JSON bodies are not part of the
 * signature base string, only the method, URL and oauth_* parameters are.
 */
export function buildOAuth1Header(method, url, overrides = {}) {
  if (!oauth1Configured()) {
    throw AppError.unavailable(
      "X posting requires OAuth 1.0a user credentials or a user access token.",
      { missing: ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] },
      "X_NOT_CONFIGURED"
    );
  }
  const oauthParams = {
    oauth_consumer_key: oauth1.consumerKey,
    oauth_nonce: overrides.nonce || crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(overrides.timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: oauth1.accessToken,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(oauthParams[key])}`)
    .join("&");
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(oauth1.consumerSecret)}&${percentEncode(oauth1.accessSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  const header = Object.entries({ ...oauthParams, oauth_signature: signature })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(", ");
  return `OAuth ${header}`;
}

/**
 * Rotated OAuth 2.0 access tokens are cached in memory and persisted in the
 * store so a serverless cold start does not re-mint a token on every post.
 */
let oauth2TokenCache = null;

const oauth2TokenFresh = (entry) => {
  if (!entry?.token) return null;
  return (entry.expiresAtMs || 0) - Date.now() > 60_000 ? entry : null;
};

async function loadCachedOAuth2Token() {
  if (!oauth2TokenFresh(oauth2TokenCache)) oauth2TokenCache = null;
  if (!oauth2TokenCache) {
    try {
      oauth2TokenCache = oauth2TokenFresh(await store.get(storeHelpers.xOauth2Token()));
    } catch (error) {
      logger.warn("x oauth2 token cache read failed", { message: error.message });
      oauth2TokenCache = null;
    }
  }
  return oauth2TokenCache?.token || null;
}

/**
 * POST /2/oauth2/token with grant_type=refresh_token (OAuth 2.0 confidential
 * client). Returns true when a fresh access token was minted and cached.
 */
async function refreshOAuth2AccessToken() {
  const { clientId, clientSecret, refreshToken } = config.social.oauth2;
  if (!clientId || !clientSecret || !refreshToken) return false;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let payload = null;
  try {
    const response = await fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15000),
    });
    payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) {
      logger.warn("x oauth2 refresh rejected", {
        status: response.status,
        detail: payload?.error || payload?.title || payload?.detail || null,
      });
      return false;
    }
  } catch (error) {
    logger.warn("x oauth2 refresh failed", { message: error.message });
    return false;
  }
  const expiresInSeconds = Math.max(0, Number(payload.expires_in) || 3600);
  const entry = {
    token: String(payload.access_token),
    expiresAtMs: Date.now() + (expiresInSeconds - 60) * 1000,
  };
  oauth2TokenCache = entry;
  try {
    await store.set(storeHelpers.xOauth2Token(), entry);
  } catch (error) {
    logger.warn("x oauth2 token cache write failed", { message: error.message });
  }
  return true;
}

/**
 * Every credential family that could authenticate a request, in preference
 * order. OAuth 2.0 user tokens go first (with a refresh attempt minted in
 * between when the confidential-client trio is configured); OAuth 1.0a keys
 * remain as the final fallback. Each attempt is only consumed after the
 * previous one was rejected by X with 401/403, so a request is never
 * duplicated by an automatic retry.
 */
async function* authAttempts(method, url) {
  if (oauth2UserConfigured() || oauth2RefreshConfigured()) {
    yield {
      name: "oauth2-user",
      authorization: async () => {
        const token = (await loadCachedOAuth2Token()) || config.social.oauth2UserToken;
        return token ? `Bearer ${token}` : null;
      },
    };
    if (oauth2RefreshConfigured()) {
      yield {
        name: "oauth2-refresh",
        authorization: async () =>
          (await refreshOAuth2AccessToken()) ? `Bearer ${oauth2TokenCache.token}` : null,
      };
    }
  }
  if (oauth1Configured()) {
    yield {
      name: "oauth1",
      authorization: () => buildOAuth1Header(method, url),
    };
  }
}

const xNotConfiguredError = () =>
  AppError.unavailable(
    "X posting is not configured. Set X_USER_ACCESS_TOKEN (or an X_BEARER_TOKEN with tweet.write scope), X_CLIENT_ID/X_CLIENT_SECRET/X_REFRESH_TOKEN for OAuth 2.0, or X_CONSUMER_KEY/X_CONSUMER_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET for OAuth 1.0a.",
    {
      missing: [
        "X_USER_ACCESS_TOKEN",
        "X_BEARER_TOKEN",
        "X_CLIENT_ID",
        "X_CLIENT_SECRET",
        "X_REFRESH_TOKEN",
        "X_CONSUMER_KEY",
        "X_CONSUMER_SECRET",
        "X_ACCESS_TOKEN",
        "X_ACCESS_SECRET",
      ],
    },
    "X_NOT_CONFIGURED"
  );

const authFailure = (status) => status === 401 || status === 403;

const xHttpError = (status, message, payload, retryAfterMs) =>
  new AppError(`x-api: ${message}`, {
    status: status === 429 ? 503 : 502,
    code: status === 429 ? "X_RATE_LIMITED" : `X_HTTP_${status}`,
    details: {
      status,
      retryAfterMs,
      resetAt: retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : null,
      payload,
    },
    retryable: false,
  });

/**
 * Single-shot request: posting is never retried automatically, because a
 * timeout after X accepted the tweet would otherwise duplicate it. The only
 * retry is advancing to the next auth attempt after a 401/403, which proves X
 * rejected the request before it was published.
 */
async function xRequest(method, path, { body, timeoutMs = 15000 } = {}) {
  const url = `${API}${path}`;
  if (!xConfigured()) throw xNotConfiguredError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let rejected = null;
    for await (const attempt of authAttempts(method, url)) {
      const authorization = await attempt.authorization(method, url);
      if (!authorization) continue;
      const response = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          authorization,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload = null;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = { raw: raw.slice(0, 300) };
      }

      const message = payload?.detail || payload?.title || `HTTP ${response.status}`;
      if (authFailure(response.status)) {
        rejected = { set: attempt.name, status: response.status, message };
        logger.info("x credential family rejected, trying the next one", {
          rejected: attempt.name,
          status: response.status,
        });
        continue;
      }

      if (!response.ok) {
        const resetSeconds = Number(response.headers.get("x-rate-limit-reset"));
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : Number.isFinite(resetSeconds) && resetSeconds > 0
              ? Math.max(0, resetSeconds * 1000 - Date.now())
              : null;
        throw xHttpError(response.status, message, payload, retryAfterMs);
      }
      return payload;
    }
    throw xHttpError(rejected?.status || 401, rejected?.message || "Unauthorized", null, null);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message =
      error?.name === "AbortError" ? `x-api: timed out after ${timeoutMs}ms` : `x-api: ${error.message}`;
    throw AppError.upstream(message, { timeoutMs }, "X_NETWORK_ERROR", error);
  } finally {
    clearTimeout(timer);
  }
}

export async function postTweet(text, { replyTo = null } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw AppError.badRequest("Tweet text is empty.", undefined, "EMPTY_TWEET");
  if (trimmed.length > config.social.maxTweetChars) {
    throw AppError.badRequest(
      `Tweet exceeds ${config.social.maxTweetChars} characters.`,
      { length: trimmed.length },
      "TWEET_TOO_LONG"
    );
  }

  const body = { text: trimmed };
  if (replyTo) body.reply = { in_reply_to_tweet_id: String(replyTo) };
  const payload = await xRequest("POST", "/tweets", { body });
  const id = payload?.data?.id;
  if (!id) {
    throw AppError.upstream("x-api: response did not contain a tweet id.", payload, "X_BAD_RESPONSE");
  }
  return { id: String(id), text: payload.data.text || trimmed, url: `https://x.com/i/web/status/${id}` };
}

/**
 * Posts tweets sequentially as a reply chain. A failure stops the chain and
 * returns what was already published instead of throwing into the scheduler.
 */
export async function postThread(tweets) {
  const posted = [];
  for (let index = 0; index < tweets.length; index += 1) {
    try {
      const tweet = await postTweet(tweets[index], { replyTo: posted.at(-1)?.id || null });
      posted.push(tweet);
    } catch (error) {
      logger.warn("x thread post failed", {
        index,
        posted: posted.length,
        code: error.code,
        message: error.message,
        retryAfterMs: error.details?.retryAfterMs ?? null,
      });
      return {
        ok: false,
        posted,
        failedIndex: index,
        error: {
          code: error.code || "X_POST_FAILED",
          message: error.message,
          retryAfterMs: error.details?.retryAfterMs ?? null,
        },
      };
    }
  }
  return { ok: posted.length > 0, posted, failedIndex: null, error: null };
}

export async function verifyXCredentials() {
  const payload = await xRequest("GET", "/users/me");
  const user = payload?.data;
  if (!user?.id) throw AppError.upstream("x-api: /users/me returned no account.", payload, "X_BAD_RESPONSE");
  return {
    id: user.id,
    username: user.username || null,
    name: user.name || null,
    url: user.username ? `https://x.com/${user.username}` : null,
    verified: user.verified ?? null,
  };
}
