// X side: read new mentions of the bot account and reply to them.
// X only accepts API replies to posts whose author mentioned (or quoted) the bot, which is
// exactly what the mentions timeline contains.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TwitterApi } from "twitter-api-v2";

export interface Mention {
  id: string;
  text: string;
  authorId: string;
}

interface State {
  userId?: string;
  sinceId?: string;
}

export class XBot {
  private api: TwitterApi;
  private stateFile: string;
  private state: State = {};

  constructor(stateFile: string) {
    const need = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const;
    const missing = need.filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing X credentials: ${missing.join(", ")} (see .env.example)`);
    this.api = new TwitterApi({
      appKey: process.env.X_API_KEY!,
      appSecret: process.env.X_API_SECRET!,
      accessToken: process.env.X_ACCESS_TOKEN!,
      accessSecret: process.env.X_ACCESS_SECRET!,
    });
    this.stateFile = stateFile;
  }

  async init(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.stateFile, "utf8")) as State;
    } catch {
      // first run
    }
    if (!this.state.userId) {
      this.state.userId = (await this.api.v2.me()).data.id;
      await this.save();
    }
  }

  /**
   * New mentions since the last run, oldest first. The very first run only records where the
   * timeline currently ends, so the bot never replies to a backlog of old posts.
   */
  async newMentions(max: number): Promise<Mention[]> {
    const firstRun = !this.state.sinceId;
    const page = await this.api.v2.userMentionTimeline(this.state.userId!, {
      max_results: firstRun ? 5 : Math.min(Math.max(max, 5), 100),
      ...(firstRun ? {} : { since_id: this.state.sinceId }),
      "tweet.fields": ["author_id", "referenced_tweets"],
    });
    const tweets = page.tweets ?? [];
    if (firstRun) {
      // "0" means "nothing seen yet" when the timeline is empty; any real ID is newer.
      this.state.sinceId = page.meta?.newest_id ?? "0";
      await this.save();
      return [];
    }
    return tweets
      .filter((t) => t.author_id !== this.state.userId)
      .filter((t) => !t.referenced_tweets?.some((r) => r.type === "retweeted"))
      .map((t) => ({ id: t.id, text: t.text, authorId: t.author_id ?? "" }))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, max);
  }

  async reply(mentionId: string, text: string): Promise<string> {
    const res = await this.api.v2.reply(text, mentionId);
    return res.data.id;
  }

  /** Record a mention as handled so a crash mid-run never causes a double reply. */
  async markHandled(mentionId: string): Promise<void> {
    if (!this.state.sinceId || BigInt(mentionId) > BigInt(this.state.sinceId)) {
      this.state.sinceId = mentionId;
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }
}
