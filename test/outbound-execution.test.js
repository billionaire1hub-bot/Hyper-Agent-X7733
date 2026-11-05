import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";
process.env.GROQ_API_KEY = "test-groq-key";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.OUTREACH_CARD_PROBES = "3";

const { store, storeHelpers } = await import("../src/lib/store.js");
const discovery = await import("../src/services/discovery.js");
const outreach = await import("../src/services/outreach.js");
const { ensureIntakeCursor } = await import("../src/services/intake.js");
const { askJSON } = await import("../src/services/ai.js");
const { getAgentAddress } = await import("../src/chain/client.js");
const { getOffering } = await import("../src/services/offerings.js");

const realFetch = globalThis.fetch;
const CLIENT = `0x${"cd".repeat(20)}`;

const stubFetch = (handler) => {
  const urls = [];
  globalThis.fetch = async (url, options = {}) => {
    urls.push({ url: String(url), options });
    const response = await handler(String(url), options);
    if (response === null) throw new Error("simulated network failure");
    return {
      ok: response.status === undefined || response.status >= 200 && response.status < 300,
      status: response.status ?? 200,
      text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
    };
  };
  return urls;
};

const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

afterEach(restoreFetch);

const makeSession = (id, patch = {}) => ({
  id,
  contextId: id,
  targetKey: "url:https://yield.example.com",
  targetName: "Yield Bot",
  endpoint: "https://yield.example.com",
  channel: "a2a",
  offeringId: "yield_alpha",
  basePriceUsdc: "0.03",
  priceUsdc: 0.03,
  floorUsdc: 0.03,
  status: "open",
  turns: 0,
  conceded: false,
  extended: false,
  createdAt: new Date().toISOString(),
  expiresAt: Date.now() + 120_000,
  lastAt: new Date().toISOString(),
  jobId: null,
  hashes: [],
  ...patch,
});

test("Virtuals directory requests use the nested pagination contract", async () => {
  const urls = stubFetch(() => ({
    body: {
      data: [
        {
          name: "Yield Router",
          description: "Base yield automation",
          walletAddress: CLIENT,
          twitterHandle: "@yieldrouter",
          enabledChains: [{ id: 8453 }],
          jobs: [{ name: "Yield scan", description: "Scan Base yield", price: 0.02 }],
        },
      ],
    },
  }));

  const agents = await discovery.fetchVirtualsDirectory({ limit: 50, page: 2 });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].twitter, "yieldrouter");
  assert.equal(urls.length, 1);
  assert.match(urls[0].url, /pagination%5Bpage%5D=2|pagination\[page\]=2/);
  assert.match(urls[0].url, /pagination%5BpageSize%5D=50|pagination\[pageSize\]=50/);
  assert.doesNotMatch(urls[0].url, /[?&]limit=50/);
  assert.doesNotMatch(urls[0].url, /[?&]page=2/);
});

test("directory limit is clamped to the provider range", async () => {
  const urls = stubFetch(() => ({ body: { data: [] } }));
  await discovery.fetchVirtualsDirectory({ limit: 5000, page: 0 });
  assert.match(urls[0].url, /pagination(?:%5B|\[)pageSize(?:%5D|\])=100/);
  assert.match(urls[0].url, /pagination(?:%5B|\[)page(?:%5D|\])=1/);
});

test("mention pitch keeps the provider wallet and order envelope within the tweet limit", () => {
  const offering = getOffering("yield_alpha");
  const target = {
    name: "A".repeat(90),
    twitter: "@verylongyieldbotname",
    description: "yield automation",
  };
  const pitch = outreach.buildMentionPitch({
    target,
    analysis: { painPoint: "x".repeat(300) },
    offering,
    quoteUsdc: 0.03,
  });
  const wallet = getAgentAddress();
  assert.ok(pitch.length <= 280, `pitch was ${pitch.length} characters`);
  assert.ok(pitch.includes(wallet), "provider wallet must survive shortening");
  assert.ok(pitch.includes('{"offeringId":"yield_alpha","params":{}}'), "order envelope must survive shortening");
  assert.ok(pitch.startsWith("@verylongyieldbotname "));
});

test("ensureIntakeCursor leaves an established cursor alone", async () => {
  await store.set(storeHelpers.intakeCursor(), "4242");
  const result = await ensureIntakeCursor("outreach-test");
  assert.equal(result.initialized, false);
  assert.equal(result.cursor, "4242");
});

test("funded A2A reply verifies the job on Base and executes it immediately", async () => {
  const wallet = getAgentAddress();
  const session = makeSession("funded-ok");
  await store.set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: 300 });

  const calls = [];
  const result = await outreach.handleOutreachReply({
    text: "I funded job 90001",
    contextId: session.id,
    getJob: async () => ({
      id: "90001",
      status: 1,
      statusName: "FUNDED",
      provider: wallet,
      client: CLIENT,
      budget: 30_000n,
      description: '{"offeringId":"yield_alpha","params":{}}',
      expiredAt: Math.floor(Date.now() / 1000) + 3600,
    }),
    executeJob: async (args) => {
      calls.push(args);
      return { httpStatus: 200, payload: { status: "completed", deliverableHash: "0xdead" } };
    },
  });

  assert.equal(result.action, "funded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, "90001");
  assert.equal(calls[0].offeringId, "yield_alpha");
  assert.equal(calls[0].buyer, CLIENT);
  assert.match(result.text, /Completed ACP job 90001/);
  assert.match(result.text, /0xdead/);
  assert.equal(result.session.status, "accepted");
  assert.equal(result.session.execution.status, "completed");
});

test("funded replies are refused when the on-chain job does not match the session", async () => {
  const wallet = getAgentAddress();
  const cases = [
    { name: "wrong provider", job: { provider: CLIENT }, expect: "ESCROW_WRONG_PROVIDER" },
    { name: "underfunded", job: { budget: 1n }, expect: "budget" },
    { name: "not funded", job: { status: 0 }, expect: "status" },
    { name: "other offering", job: { description: '{"offeringId":"trending_tokens","params":{}}' }, expect: "desc" },
    { name: "extra params", job: { description: '{"offeringId":"yield_alpha","params":{"limit":5}}' }, expect: "params" },
  ];

  for (const [index, entry] of cases.entries()) {
    const session = makeSession(`funded-bad-${index}`);
    await store.set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: 300 });
    let executed = 0;
    const result = await outreach.handleOutreachReply({
      text: `funded job 9000${index}`,
      contextId: session.id,
      getJob: async () => ({
        id: `9000${index}`,
        status: 1,
        statusName: "FUNDED",
        provider: wallet,
        client: CLIENT,
        budget: 30_000n,
        description: '{"offeringId":"yield_alpha","params":{}}',
        ...entry.job,
      }),
      executeJob: async () => {
        executed += 1;
        return { payload: { status: "completed" } };
      },
    });
    assert.equal(result.action, "funded_unverified", `${entry.name} must not execute`);
    assert.equal(executed, 0, `${entry.name} must not execute`);
    assert.match(result.text, /cannot verify ACP job/);
  }

  const missing = makeSession("funded-missing");
  await store.set(storeHelpers.outreachSession(missing.id), missing, { ttlSeconds: 300 });
  const notFound = await outreach.handleOutreachReply({
    text: "funded job 99999",
    contextId: missing.id,
    getJob: async () => null,
    executeJob: async () => ({ payload: { status: "completed" } }),
  });
  assert.equal(notFound.action, "funded_unverified");
});

test("funded replies fall back to intake when immediate execution is deferred", async () => {
  const wallet = getAgentAddress();
  const session = makeSession("funded-deferred");
  await store.set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: 300 });

  const result = await outreach.handleOutreachReply({
    text: "funded job 90200",
    contextId: session.id,
    getJob: async () => ({
      id: "90200",
      status: 1,
      provider: wallet,
      client: CLIENT,
      budget: 30_000n,
      description: '{"offeringId":"yield_alpha","params":{}}',
    }),
    executeJob: async () => {
      throw new Error("lock held");
    },
  });

  assert.equal(result.action, "funded");
  assert.equal(result.session.execution.status, "deferred");
  assert.equal(result.session.status, "accepted");
  assert.match(result.text, /intake pass/);
  assert.match(result.text, /lock held/);
});

test("funded replies report a refunded execution instead of claiming success", async () => {
  const wallet = getAgentAddress();
  const session = makeSession("funded-failed");
  await store.set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: 300 });

  const result = await outreach.handleOutreachReply({
    text: "funded job 90300",
    contextId: session.id,
    getJob: async () => ({
      id: "90300",
      status: 1,
      provider: wallet,
      client: CLIENT,
      budget: 30_000n,
      description: '{"offeringId":"yield_alpha","params":{}}',
    }),
    executeJob: async () => ({
      payload: { status: "refunded", error: { code: "UPSTREAM_FAILED", message: "provider unavailable" } },
    }),
  });

  assert.equal(result.session.status, "execution_failed");
  assert.match(result.text, /execution ended refunded/);
  assert.match(result.text, /refundable/);
});

test("outreach status reports both AI engines and intake readiness", async () => {
  const urls = stubFetch((url) => {
    if (url.includes("api.groq.com")) return { body: { data: [{ id: "groq-3" }] } };
    if (url.includes("generativelanguage")) return { body: { models: [] } };
    return { body: {} };
  });

  const status = await outreach.outreachStatus();
  assert.ok(urls.length >= 2, "status must probe both engines");
  assert.equal(status.ai.groq.configured, true);
  assert.equal(status.ai.groq.reachable, true);
  assert.equal(status.ai.gemini.configured, true);
  assert.equal(status.ai.gemini.reachable, true);
  assert.equal(status.ai.bothEnginesReachable, true);
  assert.deepEqual(status.ai.outbound.targetAnalysis, { primary: "groq", fallback: "gemini" });
  assert.equal(status.ai.outbound.pitchGrounding.primary, "gemini");
  assert.equal(status.ai.routing.json, "groq");
  assert.equal(status.execution.walletConfigured, true);
  assert.equal(typeof status.execution.intakeCursor, "string");
});

test("askJSON falls back from Groq to Gemini and honors the reverse preference", async () => {
  const groqDown = stubFetch((url) => {
    if (url.includes("api.groq.com")) return { status: 503, body: { error: { message: "overloaded" } } };
    return { body: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] } };
  });
  const fallback = await askJSON("sys", "user", { maxTokens: 100, retries: 0 });
  assert.equal(fallback.engine, "gemini");
  assert.deepEqual(fallback.data, { ok: true });
  assert.ok(groqDown.some((entry) => entry.url.includes("api.groq.com")));

  const geminiDown = stubFetch((url) => {
    if (url.includes("generativelanguage")) return { status: 500, body: { error: { message: "down" } } };
    return { body: { choices: [{ message: { content: '{"engine":"groq"}' } }] } };
  });
  const preferGemini = await askJSON("sys", "user", { maxTokens: 100, retries: 0, prefer: "gemini" });
  assert.equal(preferGemini.engine, "groq");
  assert.deepEqual(preferGemini.data, { engine: "groq" });
  assert.ok(geminiDown.some((entry) => entry.url.includes("generativelanguage")));

  const bothDown = stubFetch(() => ({ status: 500, body: { error: { message: "down" } } }));
  const failed = await askJSON("sys", "user", { maxTokens: 100, retries: 0 });
  assert.equal(failed.engine, null);
  assert.equal(failed.data, null);
  assert.equal(failed.errors.length, 2);
  assert.equal(bothDown.length, 2);
});

test("one discovery cycle sweeps consecutive directory pages and reports where to continue", async () => {
  const OTHER = `0x${"ef".repeat(20)}`;
  const urls = stubFetch((url) => {
    if (!url.includes("acpx.virtuals.io")) {
      return { body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "rpc unavailable in test" } } };
    }
    const page = Number(new URL(url).searchParams.get("pagination[page]"));
    return {
      body: {
        data: [
          {
            name: `Sweep Agent ${page}`,
            description: "Base yield automation desk",
            walletAddress: page === 39 ? CLIENT : OTHER,
            twitterHandle: `@sweep${page}`,
          },
        ],
      },
    };
  });

  const result = await discovery.discoverTargets({
    scanJobs: 1,
    targets: [],
    indexUrl: "",
    directoryPage: 39,
    directoryPages: 2,
    directoryMaxPages: 40,
  });

  assert.deepEqual(result.sources.directoryPages, [39, 40]);
  assert.equal(result.sources.nextPage, 1, "the last page of the sweep wraps the cursor back to page 1");
  assert.equal(result.sources.directory, 2);
  const requested = urls
    .filter((entry) => entry.url.includes("acpx.virtuals.io"))
    .map((entry) => new URL(entry.url).searchParams.get("pagination[page]"))
    .sort();
  assert.deepEqual(requested, ["39", "40"]);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.name).sort(),
    ["Sweep Agent 39", "Sweep Agent 40"]
  );
});

test("the directory's reported page count drives the sweep bound", async () => {
  const urls = stubFetch(() => ({
    body: {
      data: [
        { name: "Sized Agent", description: "Base trading desk", walletAddress: CLIENT, twitterHandle: "@sized" },
      ],
      meta: { pagination: { page: 7, pageSize: 100, pageCount: 442, total: 44110 } },
    },
  }));

  const result = await discovery.fetchVirtualsDirectoryPage({ page: 7, limit: 100 });
  assert.equal(result.agents.length, 1);
  assert.equal(result.page, 7);
  assert.equal(result.pageCount, 442);
  assert.equal(result.total, 44110);
  assert.match(urls[0].url, /pagination%5Bpage%5D=7|pagination\[page\]=7/);
  assert.equal(new URL(urls[0].url).searchParams.get("pagination[pageSize]"), "100");

  const legacy = await discovery.fetchVirtualsDirectory({ page: 7, limit: 100 });
  assert.equal(Array.isArray(legacy), true, "the array-returning helper keeps its contract");
  assert.equal(legacy[0].name, "Sized Agent");
});

test("a directory page that fails does not stop the rest of the sweep", async () => {
  stubFetch((url) => {
    const page = new URL(url).searchParams.get("pagination[page]");
    if (page === "39") throw new Error("upstream 502");
    return {
      body: {
        data: [
          {
            name: `Alive Agent ${page}`,
            description: "Base yield automation desk",
            walletAddress: page === "40" ? CLIENT : `0x${"ef".repeat(20)}`,
          },
        ],
      },
    };
  });

  const result = await discovery.discoverTargets({
    scanJobs: 1,
    targets: [],
    indexUrl: "",
    directoryPage: 39,
    directoryPages: 3,
    directoryMaxPages: 40,
  });

  assert.deepEqual(result.sources.directoryPages, [39, 40, 1]);
  assert.equal(result.sources.directory, 2, "the failed page is skipped, the others are kept");
  const failed = result.errors.filter((error) => error.source === "directory");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].page, 39);
});
