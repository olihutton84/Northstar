/**
 * TiingoMarketDataProvider — Northstar's price history integration.
 *
 * This is the single price vendor. Fetched bars are written through to the
 * local price_bars cache so that signal replay and forward-return analytics do
 * not re-hit the vendor (and so that a vendor outage degrades to "stale data"
 * rather than "no data", which the risk engine can reason about).
 */
import type { Clock, Logger } from '../../core/index.js';
import type { MarketCalendarStatus, PriceBar, Quote } from '../../domain/types.js';
import type { PriceBarRepo } from '../../persistence/store.js';
import { marketStatus } from './marketCalendar.js';
import type { MarketDataProvider } from './MarketDataProvider.js';
import { MarketDataError } from './MarketDataProvider.js';

export interface TiingoOptions {
  apiKey: string;
  baseUrl: string;
  clock: Clock;
  logger: Logger;
  bars: PriceBarRepo;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** A quote older than this many minutes is flagged stale. */
  staleAfterMinutes?: number;
}

interface TiingoIexRow {
  ticker?: string;
  timestamp?: string;
  last?: number | null;
  tngoLast?: number | null;
  prevClose?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
}

interface TiingoEodRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  adjClose?: number;
}

export class TiingoMarketDataProvider implements MarketDataProvider {
  readonly providerId = 'tiingo';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly bars: PriceBarRepo;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly staleAfterMinutes: number;

  constructor(opts: TiingoOptions) {
    if (!opts.apiKey) throw new Error('TiingoMarketDataProvider requires TIINGO_API_KEY.');
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.clock = opts.clock;
    this.log = opts.logger.child('tiingo');
    this.bars = opts.bars;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.staleAfterMinutes = opts.staleAfterMinutes ?? 30;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    try {
      await this.request<unknown>('/api/test');
      return { healthy: true, detail: 'Tiingo reachable' };
    } catch (e) {
      return { healthy: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async getQuote(ticker: string): Promise<Quote> {
    const map = await this.getQuotes([ticker]);
    const q = map.get(ticker.toUpperCase());
    if (!q) throw new MarketDataError(`No quote for ${ticker}`, 'NOT_FOUND');
    return q;
  }

  async getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (tickers.length === 0) return out;
    const symbols = tickers.map((t) => t.toUpperCase());
    const rows = await this.request<TiingoIexRow[]>(`/iex/?tickers=${symbols.join(',')}`);

    for (const row of rows ?? []) {
      const ticker = (row.ticker ?? '').toUpperCase();
      const price = row.last ?? row.tngoLast ?? row.prevClose;
      if (!ticker || price === null || price === undefined) continue;
      const asOf = row.timestamp ? new Date(row.timestamp).toISOString() : this.clock.nowIso();
      out.set(ticker, this.toQuote(ticker, price, asOf));
    }

    // Anything the vendor did not return falls back to the cached bar, flagged
    // by its real age. A missing quote must never look fresh.
    for (const ticker of symbols) {
      if (out.has(ticker)) continue;
      const cached = this.bars.latest(ticker);
      if (cached) {
        out.set(ticker, this.toQuote(ticker, cached.close, cached.at));
        this.log.warn('quote fell back to cached bar', { ticker, at: cached.at });
      }
    }
    return out;
  }

  private toQuote(ticker: string, price: number, asOf: string): Quote {
    const ageMinutes = Math.max(0, (this.clock.nowMs() - new Date(asOf).getTime()) / 60_000);
    return { ticker, price, asOf, ageMinutes, stale: ageMinutes > this.staleAfterMinutes };
  }

  async getDailyBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]> {
    const symbol = ticker.toUpperCase();
    const from = fromIso.slice(0, 10);
    const to = toIso.slice(0, 10);
    const rows = await this.request<TiingoEodRow[]>(
      `/tiingo/daily/${encodeURIComponent(symbol)}/prices?startDate=${from}&endDate=${to}`,
    );
    const bars: PriceBar[] = (rows ?? []).map((r) => ({
      ticker: symbol,
      at: new Date(r.date).toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume ?? null,
    }));
    this.bars.saveMany(bars);
    return bars;
  }

  async getIntradayBars(ticker: string, fromIso: string, toIso: string, minutes: number): Promise<PriceBar[]> {
    const symbol = ticker.toUpperCase();
    try {
      const rows = await this.request<TiingoEodRow[]>(
        `/iex/${encodeURIComponent(symbol)}/prices?startDate=${fromIso.slice(0, 10)}&endDate=${toIso.slice(0, 10)}` +
          `&resampleFreq=${minutes}min`,
      );
      const bars: PriceBar[] = (rows ?? []).map((r) => ({
        ticker: symbol,
        at: new Date(r.date).toISOString(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? null,
      }));
      this.bars.saveMany(bars);
      return bars;
    } catch (e) {
      // Intraday is plan-gated on Tiingo. Absence of intraday data must not
      // fail a cycle: the 1h analytics horizon simply stays unmeasured.
      this.log.warn('intraday bars unavailable', { ticker: symbol, detail: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  async getMarketStatus(): Promise<MarketCalendarStatus> {
    return marketStatus(this.clock);
  }

  private async request<T>(path: string): Promise<T> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.baseUrl}${path}${sep}token=${encodeURIComponent(this.apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    } catch (e) {
      throw new MarketDataError(`Tiingo request failed: ${e instanceof Error ? e.message : String(e)}`, 'NETWORK');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) throw new MarketDataError('Tiingo auth failed', 'AUTH');
    if (res.status === 404) throw new MarketDataError('Tiingo resource not found', 'NOT_FOUND');
    if (res.status === 429) throw new MarketDataError('Tiingo rate limit exceeded', 'RATE_LIMIT');
    if (res.status >= 500) throw new MarketDataError(`Tiingo unavailable (${res.status})`, 'UNAVAILABLE');
    if (!res.ok) throw new MarketDataError(`Tiingo returned ${res.status}`, 'BAD_RESPONSE');

    try {
      return (await res.json()) as T;
    } catch {
      throw new MarketDataError('Tiingo returned a non-JSON body', 'BAD_RESPONSE');
    }
  }
}
