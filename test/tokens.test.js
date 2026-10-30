import test from "node:test";
import assert from "node:assert/strict";
import { resolveToken, isNativeToken } from "../src/services/tokens.js";

test("resolves native ETH aliases", async () => {
  for (const input of ["ETH", "eth", "native", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"]) {
    const token = await resolveToken(input);
    assert.equal(token.native, true);
    assert.equal(token.symbol, "ETH");
    assert.ok(isNativeToken(token));
  }
});

test("resolves registry symbols offline", async () => {
  const usdc = await resolveToken("USDC");
  assert.equal(usdc.address, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(usdc.decimals, 6);

  const virtual = await resolveToken("$virtual");
  assert.equal(virtual.address, "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b");
  assert.equal(virtual.decimals, 18);
});

test("rejects empty and malformed addresses", async () => {
  await assert.rejects(() => resolveToken(""), (error) => error.code === "MISSING_TOKEN");
  await assert.rejects(
    () => resolveToken(`0x${"z".repeat(40)}`),
    (error) => error.code === "INVALID_ADDRESS"
  );
});

test("native is rejected when the operation disallows it", async () => {
  await assert.rejects(
    () => resolveToken("ETH", { allowNative: false }),
    (error) => error.code === "NATIVE_NOT_SUPPORTED"
  );
});
