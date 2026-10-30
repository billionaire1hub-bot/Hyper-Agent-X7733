const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const parseCandle = (value) => Number(value);

/** Normalizes an array of {t,o,h,l,c,v} candles, dropping malformed rows. */
export function normalizeCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => ({
      t: Number(candle.t),
      o: parseCandle(candle.o),
      h: parseCandle(candle.h),
      l: parseCandle(candle.l),
      c: parseCandle(candle.c),
      v: Number.isFinite(Number(candle.v)) ? Number(candle.v) : 0,
    }))
    .filter(
      (candle) =>
        [candle.t, candle.o, candle.h, candle.l, candle.c].every(Number.isFinite) &&
        candle.o > 0 &&
        candle.c > 0
    )
    .sort((a, b) => a.t - b.t);
}

export function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const series = [current];
  for (let i = period; i < values.length; i += 1) {
    current = values[i] * k + current * (1 - k);
    series.push(current);
  }
  return series;
}

export const ema = (values, period) => {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
};

/** Wilder RSI. Returns the latest value (0-100) or null. */
export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder ATR over the supplied candles. */
export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const { h, l } = candles[i];
    const previousClose = candles[i - 1].c;
    trueRanges.push(Math.max(h - l, Math.abs(h - previousClose), Math.abs(l - previousClose)));
  }
  let current = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    current = (current * (period - 1) + trueRanges[i]) / period;
  }
  return current;
}

export function stdev(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Deterministic technical snapshot. Every value is computed from the live
 * candles passed in; nothing is assumed or filled in.
 */
export function computeIndicators(candles, { candlesPerDay = 6 } = {}) {
  const rows = normalizeCandles(candles);
  if (rows.length < 60) {
    const error = new Error(`Need at least 60 live candles, received ${rows.length}.`);
    error.code = "INSUFFICIENT_CANDLES";
    throw error;
  }

  const closes = rows.map((row) => row.c);
  const highs = rows.map((row) => row.h);
  const lows = rows.map((row) => row.l);
  const volumes = rows.map((row) => row.v);
  const last = rows[rows.length - 1];
  const price = last.c;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(rows, 14);
  const middle = sma(closes, 20);
  const deviation = stdev(closes.slice(-20));
  const volumeRecent = sma(volumes.slice(-10), 10);
  const volumeBase = sma(volumes.slice(-30, -10), 20);
  const volumeTrend = volumeBase > 0 ? volumeRecent / volumeBase : null;

  const lookback = rows.slice(-21, -1);
  const swingHigh = Math.max(...lookback.map((row) => row.h));
  const swingLow = Math.min(...lookback.map((row) => row.l));
  const range = swingHigh - swingLow;

  const daysBack = Math.min(closes.length - 1, Math.max(1, Math.round(candlesPerDay)));
  const change24hPct = ((price - closes[closes.length - 1 - daysBack]) / closes[closes.length - 1 - daysBack]) * 100;

  let score = 50;
  if (price > ema20) score += 4;
  else score -= 4;
  if (ema20 > ema50) score += 8;
  else score -= 8;
  if (rsi14 >= 50 && rsi14 <= 70) score += 8;
  else if (rsi14 > 78) score -= 8;
  else if (rsi14 < 30) score -= 6;
  else if (rsi14 < 42) score -= 2;
  if (change24hPct > 1) score += 6;
  else if (change24hPct < -1) score -= 6;
  if (volumeTrend !== null) score += volumeTrend > 1.2 ? 5 : volumeTrend < 0.8 ? -5 : 0;
  if (range > 0) {
    const position = (price - swingLow) / range;
    if (position > 0.75) score += 5;
    else if (position < 0.25) score -= 5;
  }
  if (price > swingHigh) score += 8;
  if (price < swingLow) score -= 8;
  score = clamp(Math.round(score), 0, 100);

  const trend = ema20 > ema50 && price > ema20 ? "up" : ema20 < ema50 && price < ema20 ? "down" : "range";

  return {
    candles: rows.length,
    lastCandleAt: new Date(last.t * 1000).toISOString(),
    priceUsd: round(price, 10),
    ema20: round(ema20, 10),
    ema50: round(ema50, 10),
    rsi14: round(rsi14, 2),
    atr14: round(atr14, 10),
    atrPct: atr14 ? round((atr14 / price) * 100, 3) : null,
    bollinger: middle
      ? {
          middle: round(middle, 10),
          upper: round(middle + 2 * deviation, 10),
          lower: round(middle - 2 * deviation, 10),
          widthPct: round(((4 * deviation) / middle) * 100, 3),
        }
      : null,
    swingHigh: round(swingHigh, 10),
    swingLow: round(swingLow, 10),
    rangePositionPct: range > 0 ? round(((price - swingLow) / range) * 100, 2) : null,
    change24hPct: round(change24hPct, 3),
    volumeTrend: round(volumeTrend, 3),
    trend,
    momentumScore: score,
  };
}

export function signalFromScore(score) {
  if (score >= 62) {
    return { side: "long", confidence: clamp(Math.round(45 + (score - 50) * 1.8), 45, 95) };
  }
  if (score <= 38) {
    return { side: "short", confidence: clamp(Math.round(45 + (50 - score) * 1.8), 45, 95) };
  }
  return { side: "no_trade", confidence: clamp(Math.round(60 - Math.abs(score - 50) * 2), 5, 40) };
}

/**
 * Builds stop-loss / take-profit / sizing parameters from live volatility.
 * Position size is only absolute when the caller supplies capital.
 */
export function buildTradePlan({
  indicators,
  side,
  capitalUsdc = null,
  riskPercent = 1,
  stopAtrMultiple = 1.6,
  takeProfitAtrMultiples = [2.4, 4],
}) {
  const entry = indicators.priceUsd;
  const atrValue = indicators.atr14;
  if (!Number.isFinite(entry) || !Number.isFinite(atrValue) || atrValue <= 0) {
    const error = new Error("Cannot build a trade plan without live price and ATR.");
    error.code = "INSUFFICIENT_INDICATORS";
    throw error;
  }

  const direction = side === "short" ? -1 : 1;
  const stopLoss = entry - direction * stopAtrMultiple * atrValue;
  const takeProfits = takeProfitAtrMultiples.map(
    (multiple) => round(entry + direction * multiple * atrValue, 10)
  );
  const stopDistance = Math.abs(entry - stopLoss);
  const riskReward = Number.isFinite(stopDistance) && stopDistance > 0
    ? round(Math.abs(takeProfits[0] - entry) / stopDistance, 2)
    : null;

  let sizing = {
    mode: "relative",
    riskPerTradePercent: riskPercent,
    stopDistancePercent: round((stopDistance / entry) * 100, 3),
  };

  if (Number.isFinite(capitalUsdc) && capitalUsdc > 0) {
    const riskUsdc = (capitalUsdc * riskPercent) / 100;
    const positionUsdc = Math.min(capitalUsdc, riskUsdc / (stopDistance / entry));
    sizing = {
      mode: "absolute",
      capitalUsdc,
      riskPerTradePercent: riskPercent,
      riskUsdc: round(riskUsdc, 4),
      positionSizeUsdc: round(positionUsdc, 4),
      baseTokenSize: round(positionUsdc / entry, 8),
      stopDistancePercent: round((stopDistance / entry) * 100, 3),
    };
  }

  return {
    side,
    entry: round(entry, 10),
    stopLoss: round(stopLoss, 10),
    takeProfit1: takeProfits[0],
    takeProfit2: takeProfits[1],
    riskReward,
    atrMultipleStop: stopAtrMultiple,
    atrMultiplesTakeProfit: takeProfitAtrMultiples,
    sizing,
  };
}

export { round };
