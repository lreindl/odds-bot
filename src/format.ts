// Turn live Kalshi prices into a reply that fits in one post.
import type { KalshiEvent, KalshiMarket } from "./kalshi.ts";

const MAX_LEN = 280;
const URL_LEN = 23; // X counts every link as 23 characters

/** Implied probability of Yes, 0 to 1, or null when the market has no usable price. */
export function impliedProbability(m: KalshiMarket): number | null {
  const bid = num(m.yes_bid_dollars);
  const ask = num(m.yes_ask_dollars);
  const last = num(m.last_price_dollars);
  // A tight two-sided quote is the best read; otherwise fall back to the last trade.
  if (bid !== null && ask !== null && bid > 0 && ask < 1 && ask - bid <= 0.1) return (bid + ask) / 2;
  if (last !== null && last > 0) return last;
  if (bid !== null && ask !== null && bid > 0 && ask < 1) return (bid + ask) / 2;
  return null;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function pct(p: number): string {
  if (p < 0.01) return "<1%";
  if (p > 0.99) return ">99%";
  return `${Math.round(p * 100)}%`;
}

export function marketUrl(event: KalshiEvent): string {
  return `https://kalshi.com/markets/${event.series_ticker.toLowerCase()}`;
}

function liveMarkets(event: KalshiEvent): KalshiMarket[] {
  return (event.markets ?? []).filter((m) => !m.status || m.status === "active");
}

/** Reply for one specific market (a yes/no question, or one outcome of a bigger event). */
export function formatSingle(event: KalshiEvent, market: KalshiMarket): string {
  const p = impliedProbability(market);
  const title = market.title || event.title;
  // In multi-outcome events the market title is often the shared event question, so name the outcome.
  const sub = market.yes_sub_title ?? "";
  const shared = (event.markets?.length ?? 0) > 1 && !title.toLowerCase().includes(sub.toLowerCase());
  const label = sub && shared ? `${sub}: ` : "";
  const body =
    p === null ? `${title}\n${label}No live price on Kalshi right now.` : `${title}\n${label}${pct(p)} yes on Kalshi`;
  return fit(body, marketUrl(event));
}

/** Reply for a whole multi-outcome event: the leading outcomes by price. */
export function formatTop(event: KalshiEvent, count = 4): string {
  const priced = liveMarkets(event)
    .map((m) => ({ name: m.yes_sub_title || m.title, p: impliedProbability(m) }))
    .filter((x): x is { name: string; p: number } => x.p !== null)
    .sort((a, b) => b.p - a.p);
  if (priced.length === 0) return fit(`${event.title}\nNo live prices on Kalshi right now.`, marketUrl(event));
  const url = marketUrl(event);
  // Drop trailing outcomes until the post fits.
  for (let n = Math.min(count, priced.length); n >= 1; n--) {
    const lines = priced.slice(0, n).map((x) => `${x.name}: ${pct(x.p)}`);
    const body = `${event.title}\n${lines.join("\n")}\n(Kalshi)`;
    if (body.length + 1 + URL_LEN <= MAX_LEN) return `${body}\n${url}`;
  }
  return fit(`${event.title}\n${priced[0].name}: ${pct(priced[0].p)} (Kalshi)`, url);
}

export function formatNotFound(): string {
  return "I couldn't find a Kalshi market that clearly matches that. Try naming the event more specifically.";
}

function fit(body: string, url: string): string {
  const room = MAX_LEN - URL_LEN - 1;
  const text = body.length > room ? `${body.slice(0, room - 1).trimEnd()}…` : body;
  return `${text}\n${url}`;
}
