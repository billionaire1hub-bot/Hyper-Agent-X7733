import crypto from "node:crypto";
import { config } from "../config.js";

const safeEqual = (provided, expected) => {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const bearer = (req) => String(req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

export function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  const provided = String(req.get("x-api-key") || bearer(req)).trim();
  if (provided && safeEqual(provided, config.apiKey)) return next();
  return res.status(401).json({
    success: false,
    error: { code: "UNAUTHORIZED", message: "Invalid or missing API key." },
    requestId: req.id,
  });
}

export function requireCronSecret(req, res, next) {
  if (!config.cronSecret) {
    return res.status(503).json({
      success: false,
      error: {
        code: "CRON_NOT_CONFIGURED",
        message: "CRON_SECRET is not set; cron endpoints are disabled.",
      },
      requestId: req.id,
    });
  }
  const provided = bearer(req) || String(req.get("x-cron-secret") || "").trim();
  if (provided && safeEqual(provided, config.cronSecret)) return next();
  return res.status(401).json({
    success: false,
    error: { code: "UNAUTHORIZED", message: "Invalid cron secret." },
    requestId: req.id,
  });
}
