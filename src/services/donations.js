import { USDC, config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import {
  encodeErc20Transfer,
  fromUnits,
  getAgentAddress,
  getTokenBalance,
  publicClient,
  sendTransaction,
} from "../chain/client.js";
import { donationFeeUnits, donationShares } from "./offerings.js";

export async function executeDonation({ offering, params, log = logger }) {
  const shares = donationShares(offering, params);
  const forwardTotal = shares.reduce((sum, share) => sum + share.amount, 0n);
  const serviceFee = donationFeeUnits(offering);
  const agent = getAgentAddress();
  const balance = await getTokenBalance(USDC.address, agent);
  if (balance < forwardTotal) {
    throw AppError.unavailable(
      "Agent wallet lacks the USDC required to forward this donation.",
      {
        requiredUnits: String(forwardTotal),
        requiredUsdc: fromUnits(forwardTotal, USDC.decimals),
        balanceUnits: String(balance),
        balanceUsdc: fromUnits(balance, USDC.decimals),
        serviceFeeUnits: String(serviceFee),
        serviceFeeUsdc: fromUnits(serviceFee, USDC.decimals),
        marginBps: config.revenue.donationMarginBps,
        fundingMode: "agent_fronted",
      },
      "INSUFFICIENT_AGENT_LIQUIDITY"
    );
  }
  const completed = [];

  for (const share of shares) {
    const before = await getTokenBalance(USDC.address, share.address);
    try {
      const { hash, explorer } = await sendTransaction(
        { to: USDC.address, data: encodeErc20Transfer(share.address, share.amount) },
        { label: `donation-${share.address.slice(0, 8)}` }
      );

      const after = await getTokenBalance(USDC.address, share.address);
      const delivered = after > before ? after - before : 0n;
      if (delivered < share.amount) {
        throw AppError.upstream(
          "Donation settled but the project received less than the allocated share.",
          { project: share.address, txHash: hash, expected: String(share.amount), delivered: String(delivered) },
          "DONATION_UNDER_DELIVERED"
        );
      }

      completed.push({
        project: share.address,
        amountUnits: String(share.amount),
        amountUsdc: fromUnits(share.amount, USDC.decimals),
        txHash: hash,
        explorer,
      });
      log.info("donation forwarded", { project: share.address, amount: String(share.amount), txHash: hash });
    } catch (error) {
      if (error.code === "TX_CONFIRMATION_TIMEOUT" && error.details?.txHash) {
        const receipt = await publicClient
          .getTransactionReceipt({ hash: error.details.txHash })
          .catch(() => null);
        if (receipt?.status === "success") {
          completed.push({
            project: share.address,
            amountUnits: String(share.amount),
            amountUsdc: fromUnits(share.amount, USDC.decimals),
            txHash: error.details.txHash,
            explorer: error.details.explorer,
            confirmedLate: true,
          });
          continue;
        }
      }
      error.details = { ...(error.details || {}), completed };
      throw error;
    }
  }

  return {
    status: "executed",
    donation: true,
    offeringId: offering.id,
    memo: params.memo || null,
    marginBps: config.revenue.donationMarginBps,
    serviceFeeUnits: String(serviceFee),
    serviceFeeUsdc: fromUnits(serviceFee, USDC.decimals),
    totalUnits: String(forwardTotal),
    totalUsdc: fromUnits(forwardTotal, USDC.decimals),
    projects: completed,
    transfers: completed.length,
  };
}
