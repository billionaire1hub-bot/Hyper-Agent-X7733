import { config } from "../config.js";
import { store, storeHelpers } from "./store.js";
import { logger } from "./logger.js";

const buckets = new Map();

const memoryIncr = (key, windowMs) => {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { count: 1, resetAt: now + windowMs };
  }
  entry.count += 1;
  return entry;
};

/**
 * Fixed-window limiter. Uses Upstash when configured so the limit is shared
 * across serverless instances; otherwise degrades to per-instance memory.
 */
export function rateLimit({ limit = config.rateLimitPerMinute, windowSeconds = 60 } = {}) {
  return async (req, res, next) => {
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
    const bucketKey = `${ip}:${windowId}`;

    try {
      let count;
      let resetAt;
      if (store.type === "upstash") {
        count = await store.incr(storeHelpers.rate(bucketKey), windowSeconds * 2);
        resetAt = (windowId + 1) * windowSeconds * 1000;
      } else {
        const entry = memoryIncr(bucketKey, windowSeconds * 1000);
        count = entry.count;
        resetAt = entry.resetAt;
      }

      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(limit - count, 0)));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

      if (count > limit) {
        res.setHeader("Retry-After", String(windowSeconds));
        return res.status(429).json({
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: `Too many requests. Limit is ${limit} per ${windowSeconds}s.`,
          },
        });
      }
      return next();
    } catch (error) {
      logger.warn("rate limiter degraded to open", { message: error.message });
      return next();
    }
  };
}
