import crypto from "node:crypto";
import { config } from "../config.js";
import {
  AUTH_MIN_LENGTH,
  bossPasscode,
  containsPasscode,
  passcodeCanAuthenticate,
} from "../lib/boss-passcode.js";

const safeEqual = (provided, expected) => {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const bearer = (req) => String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

const headerSecrets = (req) =>
  [req.get?.("x-api-key"), bearer(req), req.get?.("x-cron-secret")]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

/**
 * Query-string credentials are visible to browser history and to anything that
 * records full request URLs, so they are only ever accepted on the cron trigger
 * and the read-only operator status route, and the logger stores the path
 * without its query. Vercel's own cron keeps sending the header.
 */
function querySecret(req) {
  const raw = req?.query?.secret;
  return typeof raw === "string" ? raw.trim() : "";
}

function queryPasscode(req) {
  const raw = req?.query?.passcode;
  return typeof raw === "string" ? raw.trim() : "";
}

const anySecret = (req) => headerSecrets(req).concat(querySecret(req)).filter(Boolean);

const admits = (candidates, expected) =>
  Boolean(expected) && candidates.some((provided) => safeEqual(provided, expected));

const deny = (res, req, status, code, message) =>
  res.status(status).json({ success: false, error: { code, message }, requestId: req.id });

export function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (admits(headerSecrets(req), config.apiKey)) return next();
  return deny(res, req, 401, "UNAUTHORIZED", "Invalid or missing API key.");
}

export function requireCronSecret(req, res, next) {
  if (!config.cronSecret) {
    return deny(
      res,
      req,
      503,
      "CRON_NOT_CONFIGURED",
      "CRON_SECRET is not set; cron endpoints are disabled."
    );
  }
  if (admits(anySecret(req), config.cronSecret)) return next();
  return deny(
    res,
    req,
    401,
    "UNAUTHORIZED",
    "Invalid cron secret. Send Authorization: Bearer <CRON_SECRET>, x-cron-secret, or ?secret=<CRON_SECRET>."
  );
}

/**
 * Operator surface for the outreach status/trigger route: satisfied by the API
 * key, the cron trigger secret or the boss passcode, so a browser can poll
 * status or fire a sweep with ?secret=<CRON_SECRET> or ?passcode=<BOSS_PASSCODE>.
 */
export function requireApiKeyOrCronSecret(req, res, next) {
  const passcodeActive = passcodeCanAuthenticate();
  if (!config.apiKey && !config.cronSecret && !passcodeActive) return next();
  const candidates = anySecret(req).concat(queryPasscode(req));
  if (
    admits(candidates, config.apiKey) ||
    admits(candidates, config.cronSecret) ||
    (passcodeActive && admits([queryPasscode(req)], bossPasscode()))
  ) {
    return next();
  }
  return deny(
    res,
    req,
    401,
    "UNAUTHORIZED",
    "Invalid or missing credentials. Send x-api-key, Authorization: Bearer, ?secret=<CRON_SECRET>, or ?passcode=<BOSS_PASSCODE>."
  );
}

/**
 * POST /api/chat additionally accepts the boss passcode inside the message,
 * which is how the operator commands the agent ("03210388 start outbound agent
 * discovery") and how a bare passcode message verifies the boss session and
 * runs outbound discovery without any API key header.
 */
export function requireApiKeyOrBossPasscode(req, res, next) {
  if (!config.apiKey) return next();
  if (admits(headerSecrets(req), config.apiKey)) return next();

  if (containsPasscode(String(req.body?.message ?? ""))) {
    if (passcodeCanAuthenticate()) return next();
    return deny(
      res,
      req,
      403,
      "BOSS_PASSCODE_TOO_WEAK",
      `The configured boss passcode is too short to authorise a request. Set BOSS_PASSCODE to at least ${AUTH_MIN_LENGTH} characters, redeploy, and send it in the message again.`
    );
  }
  return deny(
    res,
    req,
    401,
    "UNAUTHORIZED",
    "Invalid or missing API key. Boss operators may send BOSS_PASSCODE in the message body instead."
  );
}
