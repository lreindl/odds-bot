import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion, type Deps } from "../src/answer.ts";
import { formatSingle, formatTop, impliedProbability, pct } from "../src/format.ts";
import type { IndexedEvent, KalshiEvent } from "../src/kalshi.ts";
import type { Matcher, Pick } from "../src/match.ts";
import { cleanQuestion, EventIndex } from "../src/retrieve.ts";

const INDEX: IndexedEvent[] = [
  { ticker: "KXSB-27", series: "KXSB", title: "Super Bowl champion?", subTitle: "2027", category: "Sports", outcomes: ["Kansas City Chiefs", "Buffalo Bills", "Detroit Lions"], volume: 1000 },
  { ticker: "KXFED-26DEC", series: "KXFED", title: "Will the Federal Reserve cut rates in December?", subTitle: "Dec 2026", category: "Economics", outcomes: ["Cut"], volume: 1000 },
  { ticker: "KXMARS-99", series: "KXMARS", title: "Will Elon Musk visit Mars in his lifetime?", subTitle: "", category: "Science", outcomes: ["Mars"], volume: 1000 },
  ...Array.from({ length: 40 }, (_, i) => ({ ticker: `KXLEG-${i}`, series: "KXLEG", title: `Texas House District ${i} winner?`, subTitle: `House District ${i}`, category: "Elections", outcomes: ["Republican", "Democratic"], volume: 1000 })),
];

const SB: KalshiEvent = {
  event_ticker: "KXSB-27", series_ticker: "KXSB", title: "Super Bowl champion?",
  markets: [
    { ticker: "KXSB-27-KC", title: "Will the Kansas City Chiefs win the Super Bowl?", yes_sub_title: "Kansas City Chiefs", status: "active", yes_bid_dollars: "0.1700", yes_ask_dollars: "0.1900", last_price_dollars: "0.1800" },
    { ticker: "KXSB-27-BUF", title: "Will the Buffalo Bills win the Super Bowl?", yes_sub_title: "Buffalo Bills", status: "active", yes_bid_dollars: "0.1200", yes_ask_dollars: "0.1400", last_price_dollars: "0.1300" },
    { ticker: "KXSB-27-DET", title: "Will the Detroit Lions win the Super Bowl?", yes_sub_title: "Detroit Lions", status: "active", yes_bid_dollars: "0.0900", yes_ask_dollars: "0.1100", last_price_dollars: "0.1000" },
  ],
};

function deps(pick: Partial<Pick>, event = SB, outcome: Partial<Pick> = {}): Deps {
  const full: Pick = { index: 0, confidence: 0.95, fits: 0.95, ...pick };
  const matcher: Matcher = { pickEvent: async () => full, pickOutcome: async () => ({ ...full, ...outcome }) };
  return { index: new EventIndex(INDEX), matcher, fetchEvent: async () => event, thresholds: { confidence: 0.6, fits: 0.7 } };
}

test("cleanQuestion strips handles and links", () => {
  assert.equal(cleanQuestion("@oddsbot odds the Fed cuts? https://t.co/abc"), "odds the Fed cuts?");
});

test("shortlist ranks the right event first and expands shorthand", () => {
  const idx = new EventIndex(INDEX);
  assert.equal(idx.search("what are the odds the fed cuts in december")[0].event.ticker, "KXFED-26DEC");
  assert.equal(idx.search("chiefs super bowl odds?")[0].event.ticker, "KXSB-27");
  assert.deepEqual(idx.search("what are the odds"), []);
});

test("price reading: midpoint when tight, last trade when wide, null when empty", () => {
  assert.equal(impliedProbability({ ticker: "a", title: "", yes_bid_dollars: "0.6200", yes_ask_dollars: "0.6400" }), 0.63);
  assert.equal(impliedProbability({ ticker: "a", title: "", yes_bid_dollars: "0.1000", yes_ask_dollars: "0.9000", last_price_dollars: "0.4000" }), 0.4);
  assert.equal(impliedProbability({ ticker: "a", title: "", yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", last_price_dollars: "0.0000" }), null);
  assert.equal(pct(0.004), "<1%");
  assert.equal(pct(0.996), ">99%");
});

test("a named outcome gets its own price", async () => {
  const a = await answerQuestion("@oddsbot odds the Chiefs win the Super Bowl?", deps({}));
  assert.equal(a.matched, true);
  assert.match(a.reply, /Kansas City Chiefs.*\n18% yes on Kalshi\nhttps:\/\/kalshi\.com\/markets\/kxsb$/);
});

test("a whole-event question lists the leaders", async () => {
  const a = await answerQuestion("@oddsbot who wins the super bowl", deps({}, SB, { fits: 0.5 }));
  assert.match(a.reply, /Kansas City Chiefs: 18%\nBuffalo Bills: 13%\nDetroit Lions: 10%/);
});

test("low confidence or poor fit means no market is quoted", async () => {
  for (const pick of [{ confidence: 0.4 }, { fits: 0.3 }]) {
    // Several candidates, so both gates apply (a lone candidate skips the confidence gate).
    const a = await answerQuestion("@oddsbot super bowl or texas house district 3 odds", deps(pick));
    assert.equal(a.matched, false);
    assert.doesNotMatch(a.reply, /%/);
  }
});

test("replies always fit in a post", () => {
  const long: KalshiEvent = {
    ...SB,
    title: "T".repeat(400),
    markets: SB.markets!.map((m) => ({ ...m, title: "M".repeat(400), yes_sub_title: "S".repeat(120) })),
  };
  for (const reply of [formatSingle(long, long.markets![0]), formatTop(long)]) {
    const counted = reply.replace(/https:\/\/\S+/, "x".repeat(23));
    assert.ok(counted.length <= 280, `${counted.length} chars`);
  }
});

test("words that collide with built-in property names are ordinary tokens", () => {
  assert.deepEqual(new EventIndex(INDEX).search("constructor toString"), []);
});

test("Jev resolves an outcome that keywords miss, and the reply names it", async () => {
  const shared = { ...SB, markets: SB.markets!.map((m) => ({ ...m, title: "Who will win?" })) };
  const a = await answerQuestion("@oddsbot josh allen team odds super bowl", deps({}, shared, { index: 1, fits: 0.9 }));
  assert.match(a.reply, /Who will win\?\nBuffalo Bills: 13% yes on Kalshi/);
});
