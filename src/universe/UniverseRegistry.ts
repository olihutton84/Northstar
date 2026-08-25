/**
 * UniverseRegistry — the explicit allowlist.
 *
 * Two jobs:
 *   1. tell the ingestion layer what to search X for
 *   2. tell the resolver and the risk engine what is even eligible to trade
 *
 * A security is tradable by the X strategy only if it is active, Alpaca
 * tradable, and belongs to at least one universe source the strategy version
 * declares. Membership is checked again at risk time, so a security removed
 * from the universe between signal and order is stopped at the gate.
 */
import type { Security, UniverseSource } from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import type { BrokerProvider } from '../providers/broker/BrokerProvider.js';
import { seedToSecurities, UNIVERSE_SEED, type UniverseSeedEntry } from './seed.js';

export interface UniverseStats {
  total: number;
  tradable: number;
  bySource: Record<string, number>;
}

export class UniverseRegistry {
  private byId = new Map<string, Security>();
  private byTicker = new Map<string, Security>();

  constructor(securities: Security[] = []) {
    this.replace(securities);
  }

  static fromSeed(seed: UniverseSeedEntry[] = UNIVERSE_SEED): UniverseRegistry {
    return new UniverseRegistry(seedToSecurities(seed));
  }

  static fromStore(store: Store): UniverseRegistry {
    return new UniverseRegistry(store.securities.active());
  }

  replace(securities: Security[]): void {
    this.byId = new Map(securities.map((s) => [s.securityId, s]));
    this.byTicker = new Map(securities.map((s) => [s.ticker.toUpperCase(), s]));
  }

  add(security: Security): void {
    this.byId.set(security.securityId, security);
    this.byTicker.set(security.ticker.toUpperCase(), security);
  }

  all(): Security[] {
    return [...this.byId.values()];
  }

  active(): Security[] {
    return this.all().filter((s) => s.active);
  }

  byIdOrNull(securityId: string): Security | null {
    return this.byId.get(securityId) ?? null;
  }

  byTickerOrNull(ticker: string): Security | null {
    return this.byTicker.get(ticker.toUpperCase()) ?? null;
  }

  has(securityId: string): boolean {
    return this.byId.has(securityId);
  }

  /** Securities eligible for a strategy version's declared universe sources. */
  eligible(sources: UniverseSource[]): Security[] {
    const wanted = new Set(sources);
    return this.active().filter((s) => s.alpacaTradable && s.universeSources.some((src) => wanted.has(src)));
  }

  isEligible(securityId: string, sources: UniverseSource[]): boolean {
    const s = this.byId.get(securityId);
    if (!s || !s.active || !s.alpacaTradable) return false;
    const wanted = new Set(sources);
    return s.universeSources.some((src) => wanted.has(src));
  }

  /** Search terms for the social provider, scoped to the eligible universe. */
  searchTerms(sources: UniverseSource[]): { tickers: string[]; keywords: string[] } {
    const eligible = this.eligible(sources);
    const tickers = eligible.map((s) => s.ticker);
    const keywords = new Set<string>();
    for (const s of eligible) {
      keywords.add(s.companyName.replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Company|Co\.?|Ltd\.?|plc|Holdings|Group)$/i, ''));
      for (const a of s.aliases) keywords.add(a);
    }
    return { tickers, keywords: [...keywords] };
  }

  stats(): UniverseStats {
    const bySource: Record<string, number> = {};
    for (const s of this.active()) {
      for (const src of s.universeSources) bySource[src] = (bySource[src] ?? 0) + 1;
    }
    return { total: this.all().length, tradable: this.active().filter((s) => s.alpacaTradable).length, bySource };
  }

  persist(store: Store): void {
    for (const s of this.all()) store.securities.upsert(s);
  }

  /**
   * Reconcile the allowlist against what Alpaca will actually trade.
   *
   * A name Northstar likes but Alpaca cannot trade is marked non-tradable
   * rather than deleted: it stays visible in research, it just cannot produce
   * an order.
   */
  async reconcileWithBroker(broker: BrokerProvider): Promise<{ checked: number; disabled: string[] }> {
    const disabled: string[] = [];
    let checked = 0;
    for (const security of this.all()) {
      checked += 1;
      const asset = await broker.getAsset(security.ticker).catch(() => null);
      if (!asset || !asset.tradable) {
        this.add({ ...security, alpacaTradable: false });
        disabled.push(security.ticker);
      } else if (asset.fractionable !== security.alpacaFractionable) {
        this.add({ ...security, alpacaFractionable: asset.fractionable });
      }
    }
    return { checked, disabled };
  }
}
