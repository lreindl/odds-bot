// Kalshi public market data. No authentication needed for these reads.
import { getJson, type IndexedEvent, type MarketEvent, type Source, toNumber } from "./types.ts";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

interface RawMarket {
  ticker: string;
  title: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
}

interface RawEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  category?: string;
  markets?: RawMarket[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const kalshi: Source = {
  name: "kalshi",
  label: "Kalshi",

  /** Every open event, slimmed down for the search index. Paced to stay under the rate limit. */
  async fetchOpenEvents(): Promise<IndexedEvent[]> {
    const out: IndexedEvent[] = [];
    let cursor = "";
    do {
      const q = `/events?limit=200&status=open&with_nested_markets=true${cursor ? `&cursor=${cursor}` : ""}`;
      const page = await getJson<{ events: RawEvent[]; cursor?: string }>(BASE + q);
      for (const e of page.events) {
        out.push({
          source: "kalshi",
          ticker: e.event_ticker,
          title: e.title,
          subTitle: e.sub_title ?? "",
          category: e.category ?? "",
          outcomes: (e.markets ?? []).map((m) => m.yes_sub_title ?? "").filter(Boolean),
          volume: Math.round((e.markets ?? []).reduce((sum, m) => sum + (Number(m.volume_fp) || 0), 0)),
        });
      }
      cursor = page.cursor ?? "";
      await sleep(150);
    } while (cursor);
    return out;
  },

  async fetchEvent(ticker: string): Promise<MarketEvent> {
    const data = await getJson<{ event: RawEvent; markets?: RawMarket[] }>(
      `${BASE}/events/${encodeURIComponent(ticker)}?with_nested_markets=true`,
    );
    const raw = data.event.markets ?? data.markets ?? [];
    return {
      source: "kalshi",
      title: data.event.title,
      url: `https://kalshi.com/markets/${data.event.series_ticker.toLowerCase()}`,
      markets: raw
        .filter((m) => !m.status || m.status === "active")
        .map((m) => ({
          id: m.ticker,
          title: m.title || data.event.title,
          outcome: m.yes_sub_title ?? "",
          kind: "yesno" as const,
          bid: toNumber(m.yes_bid_dollars),
          ask: toNumber(m.yes_ask_dollars),
          last: toNumber(m.last_price_dollars),
        })),
    };
  },
};
