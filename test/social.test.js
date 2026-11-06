import test from "node:test";
import assert from "node:assert/strict";

process.env.X_CONSUMER_KEY = "test-consumer-key";
process.env.X_CONSUMER_SECRET = "test-consumer-secret";
process.env.X_ACCESS_TOKEN = "test-access-token";
process.env.X_ACCESS_SECRET = "test-access-secret";
process.env.SOCIAL_AUTOPOST = "false";

const { config } = await import("../src/config.js");
const { buildOAuth1Header, oauth1Configured, percentEncode, xConfigured } = await import("../src/services/x.js");
const {
  ARTICLE_THEMES,
  assembleThread,
  buildMetricsTweet,
  normalizeHashtags,
  pickArticleTheme,
  trimTweet,
  validateArticleNumbers,
} = await import("../src/services/articles.js");
const {
  checkAgentIdle,
  dailyCount,
  nextRunAt,
  runSocialCycle,
  socialPublishDue,
  xDiagnostics,
} = await import("../src/services/social.js");

const facts = {
  generatedAt: "2026-10-29T10:00:00.000Z",
  market: {
    global: { marketCapUsd: 3_452_000_000_000, marketCapChange24hPct: 1.238, btcDominancePct: 57.42 },
    majors: [
      { symbol: "BTC", priceUsd: 118_432.4, change24hPct: 2.345 },
      { symbol: "ETH", priceUsd: 4_321.19, change24hPct: -0.876 },
    ],
  },
  headlines: [{ id: "n1", title: "SEC approves new spot product", source: "coindesk.com" }],
  trending: [{ id: "t1", symbol: "AERO", change24hPct: 12.4 }],
  yields: [{ id: "y1", project: "aave", chain: "Base", symbol: "USDC", apy: 5.18, tvlUsd: 12_000_000 }],
  derivatives: { BTC: { fundingRatePct: 0.0034 } },
  technical: {},
};

test("RFC 5849 percent-encoding matches the published vectors", () => {
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("An encoded string!"), "An%20encoded%20string%21");
  assert.equal(percentEncode("Dogs, Cats & Mice"), "Dogs%2C%20Cats%20%26%20Mice");
  assert.equal(percentEncode("☃"), "%E2%98%83");
  assert.equal(percentEncode("a-b_c.d~e"), "a-b_c.d~e");
});

test("OAuth 1.0a signing is deterministic and complete", () => {
  assert.equal(oauth1Configured(), true);
  assert.equal(xConfigured(), true);

  const first = buildOAuth1Header("POST", "https://api.x.com/2/tweets", { nonce: "abc123", timestamp: 1_700_000_000 });
  const second = buildOAuth1Header("POST", "https://api.x.com/2/tweets", { nonce: "abc123", timestamp: 1_700_000_000 });
  assert.equal(first, second);
  assert.match(first, /^OAuth /);
  for (const key of ["oauth_consumer_key", "oauth_nonce", "oauth_signature", "oauth_signature_method", "oauth_timestamp", "oauth_token", "oauth_version"]) {
    assert.ok(first.includes(`${key}="`), `missing ${key}`);
  }
  assert.ok(first.includes('oauth_signature_method="HMAC-SHA1"'));
  assert.ok(first.includes('oauth_nonce="abc123"'));
  assert.ok(first.includes('oauth_timestamp="1700000000"'));

  const changedNonce = buildOAuth1Header("POST", "https://api.x.com/2/tweets", { nonce: "abc124", timestamp: 1_700_000_000 });
  assert.notEqual(first, changedNonce);
  const changedMethod = buildOAuth1Header("GET", "https://api.x.com/2/tweets", { nonce: "abc123", timestamp: 1_700_000_000 });
  assert.notEqual(first, changedMethod);
});

test("theme rotation is deterministic and covers every theme", () => {
  const date = new Date("2026-10-29T10:00:00Z");
  assert.equal(pickArticleTheme(3, date), pickArticleTheme(3, date));
  assert.ok(ARTICLE_THEMES.includes(pickArticleTheme(3, date)));

  const seen = new Set();
  for (let seed = 0; seed < 40; seed += 1) seen.add(pickArticleTheme(seed, date));
  assert.deepEqual([...seen].sort(), [...ARTICLE_THEMES].sort());
});

test("article numbers must come from live research", () => {
  assert.equal(validateArticleNumbers("BTC is $118,432 and up 2.35% today", facts).ok, true);
  assert.equal(validateArticleNumbers("Top 3 narratives for 2026", facts).ok, true);
  assert.equal(validateArticleNumbers("24h funding 0.0034%", facts).ok, true);

  const invented = validateArticleNumbers("BTC will hit $250,000 next week", facts);
  assert.equal(invented.ok, false);
  assert.ok(invented.unknown.includes("250000"));
});

test("hashtags and tweet trimming stay within X limits", () => {
  assert.deepEqual(normalizeHashtags(["#Bitcoin", "bitcoin", "DeFi!", "x", "a".repeat(30)]), ["#Bitcoin", "#DeFi"]);
  assert.deepEqual(normalizeHashtags(["one", "two", "three", "four"]), ["#one", "#two", "#three"]);

  const long = "Sentence one is informative. ".repeat(30);
  const trimmed = trimTweet(long);
  assert.ok(trimmed.length <= 280);
  assert.ok(trimmed.endsWith("…"));
  assert.equal(trimTweet("**Bold** text"), "Bold text");
});

test("metric callouts and thread assembly use only supplied data", () => {
  const metric = buildMetricsTweet(facts);
  assert.match(metric, /^Market snapshot:/);
  assert.ok(metric.includes("BTC $118,432"));
  assert.ok(metric.includes("+2.35%"));
  assert.ok(metric.length <= 280);
  assert.equal(buildMetricsTweet({}), null);

  const thread = assembleThread({
    title: "Base liquidity is rotating",
    thesis: "Live data shows majors firm while Base yield and trending names diverge.",
    tweets: ["Tweet body one with context.", "Tweet body two with the takeaway."],
    metricsTweet: metric,
    hashtags: ["Crypto", "Base"],
    maxLength: 6,
  });
  assert.ok(thread.length >= 3 && thread.length <= 6);
  assert.ok(thread.every((tweet) => tweet.length <= 280));
  assert.ok(thread.at(-1).includes("#Crypto #Base"));
  assert.ok(thread.at(-1).includes("Not financial advice."));
});

test("scheduler math and idle gate behave without side effects", async () => {
  const state = { lastAttemptAt: "2026-10-29T10:00:00.000Z", day: "2026-10-29", dayCount: 2 };
  assert.equal(nextRunAt(state, 300), "2026-10-29T15:00:00.000Z");
  assert.equal(dailyCount(state, new Date("2026-10-29T23:00:00Z")), 2);
  assert.equal(dailyCount(state, new Date("2026-10-30T01:00:00Z")), 0);
  assert.equal(nextRunAt({}, 300, Date.parse("2026-10-29T10:00:00Z")), "2026-10-29T10:00:00.000Z");

  const idle = await checkAgentIdle();
  assert.equal(idle.idle, true);

  const disabled = await runSocialCycle({ reason: "test" });
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.reason, "SOCIAL_AUTOPOST is false");
});

test("X diagnostics identify configured slots without exposing credentials", () => {
  const diagnostics = xDiagnostics();
  assert.equal(diagnostics.configured, true);
  assert.equal(diagnostics.mode, "oauth1");
  assert.equal(diagnostics.oauth1Complete, true);
  assert.equal(diagnostics.oauth2Complete, false);
  assert.deepEqual(diagnostics.missing, [
    "X_USER_ACCESS_TOKEN (or X_BEARER_TOKEN / TWITTER_USER_ACCESS_TOKEN)",
    "X_CLIENT_ID (or TWITTER_CLIENT_ID)",
    "X_CLIENT_SECRET (or TWITTER_CLIENT_SECRET)",
    "X_REFRESH_TOKEN (or TWITTER_OAUTH2_REFRESH_TOKEN)",
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("test-consumer-key"), false);
});

test("social due gate enforces enablement, interval and daily cap", () => {
  const now = Date.parse("2026-10-29T16:00:00Z");
  assert.equal(socialPublishDue({}, now).reason, "SOCIAL_AUTOPOST is false");

  config.social.enabled = true;
  const groqApiKey = config.ai.groqApiKey;
  const geminiApiKey = config.ai.geminiApiKey;
  config.ai.groqApiKey = "test-groq-key";
  try {
    assert.deepEqual(socialPublishDue({}, now), { due: true });
    const recent = { lastAttemptAt: "2026-10-29T14:00:00.000Z", day: "2026-10-29", dayCount: 1 };
    assert.equal(socialPublishDue(recent, now).reason, "INTERVAL_NOT_ELAPSED");
    const capped = { lastAttemptAt: "2026-10-29T01:00:00.000Z", day: "2026-10-29", dayCount: 4 };
    assert.equal(socialPublishDue(capped, now).reason, "DAILY_CAP_REACHED");
  } finally {
    config.social.enabled = false;
    config.ai.groqApiKey = groqApiKey;
    config.ai.geminiApiKey = geminiApiKey;
  }
});
