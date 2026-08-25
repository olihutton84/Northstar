/**
 * Price confirmation.
 *
 * Market data is CONTEXT, not the thesis. This module answers one narrow
 * question: does recent price/volume behaviour corroborate or contradict what X
 * is saying?
 *
 * The output is a directional -100..+100 number that the composite may add to
 * the X-derived base, capped at `maxPriceContribution` points and gated behind
 * a minimum base magnitude. Those two limits are what stop the strategy quietly
 * becoming a momentum strategy — see config/signalConfig.ts.
 *
 * All prices come from Northstar's existing market-data provider (Tiingo).
 * There is no second price integration here.
 */
import { clamp, mean, stdev } from '../../core/index.js';
import type { PriceBar, PriceConfirmationDetail } from '../../domain/types.js';
import type { SignalEngineConfig } from '../../config/signalConfig.js';

export interface PriceConfirmationInput {
  ticker: string;
  bars: PriceBar[];
  benchmarkBars: PriceBar[];
  /** Latest observed price and its age. */
  lastPrice: number;
  asOf: string;
  dataAgeMinutes: number;
  stale: boolean;
  config: SignalEngineConfig;
}

export interface PriceConfirmationResult {
  /** -100..+100, positive meaning "the tape agrees with a bullish read". */
  score: number;
  detail: PriceConfirmationDetail;
  explanation: string;
  /** Feature-by-feature breakdown for the UI. */
  features: { name: string; value: number; contribution: number; note: string }[];
}

/** Daily returns from a bar series. */
function returns(bars: PriceBar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!.close;
    const curr = bars[i]!.close;
    if (prev > 0) out.push((curr - prev) / prev);
  }
  return out;
}

export function scorePriceConfirmation(input: PriceConfirmationInput): PriceConfirmationResult {
  const { bars, benchmarkBars, config } = input;
  const lookback = Math.max(2, config.priceLookbackDays);
  const window = bars.slice(-Math.max(lookback + 1, 10));
  const features: PriceConfirmationResult['features'] = [];

  const detail: PriceConfirmationDetail = {
    asOf: input.asOf,
    lastPrice: input.lastPrice,
    momentumPct: 0,
    abnormalMoveZ: 0,
    abnormalVolumeRatio: null,
    marketRelativePct: 0,
    realisedVolatility: 0,
    stale: input.stale,
    dataAgeMinutes: Number(input.dataAgeMinutes.toFixed(2)),
  };

  // Not enough history to say anything. Returning 0 (rather than guessing)
  // means the composite simply gets no price adjustment.
  if (window.length < 3) {
    return {
      score: 0,
      detail,
      explanation: 'Insufficient price history for confirmation — no adjustment applied',
      features,
    };
  }

  const rets = returns(window);
  const dailyVol = stdev(rets);
  detail.realisedVolatility = Number((dailyVol * Math.sqrt(252) * 100).toFixed(2));

  /* --- momentum: return over the lookback ------------------------------- */
  const start = window[Math.max(0, window.length - 1 - lookback)]!.close;
  const momentumPct = start > 0 ? ((input.lastPrice - start) / start) * 100 : 0;
  detail.momentumPct = Number(momentumPct.toFixed(3));
  // Normalised against the stock's own volatility over the same window, so a
  // 3% move in a quiet utility is not read like 3% in a small-cap biotech.
  const momentumNorm = clamp(momentumPct / Math.max(1, dailyVol * 100 * Math.sqrt(lookback) * 1.5), -1, 1);
  features.push({
    name: 'momentum',
    value: detail.momentumPct,
    contribution: momentumNorm * config.priceFeatureWeights.momentum,
    note: `${momentumPct >= 0 ? '+' : ''}${momentumPct.toFixed(2)}% over ${lookback} sessions`,
  });

  /* --- abnormal move: today's move in units of daily volatility ---------- */
  const prevClose = window[window.length - 2]!.close;
  const todayReturn = prevClose > 0 ? (input.lastPrice - prevClose) / prevClose : 0;
  const z = dailyVol > 0 ? todayReturn / dailyVol : 0;
  detail.abnormalMoveZ = Number(z.toFixed(3));
  const zNorm = clamp(z / 3, -1, 1);
  features.push({
    name: 'abnormalMove',
    value: detail.abnormalMoveZ,
    contribution: zNorm * config.priceFeatureWeights.abnormalMove,
    note: `Latest move is ${Math.abs(z).toFixed(1)} daily sigma ${z >= 0 ? 'up' : 'down'}`,
  });

  /* --- abnormal volume: magnitude only, direction borrowed from the move -- */
  const volumes = window.map((b) => b.volume).filter((v): v is number => v !== null && v > 0);
  if (volumes.length >= 3) {
    const latest = volumes[volumes.length - 1]!;
    const priorAvg = mean(volumes.slice(0, -1));
    const ratio = priorAvg > 0 ? latest / priorAvg : 1;
    detail.abnormalVolumeRatio = Number(ratio.toFixed(3));
    // Volume is unsigned: heavy volume confirms whatever the move is doing.
    const magnitude = clamp((ratio - 1) / 2, 0, 1);
    const signed = magnitude * Math.sign(todayReturn || momentumPct || 0);
    features.push({
      name: 'abnormalVolume',
      value: detail.abnormalVolumeRatio,
      contribution: signed * config.priceFeatureWeights.abnormalVolume,
      note: `Volume ${ratio.toFixed(2)}x its recent average`,
    });
  } else {
    features.push({
      name: 'abnormalVolume',
      value: 0,
      contribution: 0,
      note: 'Volume unavailable for this ticker',
    });
  }

  /* --- market-relative: excess return over the benchmark ----------------- */
  if (benchmarkBars.length >= 3) {
    const benchWindow = benchmarkBars.slice(-Math.max(lookback + 1, 10));
    const benchStart = benchWindow[Math.max(0, benchWindow.length - 1 - lookback)]!.close;
    const benchEnd = benchWindow[benchWindow.length - 1]!.close;
    const benchPct = benchStart > 0 ? ((benchEnd - benchStart) / benchStart) * 100 : 0;
    const relative = momentumPct - benchPct;
    detail.marketRelativePct = Number(relative.toFixed(3));
    const relNorm = clamp(relative / Math.max(1, dailyVol * 100 * Math.sqrt(lookback) * 1.5), -1, 1);
    features.push({
      name: 'marketRelative',
      value: detail.marketRelativePct,
      contribution: relNorm * config.priceFeatureWeights.marketRelative,
      note: `${relative >= 0 ? '+' : ''}${relative.toFixed(2)}% vs the benchmark over the same window`,
    });
  } else {
    features.push({
      name: 'marketRelative',
      value: 0,
      contribution: 0,
      note: 'Benchmark history unavailable',
    });
  }

  const weightTotal = Object.values(config.priceFeatureWeights).reduce((a, b) => a + b, 0) || 1;
  const raw = features.reduce((a, f) => a + f.contribution, 0) / weightTotal;
  let score = clamp(raw * 100, -100, 100);

  // Stale data cannot confirm anything. Halve rather than zero, so a mildly
  // late quote still carries some information; the risk engine separately
  // blocks trading on genuinely stale marks.
  if (input.stale) score *= 0.5;

  const explanation = input.stale
    ? `Price confirmation halved: market data is ${input.dataAgeMinutes.toFixed(0)} minutes old. ` +
      features.map((f) => f.note).join('; ')
    : features.map((f) => f.note).join('; ');

  return { score: Math.round(score), detail, explanation, features };
}
