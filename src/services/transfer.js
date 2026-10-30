import { getAddress, zeroAddress } from "viem";
import { AppError } from "../lib/errors.js";
import { sleep } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { config, USDC } from "../config.js";
import {
  encodeErc20Transfer,
  encodeErc20TransferFrom,
  fromUnits,
  getAgentAddress,
  getAllowance,
  getTokenBalance,
  publicClient,
  sendTransaction,
  toUnits,
} from "../chain/client.js";
import { resolveToken } from "./tokens.js";

const RETRYABLE = new Set(["TX_CONFIRMATION_TIMEOUT", "GAS_ESTIMATION_FAILED", "NETWORK_ERROR", "UPSTREAM_ERROR"]);

async function sendTransfer({ token, owner, target, amount, mode, log }) {
  let lastError;

  for (let attempt = 1; attempt <= Math.min(config.execution.maxAttempts, 2); attempt += 1) {
    try {
      const data =
        mode === "transfer"
          ? encodeErc20Transfer(target, amount)
          : encodeErc20TransferFrom(owner, target, amount);

      const result = await sendTransaction({ to: token.address, data }, { label: `transfer-${token.symbol}` });
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (error.code === "TX_CONFIRMATION_TIMEOUT" && error.details?.txHash) {
        const receipt = await publicClient
          .getTransactionReceipt({ hash: error.details.txHash })
          .catch(() => null);
        if (receipt?.status === "success") {
          return {
            hash: error.details.txHash,
            explorer: error.details.explorer,
            confirmedLate: true,
            attempts: attempt,
          };
        }
        // Broadcast outcome unknown: retrying could send the transfer twice.
        throw error;
      }
      // Only retry failures that happened before a transaction was broadcast.
      if (error.details?.txHash) throw error;
      if (!RETRYABLE.has(error.code) || attempt >= 2) throw error;
      log.warn("transfer attempt failed; retrying", { attempt, code: error.code, message: error.message });
      await sleep(1200 * attempt);
    }
  }

  throw lastError;
}

export async function executeTransfer({ params, buyer, log = logger }) {
  const token = await resolveToken(params.tokenAddress, { allowNative: false });
  const amount = toUnits(params.amount, token.decimals);
  const target = getAddress(params.targetAddress);
  if (target === zeroAddress) {
    throw AppError.badRequest("targetAddress cannot be the zero address.", undefined, "INVALID_RECIPIENT");
  }

  const agent = getAgentAddress();
  const owner = getAddress(buyer);

  let mode;
  if (owner.toLowerCase() === agent.toLowerCase()) {
    mode = "transfer";
  } else {
    const allowance = await getAllowance(token.address, owner, agent);
    if (allowance < amount) {
      throw AppError.paymentRequired(
        `Client must approve the agent wallet to spend ${token.symbol}.`,
        {
          token: token.address,
          owner,
          spender: agent,
          required: String(amount),
          allowance: String(allowance),
          approveHint: `Call ${token.symbol}.approve("${agent}", amount) from the client wallet before creating the job.`,
        },
        "INSUFFICIENT_ALLOWANCE"
      );
    }
    mode = "transferFrom";
  }

  const before = await getTokenBalance(token.address, target);
  const result = await sendTransfer({ token, owner, target, amount, mode, log });
  const after = await getTokenBalance(token.address, target);
  const delivered = after > before ? after - before : 0n;

  if (delivered < amount) {
    throw AppError.upstream(
      "Transfer settled but the recipient received less than requested (fee-on-transfer token).",
      { txHash: result.hash, requested: String(amount), delivered: String(delivered) },
      "TRANSFER_UNDER_DELIVERED"
    );
  }

  return {
    status: "executed",
    token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
    from: mode === "transfer" ? agent : owner,
    target,
    amount: String(amount),
    amountFormatted: fromUnits(amount, token.decimals),
    delivered: String(delivered),
    deliveredFormatted: fromUnits(delivered, token.decimals),
    txHash: result.hash,
    explorer: result.explorer,
    confirmedLate: Boolean(result.confirmedLate),
    attempts: result.attempts,
  };
}

/**
 * Batch USDC payouts. Every recipient balance is read before and after its
 * transfer, so a fee-on-transfer or failed leg is reported instead of being
 * counted as delivered. A mid-batch failure returns the completed legs in the
 * error details for the refund record.
 */
export async function executeBatchUsdcTransfer({ params, buyer, priceUsdc = null, log = logger }) {
  const agent = getAgentAddress();
  const owner = getAddress(buyer);
  const legs = params.transfers.map((entry) => ({
    target: getAddress(entry.targetAddress),
    amount: toUnits(entry.amount, USDC.decimals),
  }));
  const total = legs.reduce((sum, leg) => sum + leg.amount, 0n);
  if (total <= 0n) {
    throw AppError.badRequest("Batch total must be greater than zero.", undefined, "INVALID_AMOUNT");
  }

  let mode = "transfer";
  if (owner.toLowerCase() !== agent.toLowerCase()) {
    const allowance = await getAllowance(USDC.address, owner, agent);
    if (allowance < total) {
      throw AppError.paymentRequired(
        "Client must approve the agent wallet to spend USDC for this batch.",
        {
          token: USDC.address,
          owner,
          spender: agent,
          required: String(total),
          allowance: String(allowance),
          approveHint: `Call USDC.approve("${agent}", ${total}) from the client wallet before creating the job.`,
        },
        "INSUFFICIENT_ALLOWANCE"
      );
    }
    mode = "transferFrom";
  }

  const completed = [];
  for (const leg of legs) {
    const before = await getTokenBalance(USDC.address, leg.target);
    try {
      const result = await sendTransfer({ token: USDC, owner, target: leg.target, amount: leg.amount, mode, log });
      const after = await getTokenBalance(USDC.address, leg.target);
      const delivered = after > before ? after - before : 0n;
      if (delivered < leg.amount) {
        throw AppError.upstream(
          "Batch leg settled but the recipient received less than requested.",
          { target: leg.target, txHash: result.hash, requested: String(leg.amount), delivered: String(delivered) },
          "TRANSFER_UNDER_DELIVERED"
        );
      }
      completed.push({
        target: leg.target,
        amountUnits: String(leg.amount),
        amountUsdc: fromUnits(leg.amount, USDC.decimals),
        deliveredUnits: String(delivered),
        txHash: result.hash,
        explorer: result.explorer,
        confirmedLate: Boolean(result.confirmedLate),
      });
    } catch (error) {
      error.details = { ...(error.details || {}), completed };
      throw error;
    }
  }

  return {
    status: "executed",
    batch: true,
    token: { address: USDC.address, symbol: "USDC", decimals: USDC.decimals },
    from: mode === "transfer" ? agent : owner,
    memo: params.memo || null,
    totalUnits: String(total),
    totalUsdc: fromUnits(total, USDC.decimals),
    transfers: completed,
    transferCount: completed.length,
    serviceFeeUsdc: priceUsdc === null ? null : Number(priceUsdc),
    settledAt: new Date().toISOString(),
  };
}
