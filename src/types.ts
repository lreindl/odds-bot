// Shapes shared by every prediction-market source.

export type SourceName = "kalshi" | "polymarket";

/** One tradable outcome with its live quote. Prices are probabilities, 0 to 1. */
export interface Market {
  id: string;
  /** The question this market asks, e.g. "Will Kansas City win the championship?". */
  title: string;
  /** The outcome's short name within its event, e.g. "Kansas City". May be empty. */
  outcome: string;
  /**
   * "yesno": the price is the chance the title's question resolves Yes.
   * "outcome": the price is the chance of this named outcome (e.g. one side of a game).
   */
  kind: "yesno" | "outcome";
  bid?: number;
  ask?: number;
  last?: number;
}

/** An event with live prices for each of its open markets. */
export interface MarketEvent {
  source: SourceName;
  title: string;
  url: string;
  markets: Market[];
}

/** The slim record kept in the local search index. */
export interface IndexedEvent {
  source: SourceName;
  /** The source's own identifier, used to fetch live prices. */
  ticker: string;
  title: string;
  subTitle: string;
  category: string;
  outcomes: string[];
  /** Amount traded across the whole event; a popularity signal for ranking. */
  volume: number;
}

export interface Source {
  name: SourceName;
  /** How the source is named in replies. */
  label: string;
  fetchOpenEvents(): Promise<IndexedEvent[]>;
  fetchEvent(ticker: string): Promise<MarketEvent>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with backoff on rate limits and server errors. */
export async function getJson<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`${res.status} after ${attempt} retries: ${url}`);
    await sleep(500 * 2 ** attempt);
    return getJson<T>(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status}: ${url}`);
  return (await res.json()) as T;
}

export function toNumber(v: string | number | undefined | null): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
