import crypto from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

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

/** True only for user-context credentials that can create posts. */
export const xConfigured = () => oauth1Configured() || oauth2UserConfigured();

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

const authHeaders = (method, url) => {
  if (oauth1Configured()) return { authorization: buildOAuth1Header(method, url) };
  if (oauth2UserConfigured()) return { authorization: `Bearer ${config.social.oauth2UserToken}` };
  throw AppError.unavailable(
    "X posting is not configured. Set X_CONSUMER_KEY/X_CONSUMER_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET or X_USER_ACCESS_TOKEN.",
    { missing: ["X_CONSUMER_KEY", "X_ACCESS_TOKEN", "X_USER_ACCESS_TOKEN"] },
    "X_NOT_CONFIGURED"
  );
};

/**
 * Single-shot request: posting is never retried automatically, because a
 * timeout after X accepted the tweet would otherwise duplicate it.
 */
async function xRequest(method, path, { body, timeoutMs = 15000 } = {}) {
  const url = `${API}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...authHeaders(method, url),
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

    if (!response.ok) {
      const resetSeconds = Number(response.headers.get("x-rate-limit-reset"));
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryAfterMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : Number.isFinite(resetSeconds) && resetSeconds > 0
            ? Math.max(0, resetSeconds * 1000 - Date.now())
            : null;
      const message = payload?.detail || payload?.title || `HTTP ${response.status}`;
      throw new AppError(`x-api: ${message}`, {
        status: response.status === 429 ? 503 : 502,
        code: response.status === 429 ? "X_RATE_LIMITED" : `X_HTTP_${response.status}`,
        details: {
          status: response.status,
          retryAfterMs,
          resetAt: retryAfterMs ? new Date(Date.now() + retryAfterMs).toISOString() : null,
          payload,
        },
        retryable: false,
      });
    }
    return payload;
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
