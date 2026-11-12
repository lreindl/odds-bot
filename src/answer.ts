// The whole pipeline for one question: shortlist → Jev pick → confidence gate → live prices → reply.
import { formatNotFound, formatSingle, formatTop } from "./format.ts";
import type { KalshiEvent } from "./kalshi.ts";
import type { Matcher } from "./match.ts";
import { type Candidate, cleanQuestion, type EventIndex, tokenize } from "./retrieve.ts";

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
const MAX_CONTEXT_CHARS = 600;
const SHORTLIST_SIZE = 10;
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

/**
 * @param rawContext The post the mention replies to or quotes, if any. People tag the bot under
 *   someone else's post and ask "odds they win?", so the subject often lives there.
 */
export async function answerQuestion(rawText: string, deps: Deps, rawContext?: string): Promise<Answer> {
  const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const question = cleanQuestion(rawText);
  const context = rawContext ? cleanQuestion(rawContext).slice(0, MAX_CONTEXT_CHARS) : undefined;
  const candidates = shortlist(deps.index, question, context);
  const trace: Record<string, unknown> = {
    question,
    ...(context ? { context } : {}),
    candidates: candidates.map((c) => `${c.event.ticker} (${c.score.toFixed(2)}) ${c.event.title}`),
  };
  if (candidates.length === 0) return { matched: false, reply: formatNotFound(), trace };

  const pick = await deps.matcher.pickEvent(
    question,
    candidates.map((c) => c.event),
    context,
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
  const qTokens = new Set(tokenize(`${question} ${context ?? ""}`));
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
      context,
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

/**
 * Candidates from the question alone and from question plus thread context, interleaved. A
 * self-contained question must not be drowned out by an unrelated thread, and a bare
 * "odds they win?" must still find the market its thread is about.
 */
function shortlist(index: EventIndex, question: string, context?: string): Candidate[] {
  const own = index.search(question, SHORTLIST_SIZE);
  if (!context) return own;
  const withContext = index.search(`${question} ${context}`, SHORTLIST_SIZE);
  const seen = new Set<string>();
  const merged: Candidate[] = [];
  for (let i = 0; i < SHORTLIST_SIZE && merged.length < SHORTLIST_SIZE; i++) {
    for (const c of [withContext[i], own[i]]) {
      if (c && !seen.has(c.event.ticker) && merged.length < SHORTLIST_SIZE) {
        seen.add(c.event.ticker);
        merged.push(c);
      }
    }
  }
  return merged;
}
