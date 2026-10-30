import test from "node:test";
import assert from "node:assert/strict";
import { acquireLock, releaseLock, store, storeHelpers, withLock } from "../src/lib/store.js";

test("memory store round-trips JSON values with TTL", async () => {
  const key = storeHelpers.cache("test-roundtrip");
  await store.set(key, { ok: true }, { ttlSeconds: 30 });
  assert.deepEqual(await store.get(key), { ok: true });
  await store.set(key, { expired: true }, { ttlSeconds: 0.01 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await store.get(key), null);
});

test("locks are exclusive and released", async () => {
  const key = storeHelpers.cache("test-lock");
  const token = await acquireLock(key, 5);
  assert.ok(token);
  assert.equal(await acquireLock(key, 5), null);
  await releaseLock(key, token);
  const again = await acquireLock(key, 5);
  assert.ok(again);
  await releaseLock(key, again);
});

test("withLock serializes work and reports lost acquisition", async () => {
  const key = storeHelpers.cache("test-withlock");
  const first = await withLock(key, 5, async () => {
    const second = await withLock(key, 5, async () => "inner", { waitMs: 300 });
    return second.acquired ? "unexpected" : "blocked";
  });
  assert.equal(first.acquired, true);
  assert.equal(first.result, "blocked");
});

test("sets add and remove members", async () => {
  const key = storeHelpers.pendingJobs();
  await store.sadd(key, "1");
  await store.sadd(key, "2");
  await store.sadd(key, "2");
  assert.deepEqual((await store.smembers(key)).sort(), ["1", "2"]);
  await store.srem(key, "1");
  assert.deepEqual(await store.smembers(key), ["2"]);
  await store.srem(key, "2");
});
