import test from "node:test";
import assert from "node:assert/strict";

const { agentCard, agentCardV1, handleA2A } = await import("../src/services/a2a.js");

test("agent cards advertise every offering and the ACP escrow", () => {
  const card = agentCard("https://agent.example");
  assert.equal(card.protocolVersion, "0.3.0");
  assert.equal(card.name, "Hyper Agent X7733");
  assert.equal(card.url, "https://agent.example/a2a");
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.skills.length, 50);
  assert.equal(card.capabilities.extensions[0].params.chainId, 8453);
  assert.equal(card.capabilities.extensions[0].params.protocol, "virtuals-acp");
});

test("the current card exposes a JSON-RPC interface", () => {
  const card = agentCardV1("https://agent.example/");
  assert.equal(card.protocolVersion, "1.0");
  assert.equal(card.supportedInterfaces[0].url, "https://agent.example/a2a");
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
  assert.equal(card.skills.length, 50);
});

test("invalid JSON-RPC requests are rejected", async () => {
  const response = await handleA2A({ jsonrpc: "1.0", method: "message/send", id: 1 });
  assert.equal(response.error.code, -32600);
  const notObject = await handleA2A("nope");
  assert.equal(notObject.error.code, -32600);
});

test("unknown and streaming methods return protocol errors", async () => {
  const unknown = await handleA2A({ jsonrpc: "2.0", id: 2, method: "no/such" });
  assert.equal(unknown.error.code, -32601);
  const stream = await handleA2A({ jsonrpc: "2.0", id: 3, method: "message/stream" });
  assert.equal(stream.error.code, -32601);
});

test("a routed message without an offering returns an agent message", async () => {
  const response = await handleA2A(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "message/send",
      params: { message: { parts: [{ kind: "text", text: "hello" }] } },
    },
    {
      parseIntent: async () => ({
        intent: { action: "help", offeringId: null, params: {}, reply: "Ask me for a swap or a market brief." },
        engine: "rules",
      }),
    }
  );
  assert.equal(response.result.kind, "message");
  assert.equal(response.result.parts[0].text.includes("swap"), true);
});

test("an offering message returns a preview task and never executes", async () => {
  const response = await handleA2A(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "SendMessage",
      params: { message: { contextId: "ctx-1", parts: [{ text: "trending tokens" }] } },
    },
    {
      parseIntent: async () => ({
        intent: { action: "trending_tokens", offeringId: "trending_tokens", params: {}, reply: null },
        engine: "groq",
      }),
      previewOffering: async () => ({ offering_id: "trending_tokens", action: "preview_intelligence" }),
    }
  );
  assert.equal(response.result.kind, "task");
  assert.equal(response.result.contextId, "ctx-1");
  assert.equal(response.result.metadata.previewOnly, true);
  assert.equal(response.result.artifacts[0].name, "preview");
  assert.equal(response.result.metadata.execution.requiresEscrow, true);
});

test("messages without text and unknown tasks are rejected", async () => {
  const empty = await handleA2A({
    jsonrpc: "2.0",
    id: 6,
    method: "message/send",
    params: { message: { parts: [] } },
  });
  assert.equal(empty.error.code, -32602);

  const missing = await handleA2A({
    jsonrpc: "2.0",
    id: 7,
    method: "tasks/get",
    params: { id: "not-a-job" },
  });
  assert.equal(missing.error.code, -32001);
});
