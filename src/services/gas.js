import { formatUnits } from "viem";
import { config } from "../config.js";
import { getEthUsdPrice } from "./market.js";

export function unlockWeiFor(minUsd, ethUsd) {
  const safeUsd = Math.max(Number(ethUsd) || config.execution.ethUsdFallback, 1);
  return BigInt(Math.floor((minUsd / safeUsd) * 1e18));
}

/**
 * Converts ONCHAIN_UNLOCK_MIN_USD into a wei threshold using the live
 * CoinGecko ETH/USD price (labeled fallback when the fetch fails). On-chain
 * execution offerings stay gated until the agent wallet holds at least this
 * much Base ETH, so the agent never spends out-of-pocket money on gas.
 */
export async function gasUnlockThresholdWei() {
  const minUsd = config.execution.onchainUnlockMinUsd;
  const quote = await getEthUsdPrice();
  const ethUsd = Math.max(Number(quote.priceUsd) || config.execution.ethUsdFallback, 1);
  const thresholdWei = unlockWeiFor(minUsd, ethUsd);
  return {
    minUsd,
    ethUsd,
    ethUsdSource: quote.source,
    thresholdWei,
    thresholdEth: formatUnits(thresholdWei, 18),
  };
}

/**
 * How far the wallet is from the self-funding unlock, in USD terms. Pure so
 * tests and status endpoints can compute progress without touching the RPC.
 */
export function unlockProgress(minUsd, ethUsd, balanceEth) {
  if (balanceEth === null || balanceEth === undefined) return { balanceUsd: null, progress: null };
  const rate = Math.max(Number(ethUsd) || 1, 1);
  const target = Math.max(Number(minUsd) || 0.01, 0.01);
  const balanceUsd = Number(balanceEth) * rate;
  return { balanceUsd, progress: Math.min(1, balanceUsd / target) };
}

export async function gasUnlockStatus({ ethBalance } = {}) {
  const unlock = await gasUnlockThresholdWei();
  const balance = ethBalance ?? null;
  const unlocked = balance !== null && balance >= unlock.thresholdWei;
  const progress = unlockProgress(
    unlock.minUsd,
    unlock.ethUsd,
    balance === null ? null : Number(formatUnits(balance, 18))
  );
  return {
    ...unlock,
    balanceWei: balance === null ? null : balance.toString(),
    balanceEth: balance === null ? null : formatUnits(balance, 18),
    ...progress,
    unlocked,
  };
}
