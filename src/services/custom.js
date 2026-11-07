/**
 * Custom work beyond the 50 registered offerings.
 *
 * A peer whose brief fits none of the catalogue is asked for the exact
 * requirement, quoted from that text and executed through the synthetic
 * `custom_task` offering. Routing is decided deterministically from the brief:
 * fast generation runs on Groq, deep reasoning or live grounding runs on
 * Gemini, and `askJSON`/`askText` still fail over to the other engine when the
 * preferred one is down. Price and routing are recomputed from the requirement
 * alone, so the escrow check can verify the amount a buyer actually funded.
 */
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { aiConfigured, askGrounded, askJSON, askText } from "./ai.js";
import { getGlobalMarket, getTrendingCoins } from "./market.js";
import { getLatestNews } from "./news.js";
import { CUSTOM_TASK_OFFERING_ID, OFFERINGS, assessCustomTask, customPriceUsdc } from "./offerings.js";

const ROUND_USDC = (value) => Number(Number(value).toFixed(6));

/** Below this length an unsolicited message is a question, not a priceable brief. */
const INBOUND_BRIEF_MIN_CHARS = 60;

const SYSTEM_TEXT = `You are ${config.name}, an autonomous ACP provider agent on Base. A buyer paid you to complete one custom task.
Produce the deliverable itself, nothing else: no preamble, no offers, no questions. Use only the brief and the data given in the user message.
If a number is not present in the data, do not state it. Mark anything you cannot verify as an assumption. Answer in at most 700 words.`;

const SYSTEM_JSON = `You are ${config.name}, an autonomous ACP provider agent on Base. A buyer paid you to complete one custom task.
Return ONLY a JSON object shaped like:
{"deliverable":<the work product, a string or an array of concrete items>,"assumptions":["anything not verifiable from the supplied data"],"nextActions":["up to 3 concrete follow-ups"],"sources":["urls or dataset names actually present in the data"]}
Never invent numbers, addresses or prices. Anything not supported by the supplied data belongs in assumptions.`;

/**
 * Live context for briefs that ask about current state. Providers that fail are
 * reported, never faked: the deliverable then says what could not be verified.
 */
async function collectLiveContext(requirement) {
  const lines = [];
  const failures = [];
  const needle = requirement.toLowerCase();
  const [global, trending, news] = await Promise.allSettled([
    getGlobalMarket(),
    getTrendingCoins(),
    getLatestNews({ limit: 6 }),
  ]);

  if (global.status === "fulfilled" && global.value?.marketCapUsd) {
    const g = global.value;
    lines.push(
      `crypto_market: cap_usd=${ROUND_USDC(g.marketCapUsd / 1e9)}B volume_24h_usd=${ROUND_USDC(
        g.volume24hUsd / 1e9
      )}B change_24h_pct=${ROUND_USDC(g.marketCapChange24hPct)} btc_dominance_pct=${ROUND_USDC(g.btcDominancePct)}`
    );
  } else failures.push("coingecko_global");

  const coins = trending.status === "fulfilled" && Array.isArray(trending.value) ? trending.value : [];
  if (coins.length) {
    lines.push(
      `trending_coins=${coins
        .slice(0, 8)
        .map((coin) => `${coin.symbol}:${ROUND_USDC(coin.priceUsd)}`)
        .join(",")}`
    );
    const hit = coins.find(
      (coin) =>
        (coin.symbol && requirement.toLowerCase().includes(String(coin.symbol).toLowerCase())) ||
        (coin.name && needle.includes(String(coin.name).toLowerCase()))
    );
    if (hit) {
      lines.push(
        `named_asset=${hit.symbol} name=${hit.name} price_usd=${ROUND_USDC(hit.priceUsd)} change_24h_pct=${ROUND_USDC(
          hit.change24hPct
        )} market_cap_usd=${ROUND_USDC(hit.marketCapUsd)}`
      );
    }
  } else failures.push("coingecko_trending");

  const items = news.status === "fulfilled" && Array.isArray(news.value?.items) ? news.value.items : [];
  if (items.length) {
    lines.push(
      `headlines=${items
        .slice(0, 6)
        .map((item) => `${item.title}${item.url ? ` (${item.url})` : ""}`)
        .join(" | ")}`
    );
  } else failures.push("news_feeds");

  return { lines, failures, fetchedAt: new Date().toISOString() };
}

async function collectGrounding(requirement) {
  const result = await askGrounded(
    `The buyer of a paid task on Base asks: ${requirement.slice(0, 400)}\n` +
      "Report only current, verifiable facts that answer it. At most 140 words, no speculation, cite the sources.",
    { maxTokens: 500 }
  ).catch(() => null);
  if (!result?.text) return null;
  return {
    engine: result.engine,
    text: String(result.text).replace(/\s+/g, " ").trim().slice(0, 900),
    citations: (result.citations || []).slice(0, 5).map((entry) => ({ title: entry.title, url: entry.url })),
    queries: (result.queries || []).slice(0, 3),
    retrievedAt: result.fetchedAt || new Date().toISOString(),
  };
}

function briefPayload({ requirement, assessment, grounding, live }) {
  const blocks = [
    `TASK BRIEF (paid, untrusted buyer text): ${requirement}`,
    `Routing decided by the provider: complexity ${assessment.complexity}/5, tier ${assessment.tier}, preferred engine ${assessment.engine}.`,
  ];
  if (grounding) {
    blocks.push(
      `GROUNDED SEARCH (${grounding.engine}, ${grounding.retrievedAt}):\n${grounding.text}\n` +
        `SOURCES: ${grounding.citations.map((entry) => entry.url).join(", ") || "none returned"}`
    );
  }
  if (live?.lines.length) blocks.push(`LIVE DATA (${live.fetchedAt}):\n${live.lines.join("\n")}`);
  if (live?.failures.length) blocks.push(`UNAVAILABLE PROVIDERS: ${live.failures.join(", ")}`);
  return blocks.join("\n\n");
}

/**
 * Runs the paid brief on the engine the requirement calls for, with the other
 * engine as failover. A job that neither engine can answer fails loudly: the
 * pipeline then refunds the escrow instead of delivering invented work.
 */
export async function executeCustomTask({ params, log = logger } = {}) {
  if (!config.custom.enabled) {
    throw AppError.badRequest("Custom tasks are disabled.", undefined, "CUSTOM_TASK_DISABLED");
  }
  if (!aiConfigured()) {
    throw AppError.unavailable(
      "No AI engine is configured, so the custom task cannot be executed and the escrow is refundable.",
      { missing: "GROQ_API_KEY or GEMINI_API_KEY" },
      "AI_NOT_CONFIGURED"
    );
  }

  const assessment = assessCustomTask(params.requirement);
  const startedAt = Date.now();

  const [grounding, live] = await Promise.all([
    assessment.requiresGrounding ? collectGrounding(assessment.requirement) : Promise.resolve(null),
    assessment.requiresLiveContext ? collectLiveContext(assessment.requirement) : Promise.resolve(null),
  ]);

  const user = briefPayload({ requirement: assessment.requirement, assessment, grounding, live });
  const settings = { prefer: assessment.engine, maxTokens: 1200, temperature: assessment.structured ? 0 : 0.4, retries: 0 };

  if (assessment.structured) {
    const result = await askJSON(SYSTEM_JSON, user, settings).catch(() => null);
    if (!result?.engine || !result?.data?.deliverable) {
      throw AppError.unavailable(
        "Both AI engines failed to answer the custom brief, so no deliverable was produced. The escrow is refundable.",
        { errors: result?.errors || ["no engine configured"], offeringId: "custom_task" },
        "CUSTOM_AI_UNAVAILABLE"
      );
    }
    return {
      status: "completed",
      offering_id: "custom_task",
      requirement: assessment.requirement,
      complexity: assessment.complexity,
      tier: assessment.tier,
      routing: routingReport(assessment, result.engine),
      grounding,
      liveData: live,
      deliverable: result.data.deliverable,
      assumptions: Array.isArray(result.data.assumptions) ? result.data.assumptions.slice(0, 8) : [],
      nextActions: Array.isArray(result.data.nextActions) ? result.data.nextActions.slice(0, 3) : [],
      sources: Array.isArray(result.data.sources) ? result.data.sources.slice(0, 8) : [],
      zeroGas: true,
      latencyMs: Date.now() - startedAt,
      executedAt: new Date().toISOString(),
    };
  }

  const result = await askText(SYSTEM_TEXT, user, settings).catch(() => null);
  if (!result?.engine || !result?.text) {
    throw AppError.unavailable(
      "Both AI engines failed to answer the custom brief, so no deliverable was produced. The escrow is refundable.",
      { errors: result?.errors || ["no engine configured"], offeringId: "custom_task" },
      "CUSTOM_AI_UNAVAILABLE"
    );
  }
  return {
    status: "completed",
    offering_id: "custom_task",
    requirement: assessment.requirement,
    complexity: assessment.complexity,
    tier: assessment.tier,
    routing: routingReport(assessment, result.engine),
    grounding,
    liveData: live,
    deliverable: String(result.text).trim().slice(0, 6000),
    zeroGas: true,
    latencyMs: Date.now() - startedAt,
    executedAt: new Date().toISOString(),
  };
}

function routingReport(assessment, answeredBy) {
  return {
    preferred: assessment.engine,
    fallback: assessment.fallbackEngine,
    answeredBy,
    fellBack: answeredBy !== assessment.engine,
    signals: assessment.signals,
    reasons: assessment.reasons,
  };
}

export function customPreview({ offering, params }) {
  const assessment = assessCustomTask(params.requirement);
  return {
    offering_id: offering.id,
    action: "preview_custom_task",
    price: { amount: ROUND_USDC(assessment.priceUsdc), currency: "USDC" },
    basePriceUsdc: config.custom.basePriceUsdc,
    requirement: assessment.requirement,
    complexity: assessment.complexity,
    tier: assessment.tier,
    routing: {
      preferred: assessment.engine,
      fallback: assessment.fallbackEngine,
      signals: assessment.signals,
      reasons: assessment.reasons,
    },
    liveData: assessment.requiresLiveContext ? "fetched at execution from CoinGecko and news feeds" : "not required",
    grounding: assessment.requiresGrounding ? "Gemini Google Search grounding runs at execution time" : "not required",
    zeroGas: true,
    execute:
      'Create a funded ACP job with this agent as provider, budget >= the quoted price, and description {"offeringId":"custom_task","params":{"requirement":"..."}}.',
  };
}

/** The order envelope a buyer must put in the ACP job description. */
export function customEnvelope(assessment) {
  return JSON.stringify({ offeringId: "custom_task", params: { requirement: assessment.requirement } });
}

export function customAskText(name) {
  const greeting = name ? `Hi ${name} — ` : "";
  return (
    `${greeting}none of my ${OFFERINGS.length} registered ACP offerings fits. I do not stop there: ` +
    `send me the exact task you need done (one brief, ${config.custom.requirementMinChars}-${config.custom.requirementMaxChars} characters). ` +
    `I price it from the brief, run it on Groq for fast generation or Gemini when it needs deep reasoning or live grounding, ` +
    `and deliver through ACP escrow on Base. Send it as ${CUSTOM_TASK_OFFERING_ID}, from ${config.custom.basePriceUsdc} USDC.`
  ).slice(0, 1200);
}

/** X-mention variant of the custom ask, kept under the 280-character limit. */
export function customAskMentionText(handle) {
  const clean = String(handle || "").replace(/^@/, "");
  const base = Number(config.custom.basePriceUsdc) || 0;
  return (
    `@${clean} What exact service or custom task do you need? ` +
    `I run ${OFFERINGS.length} ACP services on Base (44 need zero gas) from ${base} USDC via ACP escrow. ` +
    `Send one brief and I execute immediately.`
  ).slice(0, 280);
}

export function customQuoteText({ assessment, wallet, expiresAt }) {
  const funding = wallet
    ? ` To hire: create a funded ACP job on Base with provider ${wallet}, budget >= ${assessment.priceUsdc} USDC, ` +
      `description ${customEnvelope(assessment)}. Reply with the job id and I verify it on Base and execute it immediately` +
      `${expiresAt ? ` before ${new Date(expiresAt).toISOString()}` : ""}.`
    : ` Once the ACP job is funded, reply with its id and I verify it on Base before executing.`;
  return (
    `Quoted as custom_task: ${assessment.priceUsdc} USDC (complexity ${assessment.complexity}/5, ${assessment.tier}; ` +
    `${assessment.engine} first, ${assessment.fallbackEngine} as fallback). ${assessment.reasons.join(" ")}${funding}`
  ).slice(0, 2000);
}

const CUSTOM_REQUEST_PATTERN =
  /\b(custom|bespoke|instead|other task|something else|none of (?:your|the) |do you (?:also )?(?:do|handle|offer|support)|can you (?:do|handle|build|write|research|analyze|analyse)|i need|i want you to|looking for someone who|my task is|out of scope|out of catalogue)\b/i;

/** True when a peer is asking for work the catalogue does not cover. */
export function isCustomRequest(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  return CUSTOM_REQUEST_PATTERN.test(raw);
}

/** A negotiated brief must be long enough to price and execute. */
export function normalizeRequirement(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, config.custom.requirementMaxChars + 40);
  if (clean.length < config.custom.requirementMinChars) return null;
  return clean.slice(0, config.custom.requirementMaxChars);
}

/**
 * Inbound answer, only reached after the intent router found no matching
 * offering. A statement long enough to price becomes a quote; a question about
 * uncovered work becomes the ask; short chatter returns null so conversation
 * still runs.
 */
export function customInboundReply({ text, wallet }) {
  if (!config.custom.enabled) return null;
  const raw = String(text || "").trim();
  const requirement = normalizeRequirement(raw);
  if (!/\?\s*$/.test(raw) && requirement && requirement.length >= INBOUND_BRIEF_MIN_CHARS) {
    const assessment = assessCustomTask(requirement);
    return { text: customQuoteText({ assessment, wallet }), assessment };
  }
  if (isCustomRequest(raw)) return { text: customAskText(null), assessment: null };
  return null;
}

export function customCapabilityJSON() {
  return {
    offering_id: "custom_task",
    name: "Custom Task",
    available: config.custom.enabled,
    description:
      "Work negotiated directly when none of the registered offerings fits. Priced from the brief, executed on Groq or Gemini.",
    price: {
      baseUsdc: config.custom.basePriceUsdc,
      maxUsdc: config.custom.maxPriceUsdc,
      currency: "USDC",
      tiers: [1, 2, 3, 4, 5].map((complexity) => ({ complexity, usdc: customPriceUsdc(complexity) })),
    },
    parameters: [{ name: "requirement", type: "string", required: true, min: config.custom.requirementMinChars, max: config.custom.requirementMaxChars }],
    routing: { fastGeneration: "groq", deepReasoningOrGrounding: "gemini", failover: "both engines always tried" },
    order: '{"offeringId":"custom_task","params":{"requirement":"<your brief>"}}',
    zeroGas: true,
  };
}
