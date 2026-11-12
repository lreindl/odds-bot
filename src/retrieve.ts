// Cheap lexical shortlist: narrows thousands of events to a handful for Jev to choose between.
import type { IndexedEvent, SourceName } from "./types.ts";

const STOP = new Set(
  `a an the of to in on at for by with from is are was were be been will would could should can do does did
   what whats which who whom when where why how odds odd chance chances probability likelihood likely
   kalshi market markets price prices bet betting that this it its and or not no yes any some there their
   about get gets have has had you your me my i we us please tell give show think next before after than`
    .split(/\s+/)
    .filter(Boolean),
);

// Common shorthand people use that never appears in a market title.
const ALIASES = new Map<string, string[]>(Object.entries({
  fed: ["federal", "reserve", "fed"],
  fomc: ["federal", "reserve", "fed"],
  potus: ["president", "presidential"],
  scotus: ["supreme", "court"],
  btc: ["bitcoin"],
  eth: ["ethereum"],
  gop: ["republican"],
  dems: ["democratic", "democrat"],
  cpi: ["inflation", "cpi"],
  sb: ["super", "bowl"],
  superbowl: ["super", "bowl"],
  winner: ["win"],
  won: ["win"],
  championship: ["champion"],
  champ: ["champion"],
}));

// Kalshi avoids league trademarks in titles ("Pro Football Champion", not "Super Bowl"),
// so add its wording alongside the words people actually use.
const PHRASES: [RegExp, string][] = [
  [/\bsuper ?bowl\b/g, "super bowl pro football champion"],
  [/\bnfl\b/g, "nfl pro football"],
  [/\bnba( finals?)?\b/g, "nba pro basketball champion"],
  [/\b(mlb|world series)\b/g, "mlb pro baseball champion"],
  [/\bnhl\b/g, "nhl stanley cup"],
  [/\b(cfp|college football playoff)\b/g, "college football national championship"],
  [/\bmarch madness\b/g, "college basketball champion"],
];

export function tokenize(text: string): string[] {
  const out: string[] = [];
  let lowered = text.toLowerCase();
  for (const [re, to] of PHRASES) lowered = lowered.replace(re, to);
  for (const raw of lowered.replace(/['’]s\b/g, "").split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    for (const t of ALIASES.get(raw) ?? [raw]) out.push(stem(t));
  }
  return out;
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Remove @handles and links so only the person's actual question is left. */
export function cleanQuestion(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Candidate {
  event: IndexedEvent;
  score: number;
}

export class EventIndex {
  private docs: { event: IndexedEvent; head: Set<string>; outcomes: Set<string> }[];
  private idf = new Map<string, number>();

  constructor(events: IndexedEvent[]) {
    this.docs = events.map((event) => ({
      event,
      head: new Set(tokenize(`${event.title} ${event.subTitle} ${event.category}`)),
      outcomes: new Set(tokenize(event.outcomes.join(" "))),
    }));
    const df = new Map<string, number>();
    for (const d of this.docs) {
      for (const t of new Set([...d.head, ...d.outcomes])) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const n = this.docs.length;
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + (n - c + 0.5) / (c + 0.5)));
  }

  /** Best matches for the question, optionally from one source only. */
  search(question: string, limit = 10, source?: SourceName): Candidate[] {
    const terms = [...new Set(tokenize(question))];
    if (terms.length === 0) return [];
    const scored: Candidate[] = [];
    for (const d of this.docs) {
      if (source && d.event.source !== source) continue;
      let score = 0;
      for (const t of terms) {
        const w = this.idf.get(t);
        if (w === undefined) continue;
        if (d.head.has(t)) score += w;
        else if (d.outcomes.has(t)) score += w * 0.7;
      }
      // Mild length penalty so a short, on-topic title beats a sprawling one.
      if (score > 0) {
        // Heavily traded markets are the ones people ask about, so volume breaks near-ties.
        const popularity = 1 + 0.1 * Math.log10(1 + (d.event.volume ?? 0));
        scored.push({ event: d.event, score: (score * popularity) / (1 + Math.log(1 + d.head.size) / 10) });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
