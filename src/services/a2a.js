import crypto from "node:crypto";
import { isAddress } from "viem";
import { config, walletConfigured } from "../config.js";
import { getAgentAddress } from "../chain/client.js";
import { helpText, parseIntent } from "./ai.js";
import { customCapabilityJSON, customInboundReply } from "./custom.js";
import { getAcpJob } from "./escrow.js";
import { recordInbound } from "./inbox.js";
import { getJobRecord } from "./jobs.js";
import { OFFERINGS, getOffering } from "./offerings.js";
import { handleOutreachReply as defaultOutreachReply } from "./outreach.js";
import { previewOffering } from "./pipeline.js";

const A2A_PROTOCOL_VERSION = "0.3.0";

const jsonText = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);

const publicBase = (baseUrl) =>
  String(baseUrl || config.publicBaseUrl || `http://localhost:${config.port}`).replace(/\/+$/, "");

function skills() {
  return OFFERINGS.map((offering) => ({
    id: offering.id,
    name: offering.name,
    description: offering.description,
    tags: [offering.category, "base", "virtuals-acp"],
    examples: [`${offering.id}: ${offering.name}`],
    inputModes: ["text/plain", "application/json"],
    outputModes: ["application/json"],
    metadata: {
      priceUsdc: offering.priceUsdc,
      currency: "USDC",
      slaSeconds: offering.slaSeconds,
      parameters: offering.params,
      ...(offering.competitor ? { competitive: offering.competitor } : {}),
    },
  }));
}

function acpExtension() {
  return {
    uri: "https://virtuals.io/acp",
    description: "Virtuals ACP escrow on Base. Paid work requires a funded ACP job.",
    required: false,
    params: {
      protocol: "virtuals-acp",
      chainId: config.chain.id,
      escrowContract: config.acp.contract,
      agentId: config.acp.agentId || null,
      paymentToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      currency: "USDC",
      discovery: "provider job intake via jobCounter + getJob",
      // Advertised as extension metadata only: custom work is not a registered
      // skill, so the agent card keeps exactly one skill per real offering.
      customTask: customCapabilityJSON(),
    },
  };
}

export function agentCard(baseUrl) {
  const base = publicBase(baseUrl);
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: config.name,
    description: config.description,
    url: `${base}/a2a`,
    preferredTransport: "JSONRPC",
    version: config.version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [acpExtension()],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: skills(),
    securitySchemes: {},
    security: [],
    provider: { organization: config.name, url: base },
    documentationUrl: `${base}/api`,
  };
}

export function agentCardV1(baseUrl) {
  const base = publicBase(baseUrl);
  return {
    protocolVersion: "1.0",
    name: config.name,
    description: config.description,
    version: config.version,
    supportedInterfaces: [
      { url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [acpExtension()],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: skills(),
    securitySchemes: {},
    security: [],
    provider: { organization: config.name, url: base },
    documentationUrl: `${base}/api`,
  };
}

function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(0, 4000);
}

const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

const taskStatus = (state, extra = {}) => ({
  state,
  timestamp: new Date().toISOString(),
  ...extra,
});

function taskFromRecord(taskId, record) {
  const state =
    record.status === "completed"
      ? "completed"
      : record.status === "processing"
        ? "working"
        : record.status === "refunded"
          ? "canceled"
          : "failed";
  return {
    kind: "task",
    id: taskId,
    contextId: `acp-${record.jobId}`,
    status: taskStatus(state, {
      message: record.error
        ? {
            kind: "message",
            role: "agent",
            messageId: crypto.randomUUID(),
            parts: [{ kind: "text", text: record.error.message || record.error.code || "Job failed." }],
          }
        : undefined,
    }),
    artifacts: record.result
      ? [
          {
            artifactId: crypto.randomUUID(),
            name: "deliverable",
            parts: [{ kind: "text", text: jsonText(record.result) }],
          },
        ]
      : [],
    metadata: {
      jobId: record.jobId,
      offeringId: record.offeringId,
      deliverableHash: record.deliverableHash || null,
      settlement: record.settlement || null,
      refund: record.refund || null,
      a2aState: state === "completed" ? "TASK_STATE_COMPLETED" : state === "working" ? "TASK_STATE_WORKING" : "TASK_STATE_FAILED",
    },
  };
}

const ONCHAIN_STATE = {
  0: "submitted",
  1: "working",
  2: "working",
  3: "completed",
  4: "rejected",
  5: "canceled",
};

function taskFromOnchain(taskId, job) {
  const state = ONCHAIN_STATE[job.status] || "unknown";
  return {
    kind: "task",
    id: taskId,
    contextId: `acp-${job.id}`,
    status: taskStatus(state),
    artifacts: [],
    metadata: {
      jobId: job.id,
      jobStatus: job.statusName,
      client: job.client,
      provider: job.provider,
      budgetUnits: String(job.budget),
      expiredAt: job.expiredAt,
      description: job.description,
      a2aState: state === "completed" ? "TASK_STATE_COMPLETED" : state === "working" ? "TASK_STATE_WORKING" : "TASK_STATE_SUBMITTED",
    },
  };
}

async function handleMessage(id, params, deps) {
  const message = params?.message;
  const text = messageText(message);
  if (!text) return rpcError(id, -32602, "params.message.parts must contain text.");
  if (!config.a2a.enabled) return rpcError(id, -32601, "A2A is disabled.");

  const startedAt = Date.now();
  const taskId = typeof message?.taskId === "string" && message.taskId ? message.taskId : crypto.randomUUID();
  const contextId =
    typeof message?.contextId === "string" && message.contextId ? message.contextId : crypto.randomUUID();

  const outreach = await deps.handleReply({ text, contextId, message }).catch((error) => {
    return { handled: false, error: error.message };
  });

  if (outreach?.handled) {
    await recordInbound({
      text,
      contextId,
      action: outreach.action || "outreach",
      source: "outreach_reply",
      latencyMs: Date.now() - startedAt,
      silent: Boolean(outreach.silent),
      replyAction: outreach.action || null,
    });
    if (outreach.silent) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          kind: "task",
          id: taskId,
          contextId,
          status: taskStatus("canceled", { message: undefined }),
          artifacts: [],
          metadata: {
            reason: outreach.action || "session_closed",
            a2aState: "TASK_STATE_CANCELED",
          },
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        role: "agent",
        messageId: crypto.randomUUID(),
        contextId,
        taskId,
        parts: [{ kind: "text", text: outreach.text }],
        metadata: {
          engine: "session",
          outreach: {
            action: outreach.action,
            sessionId: outreach.session?.id || null,
            priceUsdc: outreach.session?.priceUsdc ?? null,
            expiresAt: outreach.session?.expiresAt
              ? new Date(outreach.session.expiresAt).toISOString()
              : null,
          },
        },
      },
    };
  }

  let parsed;
  try {
    parsed = await deps.parseIntent(text);
  } catch (error) {
    await recordInbound({
      text,
      contextId,
      action: "error",
      latencyMs: Date.now() - startedAt,
    });
    return rpcError(id, -32603, "Unable to route the message.", { message: error.message });
  }

  const intent = parsed?.intent || { action: "help", offeringId: null, params: {}, reply: null };
  if (!intent.offeringId || intent.action === "help") {
    const custom = customInboundReply({ text, wallet: walletConfigured ? getAgentAddress() : null });
    await recordInbound({
      text,
      contextId,
      action: custom ? "custom" : "help",
      engine: parsed?.engine || "fallback",
      latencyMs: Date.now() - startedAt,
    });
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        role: "agent",
        messageId: crypto.randomUUID(),
        contextId,
        taskId,
        parts: [{ kind: "text", text: custom?.text || intent.reply || helpText() }],
        metadata: { engine: parsed?.engine || "fallback", ...(custom ? { offeringId: "custom_task" } : {}) },
      },
    };
  }

  const offering = getOffering(intent.offeringId);
  const rawBuyer = message?.metadata?.buyer;
  const buyer = typeof rawBuyer === "string" && isAddress(rawBuyer) ? rawBuyer : undefined;

  let preview;
  try {
    preview = await deps.previewOffering({ offering, params: intent.params, buyer });
  } catch (error) {
    await recordInbound({
      text,
      contextId,
      action: "preview_failed",
      offeringId: offering.id,
      engine: parsed?.engine || "unknown",
      latencyMs: Date.now() - startedAt,
    });
    return {
      jsonrpc: "2.0",
      id,
      result: {
        kind: "task",
        id: taskId,
        contextId,
        status: taskStatus("failed", {
          message: {
            kind: "message",
            role: "agent",
            messageId: crypto.randomUUID(),
            parts: [{ kind: "text", text: error.message }],
          },
        }),
        artifacts: [],
        metadata: {
          offeringId: offering.id,
          error: { code: error.code || "PREVIEW_FAILED", message: error.message },
          a2aState: "TASK_STATE_FAILED",
        },
      },
    };
  }

  await recordInbound({
    text,
    contextId,
    action: "preview",
    offeringId: offering.id,
    engine: parsed?.engine || "unknown",
    latencyMs: Date.now() - startedAt,
  });

  return {
    jsonrpc: "2.0",
    id,
    result: {
      kind: "task",
      id: taskId,
      contextId,
      status: taskStatus("completed"),
      artifacts: [
        {
          artifactId: crypto.randomUUID(),
          name: "preview",
          parts: [{ kind: "text", text: jsonText(preview) }],
        },
      ],
      metadata: {
        offeringId: offering.id,
        engine: parsed?.engine || "unknown",
        previewOnly: true,
        a2aState: "TASK_STATE_COMPLETED",
        execution: {
          requiresEscrow: true,
          howTo:
            'Create and fund an ACP job with this agent as provider, and put the order in the job description as {"offeringId":"' +
            offering.id +
            '","params":{...}}. The intake poller then executes it and submits the deliverable hash on Base.',
          escrowContract: config.acp.contract,
          chainId: config.chain.id,
          priceUsdc: offering.priceUsdc,
        },
      },
    },
  };
}

async function handleGetTask(id, params) {
  const raw = String(params?.id ?? params?.taskId ?? "").trim();
  if (!raw) return rpcError(id, -32602, "params.id is required.");

  const jobId = raw.replace(/^acp[-:]/i, "");
  if (!/^\d+$/.test(jobId)) return rpcError(id, -32001, `Task ${raw} not found.`);

  const record = await getJobRecord(jobId).catch(() => null);
  if (record) return { jsonrpc: "2.0", id, result: taskFromRecord(raw, record) };

  const job = await getAcpJob(jobId).catch(() => null);
  if (!job) return rpcError(id, -32001, `Task ${raw} not found.`);
  return { jsonrpc: "2.0", id, result: taskFromOnchain(raw, job) };
}

export async function handleA2A(body, deps = {}) {
  const resolved = {
    parseIntent,
    previewOffering,
    handleReply: defaultOutreachReply,
    ...deps,
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return rpcError(null, -32600, "Invalid Request");
  }
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body.id, -32600, "Invalid Request: jsonrpc must be 2.0 and method must be a string.");
  }

  try {
    switch (body.method) {
      case "message/send":
      case "SendMessage":
        return await handleMessage(body.id, body.params, resolved);
      case "tasks/get":
      case "GetTask":
        return await handleGetTask(body.id, body.params);
      case "tasks/cancel":
      case "CancelTask":
        return rpcError(
          body.id,
          -32004,
          "Cancel is not supported here. ACP escrow jobs are refunded on-chain through reject or claimRefund."
        );
      case "message/stream":
      case "SendStreamingMessage":
      case "tasks/resubscribe":
      case "SubscribeToTask":
      case "ListTasks":
        return rpcError(body.id, -32601, "Streaming and task listing are not enabled on this agent.");
      default:
        return rpcError(body.id, -32601, `Method ${body.method} is not supported.`);
    }
  } catch (error) {
    return rpcError(body.id, -32603, "Internal error.", { message: error.message });
  }
}
