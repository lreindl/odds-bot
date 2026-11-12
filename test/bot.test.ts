import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion, type Deps } from "../src/answer.ts";
import { formatReply, impliedProbability, type Part, pct, postLength } from "../src/format.ts";
import type { Matcher, Pick } from "../src/match.ts";
import { cleanQuestion, EventIndex } from "../src/retrieve.ts";
import type { IndexedEvent, Market, MarketEvent, SourceName } from "../src/types.ts";

const ev = (source: SourceName, ticker: string, title: string, outcomes: string[], category = ""): IndexedEvent => ({
  source, ticker, title, subTitle: "", category, outcomes, volume: 1000,
});

const INDEX: IndexedEvent[] = [
  ev("kalshi", "KXSB-27", "Super Bowl champion? 2027", ["Kansas City Chiefs", "Buffalo Bills", "Detroit Lions"], "Sports"),
  ev("kalshi", "KXFED-26DEC", "Will the Federal Reserve cut rates in December?", ["Cut"], "Economics"),
  ev("kalshi", "KXMARS-99", "Will Elon Musk visit Mars in his lifetime?", ["Mars"], "Science"),
  ...Array.from({ length: 40 }, (_, i) => ev("kalshi", `KXLEG-${i}`, `Texas House District ${i} winner?`, ["Republican", "Democratic"], "Elections")),
  ev("polymarket", "super-bowl-2027", "Super Bowl 2027 winner", ["Chiefs", "Bills", "Lions"], "Sports"),
  ev("polymarket", "gta-6", "Will GTA 6 release in 2027?", [], "Gaming"),
];

const yn = (id: string, title: string, outcome: string, bid: number, ask: number): Market => ({
  id, title, outcome, kind: "yesno", bid, ask, last: (bid + ask) / 2,
});

const EVENTS: Record<string, MarketEvent> = {
  "KXSB-27": {
    source: "kalshi", title: "Super Bowl champion?", url: "https://kalshi.com/markets/kxsb",
    markets: [
      yn("KC", "Will the Kansas City Chiefs win the Super Bowl?", "Kansas City Chiefs", 0.17, 0.19),
      yn("BUF", "Will the Buffalo Bills win the Super Bowl?", "Buffalo Bills", 0.12, 0.14),
      yn("DET", "Will the Detroit Lions win the Super Bowl?", "Detroit Lions", 0.09, 0.11),
    ],
  },
  "super-bowl-2027": {
    source: "polymarket", title: "Super Bowl 2027 winner", url: "https://polymarket.com/event/super-bowl-2027",
    markets: [
      yn("p1", "Will the Chiefs win Super Bowl 2027?", "Chiefs", 0.19, 0.21),
      yn("p2", "Will the Bills win Super Bowl 2027?", "Bills", 0.13, 0.15),
    ],
  },
  "gta-6": {
    source: "polymarket", title: "Will GTA 6 release in 2027?", url: "https://polymarket.com/event/gta-6",
    markets: [yn("g", "Will GTA 6 release in 2027?", "", 0.6, 0.62)],
  },
};

const SOURCES = [
  { name: "kalshi" as const, label: "Kalshi" },
  { name: "polymarket" as const, label: "Polymarket" },
];

function deps(pick: Partial<Pick> = {}, outcome: Partial<Pick> = {}): Deps {
  const full: Pick = { index: 0, confidence: 0.95, fits: 0.95, ...pick };
  const matcher: Matcher = { pickEvent: async () => full, pickOutcome: async () => ({ ...full, ...outcome }) };
  return {
    index: new EventIndex(INDEX),
    matcher,
    sources: SOURCES,
    fetchEvent: async (e) => {
      const found = EVENTS[e.ticker];
      if (!found) throw new Error(`no fixture for ${e.ticker}`);
      return found;
    },
    thresholds: { confidence: 0.6, fits: 0.7 },
  };
}

test("cleanQuestion strips handles and links", () => {
  assert.equal(cleanQuestion("@oddsbot odds the Fed cuts? https://t.co/abc"), "odds the Fed cuts?");
});

test("shortlist ranks the right event first, expands shorthand, and filters by source", () => {
  const idx = new EventIndex(INDEX);
  assert.equal(idx.search("what are the odds the fed cuts in december")[0].event.ticker, "KXFED-26DEC");
  assert.equal(idx.search("chiefs super bowl odds", 10, "kalshi")[0].event.ticker, "KXSB-27");
  assert.equal(idx.search("chiefs super bowl odds", 10, "polymarket")[0].event.ticker, "super-bowl-2027");
  assert.deepEqual(idx.search("what are the odds"), []);
  assert.deepEqual(idx.search("constructor toString"), []);
});

test("price reading: midpoint when tight, last trade when wide, null when empty", () => {
  const m = (bid?: number, ask?: number, last?: number): Market => ({ id: "a", title: "", outcome: "", kind: "yesno", bid, ask, last });
  assert.equal(impliedProbability(m(0.62, 0.64)), 0.63);
  assert.equal(impliedProbability(m(0.1, 0.9, 0.4)), 0.4);
  assert.equal(impliedProbability(m(0, 1, 0)), null);
  assert.equal(impliedProbability(m(undefined, undefined, 0.55)), 0.55);
  assert.equal(pct(0.004), "<1%");
  assert.equal(pct(0.996), ">99%");
});

test("an event on both sites is quoted from both, Kalshi first", async () => {
  const a = await answerQuestion("@oddsbot odds the Chiefs win the Super Bowl?", deps());
  assert.equal(a.matched, true);
  assert.equal(
    a.reply,
    "Will the Chiefs win Super Bowl 2027?\n" +
      "Kalshi: 18% https://kalshi.com/markets/kxsb\n" +
      "Polymarket: 20% https://polymarket.com/event/super-bowl-2027",
  );
});

test("an event on one site only is quoted from that site", async () => {
  const a = await answerQuestion("@oddsbot will gta 6 release in 2027", deps());
  assert.equal(a.reply, "Will GTA 6 release in 2027?\nPolymarket: 61% https://polymarket.com/event/gta-6");
});

test("a whole-event question lists the leaders", async () => {
  const a = await answerQuestion("@oddsbot who wins the super bowl", deps({}, { fits: 0.5 }));
  assert.equal(
    a.reply,
    "Super Bowl champion?\n" +
      "Kalshi: Kansas City Chiefs 18%, Buffalo Bills 13%, Detroit Lions 10% https://kalshi.com/markets/kxsb\n" +
      "Polymarket: Chiefs 20%, Bills 14% https://polymarket.com/event/super-bowl-2027",
  );
});

test("low confidence or poor fit means no market is quoted", async () => {
  for (const pick of [{ confidence: 0.4 }, { fits: 0.3 }]) {
    // Several candidates, so both gates apply (a lone candidate skips the confidence gate).
    const a = await answerQuestion("@oddsbot super bowl or texas house district 3 odds", deps(pick));
    assert.doesNotMatch(a.reply, /Kalshi/);
  }
  const none = await answerQuestion("@oddsbot texas house district 3 or 4 odds", deps({ fits: 0.3 }));
  assert.equal(none.matched, false);
  assert.doesNotMatch(none.reply, /%/);
});

test("one source failing does not cost the reply from the other", async () => {
  const d = deps();
  const inner = d.fetchEvent;
  d.fetchEvent = async (e) => {
    if (e.source === "kalshi") throw new Error("kalshi is down");
    return inner(e);
  };
  const a = await answerQuestion("@oddsbot odds the Chiefs win the Super Bowl?", d);
  assert.equal(a.matched, true);
  assert.match(a.reply, /^Will the Chiefs win Super Bowl 2027\?\nPolymarket: 20% /);
  assert.doesNotMatch(a.reply, /Kalshi/);
  assert.equal((a.trace.kalshi as { error: string }).error, "kalshi is down");
});

test("Jev resolves an outcome that keywords miss, and the reply names it", async () => {
  EVENTS["KXSB-27"].markets.forEach((m) => (m.title = "Who will win?"));
  try {
    const a = await answerQuestion("@oddsbot josh allen team odds super bowl", deps({}, { index: 1, fits: 0.9 }));
    assert.match(a.reply, /\nKalshi: Buffalo Bills 13% /);
  } finally {
    EVENTS["KXSB-27"].markets.forEach((m) => (m.title = `Will the ${m.outcome} win the Super Bowl?`));
  }
});

test("a bare question finds its market through the post it replies to", async () => {
  const seen: (string | undefined)[] = [];
  const d = deps();
  d.matcher = {
    pickEvent: async (_q, _c, ctx) => (seen.push(ctx), { index: 0, confidence: 0.9, fits: 0.9 }),
    pickOutcome: async () => ({ index: 0, confidence: 0.9, fits: 0.2 }),
  };
  const tickers = (a: { trace: Record<string, unknown> }) =>
    ((a.trace.kalshi as { candidates: string[] }).candidates ?? []).map((c) => c.split(" ")[0]);
  const alone = await answerQuestion("@oddsbot odds they win?", d);
  assert.ok(!tickers(alone).includes("KXSB-27"));
  const threaded = await answerQuestion("@oddsbot odds they win?", d, "@fan The Chiefs look unstoppable heading to the Super Bowl https://t.co/x");
  assert.equal(tickers(threaded)[0], "KXSB-27");
  assert.match(threaded.reply, /Chiefs/);
  assert.equal(seen.at(-1), "The Chiefs look unstoppable heading to the Super Bowl");
});

test("replies always fit in a post", () => {
  const long = (label: string, lines: number): Part => ({
    label, title: "T".repeat(400), lines: Array.from({ length: lines }, () => `${"S".repeat(120)} 50%`), url: `https://example.com/${"u".repeat(80)}`,
  });
  for (const parts of [[long("Kalshi", 1)], [long("Kalshi", 4)], [long("Kalshi", 4), long("Polymarket", 4)], [long("Kalshi", 1), long("Polymarket", 1)]]) {
    const reply = formatReply(parts);
    assert.ok(postLength(reply) <= 280, `${postLength(reply)} chars`);
  }
});
