/**
 * Leaf layer for outbound outreach: campaign/contact/negotiation-session state
 * plus the A2A pitch transport. The outreach cycle, the inbound reply handler
 * and the revenue retainer renewal all share this module, and it must not
 * import any of them, otherwise execution (pipeline -> revenue) loops back into
 * the outreach strategy layer.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";
import { isPublicHttpUrl } from "./discovery.js";

export const CAMPAIGN = "intel-outreach";
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
const SESSION_TTL_SECONDS = 60 * 60;
const CONTACT_TTL_SECONDS = 30 * 24 * 60 * 60;
const SWEEP_TTL_SECONDS = 180 * 24 * 60 * 60;

export const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);
export const nowIso = () => new Date().toISOString();
export const sanitizeText = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

const emptyState = () => ({
  day: dayKey(),
  dayCount: 0,
  lastAttemptAt: null,
  lastError: null,
  totalPitches: 0,
  outcomes: [],
  sessions: [],
  pipeline: [],
});

const normalizeState = (raw) => ({
  ...emptyState(),
  ...(raw && typeof raw === "object" ? raw : {}),
  outcomes: Array.isArray(raw?.outcomes) ? raw.outcomes.slice(-20) : [],
  sessions: Array.isArray(raw?.sessions) ? raw.sessions.slice(-20) : [],
  pipeline: Array.isArray(raw?.pipeline) ? raw.pipeline.slice(-20) : [],
});

export async function loadOutreachState() {
  return normalizeState(await store.get(storeHelpers.outreachState()).catch(() => null));
}

export async function saveOutreachState(state) {
  await store.set(storeHelpers.outreachState(), state, { ttlSeconds: STATE_TTL_SECONDS });
  return state;
}

export const dailyPitchCount = (state, date = new Date()) =>
  state?.day === dayKey(date) ? Math.max(0, Number(state.dayCount) || 0) : 0;

/**
 * The shared store is the only memory a serverless deployment has between
 * cycles, so the directory sweep cursor lives here: every cycle resumes
 * exactly where the previous one stopped and the page wraps inside
 * 1..<directory page count> forever. The bound is the number the directory
 * itself reported on the last successful sweep, falling back to
 * OUTREACH_DIRECTORY_MAX_PAGES until a cycle has seen one.
 */
export function directorySweepPage(page, maxPages = config.outreach.directoryMaxPages) {
  const total = sweepTotalPages(maxPages);
  const value = Number(page);
  return Number.isFinite(value) && value >= 1 ? ((Math.trunc(value) - 1 + total) % total) + 1 : 1;
}

export function sweepTotalPages(value) {
  const reported = Number(value);
  const total = Number.isFinite(reported) && reported >= 1 ? Math.trunc(reported) : config.outreach.directoryMaxPages;
  return Math.min(Math.max(1, total), 2000);
}

export async function loadDirectorySweep() {
  const stored = await store.get(storeHelpers.outreachSweep()).catch(() => null);
  const maxPages = sweepTotalPages(stored?.totalPages);
  return { page: directorySweepPage(stored?.page, maxPages), maxPages, totalPages: stored?.totalPages ?? null };
}

export async function saveDirectorySweep({ page, pageCount = null } = {}) {
  const stored = await store.get(storeHelpers.outreachSweep()).catch(() => null);
  const maxPages = sweepTotalPages(pageCount ?? stored?.totalPages);
  const next = directorySweepPage(page, maxPages);
  await store
    .set(
      storeHelpers.outreachSweep(),
      { page: next, totalPages: pageCount ?? stored?.totalPages ?? null, at: nowIso() },
      { ttlSeconds: SWEEP_TTL_SECONDS }
    )
    .catch(() => null);
  return next;
}

const contactKeyFor = (targetKey) =>
  crypto.createHash("sha256").update(String(targetKey)).digest("hex").slice(0, 32);

export async function loadContact(targetKey) {
  return store.get(storeHelpers.outreachContact(contactKeyFor(targetKey))).catch(() => null);
}

export async function saveContact(targetKey, patch) {
  const key = contactKeyFor(targetKey);
  const current = (await store.get(storeHelpers.outreachContact(key)).catch(() => null)) || {};
  const next = { ...current, ...patch, targetKey, updatedAt: nowIso() };
  await store.set(storeHelpers.outreachContact(key), next, { ttlSeconds: CONTACT_TTL_SECONDS }).catch(() => null);
  return next;
}

export async function optOutTarget(targetKey) {
  if (!targetKey) return;
  await store.sadd(storeHelpers.outreachOptOut(), targetKey).catch(() => null);
}

export const optedOutKeys = async () =>
  new Set(await store.smembers(storeHelpers.outreachOptOut()).catch(() => []));

export async function loadSession(sessionId) {
  if (!sessionId) return null;
  return store.get(storeHelpers.outreachSession(sessionId)).catch(() => null);
}

export async function saveSession(session) {
  await store
    .set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: SESSION_TTL_SECONDS })
    .catch((error) => logger.warn("failed to save outreach session", { message: error.message }));
  return session;
}

export async function syncSessionSummary(session, patch = {}) {
  const state = await loadOutreachState();
  const summary = {
    id: session.id,
    contextId: session.contextId,
    targetKey: session.targetKey,
    targetName: session.targetName,
    endpoint: session.endpoint,
    offeringId: session.offeringId,
    priceUsdc: session.priceUsdc,
    status: session.status,
    turns: session.turns,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastAt: session.lastAt,
    jobId: session.jobId || null,
  };
  const index = state.sessions.findIndex((entry) => entry.id === session.id);
  if (index >= 0) state.sessions[index] = summary;
  else state.sessions.push(summary);
  state.sessions = state.sessions.slice(-20);

  if (session.status === "accepted" && !state.pipeline.some((entry) => entry.sessionId === session.id)) {
    state.pipeline.push({
      sessionId: session.id,
      targetName: session.targetName,
      offeringId: session.offeringId,
      priceUsdc: session.priceUsdc,
      jobId: session.jobId || null,
      status: session.jobId ? "funded" : "awaiting_funding",
      at: nowIso(),
    });
    state.pipeline = state.pipeline.slice(-20);
  }

  if (patch.outcome) {
    state.outcomes.push(patch.outcome);
    state.outcomes = state.outcomes.slice(-20);
  }
  if (patch.lastError) state.lastError = patch.lastError;
  await saveOutreachState(state);
  return state;
}

export async function registerOutreachSession(session) {
  await saveSession(session);
  await syncSessionSummary(session);
  return session;
}

export const sessionTtlSeconds = SESSION_TTL_SECONDS;

/**
 * Sends one JSON-RPC message/send pitch to a peer A2A endpoint. Returns a
 * result shape instead of throwing so the outreach cycle can record the
 * failure and keep working through its candidate list.
 */
export async function sendA2APitch({ endpoint, text, sessionId, offeringId, quoteUsdc, expiresAt, from = "" }) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  const url = base.endsWith("/a2a") ? base : `${base}/a2a`;
  if (!isPublicHttpUrl(url)) return { ok: false, error: "endpoint is not a public HTTPS URL" };

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId: crypto.randomUUID(),
        contextId: sessionId,
        parts: [{ kind: "text", text }],
        metadata: {
          from: from || null,
          fromAgent: config.name,
          campaign: CAMPAIGN,
          sessionId,
          offeringId,
          quotedPriceUsdc: quoteUsdc,
          expiresAt,
        },
      },
    },
  };

  try {
    const payload = await fetchJSON(
      url,
      { method: "POST", body: JSON.stringify(body) },
      { timeoutMs: config.outreach.sendTimeoutMs, retries: 0, service: "a2a-outreach" }
    );
    if (payload?.error) {
      return { ok: false, error: sanitizeText(payload.error.message, 200) || "target returned a JSON-RPC error" };
    }
    if (!payload?.result) return { ok: false, error: "target returned no JSON-RPC result" };
    return {
      ok: true,
      kind: payload.result.kind || null,
      taskId: payload.result.id || null,
      contextId: payload.result.contextId || sessionId,
    };
  } catch (error) {
    return { ok: false, error: sanitizeText(error.message, 220) };
  }
}
