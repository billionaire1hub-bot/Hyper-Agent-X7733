import express from "express";
import { config } from "../config.js";
import { rateLimit } from "../lib/rateLimit.js";
import { agentCard, agentCardV1, handleA2A } from "../services/a2a.js";

export const a2aRouter = express.Router();

const baseFrom = (req) => config.publicBaseUrl || `${req.protocol}://${req.get("host")}`;
const CARD_CACHE = "public, max-age=300";

a2aRouter.get("/.well-known/agent.json", (req, res) => {
  res.setHeader("Cache-Control", CARD_CACHE);
  res.json(agentCard(baseFrom(req)));
});

a2aRouter.get("/.well-known/agent-card.json", (req, res) => {
  res.setHeader("Cache-Control", CARD_CACHE);
  res.json(agentCardV1(baseFrom(req)));
});

a2aRouter.get("/a2a", (req, res) => {
  res.json({
    success: true,
    protocol: "a2a",
    versions: ["0.3.0", "1.0"],
    transport: "JSONRPC over HTTP",
    endpoint: `${baseFrom(req)}/a2a`,
    cards: {
      legacy: `${baseFrom(req)}/.well-known/agent.json`,
      current: `${baseFrom(req)}/.well-known/agent-card.json`,
    },
    methods: ["message/send", "tasks/get", "SendMessage", "GetTask"],
    note: "Messages are routed against the published offerings. Paid execution requires a funded ACP escrow job; the intake poller executes it automatically.",
    timestamp: new Date().toISOString(),
  });
});

a2aRouter.post("/a2a", rateLimit(), async (req, res, next) => {
  if (!config.a2a.enabled) {
    return res.status(404).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32601, message: "A2A is disabled on this deployment." },
    });
  }
  try {
    const response = await handleA2A(req.body);
    return res.json(response);
  } catch (error) {
    return next(error);
  }
});
