// Polymarket public market data (the Gamma API). No authentication needed for these reads.
import { getJson, type IndexedEvent, type Market, type MarketEvent, type Source, toNumber } from "./types.ts";

const BASE = "https://gamma-api.polymarket.com";
const PAGE = 100; // the API's maximum page size
// Plain offset paging stops around 2,000 rows, so the index holds the most traded events of
// all time plus the most traded today, which is where new, fast-moving markets show up.
const TOP_BY_VOLUME = 2000;
const TOP_BY_24H = 1000;
const MAX_OUTCOMES_INDEXED = 40;

interface RawMarket {
  id: string;
  question: string;
  groupItemTitle?: string;
  /** JSON-encoded array of outcome names, e.g. '["Yes", "No"]'. */
  outcomes?: string;
  /** JSON-encoded array of prices in the same order as `outcomes`. */
  outcomePrices?: string;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  active?: boolean;
  closed?: boolean;
}

interface RawEvent {
  slug: string;
  title: string;
  volume?: number;
  tags?: { label?: string }[];
  markets?: RawMarket[];
}

function parseList(json: string | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const isYesNo = (names: string[]) => names.length === 2 && names[0] === "Yes" && names[1] === "No";
const isOpen = (m: RawMarket) => m.active !== false && m.closed !== true;

function toIndexed(e: RawEvent): IndexedEvent {
  const outcomes: string[] = [];
  for (const m of (e.markets ?? []).filter(isOpen)) {
    const names = parseList(m.outcomes);
    if (isYesNo(names)) {
      if (m.groupItemTitle) outcomes.push(m.groupItemTitle);
    } else outcomes.push(...names);
  }
  return {
    source: "polymarket",
    ticker: e.slug,
    title: e.title,
    subTitle: "",
    category: (e.tags ?? [])
      .map((t) => t.label ?? "")
      .filter(Boolean)
      .slice(0, 4)
      .join(", "),
    outcomes: [...new Set(outcomes)].slice(0, MAX_OUTCOMES_INDEXED),
    volume: Math.round(e.volume ?? 0),
  };
}

function toMarkets(m: RawMarket): Market[] {
  const names = parseList(m.outcomes);
  if (isYesNo(names)) {
    return [
      {
        id: m.id,
        title: m.question,
        outcome: m.groupItemTitle ?? "",
        kind: "yesno",
        bid: toNumber(m.bestBid),
        ask: toNumber(m.bestAsk),
        last: toNumber(m.lastTradePrice) ?? toNumber(parseList(m.outcomePrices)[0]),
      },
    ];
  }
  // A market between named sides ("Chiefs" vs "Bills"): each side is its own outcome.
  const prices = parseList(m.outcomePrices);
  return names.map((name, i) => ({
    id: `${m.id}:${i}`,
    title: m.question,
    outcome: name,
    kind: "outcome" as const,
    last: toNumber(prices[i]),
  }));
}

export const polymarket: Source = {
  name: "polymarket",
  label: "Polymarket",

  async fetchOpenEvents(): Promise<IndexedEvent[]> {
    const bySlug = new Map<string, IndexedEvent>();
    for (const [order, total] of [
      ["volume", TOP_BY_VOLUME],
      ["volume24hr", TOP_BY_24H],
    ] as const) {
      for (let offset = 0; offset < total; offset += PAGE) {
        const page = await getJson<RawEvent[]>(
          `${BASE}/events?closed=false&active=true&order=${order}&ascending=false&limit=${PAGE}&offset=${offset}`,
        );
        for (const e of page) if (e.slug && !bySlug.has(e.slug)) bySlug.set(e.slug, toIndexed(e));
        if (page.length < PAGE) break;
      }
    }
    return [...bySlug.values()];
  },

  async fetchEvent(slug: string): Promise<MarketEvent> {
    const found = await getJson<RawEvent[]>(`${BASE}/events?slug=${encodeURIComponent(slug)}`);
    const e = found[0];
    if (!e) throw new Error(`Polymarket event not found: ${slug}`);
    return {
      source: "polymarket",
      title: e.title,
      url: `https://polymarket.com/event/${e.slug}`,
      markets: (e.markets ?? []).filter(isOpen).flatMap(toMarkets),
    };
  },
};
