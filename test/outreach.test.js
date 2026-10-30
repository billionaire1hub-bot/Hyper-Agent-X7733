import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";

const discovery = await import("../src/services/discovery.js");
const outreach = await import("../src/services/outreach.js");
const { store, storeHelpers } = await import("../src/lib/store.js");
const { recordInbound, inboxStatus } = await import("../src/services/inbox.js");
const { handleA2A } = await import("../src/services/a2a.js");
const { getOffering, validateParams } = await import("../src/services/offerings.js");

const ADDRESS = `0x${"ab".repeat(20)}`;

const makeSession = (id, patch = {}) => ({
  id,
  contextId: id,
  targetKey: "url:https://yield.example.com",
  targetName: "Yield Bot",
  endpoint: "https://yield.example.com",
  offeringId: "yield_alpha",
  basePriceUsdc: "0.005",
  priceUsdc: 0.03,
  floorUsdc: 0.005,
  status: "open",
  turns: 0,
  conceded: false,
  extended: false,
  createdAt: new Date().toISOString(),
  expiresAt: Date.now() + 60_000,
  lastAt: new Date().toISOString(),
  jobId: null,
  hashes: [],
  ...patch,
});

const putSession = async (session) => {
  await store.set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: 300 });
  return session;
};

test("outbound URLs must be public HTTPS origins", () => {
  assert.equal(discovery.isPublicHttpUrl("https://agent.example.com/a2a"), true);
  assert.equal(discovery.isPublicHttpUrl("http://agent.example.com/a2a"), false);
  assert.equal(discovery.isPublicHttpUrl("https://localhost/a2a"), false);
  assert.equal(discovery.isPublicHttpUrl("https://127.0.0.1/a2a"), false);
  assert.equal(discovery.isPublicHttpUrl("https://10.0.0.5/a2a"), false);
  assert.equal(discovery.isPublicHttpUrl("https://192.168.1.10/a2a"), false);
  assert.equal(discovery.isPublicHttpUrl("https://169.254.169.254/latest"), false);
  assert.equal(discovery.isPublicHttpUrl("https://user:pass@example.com/a2a"), false);
});

test("directory payloads normalize across common envelopes", () => {
  const entry = {
    name: "Yield Router",
    description: "DeFi yield optimizer on Base",
    a2aUrl: "https://yield.example.com",
    walletAddress: ADDRESS,
    tags: ["defi", "yield"],
  };
  for (const payload of [
    { data: [entry] },
    { agents: [entry] },
    { data: { items: [entry] } },
    [entry],
  ]) {
    const agents = discovery.normalizeIndexPayload(payload);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "Yield Router");
    assert.equal(agents[0].url, "https://yield.example.com");
    assert.equal(agents[0].address, ADDRESS);
    assert.deepEqual(agents[0].tags, ["defi", "yield"]);
  }
  assert.equal(discovery.normalizeIndexPayload({ data: [] }).length, 0);
  assert.equal(discovery.normalizeIndexPayload(null).length, 0);
});

test("scoring rewards relevant, active and contactable agents", () => {
  const relevant = discovery.scoreTarget(
    {
      name: "Yield Router",
      description: "DeFi yield optimizer and portfolio rebalancer on Base",
      tags: ["yield"],
      skills: ["trending_tokens"],
      endpoint: "https://yield.example.com",
      address: ADDRESS,
    },
    {
      activity: { jobs: 5, budgetUnits: "2000000", lastJobId: "100", descriptions: [] },
      counter: "105",
    }
  );
  assert.ok(relevant.score >= 60, `expected >= 60, got ${relevant.score}`);
  assert.ok(relevant.reasons.includes("domain:yield"));
  assert.ok(relevant.reasons.includes("a2a:endpoint"));
  assert.ok(relevant.reasons.includes("onchain:recent"));
  assert.ok(relevant.score <= 100);

  const irrelevant = discovery.scoreTarget({
    name: "JPEG Minter",
    description: "mints collectible pictures",
    tags: [],
    skills: [],
    endpoint: null,
    address: null,
  });
  assert.ok(irrelevant.score < 30, `expected < 30, got ${irrelevant.score}`);
});

test("outbound pitch menu only lists offerings executable from an empty envelope", () => {
  const ids = discovery.INTEL_OFFERINGS.map((offering) => offering.id);
  assert.ok(ids.length > 0);
  assert.ok(ids.includes("trending_tokens"));
  assert.ok(ids.includes("virtuals_alpha"));
  for (const id of ["suggest_a_trade", "topic_research", "token_info", "token_alpha", "deep_analytics", "intel_retainer"]) {
    assert.equal(ids.includes(id), false, `${id} needs params and must not be pitched with {}`);
  }
  for (const id of ids) {
    assert.doesNotThrow(() => validateParams(getOffering(id), {}), `${id} must accept {}`);
  }
});

test("pricing stays above list price and below the campaign cap", () => {
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "0.005", complexity: 1 }), 0.005);
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "0.005", complexity: 5 }), 0.007);
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "0.05", complexity: 5 }), 0.07);
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "0.05", complexity: 5, maxPriceUsdc: 0.01 }), 0.05);
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "0.05", complexity: 5, ceilingUsdc: 0.05 }), 0.05);
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "0.005", complexity: 5, ceilingUsdc: 0.005 }), 0.005);
  assert.equal(outreach.pitchPrice({ basePriceUsdc: "nope" }), null);
});

test("budget parsing ignores scheduling language", () => {
  assert.equal(outreach.parseBudget("0.03 USDC"), 0.03);
  assert.equal(outreach.parseBudget("I can pay $0.04"), 0.04);
  assert.equal(outreach.parseBudget("budget of 0.02"), 0.02);
  assert.equal(outreach.parseBudget("price: 0.035"), 0.035);
  assert.equal(outreach.parseBudget("your price holds for 5 minutes"), null);
  assert.equal(outreach.parseBudget("reply within 5 minutes"), null);
});

test("negotiation enforces floor, expiry, extension and turns", () => {
  const base = { status: "open", priceUsdc: 0.03, floorUsdc: 0.025, turns: 0, expiresAt: Date.now() + 60_000 };
  assert.equal(outreach.evaluateNegotiation({ session: base, text: "deal at 0.03 USDC" }).action, "accept");
  assert.equal(outreach.evaluateNegotiation({ session: base, text: "budget 0.02 USDC" }).action, "counter");
  const concede = outreach.evaluateNegotiation({ session: base, text: "budget 0.027 USDC" });
  assert.equal(concede.action, "concede");
  assert.equal(concede.priceUsdc, 0.027);
  assert.equal(
    outreach.evaluateNegotiation({ session: { ...base, conceded: true }, text: "budget 0.027 USDC" }).action,
    "counter"
  );
  assert.equal(outreach.evaluateNegotiation({ session: base, text: "what is your price?" }).action, "quote");
  assert.equal(outreach.evaluateNegotiation({ session: base, text: "unsubscribe please" }).action, "opt_out");
  assert.equal(
    outreach.evaluateNegotiation({ session: { ...base, expiresAt: Date.now() - 1000 }, text: "ok" }).action,
    "expired"
  );
  const extend = outreach.evaluateNegotiation({
    session: { ...base, expiresAt: Date.now() - 1000 },
    text: "budget 0.10 USDC",
  });
  assert.equal(extend.action, "extend");
  assert.equal(
    outreach.evaluateNegotiation({ session: { ...base, turns: 6 }, text: "ok" }).action,
    "turn_cap"
  );
  assert.equal(outreach.evaluateNegotiation({ session: base, text: "I funded job 82501" }).action, "funded");
  assert.equal(outreach.evaluateNegotiation({ session: base, text: "analyze VIRTUAL" }).action, "unclear");
});

test("hook numbers must exist in the live snapshot", () => {
  assert.equal(outreach.hasUnverifiedNumber("BTC funding is 0.01%", "funding 0.01"), false);
  assert.equal(outreach.hasUnverifiedNumber("BTC will hit 123456", "funding 0.01"), true);
  assert.equal(outreach.hasUnverifiedNumber("no digits here", "whatever"), false);
});

test("teaser and pitch contain live facts and the escrow envelope", () => {
  const lines = outreach.buildTeaserLines({
    trending: [{ symbol: "VIRTUAL", change24hPct: 5.2, rank: 10 }],
    derivatives: { fundingRatePct: 0.01, openInterestChangePct: -2.3, longShortRatio: 1.4 },
    global: { marketCapUsd: 3.4e12, marketCapChange24hPct: 1.1, btcDominancePct: 55 },
    news: [{ title: "Base activity grows" }],
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /VIRTUAL 5\.20%/);
  assert.match(lines[1], /funding 0\.01%/);

  const offering = getOffering("yield_alpha");
  const session = makeSession("pitch-session");
  const text = outreach.buildPitch({
    target: { name: "Yield Router" },
    analysis: { painPoint: "Needs faster yield discovery", hook: null },
    teaser: { lines, fetchedAt: new Date().toISOString() },
    offering,
    quoteUsdc: 0.005,
    session,
    wallet: "0x0000000000000000000000000000000000000001",
  });
  assert.match(text, /Offer: .*yield_alpha/);
  assert.match(text, /0\.005 USDC/);
  assert.match(text, /Benchmark: Otto AI lists yield alpha at 0\.01 USDC/);
  assert.match(text, /operator-supplied, unverified/);
  assert.match(text, /\{"offeringId":"yield_alpha","params":\{\}\}/);
  assert.match(text, /5-minute limit/);
});

test("inbound replies drive sessions and honor opt-out", async () => {
  await putSession(makeSession("ctx-accept"));
  const accepted = await outreach.handleOutreachReply({ text: "deal at 0.03 USDC", contextId: "ctx-accept" });
  assert.equal(accepted.handled, true);
  assert.equal(accepted.action, "accept");
  assert.match(accepted.text, /Agreed at 0.03 USDC/);
  assert.match(accepted.text, /intake poller/);

  await putSession(makeSession("ctx-optout", { targetKey: `addr:${ADDRESS}` }));
  const optOut = await outreach.handleOutreachReply({
    text: "not interested, unsubscribe",
    contextId: "ctx-optout",
  });
  assert.equal(optOut.handled, true);
  assert.equal(optOut.silent, true);
  const opted = await store.smembers(storeHelpers.outreachOptOut());
  assert.ok(opted.includes(`addr:${ADDRESS}`));

  await putSession(makeSession("ctx-loop"));
  const first = await outreach.handleOutreachReply({ text: "what is your price?", contextId: "ctx-loop" });
  assert.equal(first.action, "quote");
  const second = await outreach.handleOutreachReply({ text: "what is your price?", contextId: "ctx-loop" });
  assert.equal(second.silent, true);
  assert.equal(second.action, "loop");

  await putSession(makeSession("ctx-expired", { expiresAt: Date.now() - 5_000 }));
  const expired = await outreach.handleOutreachReply({ text: "hello there", contextId: "ctx-expired" });
  assert.equal(expired.silent, true);
  assert.equal(expired.action, "expired");
});

test("A2A routes session replies before intent parsing", async () => {
  await putSession(makeSession("a2a-quote"));
  const response = await handleA2A({
    jsonrpc: "2.0",
    id: 7,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId: "m-session",
        contextId: "a2a-quote",
        parts: [{ kind: "text", text: "what is your price?" }],
      },
    },
  });
  assert.equal(response.result.kind, "message");
  assert.equal(response.result.metadata.engine, "session");
  assert.equal(response.result.metadata.outreach.action, "quote");

  await putSession(makeSession("a2a-loop"));
  const payload = (text) => ({
    jsonrpc: "2.0",
    id: 8,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId: "m-loop",
        contextId: "a2a-loop",
        parts: [{ kind: "text", text }],
      },
    },
  });
  await handleA2A(payload("what is your price?"));
  const loop = await handleA2A(payload("what is your price?"));
  assert.equal(loop.result.kind, "task");
  assert.equal(loop.result.status.state, "canceled");
  assert.equal(loop.result.metadata.reason, "loop");
});

test("inbound log records actions and counts", async () => {
  await recordInbound({ text: "hello", contextId: "inbox-1", action: "help", engine: "rules" });
  await recordInbound({
    text: "resolve USDC",
    contextId: "inbox-2",
    action: "preview",
    offeringId: "resolve_tokens",
    engine: "rules",
    latencyMs: 12,
  });
  const status = await inboxStatus();
  assert.ok(status.total >= 2);
  assert.ok(status.byAction.help >= 1);
  assert.ok(status.byAction.preview >= 1);
  assert.equal(status.recent[0].contextId, "inbox-2");
});
