// The whole pipeline for one question: shortlist → Jev pick → confidence gate → live prices → reply.
import { formatNotFound, formatSingle, formatTop } from "./format.ts";
import type { KalshiEvent } from "./kalshi.ts";
import type { Matcher } from "./match.ts";
import { cleanQuestion, type EventIndex, tokenize } from "./retrieve.ts";

export interface Thresholds {
  /** Minimum Jev confidence in the chosen option. */
  confidence: number;
  /** Minimum probability that some offered option actually fits. */
  fits: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  confidence: Number(process.env.MIN_CONFIDENCE ?? 0.4),
  fits: Number(process.env.MIN_FITS ?? 0.5),
};

const MAX_OUTCOME_OPTIONS = 60;
// Quoting one outcome when the person asked about the whole event is a wrong answer, so the bar
// for "they meant this specific outcome" is higher than the bar for matching the event.
const MIN_OUTCOME_FITS = Number(process.env.MIN_OUTCOME_FITS ?? 0.7);

export interface Answer {
  matched: boolean;
  reply: string;
  /** Why the bot answered the way it did, for logs and tuning thresholds. */
  trace: Record<string, unknown>;
}

export interface Deps {
  index: EventIndex;
  matcher: Matcher;
  fetchEvent: (ticker: string) => Promise<KalshiEvent>;
  thresholds?: Thresholds;
}

export async function answerQuestion(rawText: string, deps: Deps): Promise<Answer> {
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const question = cleanQuestion(rawText);
  const candidates = deps.index.search(question);
  const trace: Record<string, unknown> = {
    question,
    candidates: candidates.map((c) => `${c.event.ticker} (${c.score.toFixed(2)}) ${c.event.title}`),
  };
  if (candidates.length === 0) return { matched: false, reply: formatNotFound(), trace };

  const pick = await deps.matcher.pickEvent(
    question,
    candidates.map((c) => c.event),
  );
  trace.eventPick = pick;
  const chosen = candidates[pick.index]?.event;
  // With a single candidate there is nothing to choose between, so only the "fits" gate applies.
  const sure = candidates.length === 1 || pick.confidence >= t.confidence;
  if (!chosen || !sure || pick.fits < t.fits) return { matched: false, reply: formatNotFound(), trace };

  const event = await deps.fetchEvent(chosen.ticker);
  trace.event = event.event_ticker;
  const markets = (event.markets ?? []).filter((m) => !m.status || m.status === "active");
  if (markets.length === 0) return { matched: false, reply: formatNotFound(), trace };
  if (markets.length === 1) return { matched: true, reply: formatSingle(event, markets[0]), trace };

  // Multi-outcome event: did they name one outcome ("Chiefs"), or ask about the event as a whole?
  const qTokens = new Set(tokenize(question));
  const named = markets.filter((m) => tokenize(m.yes_sub_title ?? "").some((tok) => qTokens.has(tok)));
  if (named.length === 1) {
    trace.outcome = named[0].ticker;
    return { matched: true, reply: formatSingle(event, named[0]), trace };
  }
  // Outcome names often differ from how people say them ("Kansas City" for the Chiefs), so when
  // keywords do not settle it, Jev chooses among the outcomes and judges whether one was meant.
  const pool = named.length > 1 ? named : markets;
  if (pool.length <= MAX_OUTCOME_OPTIONS) {
    const op = await deps.matcher.pickOutcome(
      question,
      event.title,
      pool.map((m) => m.yes_sub_title ?? m.title),
    );
    trace.outcomePick = op;
    const m = pool[op.index];
    if (m && op.confidence >= t.confidence && op.fits >= Math.max(t.fits, MIN_OUTCOME_FITS)) {
      trace.outcome = m.ticker;
      return { matched: true, reply: formatSingle(event, m), trace };
    }
  }
  return { matched: true, reply: formatTop(event), trace };
}
