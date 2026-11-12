// Kalshi public market data. No authentication needed for these reads.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  category?: string;
  markets?: KalshiMarket[];
}

/** The slim record kept in the local search index. */
export interface IndexedEvent {
  ticker: string;
  series: string;
  title: string;
  subTitle: string;
  category: string;
  outcomes: string[];
  /** Contracts traded across the whole event; a popularity signal for ranking. */
  volume: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(BASE + path, { headers: { accept: "application/json" } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`Kalshi ${res.status} after ${attempt} retries: ${path}`);
    await sleep(500 * 2 ** attempt);
    return getJson<T>(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`Kalshi ${res.status}: ${path}`);
  return (await res.json()) as T;
}

/** One event with live prices for every market in it. */
export async function fetchEvent(eventTicker: string): Promise<KalshiEvent> {
  const data = await getJson<{ event: KalshiEvent; markets?: KalshiMarket[] }>(
    `/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`,
  );
  return { ...data.event, markets: data.event.markets ?? data.markets ?? [] };
}

/** Every open event, slimmed down for the search index. Paced to stay under the rate limit. */
export async function fetchOpenEvents(onPage?: (count: number) => void): Promise<IndexedEvent[]> {
  const out: IndexedEvent[] = [];
  let cursor = "";
  do {
    const q = `/events?limit=200&status=open&with_nested_markets=true${cursor ? `&cursor=${cursor}` : ""}`;
    const page = await getJson<{ events: KalshiEvent[]; cursor?: string }>(q);
    for (const e of page.events) {
      out.push({
        ticker: e.event_ticker,
        series: e.series_ticker,
        title: e.title,
        subTitle: e.sub_title ?? "",
        category: e.category ?? "",
        outcomes: (e.markets ?? []).map((m) => m.yes_sub_title ?? "").filter(Boolean),
        volume: Math.round((e.markets ?? []).reduce((sum, m) => sum + (Number(m.volume_fp) || 0), 0)),
      });
    }
    cursor = page.cursor ?? "";
    onPage?.(out.length);
    await sleep(150);
  } while (cursor);
  return out;
}

interface IndexFile {
  fetchedAt: number;
  events: IndexedEvent[];
}

/** Load the event index from disk, refreshing it from Kalshi when it is older than maxAgeMs. */
export async function loadIndex(
  file: string,
  maxAgeMs: number,
  log: (msg: string) => void = () => {},
): Promise<IndexedEvent[]> {
  let cached: IndexFile | undefined;
  try {
    cached = JSON.parse(await readFile(file, "utf8")) as IndexFile;
  } catch {
    // no cache yet
  }
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return cached.events;
  try {
    log("Refreshing Kalshi event index…");
    const events = await fetchOpenEvents();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), events } satisfies IndexFile));
    log(`Indexed ${events.length} open events.`);
    return events;
  } catch (err) {
    if (cached) {
      log(`Index refresh failed, using stale cache: ${(err as Error).message}`);
      return cached.events;
    }
    throw err;
  }
}
