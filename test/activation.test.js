import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "";
process.env.VERCEL_PROJECT_PRODUCTION_URL = "agent.example.com";
process.env.CRON_SECRET = "test-cron-secret";

const { config } = await import("../src/config.js");
const { store, storeHelpers } = await import("../src/lib/store.js");
const {
  activationStatus,
  loadPublicUrl,
  maybeWakeOutreach,
  observePublicUrl,
  outreachCycleDue,
  publicUrlFromRequest,
  wakeOutreachCycle,
} = await import("../src/services/activation.js");

const request = (host, proto = "https") => ({
  protocol: proto,
  get(name) {
    if (name === "host") return host;
    if (name === "x-forwarded-proto") return proto;
    return "";
  },
});

test("only the configured or Vercel deployment host can activate outreach", () => {
  assert.equal(publicUrlFromRequest(request("agent.example.com")), "https://agent.example.com");
  assert.equal(publicUrlFromRequest(request("AGENT.EXAMPLE.COM")), "https://agent.example.com");
  assert.equal(publicUrlFromRequest(request("attacker.example.net")), null);
  assert.equal(publicUrlFromRequest(request("agent.example.com", "http")), null);
  assert.equal(publicUrlFromRequest(request("localhost")), null);
});

test("a newly observed chat URL activates once and persists", async () => {
  await store.del(storeHelpers.publicUrl());
  await store.del(storeHelpers.activationState());

  const first = await observePublicUrl(request("agent.example.com"));
  assert.equal(first.changed, true);
  assert.equal(first.url, "https://agent.example.com");
  assert.deepEqual(await loadPublicUrl(), { url: "https://agent.example.com", source: "observed" });

  const second = await observePublicUrl(request("agent.example.com"));
  assert.equal(second.changed, false);
  const status = await activationStatus();
  assert.equal(status.activations, 1);
  assert.equal(status.urlConfigured, true);
});

test("an explicitly configured URL also activates on its first request", async () => {
  config.publicBaseUrl = "https://configured.example.com";
  try {
    const first = await observePublicUrl(request("agent.example.com"));
    assert.equal(first.changed, true);
    assert.equal(first.source, "env");
    const second = await observePublicUrl(request("agent.example.com"));
    assert.equal(second.changed, false);
    assert.deepEqual(await loadPublicUrl(), { url: "https://configured.example.com", source: "env" });
  } finally {
    config.publicBaseUrl = "";
  }
});

test("wake-up authenticates in headers and keeps secrets out of the URL", async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, status: 200, text: async () => '{"success":true}' };
  };
  try {
    const result = await wakeOutreachCycle("https://agent.example.com/", { reason: "chat_url_saved" });
    assert.equal(result.ok, true);
    assert.equal(
      captured.url,
      "https://agent.example.com/api/cron/outreach?reason=chat_url_saved&force=1"
    );
    assert.equal(captured.options.headers["x-cron-secret"], "test-cron-secret");
    assert.equal(captured.url.includes("test-cron-secret"), false);

    const throttled = await wakeOutreachCycle("https://agent.example.com", {
      reason: "traffic",
      force: false,
    });
    assert.equal(throttled.ok, true);
    assert.equal(captured.url, "https://agent.example.com/api/cron/outreach?reason=traffic");
    assert.equal(captured.url.includes("force"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cycle is only due after the interval and while the daily budget has room", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const ago = (seconds) => new Date(now - seconds * 1000).toISOString();

  assert.equal(outreachCycleDue(null, now), true);
  assert.equal(outreachCycleDue({ lastAttemptAt: null }, now), true);
  assert.equal(
    outreachCycleDue({ lastAttemptAt: ago(config.outreach.intervalSeconds - 30) }, now),
    false
  );
  assert.equal(
    outreachCycleDue({ lastAttemptAt: ago(config.outreach.intervalSeconds + 30) }, now),
    true
  );
  assert.equal(
    outreachCycleDue(
      {
        lastAttemptAt: ago(config.outreach.intervalSeconds + 30),
        day: new Date(now).toISOString().slice(0, 10),
        dayCount: config.outreach.dailyCap,
      },
      now
    ),
    false
  );
  assert.equal(config.outreach.enabled, true);
});

test("inbound traffic re-arms the cycle once per interval, without force", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => '{"success":true}' };
  };
  try {
    await store.del(storeHelpers.publicUrl());
    await store.del(storeHelpers.outreachState());
    await store.del(storeHelpers.outreachKick());
    await observePublicUrl(request("agent.example.com"));

    const first = await maybeWakeOutreach({ reason: "traffic" });
    assert.equal(first.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].includes("force"), false);

    const repeated = await maybeWakeOutreach({ reason: "traffic" });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.skipped, "wake_already_armed");
    assert.equal(calls.length, 1);

    const kick = await store.get(storeHelpers.outreachKick());
    assert.equal(kick.reason, "traffic");
    const status = await activationStatus();
    assert.equal(status.lastWakeReason, "traffic");
    assert.ok(status.nextWakeEligibleAt);
  } finally {
    globalThis.fetch = originalFetch;
    await store.del(storeHelpers.outreachKick());
    await store.del(storeHelpers.outreachState());
    await store.del(storeHelpers.publicUrl());
  }
});

test("an unreachable wake re-arms immediately, an answered one does not", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await store.del(storeHelpers.publicUrl());
    await store.del(storeHelpers.outreachState());
    await store.del(storeHelpers.outreachKick());
    await observePublicUrl(request("agent.example.com"));

    globalThis.fetch = async () => {
      throw new Error("socket hang up");
    };
    const failed = await maybeWakeOutreach({ reason: "traffic" });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "socket hang up");
    assert.equal(await store.get(storeHelpers.outreachKick()), null);

    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "nope" });
    const rejected = await maybeWakeOutreach({ reason: "traffic" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 401);
    assert.ok(await store.get(storeHelpers.outreachKick()));

    const blocked = await maybeWakeOutreach({ reason: "traffic" });
    assert.equal(blocked.skipped, "wake_already_armed");
  } finally {
    globalThis.fetch = originalFetch;
    await store.del(storeHelpers.outreachKick());
    await store.del(storeHelpers.outreachState());
    await store.del(storeHelpers.publicUrl());
  }
});
