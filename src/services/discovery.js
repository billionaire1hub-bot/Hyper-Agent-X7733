import { config } from "../config.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { getAgentAddress } from "../chain/client.js";
import { getAcpJobs, getJobCounter } from "./escrow.js";
import { OFFERINGS, validateParams } from "./offerings.js";

// buildPitch emits {"offeringId":...,"params":{}}, so only intelligence
// offerings that validate on an empty envelope are safe to pitch. Anything
// else would be funded with a description the intake poller rejects.
const INTEL_OFFERINGS = OFFERINGS.filter((offering) => {
  if (offering.category !== "intelligence") return false;
  try {
    validateParams(offering, {});
    return true;
  } catch {
    return false;
  }
});

/**
 * Outbound requests only go to public HTTPS origins. This blocks loopback,
 * link-local and RFC1918 hosts so a hostile directory entry cannot turn the
 * agent into an SSRF proxy against its own infrastructure.
 */
export function isPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || host.includes("[")) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

const firstString = (...values) =>
  values.find((value) => typeof value === "string" && value.trim())?.trim() || null;

const asList = (value) => {
  if (Array.isArray(value)) return value.flatMap((entry) => asList(entry));
  if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter(Boolean);
  if (value && typeof value === "object") {
    const label = firstString(value.name, value.id, value.title, value.description);
    return label ? [label] : [];
  }
  return [];
};

const isAddressLike = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());

const stripSlash = (value) => value.replace(/\/+$/, "");

function normalizeUrl(raw, { card = false } = {}) {
  const value = firstString(raw);
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  if (!isPublicHttpUrl(withScheme)) return null;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  url.hash = "";
  url.search = "";
  const text = stripSlash(url.toString());
  return { base: text.endsWith(".json") ? text : text, isCard: card || text.endsWith(".json") };
}

/**
 * Accepts the shapes returned by directory APIs (`{ data: [...] }`,
 * `{ agents: [...] }`, `{ data: { items: [...] } }`) and plain arrays.
 */
export function normalizeIndexPayload(payload) {
  const container =
    (Array.isArray(payload) && payload) ||
    (Array.isArray(payload?.data) && payload.data) ||
    (Array.isArray(payload?.agents) && payload.agents) ||
    (Array.isArray(payload?.items) && payload.items) ||
    (Array.isArray(payload?.results) && payload.results) ||
    (Array.isArray(payload?.data?.items) && payload.data.items) ||
    [];

  const agents = [];
  const seen = new Set();
  for (const entry of container) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const url = firstString(
      entry.url,
      entry.a2aUrl,
      entry.a2a_url,
      entry.agentCardUrl,
      entry.agent_card_url,
      entry.endpoint,
      entry.serviceUrl,
      entry.service_url,
      entry.metadata?.url,
      entry.metadata?.a2aUrl,
      entry.card?.url
    );
    const address = firstString(
      entry.address,
      entry.walletAddress,
      entry.wallet_address,
      entry.wallet,
      entry.provider,
      entry.owner,
      entry.metadata?.address
    );
    const name = firstString(
      entry.name,
      entry.agentName,
      entry.agent_name,
      entry.title,
      entry.slug,
      entry.id !== undefined ? String(entry.id) : null
    );
    const description = firstString(
      entry.description,
      entry.goal,
      entry.tagline,
      entry.persona,
      entry.metadata?.description
    );
    const tags = asList(entry.tags).concat(asList(entry.categories), asList(entry.capabilities));
    const skills = asList(entry.skills).concat(asList(entry.services));
    if (!name && !url && !address) continue;
    const key = `${String(address || "").toLowerCase()}|${url ? normalizeUrl(url)?.base || "" : ""}|${name || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    agents.push({
      source: "index",
      name: name || null,
      description: description || null,
      url: url ? normalizeUrl(url)?.base || null : null,
      address: isAddressLike(address) ? address : null,
      tags: [...new Set(tags)].slice(0, 20),
      skills: [...new Set(skills)].slice(0, 20),
      activity: null,
      card: null,
      endpoint: null,
      score: 0,
      reasons: [],
    });
    if (agents.length >= 200) break;
  }
  return agents;
}

export async function fetchIndex({ url = config.outreach.indexUrl, token = config.outreach.indexToken } = {}) {
  const target = normalizeUrl(url);
  if (!target) throw new Error("OUTREACH_INDEX_URL must be a public HTTPS URL");
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const payload = await fetchJSON(
    target.base,
    { headers },
    { timeoutMs: 10000, retries: 0, service: "outreach-index" }
  );
  return { agents: normalizeIndexPayload(payload), url: target.base };
}

function deriveEndpoint(input, card) {
  const declared = firstString(card?.url);
  if (declared) {
    const normalized = normalizeUrl(declared);
    if (normalized) return normalized.base.endsWith(".json") ? stripCardPath(normalized.base) : normalized.base;
  }
  if (!input) return null;
  return input.endsWith(".json") ? stripCardPath(input) : input;
}

function stripCardPath(value) {
  return stripSlash(value.replace(/\/\.well-known\/(agent-card|agent)\.json$/i, ""));
}

export async function fetchAgentCard(input, { timeoutMs = config.outreach.cardTimeoutMs } = {}) {
  const normalized = normalizeUrl(input);
  if (!normalized) throw new Error("target URL must be a public HTTPS URL");
  const cardUrl = normalized.base.endsWith(".json")
    ? normalized.base
    : `${normalized.base}/.well-known/agent-card.json`;
  const card = await fetchJSON(cardUrl, {}, { timeoutMs, retries: 0, service: "a2a-card" });
  if (!card || typeof card !== "object" || Array.isArray(card)) throw new Error("agent card is not an object");
  if (!firstString(card.name) && !Array.isArray(card.skills)) throw new Error("agent card has no name or skills");
  const endpoint = deriveEndpoint(normalized.base.endsWith(".json") ? cardUrl : normalized.base, card);
  if (!endpoint || !isPublicHttpUrl(endpoint)) throw new Error("agent card has no public endpoint");
  return {
    card,
    endpoint,
    name: firstString(card.name) || new URL(endpoint).hostname,
    description: firstString(card.description) || null,
    tags: asList(card.capabilities?.extensions).map((extension) => String(extension)),
    skills: asList(card.skills),
  };
}

/**
 * Recent ACP jobs are a live, unauthenticated source of active agents. Each
 * address is scored by how many jobs it took or funded and how recently.
 */
export async function collectOnchainActivity({ scanJobs = config.outreach.scanJobs, exclude = [] } = {}) {
  const counter = await getJobCounter();
  const head = BigInt(counter);
  const span = BigInt(Math.max(1, Number(scanJobs) || 1));
  const from = head - span + 1n > 0n ? head - span + 1n : 1n;
  const ids = [];
  for (let id = from; id <= head; id += 1n) ids.push(id.toString());
  const jobs = await getAcpJobs(ids);
  const skip = new Set(exclude.filter(Boolean).map((address) => String(address).toLowerCase()));
  const agents = new Map();

  const touch = (address, role, job) => {
    if (!address || !isAddressLike(address)) return;
    const key = address.toLowerCase();
    if (skip.has(key)) return;
    const entry = agents.get(key) || {
      address,
      jobs: 0,
      providerJobs: 0,
      clientJobs: 0,
      budgetUnits: 0n,
      lastJobId: "0",
      descriptions: [],
    };
    entry.jobs += 1;
    entry[role] += 1;
    entry.budgetUnits += BigInt(job.budget || 0);
    if (BigInt(job.id) > BigInt(entry.lastJobId)) entry.lastJobId = String(job.id);
    if (entry.descriptions.length < 2 && job.description) {
      entry.descriptions.push(String(job.description).slice(0, 160));
    }
    agents.set(key, entry);
  };

  jobs.forEach((job) => {
    if (!job) return;
    touch(job.provider, "providerJobs", job);
    touch(job.client, "clientJobs", job);
  });

  return {
    counter: String(counter),
    scanned: jobs.filter(Boolean).length,
    window: { from: String(from), to: String(head) },
    agents: [...agents.values()].map((entry) => ({
      ...entry,
      budgetUnits: String(entry.budgetUnits),
    })),
  };
}

const DOMAIN_WEIGHTS = [
  { key: "yield", pattern: /\b(yield|apy|apr|staking|vault|lending|borrow|liquidity provision|restaking)\b/, points: 14 },
  { key: "trading", pattern: /\b(trading|hft|high[- ]frequency|arbitrage|market[- ]maker|perpetual|perp|futures|derivatives)\b/, points: 14 },
  { key: "portfolio", pattern: /\b(portfolio|rebalanc|allocation|risk management|treasury)\b/, points: 12 },
  { key: "analysis", pattern: /\b(market analysis|research|alpha|intel|sentiment|news|screener|analytics)\b/, points: 12 },
  { key: "defi", pattern: /\b(defi|dex|amm|swap|liquidity|onchain|on-chain)\b/, points: 8 },
  { key: "base", pattern: /\b(base|virtuals|acp|agent commerce)\b/, points: 5 },
];

export function scoreTarget(target, { activity = null, counter = null, now = Date.now(), extraKeywords = [] } = {}) {
  const reasons = [];
  let score = 0;
  const text = [
    target.name,
    target.description,
    ...(target.tags || []),
    ...(target.skills || []),
    ...(activity?.descriptions || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let domainPoints = 0;
  for (const domain of DOMAIN_WEIGHTS) {
    if (domain.pattern.test(text)) {
      domainPoints += domain.points;
      reasons.push(`domain:${domain.key}`);
    }
  }
  score += Math.min(domainPoints, 40);

  const customHits = extraKeywords
    .map((keyword) => String(keyword).toLowerCase())
    .filter((keyword) => keyword && text.includes(keyword));
  if (customHits.length) {
    score += Math.min(customHits.length * 6, 12);
    reasons.push(`keywords:${customHits.slice(0, 3).join(",")}`);
  }

  const skillHits = INTEL_OFFERINGS.filter(
    (offering) => text.includes(offering.id) || text.includes(offering.name.toLowerCase())
  );
  if (skillHits.length) {
    score += Math.min(skillHits.length * 6, 18);
    reasons.push(`offering-overlap:${skillHits.slice(0, 3).map((offering) => offering.id).join(",")}`);
  }

  if (activity) {
    const jobs = Math.min(Number(activity.jobs) || 0, 8);
    score += Math.min(jobs * 4, 16);
    if (jobs) reasons.push(`onchain:${activity.jobs} jobs`);
    const budget = BigInt(activity.budgetUnits || 0);
    if (budget >= 5_000_000n) {
      score += 6;
      reasons.push("onchain:>=5 USDC volume");
    } else if (budget >= 1_000_000n) {
      score += 3;
      reasons.push("onchain:>=1 USDC volume");
    }
    if (counter && activity.lastJobId) {
      const distance = Number(BigInt(counter) - BigInt(activity.lastJobId));
      if (distance <= 10) {
        score += 8;
        reasons.push("onchain:recent");
      } else if (distance <= 40) {
        score += 4;
        reasons.push("onchain:active");
      }
    }
  }

  if (target.endpoint) {
    score += 10;
    reasons.push("a2a:endpoint");
  }
  if (target.address) {
    score += 3;
  }

  const value = Math.max(0, Math.min(100, Math.round(score)));
  return { score: value, reasons, matchedAt: new Date(now).toISOString() };
}

const targetKey = (target) =>
  target.address
    ? `addr:${target.address.toLowerCase()}`
    : `url:${(target.endpoint || target.url || target.name || "").toLowerCase()}`;

const isSelf = (target) => {
  if (!target) return true;
  if (target.name && target.name.toLowerCase() === config.name.toLowerCase()) return true;
  if (target.card?.name && String(target.card.name).toLowerCase() === config.name.toLowerCase()) return true;
  if (target.address) {
    try {
      if (target.address.toLowerCase() === getAgentAddress().toLowerCase()) return true;
    } catch {
      // wallet not configured; nothing to compare
    }
  }
  if (config.publicBaseUrl && target.endpoint) {
    try {
      const ours = new URL(config.publicBaseUrl);
      const theirs = new URL(target.endpoint);
      if (ours.host === theirs.host && stripSlash(ours.pathname) === stripSlash(theirs.pathname)) return true;
    } catch {
      return false;
    }
  }
  return false;
};

/**
 * Merges allowlisted targets, an optional authenticated index and recent
 * on-chain ACP participants, fetches a bounded number of live agent cards, and
 * returns scored candidates. Never throws: source failures are reported.
 */
export async function discoverTargets({
  scanJobs = config.outreach.scanJobs,
  indexUrl = config.outreach.indexUrl,
  indexToken = config.outreach.indexToken,
  targets = config.outreach.targets,
  cardLimit = 6,
  now = Date.now(),
} = {}) {
  const errors = [];
  const collected = [];

  for (const raw of targets) {
    const normalized = normalizeUrl(raw);
    if (!normalized) continue;
    collected.push({
      source: "allowlist",
      name: null,
      description: null,
      url: normalized.base,
      address: null,
      tags: [],
      skills: [],
      activity: null,
      card: null,
      endpoint: null,
    });
  }

  let indexAgents = 0;
  if (indexUrl) {
    try {
      const index = await fetchIndex({ url: indexUrl, token: indexToken });
      indexAgents = index.agents.length;
      collected.push(...index.agents);
    } catch (error) {
      errors.push({ source: "index", code: error.code || "OUTREACH_INDEX_FAILED", message: error.message });
    }
  }

  let onchain = { agents: [], counter: null, scanned: 0 };
  try {
    let selfAddress = null;
    try {
      selfAddress = getAgentAddress();
    } catch {
      selfAddress = null;
    }
    onchain = await collectOnchainActivity({ scanJobs, exclude: [selfAddress] });
  } catch (error) {
    errors.push({ source: "onchain", code: error.code || "ONCHAIN_SCAN_FAILED", message: error.message });
  }

  const activityByAddress = new Map(
    onchain.agents.map((entry) => [entry.address.toLowerCase(), entry])
  );

  const merged = new Map();
  for (const agent of collected) {
    const key = targetKey(agent);
    const existing = merged.get(key);
    if (existing) {
      existing.tags = [...new Set([...(existing.tags || []), ...(agent.tags || [])])];
      existing.skills = [...new Set([...(existing.skills || []), ...(agent.skills || [])])];
      existing.description = existing.description || agent.description;
      existing.url = existing.url || agent.url;
      existing.source = existing.source === agent.source ? existing.source : `${existing.source}+${agent.source}`;
      continue;
    }
    merged.set(key, { ...agent });
  }

  const knownAddresses = new Set(
    [...merged.values()].filter((agent) => agent.address).map((agent) => agent.address.toLowerCase())
  );
  for (const activity of onchain.agents) {
    if (knownAddresses.has(activity.address.toLowerCase())) continue;
    merged.set(`addr:${activity.address.toLowerCase()}`, {
      source: "onchain",
      name: null,
      description: null,
      url: null,
      address: activity.address,
      tags: [],
      skills: [],
      activity,
      card: null,
      endpoint: null,
    });
  }

  const candidates = [...merged.values()];
  for (const candidate of candidates) {
    candidate.activity = candidate.address ? activityByAddress.get(candidate.address.toLowerCase()) : null;
    candidate.endpoint = candidate.url && !candidate.url.endsWith(".json") ? candidate.url : null;
    candidate.card = null;
    const prelim = scoreTarget(candidate, { activity: candidate.activity, counter: onchain.counter, now });
    candidate.score = prelim.score;
    candidate.reasons = prelim.reasons;
  }

  const fetchable = candidates
    .filter((candidate) => candidate.url)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(cardLimit) || 1));

  await Promise.allSettled(
    fetchable.map(async (candidate) => {
      try {
        const card = await fetchAgentCard(candidate.url);
        candidate.card = card.card;
        candidate.endpoint = card.endpoint;
        candidate.name = candidate.name || card.name;
        candidate.description = candidate.description || card.description;
        candidate.skills = [...new Set([...(candidate.skills || []), ...(card.skills || [])])];
      } catch (error) {
        errors.push({
          source: "card",
          target: candidate.url,
          code: error.code || "AGENT_CARD_FAILED",
          message: error.message,
        });
      }
    })
  );

  const scored = candidates
    .filter((candidate) => !isSelf(candidate))
    .map((candidate) => {
      const result = scoreTarget(candidate, { activity: candidate.activity, counter: onchain.counter, now });
      return {
        ...candidate,
        key: targetKey(candidate),
        score: result.score,
        reasons: result.reasons,
        contactable: Boolean(candidate.endpoint && isPublicHttpUrl(candidate.endpoint)),
      };
    })
    .sort((a, b) => b.score - a.score);

  logger.info("outreach discovery finished", {
    allowlist: targets.length,
    index: indexAgents,
    onchain: onchain.agents.length,
    candidates: scored.length,
    contactable: scored.filter((candidate) => candidate.contactable).length,
    errors: errors.length,
  });

  return {
    candidates: scored,
    sources: {
      allowlist: targets.length,
      index: indexAgents,
      onchain: onchain.agents.length,
      jobsScanned: onchain.scanned,
      counter: onchain.counter,
    },
    errors: errors.slice(0, 8),
    fetchedAt: new Date(now).toISOString(),
  };
}

export { INTEL_OFFERINGS, targetKey };
