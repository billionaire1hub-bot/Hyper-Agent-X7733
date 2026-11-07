import assert from "node:assert/strict";
import test from "node:test";

process.env.AGENT_PRIVATE_KEY = `0x${"11".repeat(32)}`;
process.env.PUBLIC_BASE_URL = "https://agent.example.com";

const { candidateLiveChannel } = await import("../src/services/outreach.js");

test("a verified A2A endpoint is always a live channel", () => {
  assert.equal(candidateLiveChannel({ endpoint: "https://peer.example/a2a" }, { xUsable: false }), "a2a");
  assert.equal(candidateLiveChannel({ endpoint: "https://peer.example/a2a", twitter: "peer" }, { xUsable: false }), "a2a");
});

test("an X-only target is live only while X is usable, dead otherwise", () => {
  assert.equal(candidateLiveChannel({ twitter: "peer" }, { xUsable: true }), "x");
  assert.equal(candidateLiveChannel({ twitter: "peer" }, { xUsable: false }), null, "credit-exhausted/frozen X is not a channel");
  assert.equal(candidateLiveChannel({ twitter: "peer" }), null, "defaults to unusable");
});

test("a candidate with neither endpoint nor handle has no channel", () => {
  assert.equal(candidateLiveChannel({ name: "anon" }, { xUsable: true }), null);
  assert.equal(candidateLiveChannel(null, { xUsable: true }), null);
});
