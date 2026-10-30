import crypto from "node:crypto";
import { store, storeHelpers } from "../lib/store.js";

const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_ENTRIES = 50;

const emptyInbox = () => ({
  entries: [],
  totals: { all: 0, help: 0, preview: 0, outreachReply: 0, other: 0 },
  lastAt: null,
  updatedAt: null,
});

const normalize = (raw) => ({
  ...emptyInbox(),
  ...(raw && typeof raw === "object" ? raw : {}),
  entries: Array.isArray(raw?.entries) ? raw.entries.slice(-MAX_ENTRIES) : [],
  totals: { ...emptyInbox().totals, ...(raw?.totals && typeof raw.totals === "object" ? raw.totals : {}) },
});

const textHash = (text) =>
  crypto.createHash("sha256").update(String(text || "").slice(0, 2000)).digest("hex").slice(0, 32);

/**
 * Every inbound A2A message is appended to a bounded log so the operator can
 * see who is asking for what without querying a database. Writes are
 * best-effort: an inbox failure must never fail the client's request.
 */
export async function recordInbound({
  text = "",
  contextId = null,
  action = "other",
  offeringId = null,
  engine = null,
  source = "a2a",
  latencyMs = null,
  silent = false,
  replyAction = null,
} = {}) {
  const entry = {
    at: new Date().toISOString(),
    contextId,
    source,
    action,
    offeringId,
    engine,
    latencyMs,
    textHash: text ? textHash(text) : null,
    excerpt: String(text || "").replace(/\s+/g, " ").trim().slice(0, 160),
    silent: Boolean(silent),
    replyAction,
  };

  try {
    const current = normalize(await store.get(storeHelpers.a2aInbox()));
    const totals = { ...current.totals, all: (Number(current.totals.all) || 0) + 1 };
    if (action === "help") totals.help += 1;
    else if (action === "preview") totals.preview += 1;
    else if (source === "outreach_reply") totals.outreachReply += 1;
    else totals.other += 1;

    const next = {
      entries: [...current.entries, entry].slice(-MAX_ENTRIES),
      totals,
      lastAt: entry.at,
      updatedAt: entry.at,
    };
    await store.set(storeHelpers.a2aInbox(), next, { ttlSeconds: TTL_SECONDS });
    return next;
  } catch {
    return null;
  }
}

export async function inboxStatus() {
  const inbox = normalize(await store.get(storeHelpers.a2aInbox()).catch(() => null));
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const last24h = inbox.entries.filter((entry) => Date.parse(entry.at) >= since).length;
  return {
    total: inbox.totals.all,
    last24h,
    byAction: {
      help: inbox.totals.help,
      preview: inbox.totals.preview,
      outreachReply: inbox.totals.outreachReply,
      other: inbox.totals.other,
    },
    lastAt: inbox.lastAt,
    recent: inbox.entries.slice(-10).reverse(),
  };
}

export { textHash };
