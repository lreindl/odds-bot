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
  let line: string;
  if (p === null) line = "No live price right now";
  else if (market.kind === "outcome") line = `${market.outcome}: ${pct(p)}`;
  else {
    // In multi-outcome events the title is often the shared event question, so name the outcome.
    const shared = event.markets.length > 1 && !title.toLowerCase().includes(market.outcome.toLowerCase());
    line = `${market.outcome && shared ? `${market.outcome}: ` : ""}${pct(p)} yes`;
  }
  return { label, title, lines: [line], url: event.url };
}

/** A whole multi-outcome event: the leading outcomes by price. */
export function partTop(event: MarketEvent, label: string, count = 4): Part {
  const priced = event.markets
    .map((m) => ({ name: m.outcome || m.title, p: impliedProbability(m) }))
    .filter((x): x is { name: string; p: number } => x.p !== null)
    .sort((a, b) => b.p - a.p)
    .slice(0, count);
  const lines = priced.length ? priced.map((x) => `${x.name}: ${pct(x.p)}`) : ["No live prices right now"];
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

function render(parts: Part[], maxLines: number, maxTitle: number): string {
  if (parts.length === 1) {
    const p = parts[0];
    const lines = p.lines.slice(0, maxLines);
    const body =
      lines.length === 1 ? `${lines[0]} on ${p.label}` : `${lines.join("\n")}\n(${p.label})`;
    return `${clip(p.title, maxTitle)}\n${body}\n${p.url}`;
  }
  return parts
    .map((p) => `${p.label}: ${clip(p.title, maxTitle)}\n${p.lines.slice(0, maxLines).join("\n")}\n${p.url}`)
    .join("\n\n");
}

/** Compose the reply, trimming outcome lines first and titles second until it fits. */
export function formatReply(parts: Part[]): string {
  const most = Math.max(...parts.map((p) => p.lines.length));
  for (let lines = Math.min(most, parts.length === 1 ? 4 : 2); lines >= 1; lines--) {
    const text = render(parts, lines, 400);
    if (postLength(text) <= MAX_LEN) return text;
  }
  for (let title = 120; title >= 10; title -= 5) {
    const text = render(parts, 1, title);
    if (postLength(text) <= MAX_LEN) return text;
  }
  // Even clipped titles did not fit (very long outcome names): keep only the first source.
  const p = parts[0];
  return `${clip(p.title, 60)}\n${clip(p.lines[0], 150)}\n${p.url}`;
}
