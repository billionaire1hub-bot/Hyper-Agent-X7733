import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { AppError, asAppError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { a2aRouter } from "./routes/a2a.js";
import { router } from "./routes/api.js";

const app = express();

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", {
    message: reason?.message || String(reason),
    code: reason?.code || null,
  });
});

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  req.id = String(req.get("x-request-id") || crypto.randomUUID());
  req.log = logger.child({ requestId: req.id });
  res.setHeader("x-request-id", req.id);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, x-request-id, x-cron-secret"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    req.log.info("http_request", {
      method: req.method,
      path: req.originalUrl.split("?")[0],
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
  });
  next();
});

app.use(a2aRouter);
app.use(router);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `No route for ${req.method} ${req.path}. See GET /api for the endpoint list.`,
    },
    requestId: req.id,
  });
});

app.use((error, req, res, _next) => {
  const isJsonParseError = error instanceof SyntaxError && error.status === 400 && "body" in error;
  const isPayloadTooLarge = error?.type === "entity.too.large";
  const appError = isJsonParseError
    ? AppError.badRequest("Request body must be valid JSON.", undefined, "INVALID_JSON")
    : isPayloadTooLarge
      ? new AppError("Request body exceeds the 1mb limit.", {
          status: 413,
          code: "PAYLOAD_TOO_LARGE",
        })
      : asAppError(error);

  if (appError.status >= 500) {
    req.log.error("request_failed", {
      code: appError.code,
      message: appError.message,
      stack: config.env === "production" ? undefined : appError.stack,
    });
  } else {
    req.log.warn("request_rejected", { code: appError.code, message: appError.message });
  }

  res.status(appError.status).json({
    success: false,
    error: appError.toJSON(),
    requestId: req.id,
    timestamp: new Date().toISOString(),
  });
});

export default app;
