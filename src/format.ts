// Turn live prices into a reply that fits in one post.
import type { Market, MarketEvent } from "./types.ts";

const MAX_LEN = 280;
const URL_LEN = 23; // X counts every link as 23 characters

/** Implied probability, 0 to 1, or null when the market has no usable price. */
export function impliedProbability(m: Market): number | null {
  const { bid, ask, last } = m;
  const twoSided = bid !== undefined && ask !== undefined && bid > 0 && ask < 1;
  // A tight two-sided quote is the best read; otherwise fall back to the last trade.
  if (twoSided && ask - bid <= 0.1) return (bid + ask) / 2;
  if (last !== undefined && last > 0) return last;
  if (twoSided) return (bid + ask) / 2;
  return null;
}

export function pct(p: number): string {
  if (p < 0.01) return "<1%";
  if (p > 0.99) return ">99%";
  return `${Math.round(p * 100)}%`;
}

/** One source's contribution to a reply. */
export interface Part {
  label: string;
  title: string;
  lines: string[];
  url: string;
}

/** One specific market: a yes/no question, or one outcome of a bigger event. */
export function partSingle(event: MarketEvent, market: Market, label: string): Part {
  const p = impliedProbability(market);
  const title = market.title || event.title;
  // In multi-outcome events the title is often the shared event question, so name the outcome.
  const shared = event.markets.length > 1 && !title.toLowerCase().includes(market.outcome.toLowerCase());
  const name = market.outcome && (market.kind === "outcome" || shared) ? `${market.outcome} ` : "";
  return { label, title, lines: [p === null ? "no live price" : `${name}${pct(p)}`], url: event.url };
}

/** A whole multi-outcome event: the leading outcomes by price. */
export function partTop(event: MarketEvent, label: string, count = 4): Part {
  const priced = event.markets
    .map((m) => ({ name: m.outcome || m.title, p: impliedProbability(m) }))
    .filter((x): x is { name: string; p: number } => x.p !== null)
    .sort((a, b) => b.p - a.p)
    .slice(0, count);
  const lines = priced.length ? priced.map((x) => `${x.name} ${pct(x.p)}`) : ["no live prices"];
  return { label, title: event.title, lines, url: event.url };
}

export function formatNotFound(): string {
  return "I couldn't find a prediction market that clearly matches that. Try naming the event more specifically.";
}

/** Length as X counts it: every link is 23 characters whatever its real length. */
export function postLength(text: string): number {
  return text.replace(/https?:\/\/\S+/g, "x".repeat(URL_LEN)).length;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(max - 1, 1)).trimEnd()}…`);

/**
 * One subject line, then one line per source: "Kalshi: 87% <link>". The question is stated
 * once (the shortest wording on offer) rather than once per source; the links carry the rest.
 */
function render(parts: Part[], maxItems: number, maxTitle: number, maxItem: number): string {
  // A specific question ("Will Bitcoin be above $150k by Dec 31?") says more than an event name
  // ("When will Bitcoin hit $150k?"), so prefer the wording of a single-price part.
  const specific = parts.filter((p) => p.lines.length === 1);
  const title = (specific.length ? specific : parts)
    .map((p) => p.title)
    .reduce((a, b) => (b.length < a.length ? b : a));
  const rows = parts.map(
    (p) => `${p.label}: ${p.lines.slice(0, maxItems).map((l) => clip(l, maxItem)).join(", ")} ${p.url}`,
  );
  return [clip(title, maxTitle), ...rows].join("\n");
}

/** Compose the reply, trimming outcomes first, then the title, then long outcome names. */
export function formatReply(parts: Part[]): string {
  const most = Math.max(...parts.map((p) => p.lines.length));
  for (let items = Math.min(most, 4); items >= 1; items--) {
    const text = render(parts, items, 100, 60);
    if (postLength(text) <= MAX_LEN) return text;
  }
  for (const [title, item] of [[60, 60], [60, 30], [40, 20], [20, 12]]) {
    const text = render(parts, 1, title, item);
    if (postLength(text) <= MAX_LEN) return text;
  }
  return render(parts.slice(0, 1), 1, 20, 12);
}
