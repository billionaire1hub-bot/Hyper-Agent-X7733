import test from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../src/config.js");
const {
  bossClientKey,
  capabilitySummary,
  containsPasscode,
  handleBossMessage,
  isAdminRequest,
  isDiscoveryRequest,
  wantsCatalog,
} = await import("../src/services/chat.js");

const cannedAsk = async () => ({
  engine: "groq",
  text: "That is an admin-only command. Enter the secret passcode first, then repeat the request.",
});

test("the passcode is detected anywhere in the message", () => {
  assert.equal(containsPasscode("03210388"), true);
  assert.equal(containsPasscode("boss 03210388 start outbound agent discovery"), true);
  assert.equal(containsPasscode("0321038"), false);
  assert.equal(containsPasscode("hello there"), false);
  assert.equal(containsPasscode(""), false);
});

test("admin requests are detected without swallowing offering traffic", () => {
  assert.equal(isAdminRequest("start outbound agent discovery"), true);
  assert.equal(isAdminRequest("system admin controls please"), true);
  assert.equal(isAdminRequest("swap 10 USDC to WETH"), false);
  assert.equal(isAdminRequest("what's trending in crypto"), false);
  assert.equal(isAdminRequest("is VIRTUAL a honeypot"), false);
});

test("discovery requests are recognised", () => {
  assert.equal(isDiscoveryRequest("start outbound agent discovery"), true);
  assert.equal(isDiscoveryRequest("run the outreach cycle now"), true);
  assert.equal(isDiscoveryRequest("what is the weather today"), false);
});

test("catalog requests are recognised", () => {
  assert.equal(wantsCatalog("what can you do?"), true);
  assert.equal(wantsCatalog("list offerings"), true);
  assert.equal(wantsCatalog("what can you do for a small fund?"), false);
  assert.equal(wantsCatalog("hello"), false);
});

test("the capability summary stays compact", () => {
  const summary = capabilitySummary();
  assert.equal(summary.total, 50);
  assert.ok(summary.categories.length > 0);
  assert.ok(summary.examples.length > 0);
  assert.equal(summary.catalog.includes("/api/offerings"), true);
});

test("an admin request without the passcode asks for the passcode", async () => {
  const result = await handleBossMessage({
    message: "start outbound agent discovery",
    clientKey: "client-admin",
    deps: { askText: cannedAsk },
  });
  assert.equal(result.handled, true);
  assert.equal(result.status, "admin_required");
  assert.equal(result.boss, false);
  assert.match(result.reply, /passcode/i);
});

test("the passcode instruction is enforced even when the model ignores it", async () => {
  const result = await handleBossMessage({
    message: "status",
    clientKey: "client-admin-directive",
    deps: { askText: async () => ({ engine: "groq", text: "I am online and operating normally." }) },
  });
  assert.equal(result.status, "admin_required");
  assert.match(result.reply, /passcode/i);
});

test("ordinary messages fall through to the offering flow", async () => {
  const result = await handleBossMessage({
    message: "swap 10 USDC to WETH",
    clientKey: "client-plain",
    deps: { askText: cannedAsk },
  });
  assert.equal(result.handled, false);
});

test("a bare status command without the passcode asks for the passcode", async () => {
  const result = await handleBossMessage({
    message: "status",
    clientKey: "client-status",
    deps: { askText: cannedAsk },
  });
  assert.equal(result.handled, true);
  assert.equal(result.status, "admin_required");
});

test("a verified session returns the live status", async () => {
  const clientKey = "client-status-session";
  await handleBossMessage({ message: "03210388", clientKey, deps: { askText: cannedAsk } });
  const result = await handleBossMessage({
    message: "status",
    clientKey,
    deps: {
      askText: cannedAsk,
      outreachStatus: async () => ({
        enabled: true,
        aiConfigured: true,
        publicBaseUrlConfigured: true,
        dailyCap: 5,
        state: { pitchedToday: 2, totalPitches: 7, lastAttemptAt: "2026-11-04T00:00:00.000Z" },
      }),
    },
  });
  assert.equal(result.status, "boss_status");
  assert.equal(result.boss, true);
  assert.match(result.reply, /pitches today 2\/5/);
});

test("the passcode acknowledges the boss and asks what to initiate", async () => {
  const result = await handleBossMessage({
    message: "03210388",
    clientKey: "client-boss",
    deps: { askText: cannedAsk },
  });
  assert.equal(result.handled, true);
  assert.equal(result.status, "boss_verified");
  assert.equal(result.boss, true);
  assert.match(result.reply, /boss/i);
  assert.match(result.reply, /outbound agent discovery/i);
  assert.ok(!result.reply.includes("03210388"));
});

test("boss discovery runs directly and reports the cycle summary", async () => {
  let called = null;
  const result = await handleBossMessage({
    message: "03210388 start outbound agent discovery",
    clientKey: "client-discovery",
    deps: {
      askText: cannedAsk,
      runOutreachCycle: async (options) => {
        called = options;
        return {
          status: "ok",
          candidates: 7,
          contactable: 3,
          eligible: 2,
          pitched: 1,
          skipped: 1,
          outcomes: [],
        };
      },
    },
  });
  assert.equal(result.status, "boss_discovery");
  assert.equal(result.boss, true);
  assert.deepEqual(called, { reason: "boss", force: true });
  assert.match(result.reply, /1 pitched/);
  assert.equal(result.extra.discovery.candidates, 7);
});

test("a verified session keeps admin commands unlocked", async () => {
  const clientKey = "client-session";
  const first = await handleBossMessage({
    message: "03210388",
    clientKey,
    deps: { askText: cannedAsk },
  });
  assert.equal(first.status, "boss_verified");
  const second = await handleBossMessage({
    message: "start outbound agent discovery",
    clientKey,
    deps: {
      askText: cannedAsk,
      runOutreachCycle: async () => ({
        status: "no_targets",
        candidates: 3,
        contactable: 0,
        eligible: 0,
        pitched: 0,
        skipped: 0,
        reason: "NO_MATCHES",
      }),
    },
  });
  assert.equal(second.status, "boss_discovery");
  assert.equal(second.boss, true);
});

test("a verified session does not swallow ordinary offering requests", async () => {
  const clientKey = "client-session-offering";
  const first = await handleBossMessage({
    message: "03210388",
    clientKey,
    deps: { askText: cannedAsk },
  });
  assert.equal(first.status, "boss_verified");
  const second = await handleBossMessage({
    message: "swap 10 USDC to WETH",
    clientKey,
    deps: { askText: cannedAsk },
  });
  assert.equal(second.handled, false);
});

test("the client key is stable per operator and never leaks the api key", () => {
  const req = { ip: "1.2.3.4", get: (name) => (name === "x-api-key" ? "super-secret" : "") };
  const key = bossClientKey(req, { clientId: "boss-console" });
  assert.equal(key.length, 32);
  assert.ok(!key.includes("super-secret"));
  assert.equal(key, bossClientKey(req, { clientId: "boss-console" }));
  assert.notEqual(key, bossClientKey(req, { clientId: "other" }));
});

test("the chat endpoint acknowledges a boss passcode over HTTP", async () => {
  const app = (await import("../src/app.js")).default;
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({ message: "03210388" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, "boss_verified");
    assert.equal(payload.boss.verified, true);
    assert.match(payload.reply, /boss/i);
  } finally {
    server.close();
  }
});

test("the chat endpoint still rejects an empty message", async () => {
  const app = (await import("../src/app.js")).default;
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({ message: "   " }),
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.error.code, "MISSING_MESSAGE");
  } finally {
    server.close();
  }
});
