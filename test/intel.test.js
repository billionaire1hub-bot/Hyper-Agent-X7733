import test from "node:test";
import assert from "node:assert/strict";
import { atr, buildTradePlan, computeIndicators, ema, emaSeries, normalizeCandles, rsi, signalFromScore } from "../src/services/ta.js";
import { decodeEntities, parseFeed, stripHtml } from "../src/lib/xml.js";
import { heuristicImportance, lexiconSentiment, matchesQuery, rankHeuristic } from "../src/services/news.js";
import { getOffering, validateParams } from "../src/services/offerings.js";

const trendCandles = (count = 80, { start = 100, step = 0.75 } = {}) =>
  Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    return {
      t: 1_700_000_000 + index * 14_400,
      o: close - step,
      h: close * 1.008,
      l: close * 0.992,
      c: close,
      v: 1_000 + index * 5,
    };
  });

test("EMA, RSI and ATR match their definitions", () => {
  const flat = Array(40).fill(100);
  assert.ok(Math.abs(ema(flat, 20) - 100) < 1e-9);
  assert.equal(emaSeries(flat, 20).length, 21);

  const rising = Array.from({ length: 40 }, (_, index) => 100 + index);
  assert.equal(rsi(rising, 14), 100);
  const falling = Array.from({ length: 40 }, (_, index) => 200 - index);
  assert.equal(rsi(falling, 14), 0);

  const flatCandles = Array.from({ length: 20 }, (_, index) => ({
    t: index,
    o: 100,
    h: 101,
    l: 99,
    c: 100,
    v: 0,
  }));
  assert.equal(atr(flatCandles, 14), 2);
});

test("normalizeCandles sorts rows and drops malformed entries", () => {
  const rows = normalizeCandles([
    { t: 2, o: 1, h: 2, l: 0.5, c: 1.5, v: "10" },
    { t: 1, o: 1, h: 2, l: 0.5, c: 1.2, v: 5 },
    { t: 3, o: 0, h: 2, l: 0.5, c: 1.5, v: 5 },
    { t: "bad", o: 1, h: 2, l: 0.5, c: 1.5, v: 5 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.t), [1, 2]);
});

test("computeIndicators derives a bullish snapshot from live-shaped candles", () => {
  const snapshot = computeIndicators(trendCandles(), { candlesPerDay: 6 });
  assert.equal(snapshot.candles, 80);
  assert.equal(snapshot.trend, "up");
  assert.ok(snapshot.ema20 > snapshot.ema50);
  assert.ok(snapshot.rsi14 > 70);
  assert.ok(snapshot.atrPct > 0);
  assert.ok(snapshot.momentumScore > 62, `score=${snapshot.momentumScore}`);
  assert.ok(snapshot.rangePositionPct > 50);
  assert.ok(snapshot.change24hPct > 0);
  assert.ok(snapshot.bollinger.upper > snapshot.bollinger.middle);
});

test("computeIndicators refuses to invent data without enough candles", () => {
  assert.throws(
    () => computeIndicators(trendCandles(30)),
    (error) => error.code === "INSUFFICIENT_CANDLES"
  );
});

test("signalFromScore maps momentum to sides with bounded confidence", () => {
  assert.equal(signalFromScore(70).side, "long");
  assert.equal(signalFromScore(30).side, "short");
  assert.equal(signalFromScore(50).side, "no_trade");
  assert.ok(signalFromScore(95).confidence <= 95);
  assert.ok(signalFromScore(50).confidence <= 40);
});

test("buildTradePlan places stop and targets around live entry with ATR sizing", () => {
  const indicators = computeIndicators(trendCandles(), { candlesPerDay: 6 });
  const plan = buildTradePlan({ indicators, side: "long", capitalUsdc: 500, riskPercent: 1 });
  assert.ok(plan.stopLoss < plan.entry);
  assert.ok(plan.takeProfit1 > plan.entry);
  assert.ok(plan.takeProfit2 > plan.takeProfit1);
  assert.equal(plan.riskReward, 1.5);
  assert.equal(plan.sizing.mode, "absolute");
  assert.ok(plan.sizing.positionSizeUsdc <= 500);
  assert.equal(plan.sizing.riskUsdc, 5);

  const relative = buildTradePlan({ indicators, side: "short" });
  assert.equal(relative.sizing.mode, "relative");
  assert.ok(relative.stopLoss > relative.entry);
});

test("RSS and Atom parsing keep titles, links, timestamps and summaries", () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[Bitcoin &amp; ETFs surge]]></title>
      <link>https://example.com/a?x=1&amp;y=2</link>
      <pubDate>Tue, 28 Oct 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>ETF inflows <strong>record</strong> high.</p>]]></description>
      <category>Markets</category>
    </item>
    <item><title>No link</title></item>
  </channel></rss>`;
  const items = parseFeed(rss);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Bitcoin & ETFs surge");
  assert.equal(items[0].url, "https://example.com/a?x=1&y=2");
  assert.equal(items[0].summary, "ETF inflows record high.");
  assert.deepEqual(items[0].categories, ["Markets"]);
  assert.equal(items[0].publishedAt, "2026-10-28T10:00:00.000Z");

  const atom = `<feed><entry>
    <title>SEC approves spot fund</title>
    <link href="https://example.com/atom"/>
    <updated>2026-10-29T08:30:00Z</updated>
    <summary>Regulatory approval &amp; adoption.</summary>
  </entry></feed>`;
  const atomItems = parseFeed(atom);
  assert.equal(atomItems.length, 1);
  assert.equal(atomItems[0].url, "https://example.com/atom");
  assert.equal(atomItems[0].summary, "Regulatory approval & adoption.");

  assert.equal(decodeEntities("&#36;100 &amp; &#x20AC;5"), "$100 & €5");
  assert.equal(stripHtml("<b>hi</b> <script>x()</script>"), "hi");
});

test("lexicon sentiment and heuristic ranking are deterministic", () => {
  assert.equal(lexiconSentiment("ETF approval sparks record inflows").label, "bullish");
  assert.equal(lexiconSentiment("Exchange hack causes record outflows").label, "bearish");
  assert.equal(lexiconSentiment("Weekly community update").label, "neutral");

  const now = Date.parse("2026-10-29T12:00:00Z");
  const hacking = {
    title: "Bridge hack drains $40m",
    summary: "Exploit triggers liquidation risk",
    publishedAt: "2026-10-29T11:00:00Z",
    categories: ["Security"],
  };
  const routine = {
    title: "Weekly community update",
    summary: "Roundup of developer calls",
    publishedAt: "2026-10-29T09:00:00Z",
    categories: [],
  };
  assert.ok(heuristicImportance(hacking, now) > heuristicImportance(routine, now));

  const ranked = rankHeuristic([routine, hacking], now);
  assert.equal(ranked[0].title, hacking.title);
  assert.equal(ranked[0].sentiment.label, "bearish");
  assert.ok(ranked[0].importance <= 100);
});

test("news query matching filters by meaningful tokens", () => {
  const item = { title: "Base activity climbs", summary: "Airdrop farming boosts VIRTUAL", categories: ["DeFi"] };
  assert.equal(matchesQuery(item, null), true);
  assert.equal(matchesQuery(item, "virtual"), true);
  assert.equal(matchesQuery(item, "solana"), false);
  assert.equal(matchesQuery(item, "a"), true);
});

test("intelligence offering validators apply defaults and enforce bounds", () => {
  const trade = validateParams(getOffering("suggest_a_trade"), { token: "VIRTUAL" });
  assert.deepEqual(trade, { token: "VIRTUAL", timeframe: "4h", side: "auto", capitalUsdc: null, riskPercent: 1 });
  assert.throws(
    () => validateParams(getOffering("suggest_a_trade"), { token: "VIRTUAL", timeframe: "7d" }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.throws(
    () => validateParams(getOffering("suggest_a_trade"), { token: "VIRTUAL", side: "both" }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.throws(
    () => validateParams(getOffering("suggest_a_trade"), { token: "VIRTUAL", capitalUsdc: 0 }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.throws(
    () => validateParams(getOffering("suggest_a_trade"), { token: "VIRTUAL", riskPercent: 9 }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.throws(
    () => validateParams(getOffering("suggest_a_trade"), {}),
    (error) => error.code === "INVALID_PARAM"
  );

  assert.deepEqual(validateParams(getOffering("mega_report"), { ignored: true }), {});

  assert.deepEqual(validateParams(getOffering("crypto_news"), {}), { query: null, limit: 8 });
  assert.equal(validateParams(getOffering("crypto_news"), { limit: "20" }).limit, 20);
  assert.throws(
    () => validateParams(getOffering("crypto_news"), { limit: 21 }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.throws(
    () => validateParams(getOffering("crypto_news"), { query: "x".repeat(61) }),
    (error) => error.code === "INVALID_PARAM"
  );

  assert.deepEqual(validateParams(getOffering("topic_research"), { query: "Base airdrops" }), { query: "Base airdrops" });
  assert.throws(
    () => validateParams(getOffering("topic_research"), { query: "a" }),
    (error) => error.code === "INVALID_PARAM"
  );

  assert.deepEqual(validateParams(getOffering("yield_alpha"), {}), { assetClass: "any", minTvlUsd: null });
  assert.equal(validateParams(getOffering("yield_alpha"), { assetClass: "STABLE" }).assetClass, "stable");
  assert.throws(
    () => validateParams(getOffering("yield_alpha"), { assetClass: "sol" }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.throws(
    () => validateParams(getOffering("yield_alpha"), { minTvlUsd: 50_000 }),
    (error) => error.code === "INVALID_PARAM"
  );

  assert.deepEqual(validateParams(getOffering("trending_tokens"), {}), { limit: 8 });
  assert.deepEqual(validateParams(getOffering("twitter_alpha"), {}), { topic: null });
  assert.deepEqual(validateParams(getOffering("kol_alpha"), { focus: " AI agents " }), { focus: "AI agents" });
  assert.deepEqual(validateParams(getOffering("token_info"), { token: " WETH " }), { token: "WETH" });
  assert.deepEqual(validateParams(getOffering("token_alpha"), { token: "VIRTUAL", timeframe: "1h" }), {
    token: "VIRTUAL",
    timeframe: "1h",
  });
});
