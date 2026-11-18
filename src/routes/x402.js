import express from "express";
import { isAddress, isHex } from "viem";
import { rateLimit } from "../lib/rateLimit.js";
import {
  buildTokenVerdict,
  buildWalletDossier,
  buildX402Manifest,
  consumePayment,
  logX402,
  paymentTermsJSON,
  payToAddress,
  takeFreeSummaryBudget,
  verifyUsdcPayment,
  X402_RESOURCES,
} from "../services/x402-worker.js";

export const x402Router = express.Router();

x402Router.get("/.well-known/x402", rateLimit(), (req, res) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  const manifest = buildX402Manifest(origin, payToAddress());
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(manifest);
});

const resourceFor = (resourceId) => X402_RESOURCES.find((r) => r.id === resourceId);

async function servePaidResource(req, res, resourceId, buildReport) {
  const resource = resourceFor(resourceId);
  const payTo = payToAddress();

  if (resourceId === "token-verdict" && String(req.get("x402-free") || "").trim() === "1") {
    const allowed = await takeFreeSummaryBudget();
    if (!allowed) {
      return res.status(429).json({
        success: false,
        error: {
          code: "FREE_TIER_EXHAUSTED",
          message: "Daily free summary allowance for this worker is exhausted.",
        },
      });
    }
    const report = await buildReport();
    return res.json({
      success: true,
      free: true,
      summary: {
        token: report.verdict.token,
        name: report.verdict.name,
        symbol: report.verdict.symbol,
        decimals: report.verdict.decimals,
        totalSupply: report.verdict.totalSupply,
        isContract: report.verdict.isContract,
        chain: report.verdict.chain,
        fetchedAt: report.fetchedAt,
        by: report.by,
      },
    });
  }

  const payer = String(req.query.payer || "").trim();
  const tx = String(req.query.tx || "").trim();
  if (!isAddress(payer) || !isHex(tx) || tx.length !== 66) {
    return res.status(402).json({ success: false, ...paymentTermsJSON(resourceId) });
  }

  let payment;
  try {
    payment = await verifyUsdcPayment({ payer, txHash: tx, priceUnits: resource.priceUnits, payTo });
  } catch (error) {
    logX402(req, "x402 payment verification failed", { resourceId, message: error.message });
    return res.status(402).json({
      success: false,
      error: {
        code: "PAYMENT_NOT_FOUND",
        message: "The payment transaction was not found on Base yet; it may still be pending.",
      },
      ...paymentTermsJSON(resourceId),
    });
  }

  if (!payment.ok) {
    logX402(req, "x402 payment rejected", { resourceId, reason: payment.reason });
    return res.status(402).json({ success: false, error: { code: "PAYMENT_INVALID", message: payment.reason }, ...paymentTermsJSON(resourceId) });
  }

  const report = await buildReport();
  try {
    await consumePayment(tx);
  } catch (error) {
    logX402(req, "x402 payment consume failed", { resourceId, message: error.message });
  }
  logX402(req, "x402 payment accepted", { resourceId, payer, paid: payment.paid });
  return res.json({ success: true, paid: payment.paid, ...report });
}

x402Router.get("/api/x402/token-verdict", rateLimit(), async (req, res, next) => {
  const token = String(req.query.token || "").trim();
  if (!isAddress(token)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_TOKEN", message: "token must be a valid Base address (0x…)." },
    });
  }
  try {
    return await servePaidResource(req, res, "token-verdict", () => buildTokenVerdict(token));
  } catch (error) {
    return next(error);
  }
});

x402Router.get("/api/x402/wallet-dossier", rateLimit(), async (req, res, next) => {
  const wallet = String(req.query.address || "").trim();
  if (!isAddress(wallet)) {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_ADDRESS", message: "address must be a valid Base address (0x…)." },
    });
  }
  try {
    return await servePaidResource(req, res, "wallet-dossier", () => buildWalletDossier(wallet));
  } catch (error) {
    return next(error);
  }
});
