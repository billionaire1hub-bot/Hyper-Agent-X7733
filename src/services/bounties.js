/**
 * Direct-earning bounty radar: read-only scans of verified public task feeds
 * for legal micro-bounties the agent can actually deliver. GitHub
 * bounty-labeled issue search is the primary feed; results are cached in the
 * store so serverless cold starts and status polls do not re-hit the API.
 *
 * The agent prepares the pitch/deliverable and the operator submits through
 * the platform's claim flow, routing the payout to the agent wallet.
 */
import { config } from "../config.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";

const GITHUB_ISSUES = "https://api.github.com/search/issues";

// Terms that map a bounty onto the agent's 50 offerings: intelligence,
// automation, and Base/Web3 work the pipeline can genuinely produce.
const SKILL_TERMS = [
  "data", "analysis", "api", "script", "bot", "automation", "python",
  "javascript", "typescript", "node", "content", "research", "report",
  "dashboard", "scrape", "scraper", "ai", "llm", "defi", "trading",
  "yield", "wallet", "contract", "solidity", "base", "ethereum", "evm",
  "indexer", "webhook", "sdk", "cli", "docs", "documentation", "audit",
];

export function rewardHint(text) {
  const source = String(text || "");
  const bracket = source.match(/\[\s*\$?\s*([0-9][0-9,.]*)\s*([A-Za-z]{2,8})\s*\]/);
  if (bracket) return `${bracket[1]} ${bracket[2].toUpperCase()}`;
  const dollar = source.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k|K)?\b/);
  if (dollar) return `$${dollar[1]}${(dollar[2] || "").toLowerCase()}`;
  const token = source.match(
    /\b([0-9][0-9,.]*)\s*(USDC|USDT|USDE|DAI|ETH|SOL|BASE|STRK|APT|WETH|MRG)\b/i
  );
  if (token) return `${token[1]} ${token[2].toUpperCase()}`;
  return null;
}

export function bountyScore({ title = "", body = "", labels = [] } = {}) {
  const text = `${title} ${String(body || "").slice(0, 600)} ${labels.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const term of SKILL_TERMS) {
    if (text.includes(term)) hits += 1;
  }
  return hits;
}

export function normalizeGithubItem(item) {
  const repo = String(item?.repository_url || "").split("/repos/")[1] || null;
  const labels = Array.isArray(item?.labels)
    ? item.labels.map((label) => String(label?.name || "")).filter(Boolean)
    : [];
  const title = String(item?.title || "").slice(0, 200);
  const body = String(item?.body || "");
  return {
    repo,
    title,
    url: String(item?.html_url || ""),
    updatedAt: String(item?.updated_at || ""),
    labels: labels.slice(0, 8),
    reward: rewardHint(`${title} ${body.slice(0, 500)}`),
    score: bountyScore({ title, body, labels }),
  };
}

export async function fetchGithubBounties({
  query = config.bounties.query,
  limit = config.bounties.limit,
} = {}) {
  const perPage = Math.max(5, Math.min(30, Number(limit) * 3 || 15));
  const url = `${GITHUB_ISSUES}?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${perPage}`;
  const payload = await fetchJSON(
    url,
    { headers: { accept: "application/vnd.github+json" } },
    { timeoutMs: 10000, retries: 1, service: "github-bounties" }
  );
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const opportunities = items
    .map(normalizeGithubItem)
    .filter((entry) => entry.repo && entry.url)
    .filter((entry) => entry.reward || entry.score >= 2)
    .sort((a, b) => (b.reward ? 1 : 0) - (a.reward ? 1 : 0) || b.score - a.score)
    .slice(0, Math.max(1, Number(limit) || 1));
  return {
    total: Number(payload?.total_count) || 0,
    opportunities,
  };
}

export async function bountyScan({ refresh = false } = {}) {
  if (!config.bounties.enabled) {
    return { enabled: false, scannedAt: null, total: null, opportunities: [], errors: [] };
  }
  if (!refresh) {
    try {
      const cached = await store.get(storeHelpers.bountyScan());
      if (cached?.scannedAt && Date.now() - Date.parse(cached.scannedAt) < config.bounties.ttlSeconds * 1000) {
        return cached;
      }
    } catch (error) {
      logger.warn("bounty scan cache read failed", { message: error.message });
    }
  }
  let snapshot = {
    enabled: true,
    scannedAt: new Date().toISOString(),
    total: null,
    opportunities: [],
    errors: [],
  };
  try {
    const result = await fetchGithubBounties();
    snapshot.total = result.total;
    snapshot.opportunities = result.opportunities;
  } catch (error) {
    logger.warn("bounty scan failed", { message: error.message });
    snapshot.errors.push({ source: "github", code: error.code || "BOUNTY_SCAN_FAILED", message: error.message });
  }
  try {
    await store.set(storeHelpers.bountyScan(), snapshot, { ttlSeconds: config.bounties.ttlSeconds });
  } catch (error) {
    logger.warn("bounty scan cache write failed", { message: error.message });
  }
  return snapshot;
}

export const bountyStatus = () => bountyScan({ refresh: false });
