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
  /** Text of the post this mention replies to or quotes, when there is one. */
  context?: string;
  /** Image links from the parent post first, then the mention itself. Videos give their preview frame. */
  imageUrls: string[];
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
      "tweet.fields": ["author_id", "referenced_tweets", "attachments"],
      expansions: ["referenced_tweets.id", "attachments.media_keys", "referenced_tweets.id.attachments.media_keys"],
      "media.fields": ["type", "url", "preview_image_url"],
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
      .map((t) => {
        // Prefer the post being replied to; fall back to a quoted post.
        const refs = t.referenced_tweets ?? [];
        const ref = refs.find((r) => r.type === "replied_to") ?? refs.find((r) => r.type === "quoted");
        const parent = ref && page.includes.tweets.find((p) => p.id === ref.id);
        const media = page.includes.media;
        const imagesOf = (keys: string[] | undefined) =>
          (keys ?? [])
            .map((k) => media.find((m) => m.media_key === k))
            .map((m) => (m?.type === "photo" ? m.url : m?.preview_image_url))
            .filter((u): u is string => !!u);
        const imageUrls = [...imagesOf(parent?.attachments?.media_keys), ...imagesOf(t.attachments?.media_keys)];
        return { id: t.id, text: t.text, authorId: t.author_id ?? "", context: parent?.text, imageUrls };
      })
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
