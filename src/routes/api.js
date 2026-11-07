import express from "express";
import { getAddress, isAddress } from "viem";
import { config, walletConfigured } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { rateLimit } from "../lib/rateLimit.js";
import {
  requireApiKey,
  requireApiKeyOrBossPasscode,
  requireApiKeyOrCronSecret,
  requireCronSecret,
} from "../middleware/auth.js";
import { getAgentAddress } from "../chain/client.js";
import { buildHealth } from "../services/health.js";
import { getOffering, offeringsPublicJSON, validateParams } from "../services/offerings.js";
import { customCapabilityJSON, customInboundReply } from "../services/custom.js";
import { executeAcpJob, previewOffering, runOffering } from "../services/pipeline.js";
import { helpText, parseIntent } from "../services/ai.js";
import {
  bossClientKey,
  capabilitySummary,
  chatReply,
  handleBossMessage,
  wantsCatalog,
} from "../services/chat.js";
import { getJobRecord } from "../services/jobs.js";
import { getAcpJob } from "../services/escrow.js";
import { sweepJobs } from "../services/sweep.js";
import { runSocialCycle, socialStatus } from "../services/social.js";
import { intakeOnce, intakeStatus } from "../services/intake.js";
import { inboxStatus } from "../services/inbox.js";
import { outreachStatus, runOutreachCycle } from "../services/outreach.js";
import { currentPricing, issueQuote, quoteEnvelope, quotePublicJSON } from "../services/pricing.js";
import { revenueStatus, runRevenueCycle, subscriptionStatus } from "../services/revenue.js";
import { referralStatus } from "../services/referrals.js";
import { bountyScan } from "../services/bounties.js";

export const router = express.Router();
const isTruthy = (value) => value === true || /^(1|true|yes)$/i.test(String(value ?? ""));

const info = () => ({
  success: true,
  status: "online",
  name: config.name,
  slug: config.slug,
  version: config.version,
  description: config.description,
  chain: { id: config.chain.id, name: config.chain.name, explorer: config.chain.explorer },
  acp: {
    protocol: "virtuals-acp",
    escrowContract: config.acp.contract,
    api: config.acp.apiUrl,
    agentId: config.acp.agentId || null,
    verification: "on-chain getJob() + USDC escrow solvency",
  },
  offerings: offeringsPublicJSON().map((offering) => ({
    offering_id: offering.offering_id,
    name: offering.name,
    price: offering.price.amount,
    currency: offering.price.currency,
    sla_seconds: offering.sla_seconds,
  })),
  endpoints: {
    health: "GET /api/health",
    offerings: "GET /api/offerings",
    custom: "GET /api/custom",
    chat: "POST /api/chat",
    acp: "POST /api/acp",
    jobStatus: "GET /api/jobs/:jobId",
    intake: "GET /api/intake",
    cronIntake: "GET /api/cron/intake",
    sweep: "GET /api/cron/sweep",
    social: "GET /api/social",
    socialCron: "GET /api/cron/social",
    a2a: "POST /a2a",
    agentCard: "GET /.well-known/agent-card.json",
    inbox: "GET /api/a2a/inbox",
    outreach: "GET /api/outreach",
    cronOutreach: "GET /api/cron/outreach",
    outreachStart: "POST /api/outreach/start",
    pricing: "GET /api/pricing",
    quote: "POST /api/quote",
    revenue: "GET /api/revenue",
    revenueSubscriptions: "GET /api/revenue/subscriptions",
    revenueReferrals: "GET /api/revenue/referrals",
    cronRevenue: "GET /api/cron/revenue",
  },
  timestamp: new Date().toISOString(),
});

router.get("/", (_req, res) => res.json(info()));
router.get("/api", (_req, res) => res.json(info()));

router.get("/api/health", async (req, res, next) => {
  try {
    const health = await buildHealth({ force: req.query.refresh === "1" });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(health);
  } catch (error) {
    next(error);
  }
});

router.get("/api/offerings", (_req, res) => {
  res.json({
    success: true,
    count: offeringsPublicJSON().length,
    offerings: offeringsPublicJSON(),
    timestamp: new Date().toISOString(),
  });
});

router.get("/api/offerings/:offeringId", (req, res, next) => {
  try {
    const offering = getOffering(req.params.offeringId);
    res.json({ success: true, offering: offeringsPublicJSON().find((o) => o.offering_id === offering.id) });
  } catch (error) {
    next(error);
  }
});

router.get("/api/custom", (_req, res) => {
  res.json({ success: true, custom: customCapabilityJSON(), timestamp: new Date().toISOString() });
});

router.get("/api/pricing", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, pricing: await currentPricing(), timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.post("/api/quote", requireApiKey, rateLimit(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const offeringId = body.offeringId || body.offering_id;
    if (!offeringId) throw AppError.badRequest("offeringId is required.", undefined, "MISSING_OFFERING");
    if (body.client && !isAddress(body.client)) {
      throw AppError.badRequest("client must be a valid EVM address.", { client: body.client }, "INVALID_CLIENT");
    }
    if (body.referrer && !isAddress(body.referrer)) {
      throw AppError.badRequest("referrer must be a valid EVM address.", { referrer: body.referrer }, "INVALID_REFERRER");
    }
    const client = body.client ? getAddress(body.client) : null;
    if (client && getAgentAddress().toLowerCase() === client.toLowerCase()) {
      throw AppError.badRequest("client cannot be the agent wallet.", undefined, "INVALID_CLIENT");
    }
    const offering = getOffering(offeringId);
    const params = validateParams(offering, body.params || {});
    const quote = await issueQuote({
      offering,
      params,
      client,
      referrer: body.referrer ? getAddress(body.referrer) : null,
      model: body.model || "standard",
    });
    res.json({
      success: true,
      quote: await quotePublicJSON(quote),
      envelope: quoteEnvelope(quote),
      note:
        quote.model === "performance"
          ? "Performance pricing charges the upfront amount through escrow; the bonus is a separate ACP job the client may elect after delivery."
          : "Fund an ACP job with this exact description and budget. The quote expires and is bound to the offering, params and client.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/api/acp", (_req, res) => {
  res.json({
    success: true,
    method: "POST",
    description:
      "Execute a paid ACP job. Funds are verified in the Virtuals ACP escrow contract before execution. Intelligence offerings run live data providers and AI synthesis at execution time and settle the deliverable hash on Base.",
    body: {
      jobId: "ACP on-chain job id (uint256)",
      offeringId: "one of the published offering ids",
      params: "offering-specific parameters",
      buyer: "optional; must match the ACP job client",
      quoteId: "optional; a /api/quote id when the job was funded at a quoted price",
      referrer: "optional partner wallet that receives the referral commission after completion",
    },
    offerings: offeringsPublicJSON().map((offering) => ({
      offering_id: offering.offering_id,
      price: offering.price.amount,
      parameters: offering.parameters,
    })),
    statusCodes: {
      "200": "job completed, or failed with an escrow refund payload",
      "400": "invalid params or malformed jobId",
      "401": "API key required",
      "402": "escrow not funded or budget too low",
      "403": "buyer mismatch",
      "404": "unknown offering or job not found",
      "409": "wrong job state or job already in progress",
      "503": "wallet/ACP/upstream unavailable",
    },
    timestamp: new Date().toISOString(),
  });
});

router.get("/api/chat", (_req, res) => {
  res.json({
    success: true,
    method: "POST",
    body: {
      message: "natural language request, e.g. \"swap 10 USDC to WETH\"",
      offeringId: "optional explicit offering",
      params: "optional explicit params",
      execute: "boolean; requires a funded jobId",
      jobId: "ACP job id when execute=true",
      buyer: "client wallet address",
      clientId: "optional stable id for the boss admin session",
    },
    examples: [
      "resolve USDC WETH VIRTUAL",
      "swap 10 USDC to WETH with slippage 3%",
      "transfer 5 USDC to 0x0000000000000000000000000000000000000001",
      "what's trending in crypto",
      "Bitcoin news",
      "best stablecoin yields",
      "research Base airdrop farming",
      "analyze VIRTUAL",
      "list offerings",
      "hello, how are you doing?",
    ],
    responses: {
      preview: "status=preview when an offering matches; execution still needs a funded ACP job",
      chat: "status=chat for general conversation, answered live by Groq with Gemini as fallback",
      help: "status=help with the full offering catalog when the catalog is requested",
      boss_verified: "status=boss_verified after the admin passcode is accepted",
      boss_discovery: "status=boss_discovery when outbound agent discovery runs directly",
      admin_required: "status=admin_required when an admin command arrives without the passcode",
    },
    auth: "Send x-api-key (or Authorization: Bearer) when API_KEY is set. Boss operators can send the configured BOSS_PASSCODE in the message body instead: a bare passcode message verifies the boss session and immediately runs outbound agent discovery, with no API key header required.",
    note: "Read-only previews are free. Execution requires a funded ACP escrow job. Intelligence offerings preview provider availability only; the live report is generated when the job executes. A message containing the admin passcode is acknowledged as boss/admin and can trigger outbound agent discovery directly, outside the escrow flow.",
    timestamp: new Date().toISOString(),
  });
});

router.post("/api/acp", requireApiKey, rateLimit(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const offeringId = body.offeringId || body.offering_id;
    const { jobId, buyer } = body;
    const params = body.params || {};

    if (jobId === undefined || jobId === null || jobId === "") {
      throw AppError.badRequest("jobId is required.", undefined, "MISSING_JOB_ID");
    }
    if (!offeringId) {
      throw AppError.badRequest("offeringId is required.", undefined, "MISSING_OFFERING");
    }
    if (buyer && !isAddress(buyer)) {
      throw AppError.badRequest("buyer must be a valid EVM address.", { buyer }, "INVALID_BUYER");
    }

    const result = await executeAcpJob({
      jobId,
      offeringId,
      params,
      buyer: buyer ? getAddress(buyer) : undefined,
      quoteId: body.quoteId || body.quote_id || null,
      referrer: body.referrer || null,
      log: req.log,
    });

    res.status(result.httpStatus).json(result.payload);
  } catch (error) {
    next(error);
  }
});

router.post("/api/chat", requireApiKeyOrBossPasscode, rateLimit(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const execute = isTruthy(body.execute);
    const explicitOffering = body.offeringId || body.offering_id;

    let intent;
    let engine = "rules";
    let reply = null;

    if (explicitOffering) {
      const offering = getOffering(explicitOffering);
      intent = {
        action: offering.id,
        offeringId: offering.id,
        params: body.params || {},
        reply: `Prepared ${offering.name}.`,
      };
    } else {
      if (!body.message || String(body.message).trim() === "") {
        throw AppError.badRequest("Provide message or offeringId + params.", undefined, "MISSING_MESSAGE");
      }

      const boss = await handleBossMessage({
        message: String(body.message),
        clientKey: bossClientKey(req, body),
        deps: { runOutreachCycle, outreachStatus },
      });
      if (boss.handled) {
        return res.json({
          success: true,
          status: boss.status,
          reply: boss.reply,
          engine: boss.engine,
          intent: boss.intent,
          boss: { verified: Boolean(boss.boss) },
          ...(boss.extra || {}),
          timestamp: new Date().toISOString(),
        });
      }

      const parsed = await parseIntent(body.message);
      intent = parsed.intent;
      engine = parsed.engine;
      reply = intent.reply;
    }

    if (intent.action === "help" || !intent.offeringId) {
      if (wantsCatalog(body.message)) {
        return res.json({
          success: true,
          status: "help",
          reply: reply || helpText(),
          engine,
          intent,
          offerings: offeringsPublicJSON().map((offering) => ({
            offering_id: offering.offering_id,
            name: offering.name,
            price: offering.price.amount,
            currency: offering.price.currency,
          })),
          timestamp: new Date().toISOString(),
        });
      }

      const custom = customInboundReply({
        text: body.message,
        wallet: walletConfigured ? getAgentAddress() : null,
      });
      if (custom) {
        return res.json({
          success: true,
          status: "custom",
          reply: custom.text,
          engine,
          intent: custom.assessment
            ? {
                action: "custom_task",
                offeringId: "custom_task",
                params: { requirement: custom.assessment.requirement },
                reply: custom.text,
              }
            : intent,
          routing: custom.assessment
            ? {
                complexity: custom.assessment.complexity,
                tier: custom.assessment.tier,
                preferred: custom.assessment.engine,
                fallback: custom.assessment.fallbackEngine,
                priceUsdc: custom.assessment.priceUsdc,
                reasons: custom.assessment.reasons,
              }
            : null,
          custom: customCapabilityJSON(),
          timestamp: new Date().toISOString(),
        });
      }

      const conversation = await chatReply({ message: body.message });
      return res.json({
        success: true,
        status: "chat",
        reply: conversation.reply,
        engine: conversation.engine,
        intent,
        capabilities: capabilitySummary(),
        custom: customCapabilityJSON(),
        timestamp: new Date().toISOString(),
      });
    }

    const offering = getOffering(intent.offeringId);

    if (!execute) {
      const preview = await previewOffering({
        offering,
        params: intent.params,
        buyer: body.buyer && isAddress(body.buyer) ? getAddress(body.buyer) : undefined,
      });
      return res.json({
        success: true,
        status: "preview",
        reply: reply || `Prepared a ${offering.id} execution plan.`,
        engine,
        intent,
        preview,
        next: {
          method: "POST",
          path: "/api/acp",
          body: { jobId: "<funded ACP job id>", offeringId: offering.id, params: intent.params },
          note: "Execution only starts after the ACP escrow is funded on Base.",
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (body.jobId) {
      const result = await executeAcpJob({
        jobId: body.jobId,
        offeringId: offering.id,
        params: intent.params,
        buyer: body.buyer && isAddress(body.buyer) ? getAddress(body.buyer) : undefined,
        log: req.log,
      });
      return res.status(result.httpStatus).json({
        ...result.payload,
        reply: reply || `Executed ${offering.id}.`,
        engine,
        intent,
      });
    }

    if (!config.execution.allowUnpaidExecution) {
      throw AppError.paymentRequired(
        "Execution requires a funded ACP escrow job. Create a job and pass its jobId.",
        {
          jobId: "required",
          offeringId: offering.id,
          priceUsdc: offering.priceUsdc,
          howTo:
            "Create the ACP job with provider=agent wallet, fund it in USDC, then POST /api/acp with the jobId.",
        },
        "ESCROW_REQUIRED"
      );
    }

    if (!body.buyer || !isAddress(body.buyer)) {
      throw AppError.badRequest(
        "buyer address is required for unpaid execution (development mode).",
        undefined,
        "MISSING_BUYER"
      );
    }

    const params = validateParams(offering, intent.params);
    const buyer = getAddress(body.buyer);
    if (offering.id === "transfer_token" || offering.id === "token_swap") {
      logger.warn("unpaid execution enabled", { offering: offering.id, buyer });
    }
    const result = await runOffering({ offering, params, buyer, log: req.log });

    return res.json({
      success: true,
      status: "completed",
      mode: "unpaid_dev",
      reply: reply || `Executed ${offering.id}.`,
      engine,
      intent,
      offering_id: offering.id,
      buyer,
      agent: getAgentAddress(),
      result,
      acp: null,
      warning: "Executed without ACP escrow because ALLOW_UNPAID_EXECUTION=true.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/api/jobs/:jobId", async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.jobId)) {
      throw AppError.badRequest("jobId must be numeric.", undefined, "INVALID_JOB_ID");
    }
    const record = await getJobRecord(req.params.jobId);
    if (!record) {
      throw AppError.notFound(`No local record for ACP job ${req.params.jobId}.`, "JOB_NOT_FOUND");
    }

    let onchain = null;
    if (req.query.onchain === "1") {
      onchain = await getAcpJob(req.params.jobId).catch((error) => ({ error: error.message }));
    }

    res.json({ success: true, job: record, onchain, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.all("/api/cron/sweep", requireCronSecret, async (req, res, next) => {
  try {
    const summary = await sweepJobs({ limit: 10 });
    res.json({ success: true, ...summary, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/bounties", async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const status = await bountyScan({ refresh: req.query.refresh === "1" });
    res.json({ success: true, bounties: status, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.all("/api/cron/bounty", requireCronSecret, async (req, res, next) => {
  try {
    const status = await bountyScan({ refresh: true });
    res.json({ success: true, ...status, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/intake", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, intake: await intakeStatus(), timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.all("/api/cron/intake", requireCronSecret, async (req, res, next) => {
  try {
    const summary = await intakeOnce({ reason: String(req.query.reason || "cron") });
    res.json({ success: summary.status !== "failed", intake: summary, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/a2a/inbox", requireApiKey, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, inbox: await inboxStatus(), timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

/**
 * Outreach status surface. With a valid credential in the query string a
 * browser can also fire an immediate sweep: append &run=1 (or &force=1).
 */
router.get("/api/outreach", requireApiKeyOrCronSecret, async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (isTruthy(req.query.run) || isTruthy(req.query.force)) {
      const summary = await runOutreachCycle({
        reason: String(req.query.reason || "browser"),
        force: true,
      });
      return res.json({
        success: summary.status !== "failed",
        triggered: true,
        outreach: summary,
        timestamp: new Date().toISOString(),
      });
    }
    res.json({
      success: true,
      outreach: await outreachStatus(),
      trigger:
        "Append &run=1 with a valid credential (?secret=<CRON_SECRET> or ?passcode=<BOSS_PASSCODE>) to run an immediate discovery sweep.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.all("/api/cron/outreach", requireCronSecret, async (req, res, next) => {
  try {
    const summary = await runOutreachCycle({
      reason: String(req.query.reason || "cron"),
      force: isTruthy(req.query.force),
    });
    res.json({ success: summary.status !== "failed", outreach: summary, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

/**
 * Forces an immediate outbound discovery cycle. Used by the activation wake-up
 * and by the operator to start outreach without waiting for the daily cron.
 * Accepts x-api-key / Bearer, or ?secret=<CRON_SECRET> / ?passcode=<BOSS_PASSCODE>
 * so a browser POST works with no header support.
 */
router.post("/api/outreach/start", requireApiKeyOrCronSecret, rateLimit(), async (req, res, next) => {
  try {
    const summary = await runOutreachCycle({
      reason: String(req.body?.reason || req.query.reason || "manual"),
      force: isTruthy(req.body?.force ?? req.query.force ?? true),
    });
    res.json({ success: summary.status !== "failed", outreach: summary, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/revenue", requireApiKey, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, revenue: await revenueStatus(), timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/revenue/subscriptions", requireApiKey, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, subscriptions: await subscriptionStatus(), timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/revenue/referrals", requireApiKey, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, referrals: await referralStatus(), timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.all("/api/cron/revenue", requireCronSecret, async (req, res, next) => {
  try {
    const summary = await runRevenueCycle({
      reason: String(req.query.reason || "cron"),
      force: isTruthy(req.query.force),
    });
    res.json({ success: summary.status !== "failed", revenue: summary, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.get("/api/social", async (req, res, next) => {
  try {
    const status = await socialStatus({ verify: req.query.verify === "1" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, social: status, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

router.all("/api/cron/social", requireCronSecret, async (req, res, next) => {
  try {
    const result = await runSocialCycle({ reason: "cron", force: isTruthy(req.query.force) });
    res.json({ success: result.status === "published" || result.status === "partial", ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});
