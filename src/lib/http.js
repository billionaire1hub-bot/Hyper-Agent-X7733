import { AppError } from "./errors.js";
import { config } from "../config.js";
import { logger } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const UA = `${config.slug}/${config.version} (+https://github.com/virtuals-acp)`;

async function request(url, options = {}, { timeoutMs = 10000, retries = 1, service = "upstream", accept = "application/json" } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          accept,
          "user-agent": UA,
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
      });

      const text = await response.text();

      if (!response.ok) {
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { raw: text.slice(0, 500) };
        }
        const message =
          payload?.message || payload?.error?.message || payload?.error || `HTTP ${response.status}`;
        const error = new AppError(`${service}: ${message}`, {
          status: response.status === 429 ? 503 : 502,
          code: `${service.toUpperCase()}_HTTP_${response.status}`,
          details: typeof payload === "object" ? payload : undefined,
          retryable: response.status === 429 || response.status >= 500,
        });
        lastError = error;
        if (response.status === 429 || response.status >= 500) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        throw error;
      }

      return text;
    } catch (error) {
      if (error instanceof AppError && !error.retryable) throw error;
      lastError =
        error?.name === "AbortError"
          ? AppError.timeout(`${service}: request timed out after ${timeoutMs}ms`, { service })
          : error instanceof AppError
            ? error
            : AppError.upstream(`${service}: ${error.message}`, { service }, "NETWORK_ERROR", error);
      if (attempt < retries) await sleep(300 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  logger.warn("upstream request failed", { service, url: url.split("?")[0], message: lastError?.message });
  throw lastError;
}

/**
 * fetch with hard timeout, retries on transient failures and JSON decoding.
 * Never throws raw fetch errors; always surfaces AppError.
 */
export async function fetchJSON(url, options = {}, opts = {}) {
  const text = await request(url, options, { ...opts, accept: opts.accept || "application/json" });
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

/**
 * Same retry/timeout semantics as fetchJSON but returns the raw body, used for
 * XML feeds where JSON decoding does not apply.
 */
export async function fetchText(url, options = {}, opts = {}) {
  return request(url, options, {
    ...opts,
    accept: opts.accept || "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  });
}

export { sleep };
