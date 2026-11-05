import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";

const { config } = await import("../src/config.js");
const { store, storeHelpers } = await import("../src/lib/store.js");
const customModule = await import("../src/services/custom.js");
const { aiConfigured } = await import("../src/services/ai.js");
const { parseJobOrder } = await import("../src/services/intake.js");
const { getAgentAddress } = await import("../src/chain/client.js");
const outreach = await import("../src/services/outreach.js");
const { priceUnitsFor } = await import("../src/services/pricing.js");
const { agentCard } = await import("../src/services/a2a.js");
const {
  OFFERINGS,
  assessCustomTask,
  customPriceUsdc,
  getOffering,
  offeringsPublicJSON,
  validateParams,
} = await import("../src/services/offerings.js");

const {
  customAskText,
  customEnvelope,
  customInboundReply,
  customPreview,
  executeCustomTask,
  normalizeRequirement,
} = customModule;

const GENERATION_BRIEF = "Write a 200-word launch blurb for our new Base memecoin.";
const DEEP_BRIEF =
  "Compare the three largest liquidity pools on Base right now and forecast which one a small agent should prioritise, with risk notes.";

const customOffering = () => getOffering("custom_task");

const putSession = async (session) => {
  await store.set(storeHelpers.outreachSession(session.id), session, { ttlSeconds: 300 });
  return session;
};

test("routing and price are recomputed identically from the same brief", () => {
  const first = assessCustomTask(DEEP_BRIEF);
  const second = assessCustomTask(`  ${DEEP_BRIEF.replace(/\s+/g, "  ")}  `);
  assert.deepEqual(first, second);
  assert.equal(first.engine, "gemini");
  assert.equal(first.fallbackEngine, "groq");
  assert.ok(first.requiresLiveContext);
  assert.equal(assessCustomTask(GENERATION_BRIEF).engine, "groq");
});

test("complexity clamps to five tiers and the tier price stays inside the caps", () => {
  const tiers = [1, 2, 3, 4, 5].map((complexity) => customPriceUsdc(complexity));
  assert.ok(tiers.every((price, index) => index === 0 || price >= tiers[index - 1]));
  assert.ok(tiers.every((price) => price >= config.custom.basePriceUsdc && price <= config.custom.maxPriceUsdc));
  const monster = assessCustomTask(
    `${"research, compare, optimize and evaluate the current news around contracts, pools and wallets with a JSON table of 50 tokens and a strategy framework. ".repeat(6)}`
  );
  assert.equal(monster.complexity, 5);
  assert.equal(monster.tier, "expert");
  assert.equal(monster.engine, "gemini");
});

test("custom_task never joins the 50 registered offerings or the agent card skills", () => {
  assert.equal(OFFERINGS.length, 50);
  assert.equal(OFFERINGS.some((offering) => offering.id === "custom_task"), false);
  const publicList = offeringsPublicJSON();
  assert.equal(publicList.length, 50);
  assert.equal(publicList.some((offering) => offering.offering_id === "custom_task"), false);

  const card = agentCard("https://agent.example.com");
  assert.equal(card.skills.length, 50);
  assert.equal(card.skills.some((skill) => skill.id === "custom_task"), false);
  const advertised = card.capabilities.extensions.find((entry) => entry.uri === "https://virtuals.io/acp");
  assert.equal(advertised.params.customTask.offering_id, "custom_task");
  assert.equal(advertised.params.customTask.available, config.custom.enabled);

  const offering = customOffering();
  assert.equal(offering.custom, true);
  assert.equal(offering.category, "custom");
  assert.equal(offering.params[0].name, "requirement");
});

test("the brief is length-gated and normalized before it is priced", () => {
  assert.equal(normalizeRequirement("too short"), null);
  assert.equal(normalizeRequirement("a".repeat(config.custom.requirementMaxChars + 200)).length, config.custom.requirementMaxChars);
  const normalized = validateParams(customOffering(), { requirement: `  ${DEEP_BRIEF}  ` });
  assert.equal(normalized.requirement, assessCustomTask(DEEP_BRIEF).requirement);
  assert.equal(normalized.complexity, assessCustomTask(DEEP_BRIEF).complexity);
  assert.throws(() => validateParams(customOffering(), { requirement: "short" }), /requirement/);
});

test("the quoted envelope is exactly what the escrow check recomputes", () => {
  const assessment = assessCustomTask(DEEP_BRIEF);
  const envelope = customEnvelope(assessment);
  const order = parseJobOrder(envelope);
  assert.equal(order.offeringId, "custom_task");
  assert.equal(order.params.requirement, assessment.requirement);
  assert.equal(priceUnitsFor(customOffering(), order.params), BigInt(Math.round(assessment.priceUsdc * 1_000_000)));
  assert.equal(priceUnitsFor(customOffering(), order.params), priceUnitsFor(customOffering(), { requirement: assessment.requirement }));
});

test("preview prices and routes a brief without touching an engine", () => {
  const preview = customPreview({ offering: customOffering(), params: validateParams(customOffering(), { requirement: DEEP_BRIEF }) });
  assert.equal(preview.action, "preview_custom_task");
  assert.equal(preview.price.amount, assessCustomTask(DEEP_BRIEF).priceUsdc);
  assert.equal(preview.routing.preferred, "gemini");
  assert.equal(preview.routing.fallback, "groq");
  assert.equal(preview.zeroGas, true);
});

test("an inbound request outside the catalogue is answered with an ask or a quote", () => {
  assert.equal(customInboundReply({ text: "hello there", wallet: getAgentAddress() }), null);
  assert.equal(
    customInboundReply({ text: "what does this agent do and how does it differ from other agents?", wallet: getAgentAddress() }),
    null
  );
  const ask = customInboundReply({ text: "do you handle anything outside your catalogue?", wallet: getAgentAddress() });
  assert.ok(ask.text.includes("custom_task"));
  assert.equal(ask.assessment, null);
  assert.ok(customAskText("Peer").includes("ACP offerings"));

  const quoted = customInboundReply({ text: DEEP_BRIEF, wallet: getAgentAddress() });
  assert.ok(quoted.text.includes("custom_task"));
  assert.ok(quoted.text.includes(String(assessCustomTask(DEEP_BRIEF).priceUsdc)));
  assert.ok(quoted.text.includes(getAgentAddress()));
  assert.equal(quoted.assessment.engine, "gemini");
});

test("a no-fit peer opens a custom session with no price until a brief arrives", () => {
  const now = Date.now();
  const session = outreach.customAskSession({ key: "url:https://peer.example", name: "Peer", endpoint: "https://peer.example", score: 70 }, now);
  assert.equal(session.mode, "custom");
  assert.equal(session.offeringId, "custom_task");
  assert.equal(session.priceUsdc, null);
  assert.equal(session.requirement, null);
  assert.ok(session.expiresAt > now);

  const verdict = outreach.evaluateNegotiation({ session, text: "sure, but can you research the top three L2 yield venues this month for me?", now: now + 1000 });
  assert.equal(verdict.action, "requirement");
  assert.equal(verdict.priceUsdc, assessCustomTask(verdict.requirement).priceUsdc);
  assert.ok(verdict.resetExpiresAt > session.expiresAt);
  assert.equal(outreach.evaluateNegotiation({ session, text: "hmm", now: now + 1000 }).action, "need_brief");
});

test("a quoted custom session never concedes below its tier price", () => {
  const now = Date.now();
  const session = outreach.customAskSession({ key: "url:https://peer2.example", name: "Peer2", endpoint: "https://peer2.example", score: 70 }, now);
  const assessment = assessCustomTask(DEEP_BRIEF);
  Object.assign(session, { requirement: assessment.requirement, priceUsdc: assessment.priceUsdc, floorUsdc: assessment.priceUsdc });
  assert.equal(outreach.evaluateNegotiation({ session, text: `budget ${assessment.priceUsdc * 3} usdc`, now: now + 1000 }).action, "accept");
  const countered = outreach.evaluateNegotiation({ session, text: "budget 0.001 usdc", now: now + 1000 });
  assert.equal(countered.action, "counter");
  assert.equal(countered.priceUsdc, assessment.priceUsdc);
});

test("a funded custom order only executes when it carries the quoted brief", async () => {
  const now = Date.now();
  const assessment = assessCustomTask(DEEP_BRIEF);
  const session = outreach.customAskSession({ key: "url:https://peer3.example", name: "Peer3", endpoint: "https://peer3.example", score: 70 }, now);
  Object.assign(session, { requirement: assessment.requirement, priceUsdc: assessment.priceUsdc, floorUsdc: assessment.priceUsdc });
  await putSession(session);

  const wallet = getAgentAddress();
  const job = (description, budget) => async () => ({
    id: "9001",
    status: 1,
    provider: wallet,
    budget: String(budget),
    description,
    client: `0x${"cd".repeat(20)}`,
  });
  const paid = Math.round(assessment.priceUsdc * 1_000_000);
  let executed = null;
  const ok = await outreach.handleOutreachReply({
    text: "job 9001",
    contextId: session.id,
    now: now + 2000,
    getJob: job(customEnvelope(assessment), paid),
    executeJob: async ({ offeringId, params }) => {
      executed = { offeringId, params };
      return { payload: { status: "completed", deliverableHash: "0xdead" } };
    },
  });
  assert.equal(ok.action, "funded");
  assert.equal(executed.offeringId, "custom_task");
  assert.equal(executed.params.requirement, assessment.requirement);

  const swapped = outreach.customAskSession({ key: "url:https://peer4.example", name: "Peer4", endpoint: "https://peer4.example", score: 70 }, now);
  Object.assign(swapped, { requirement: assessment.requirement, priceUsdc: assessment.priceUsdc, floorUsdc: assessment.priceUsdc });
  await putSession(swapped);
  const refused = await outreach.handleOutreachReply({
    text: "job 9002",
    contextId: swapped.id,
    now: now + 2000,
    getJob: job(customEnvelope(assessCustomTask(GENERATION_BRIEF)), paid),
    executeJob: async () => {
      throw new Error("must not execute a brief that was never quoted");
    },
  });
  assert.equal(refused.action, "funded_unverified");
  assert.ok(refused.text.includes("custom_task"));
});

test("a peer that funds a described order is quoted and verified without a prior brief", async () => {
  const now = Date.now();
  const assessment = assessCustomTask(DEEP_BRIEF);
  const session = outreach.customAskSession({ key: "url:https://peer5.example", name: "Peer5", endpoint: "https://peer5.example", score: 70 }, now);
  await putSession(session);
  let executed = null;
  const result = await outreach.handleOutreachReply({
    text: "job 9100",
    contextId: session.id,
    now: now + 2000,
    getJob: async () => ({
      id: "9100",
      status: 1,
      provider: getAgentAddress(),
      budget: String(Math.round(assessment.priceUsdc * 1_000_000)),
      description: customEnvelope(assessment),
      client: `0x${"ef".repeat(20)}`,
    }),
    executeJob: async ({ params }) => {
      executed = params;
      return { payload: { status: "completed", deliverableHash: "0xbeef" } };
    },
  });
  assert.equal(result.action, "funded");
  assert.equal(executed.requirement, assessment.requirement);
});

test("a custom brief cannot be executed without an AI engine configured", async (t) => {
  if (aiConfigured()) return t.skip("an AI engine is configured, so the guard cannot be observed offline");
  await assert.rejects(() => executeCustomTask({ params: { requirement: DEEP_BRIEF } }), /AI_NOT_CONFIGURED|No AI engine/);
});
