import crypto from "node:crypto";
import { config, isVercel } from "../config.js";
import { logger } from "./logger.js";

const PREFIX = "hax7733";
const key = (suffix) => `${PREFIX}:${suffix}`;

class UpstashStore {
  type = "upstash";

  constructor(url, token) {
    this.url = url;
    this.token = token;
  }

  async command(args) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error(`store HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error) throw new Error(payload.error);
    return payload?.result ?? null;
  }

  async get(rawKey) {
    const result = await this.command(["GET", rawKey]);
    if (result === null || result === undefined) return null;
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }

  async set(rawKey, value, { ttlSeconds, onlyIfAbsent = false } = {}) {
    const args = ["SET", rawKey, JSON.stringify(value)];
    if (ttlSeconds) args.push("EX", String(Math.ceil(ttlSeconds)));
    if (onlyIfAbsent) args.push("NX");
    const result = await this.command(args);
    return result === "OK";
  }

  async del(rawKey) {
    return this.command(["DEL", rawKey]);
  }

  async sadd(rawKey, member) {
    return this.command(["SADD", rawKey, String(member)]);
  }

  async srem(rawKey, member) {
    return this.command(["SREM", rawKey, String(member)]);
  }

  async smembers(rawKey) {
    const result = await this.command(["SMEMBERS", rawKey]);
    return Array.isArray(result) ? result.map(String) : [];
  }

  async incr(rawKey, ttlSeconds) {
    const value = await this.command(["INCR", rawKey]);
    if (value === 1 && ttlSeconds) await this.command(["EXPIRE", rawKey, String(Math.ceil(ttlSeconds))]);
    return Number(value);
  }
}

class MemoryStore {
  type = "memory";

  constructor() {
    this.values = new Map();
    this.sets = new Map();
  }

  #alive(entry) {
    return entry && (!entry.expiresAt || entry.expiresAt > Date.now());
  }

  async get(rawKey) {
    const entry = this.values.get(rawKey);
    if (!this.#alive(entry)) {
      this.values.delete(rawKey);
      return null;
    }
    return entry.value;
  }

  async set(rawKey, value, { ttlSeconds, onlyIfAbsent = false } = {}) {
    if (onlyIfAbsent && this.#alive(this.values.get(rawKey))) return false;
    this.values.set(rawKey, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
    return true;
  }

  async del(rawKey) {
    this.values.delete(rawKey);
    this.sets.delete(rawKey);
    return 1;
  }

  async sadd(rawKey, member) {
    const set = this.sets.get(rawKey) || new Set();
    const sizeBefore = set.size;
    set.add(String(member));
    this.sets.set(rawKey, set);
    return set.size - sizeBefore;
  }

  async srem(rawKey, member) {
    const set = this.sets.get(rawKey);
    if (!set) return 0;
    return set.delete(String(member)) ? 1 : 0;
  }

  async smembers(rawKey) {
    return Array.from(this.sets.get(rawKey) || []);
  }

  async incr(rawKey, ttlSeconds) {
    const entry = this.values.get(rawKey);
    const current = this.#alive(entry) ? Number(entry.value) || 0 : 0;
    const next = current + 1;
    this.values.set(rawKey, {
      value: next,
      expiresAt:
        this.#alive(entry) && entry.expiresAt ? entry.expiresAt : Date.now() + (ttlSeconds || 60) * 1000,
    });
    return next;
  }
}

export const store =
  config.store.url && config.store.token
    ? new UpstashStore(config.store.url, config.store.token)
    : new MemoryStore();

if (store.type === "memory" && isVercel) {
  logger.warn(
    "UPSTASH_REDIS_REST_URL/TOKEN not set: job state is ephemeral inside this serverless instance. Configure Upstash before taking real ACP jobs."
  );
}

export const storeHelpers = {
  job: (chainId, jobId) => key(`job:${chainId}:${jobId}`),
  jobLock: (chainId, jobId) => key(`lock:job:${chainId}:${jobId}`),
  pendingJobs: () => key("jobs:pending"),
  refund: (chainId, jobId) => key(`refund:${chainId}:${jobId}`),
  walletLock: () => key("lock:wallet"),
  socialLock: () => key("lock:social"),
  socialState: () => key("social:state"),
  xOauth2Token: () => key("x:oauth2:token"),
  xAutoUpgradeNotified: () => key("x:autoupgrade:notified"),
  intakeLock: () => key("lock:intake"),
  intakeCursor: () => key(`intake:cursor:${config.chain.id}`),
  intakeState: () => key(`intake:state:${config.chain.id}`),
  intakeGasGated: () => key(`intake:gas-gated:${config.chain.id}`),
  outreachLock: () => key("lock:outreach"),
  outreachState: () => key("outreach:state"),
  outreachKick: () => key("outreach:kick"),
  outreachSweep: () => key("outreach:directory:sweep"),
  outreachSession: (sessionId) => key(`outreach:session:${sessionId}`),
  outreachContact: (targetKey) => key(`outreach:contact:${targetKey}`),
  outreachOptOut: () => key("outreach:optout"),
  bossSession: (clientKey) => key(`boss:session:${clientKey}`),
  publicUrl: () => key("public:url"),
  activationState: () => key("activation:state"),
  a2aInbox: () => key("a2a:inbox"),
  revenueLock: () => key("lock:revenue"),
  revenueState: () => key("revenue:state"),
  revenueQuote: (quoteId) => key(`revenue:quote:${quoteId}`),
  revenueSubscription: (subscriptionId) => key(`revenue:subscription:${subscriptionId}`),
  revenueSubscriptions: () => key("revenue:subscriptions"),
  revenueReferral: (jobId) => key(`revenue:referral:${jobId}`),
  revenueReferralLock: (jobId) => key(`lock:referral:${jobId}`),
  revenueReferralQueue: () => key("revenue:referral:queue"),
  revenuePoolSnapshot: (pool) => key(`revenue:pool:${pool.toLowerCase()}`),
  rate: (bucket) => key(`rate:${bucket}`),
  cache: (name) => key(`cache:${name}`),
};

export async function acquireLock(lockKey, ttlSeconds = 45) {
  const token = crypto.randomUUID();
  const acquired = await store.set(lockKey, token, { ttlSeconds, onlyIfAbsent: true });
  return acquired ? token : null;
}

export async function releaseLock(lockKey, token) {
  try {
    const current = await store.get(lockKey);
    if (current === token) await store.del(lockKey);
  } catch (error) {
    logger.warn("failed to release lock", { lockKey, message: error.message });
  }
}

export async function withLock(lockKey, ttlSeconds, fn, { waitMs = 12000, pollMs = 400 } = {}) {
  const deadline = Date.now() + waitMs;
  let token = await acquireLock(lockKey, ttlSeconds);
  while (!token && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    token = await acquireLock(lockKey, ttlSeconds);
  }
  if (!token) return { acquired: false, result: null };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    await releaseLock(lockKey, token);
  }
}
