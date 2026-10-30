import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { fetchJSON, fetchText } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { parseFeed } from "../lib/xml.js";

const INTEL = config.intelligence;
const FEED_TTL_MS = 60_000;
const feedCache = new Map();

const hostnameOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "rss";
  }
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeTitle = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export async function fetchFeed(feedUrl) {
  const hit = feedCache.get(feedUrl);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const xml = await fetchText(
    feedUrl,
    {},
    { timeoutMs: INTEL.newsTimeoutMs, retries: 1, service: `rss:${hostnameOf(feedUrl)}` }
  );
  const items = parseFeed(xml)
    .slice(0, 40)
    .map((item) => ({
      ...item,
      source: hostnameOf(item.url || feedUrl),
      feed: feedUrl,
    }));

  if (items.length === 0) throw new Error(`feed ${feedUrl} contained no items`);
  feedCache.set(feedUrl, { value: items, expiresAt: Date.now() + FEED_TTL_MS });
  return items;
}

export function matchesQuery(item, query) {
  if (!query) return true;
  const tokens = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .slice(0, 8);
  if (tokens.length === 0) return true;
  const haystack = `${item.title || ""} ${item.summary || ""} ${(item.categories || []).join(" ")}`.toLowerCase();
  return tokens.some((token) => new RegExp(`\\b${escapeRegExp(token)}`, "i").test(haystack));
}

/**
 * Pulls live headlines from every configured RSS feed in parallel. Throws only
 * when no feed can be read, so callers can decide between degraded output and
 * an escrow refund.
 */
export async function getLatestNews({ limit = INTEL.maxNewsItems, query = null, hours = 72 } = {}) {
  if (INTEL.newsFeeds.length === 0) {
    throw AppError.unavailable("No news feeds are configured.", { env: "NEWS_FEEDS" }, "NEWS_NOT_CONFIGURED");
  }

  const settled = await Promise.allSettled(INTEL.newsFeeds.map((feed) => fetchFeed(feed)));
  const sources = settled.map((result, index) => ({
    feed: INTEL.newsFeeds[index],
    name: hostnameOf(INTEL.newsFeeds[index]),
    ok: result.status === "fulfilled",
    items: result.status === "fulfilled" ? result.value.length : 0,
    ...(result.status === "rejected" ? { error: result.reason?.message || "unavailable" } : {}),
  }));

  const seenTitles = new Set();
  const seenUrls = new Set();
  const cutoff = Date.now() - hours * 3_600_000;
  const items = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value) {
      const key = normalizeTitle(item.title);
      if (!key || seenTitles.has(key)) continue;
      if (item.url && seenUrls.has(item.url)) continue;
      if (item.publishedAt && Date.parse(item.publishedAt) < cutoff) continue;
      if (!matchesQuery(item, query)) continue;
      seenTitles.add(key);
      if (item.url) seenUrls.add(item.url);
      items.push(item);
    }
  }

  items.sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bTime - aTime;
  });

  if (items.length === 0) {
    throw AppError.upstream(
      `No live news items matched${query ? ` "${query}"` : ""} in the last ${hours}h.`,
      { query, feeds: sources.filter((source) => source.ok).length },
      "NEWS_EMPTY"
    );
  }

  return {
    items: items.slice(0, Math.max(limit, 1)),
    sources,
    fetchedAt: new Date().toISOString(),
    coverage: {
      feedsConfigured: INTEL.newsFeeds.length,
      feedsOk: sources.filter((source) => source.ok).length,
      feedsFailed: sources.filter((source) => !source.ok).length,
    },
  };
}

/* ------------------------------ Deterministic ----------------------------- */

const IMPORTANCE_KEYWORDS = [
  [/etf/i, 6],
  [/sec\b|regulat/i, 5],
  [/hack|exploit|breach|stolen/i, 7],
  [/fed\b|rate cut|inflation|cpi/i, 5],
  [/lawsuit|settlement|court/i, 4],
  [/approval|approve/i, 4],
  [/partnership|integration|acquire|merger/i, 4],
  [/upgrade|mainnet|launch/i, 3],
  [/liquidation|crash|plunge|sell-?off/i, 5],
  [/rally|surge|all-time high|ath\b/i, 4],
  [/airdrop|listing/i, 3],
  [/stablecoin|usdc|tether/i, 3],
];

const POSITIVE_WORDS = /\b(bullish|surge|surges|rally|rallies|gain|gains|soar|soars|record|approval|adopt|adoption|partnership|upgrade|breakout|inflow|inflows|profit|profits|support)\b/gi;
const NEGATIVE_WORDS = /\b(bearish|crash|crashes|plunge|plunges|dump|dumps|hack|hacked|exploit|breach|lawsuit|ban|banned|outflow|outflows|liquidation|liquidations|loss|losses|scam|fraud|reject|rejected|delay|delayed|risk)\b/gi;

export function lexiconSentiment(text) {
  const haystack = String(text || "");
  const positive = (haystack.match(POSITIVE_WORDS) || []).length;
  const negative = (haystack.match(NEGATIVE_WORDS) || []).length;
  const total = positive + negative;
  const score = total === 0 ? 0 : Math.round(((positive - negative) / total) * 100);
  return {
    score,
    label: score >= 25 ? "bullish" : score <= -25 ? "bearish" : "neutral",
    terms: { positive, negative },
    method: "lexicon",
  };
}

export function heuristicImportance(item, now = Date.now()) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  let score = 35;
  for (const [pattern, weight] of IMPORTANCE_KEYWORDS) {
    if (pattern.test(text)) score += weight;
  }
  if (item.publishedAt) {
    const ageHours = (now - Date.parse(item.publishedAt)) / 3_600_000;
    score += Math.max(0, 12 - ageHours * 0.4);
  }
  for (const category of item.categories || []) {
    if (/market|regulation|defi|security/i.test(category)) score += 1;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function rankHeuristic(items, now = Date.now()) {
  return [...items]
    .map((item) => ({
      ...item,
      importance: heuristicImportance(item, now),
      sentiment: lexiconSentiment(`${item.title || ""} ${item.summary || ""}`),
    }))
    .sort((a, b) => b.importance - a.importance);
}

/* --------------------------------- Twitter -------------------------------- */

const TWITTER_BASE = "https://api.twitter.com/2";

export const twitterConfigured = () => Boolean(INTEL.twitterBearerToken);
export const kolHandlesConfigured = () => INTEL.kolHandles.length > 0;

const twitterAuth = () => ({
  authorization: `Bearer ${INTEL.twitterBearerToken}`,
  accept: "application/json",
});

const normalizeTweet = (tweet, users) => {
  const author = users.get(tweet.author_id) || {};
  return {
    id: tweet.id,
    text: tweet.text,
    createdAt: tweet.created_at || null,
    lang: tweet.lang || null,
    metrics: {
      likes: tweet.public_metrics?.like_count ?? null,
      retweets: tweet.public_metrics?.retweet_count ?? null,
      replies: tweet.public_metrics?.reply_count ?? null,
      quotes: tweet.public_metrics?.quote_count ?? null,
      impressions: tweet.public_metrics?.impression_count ?? null,
    },
    author: {
      id: tweet.author_id || author.id || null,
      username: author.username || null,
      name: author.name || null,
      verified: author.verified ?? null,
      followers: author.public_metrics?.followers_count ?? null,
    },
    url: author.username ? `https://x.com/${author.username}/status/${tweet.id}` : null,
  };
};

export async function searchRecentTweets(query, { maxResults = 25 } = {}) {
  if (!twitterConfigured()) {
    throw AppError.unavailable(
      "Twitter API v2 is not configured.",
      { missing: "TWITTER_BEARER_TOKEN" },
      "TWITTER_NOT_CONFIGURED"
    );
  }
  const params = new URLSearchParams({
    query,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,public_metrics,lang,author_id",
    expansions: "author_id",
    "user.fields": "username,name,verified,public_metrics",
  });
  const payload = await fetchJSON(
    `${TWITTER_BASE}/tweets/search/recent?${params}`,
    { headers: twitterAuth() },
    { timeoutMs: 9000, retries: 1, service: "twitter" }
  );
  const users = new Map((payload?.includes?.users || []).map((user) => [user.id, user]));
  return (payload?.data || []).map((tweet) => normalizeTweet(tweet, users));
}

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

/**
 * Real recent tweets from the configured KOL list. Twitter recent-search caps
 * the query at 512 characters, so handles are batched (10 per request, max 5
 * requests) and results deduped.
 */
export async function getKolTweets({ handles = INTEL.kolHandles } = {}) {
  if (!twitterConfigured()) {
    throw AppError.unavailable(
      "Twitter API v2 is not configured.",
      { missing: "TWITTER_BEARER_TOKEN" },
      "TWITTER_NOT_CONFIGURED"
    );
  }
  if (handles.length === 0) {
    throw AppError.unavailable(
      "No KOL handles are configured.",
      { missing: "KOL_HANDLES" },
      "KOL_NOT_CONFIGURED"
    );
  }

  const batches = chunk(handles, 10).slice(0, 5);
  const settled = await Promise.allSettled(
    batches.map((batch) =>
      searchRecentTweets(`(${batch.map((handle) => `from:${handle}`).join(" OR ")}) -is:retweet`, {
        maxResults: 50,
      })
    )
  );

  const tweets = [];
  const failures = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") tweets.push(...result.value);
    else failures.push({ handles: batches[index], error: result.reason?.message || "unavailable" });
  });

  if (tweets.length === 0) {
    throw AppError.upstream(
      "Twitter returned no recent posts for the configured KOL list.",
      { handles: handles.length, failures },
      "TWITTER_EMPTY"
    );
  }

  const unique = new Map();
  for (const tweet of tweets) {
    if (!unique.has(tweet.id)) unique.set(tweet.id, tweet);
  }
  const items = Array.from(unique.values()).sort(
    (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)
  );

  logger.info("kol tweets fetched", { handles: handles.length, tweets: items.length, failures: failures.length });
  return items;
}
