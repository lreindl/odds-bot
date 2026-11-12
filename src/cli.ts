// Usage:
//   npm run ask -- "odds the Fed cuts in December?"   answer one question locally, post nothing
//   npm run poll                                       check mentions once and reply
//   npm run poll -- --dry-run                          check mentions, print replies, post nothing
//   npm run poll -- --loop 60                          keep polling every 60 seconds
//   npm run refresh                                    rebuild the Kalshi event index now
import { answerQuestion, type Deps } from "./answer.ts";
import { fetchEvent, loadIndex } from "./kalshi.ts";
import { JevMatcher, type Matcher } from "./match.ts";
import { EventIndex } from "./retrieve.ts";
import { XBot } from "./x.ts";

const INDEX_FILE = "data/events.json";
const STATE_FILE = "data/state.json";
const INDEX_MAX_AGE_MS = Number(process.env.INDEX_MAX_AGE_HOURS ?? 6) * 3_600_000;
const MAX_REPLIES_PER_RUN = Number(process.env.MAX_REPLIES_PER_RUN ?? 10);
const REPLY_WHEN_NOT_FOUND = (process.env.REPLY_WHEN_NOT_FOUND ?? "true") === "true";

const log = (msg: string) => console.error(`[${new Date().toISOString()}] ${msg}`);

async function deps(matcher?: Matcher): Promise<Deps> {
  const events = await loadIndex(INDEX_FILE, INDEX_MAX_AGE_MS, log);
  return { index: new EventIndex(events), matcher: matcher ?? new JevMatcher(), fetchEvent };
}

async function ask(question: string, context?: string): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY) {
    // Without a Jev key we can still show what the shortlist looks like.
    const events = await loadIndex(INDEX_FILE, INDEX_MAX_AGE_MS, log);
    const hits = new EventIndex(events).search(question);
    console.log("TYPESAFE_API_KEY is not set, so Jev cannot pick. Shortlist only:");
    for (const h of hits) console.log(`  ${h.score.toFixed(2)}  ${h.event.ticker}  ${h.event.title}`);
    return;
  }
  const a = await answerQuestion(question, await deps(), context);
  console.log(JSON.stringify(a.trace, null, 2));
  console.log(`\n--- reply (${a.reply.length} chars, matched=${a.matched}) ---\n${a.reply}`);
}

async function pollOnce(bot: XBot, d: Deps, dryRun: boolean): Promise<void> {
  const mentions = await bot.newMentions(MAX_REPLIES_PER_RUN);
  log(`${mentions.length} new mention(s).`);
  for (const m of mentions) {
    try {
      const a = await answerQuestion(m.text, d, m.context);
      log(`mention ${m.id}: ${JSON.stringify(a.trace)}`);
      if (!a.matched && !REPLY_WHEN_NOT_FOUND) log(`mention ${m.id}: no match, staying quiet.`);
      else if (dryRun) log(`mention ${m.id}: would reply:\n${a.reply}`);
      else log(`mention ${m.id}: replied with ${await bot.reply(m.id, a.reply)}:\n${a.reply}`);
    } catch (err) {
      // One bad mention must not block the rest; it is skipped, not retried.
      log(`mention ${m.id}: failed: ${(err as Error).message}`);
    }
    if (!dryRun) await bot.markHandled(m.id);
  }
}

async function poll(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const loopAt = args.indexOf("--loop");
  const everySec = loopAt >= 0 ? Number(args[loopAt + 1] ?? 60) : 0;
  const bot = new XBot(STATE_FILE);
  await bot.init();
  do {
    try {
      await pollOnce(bot, await deps(), dryRun);
    } catch (err) {
      log(`poll failed: ${(err as Error).message}`);
      if (!everySec) throw err;
    }
    if (everySec) await new Promise((r) => setTimeout(r, everySec * 1000));
  } while (everySec);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "ask" && rest.length) {
  // Optional: --context "text of the post being replied to"
  const at = rest.indexOf("--context");
  const context = at >= 0 ? rest.splice(at, 2)[1] : undefined;
  await ask(rest.join(" "), context);
}
else if (cmd === "poll") await poll(rest);
else if (cmd === "refresh") await loadIndex(INDEX_FILE, 0, log);
else {
  console.error('Commands: ask "<question>" | poll [--dry-run] [--loop <seconds>] | refresh');
  process.exitCode = 1;
}
