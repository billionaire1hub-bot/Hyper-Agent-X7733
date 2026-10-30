import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { VIRTUALS } from "../config.js";
import { VIRTUALS_ROUTER_ABI } from "../abi/index.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  ensureAllowance,
  getAgentAddress,
  publicClient,
  sendTransaction,
  shortRpcError,
} from "../chain/client.js";

export const VIRTUALS_ROUTER = getAddress(VIRTUALS.router);

let assetTokenCache = null;

export async function getVirtualsAssetToken() {
  if (assetTokenCache && assetTokenCache.expiresAt > Date.now()) return assetTokenCache.value;
  try {
    const asset = await publicClient.readContract({
      address: VIRTUALS_ROUTER,
      abi: VIRTUALS_ROUTER_ABI,
      functionName: "assetToken",
    });
    assetTokenCache = { value: getAddress(asset), expiresAt: Date.now() + 60 * 60 * 1000 };
    return assetTokenCache.value;
  } catch (error) {
    throw AppError.upstream(
      `Virtuals router unavailable: ${shortRpcError(error)}`,
      { router: VIRTUALS_ROUTER },
      "VIRTUALS_ROUTER_UNAVAILABLE"
    );
  }
}

async function getAmountsOut(token, assetToken, amountIn) {
  return publicClient.readContract({
    address: VIRTUALS_ROUTER,
    abi: VIRTUALS_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [token, assetToken, amountIn],
  });
}

export async function quoteBondingBuy({ token, amountIn }) {
  const assetToken = await getVirtualsAssetToken();
  try {
    const amountOut = await getAmountsOut(token, assetToken, amountIn);
    if (amountOut <= 0n) return null;
    return { venue: "virtuals-bonding", side: "buy", assetToken, amountOut, token, router: VIRTUALS_ROUTER };
  } catch (error) {
    logger.debug("virtuals buy quote unavailable", { token, message: shortRpcError(error) });
    return null;
  }
}

export async function quoteBondingSell({ token, amountIn }) {
  const assetToken = await getVirtualsAssetToken();
  try {
    const amountOut = await getAmountsOut(token, zeroAddress, amountIn);
    if (amountOut <= 0n) return null;
    return { venue: "virtuals-bonding", side: "sell", assetToken, amountOut, token, router: VIRTUALS_ROUTER };
  } catch (error) {
    logger.debug("virtuals sell quote unavailable", { token, message: shortRpcError(error) });
    return null;
  }
}

export async function isBondingToken(token) {
  const quote = await quoteBondingBuy({ token, amountIn: 10n ** 15n });
  return Boolean(quote);
}

export async function executeBondingBuy({ tokenAddress, amountIn, recipient, assetToken }) {
  const asset = assetToken || (await getVirtualsAssetToken());
  await ensureAllowance(asset, VIRTUALS_ROUTER, amountIn, { label: "approve-virtuals-asset" });

  const data = encodeFunctionData({
    abi: VIRTUALS_ROUTER_ABI,
    functionName: "buy",
    args: [amountIn, tokenAddress, recipient],
  });

  const { hash, explorer } = await sendTransaction(
    { to: VIRTUALS_ROUTER, data },
    { label: `virtuals-buy-${tokenAddress.slice(0, 8)}` }
  );
  return { txHash: hash, explorer, router: VIRTUALS_ROUTER, side: "buy" };
}

export async function executeBondingSell({ tokenAddress, amountIn, recipient }) {
  await ensureAllowance(tokenAddress, VIRTUALS_ROUTER, amountIn, { label: "approve-virtuals-token" });

  const data = encodeFunctionData({
    abi: VIRTUALS_ROUTER_ABI,
    functionName: "sell",
    args: [amountIn, tokenAddress, recipient],
  });

  const { hash, explorer } = await sendTransaction(
    { to: VIRTUALS_ROUTER, data },
    { label: `virtuals-sell-${tokenAddress.slice(0, 8)}` }
  );
  return { txHash: hash, explorer, router: VIRTUALS_ROUTER, side: "sell" };
}

export const virtualsAgent = getAgentAddress;
