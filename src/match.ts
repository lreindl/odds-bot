// Jev (TypeSafe's System One model) picks the market and tells us how sure it is.
// A Choice always picks something, so a companion Noul asks whether anything fits at all.
import { choice, type ContentValue, image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { IndexedEvent } from "./types.ts";

export interface Pick {
  /** Index into the list that was offered. */
  index: number;
  /** How concentrated Jev's probability is on that one option, 0 to 1. */
  confidence: number;
  /** Probability that one of the offered options really answers the question, 0 to 1. */
  fits: number;
}

/** What surrounds the question: the post it replies to or quotes, and any attached images. */
export interface Thread {
  text?: string;
  /** PNG or JPEG images from the mention and its parent post. Jev sees them; search does not. */
  images?: Blob[];
}

export interface Matcher {
  pickEvent(question: string, candidates: IndexedEvent[], thread?: Thread): Promise<Pick>;
  pickOutcome(question: string, eventTitle: string, outcomes: string[], thread?: Thread): Promise<Pick>;
}

export class JevMatcher implements Matcher {
  private client: TypeSafeClient;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = () => {}, model = process.env.JEV_MODEL ?? "jev-latest") {
    // Image input is experimental in the TypeSafe API and has to be opted into.
    this.client = new TypeSafeClient({
      defaultModel: model,
      defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
    });
    this.log = log;
  }

  async pickEvent(question: string, candidates: IndexedEvent[], thread?: Thread): Promise<Pick> {
    const options = labelled(
      candidates.map(
        (e) =>
          `${e.title}${e.subTitle ? ` (${e.subTitle})` : ""} [${e.category}]` +
          (e.outcomes.length > 1 ? ` Outcomes: ${e.outcomes.slice(0, 12).join(", ")}` : ""),
      ),
    );
    const surroundings = [thread?.text && "the post being replied to", thread?.images?.length && "the attached images"]
      .filter(Boolean)
      .join(" and ");
    return this.ask(
      { question, note: "A person on social media is asking a bot for prediction-market odds." },
      "Which prediction market is the person asking about?",
      `${surroundings ? `Taking ${surroundings} into account, is` : "Is"} at least one of the listed prediction markets about the same thing the person is asking about?`,
      options,
      thread,
    );
  }

  async pickOutcome(question: string, eventTitle: string, outcomes: string[], thread?: Thread): Promise<Pick> {
    return this.ask(
      { question, market: eventTitle },
      "Which outcome of this market is the person asking about?",
      "Is the person asking about one specific listed outcome, rather than the market as a whole?",
      labelled(outcomes),
      thread,
    );
  }

  private async ask(
    state: Record<string, string>,
    choiceQ: string,
    fitsQ: string,
    options: Record<string, string>,
    thread?: Thread,
  ): Promise<Pick> {
    const questions = { pick: choice(choiceQ, options), fits: noul(fitsQ) };
    const run = async (withImages: boolean) => {
      const full: Record<string, ContentValue> = { ...state, options };
      if (thread?.text) full.post_being_replied_to = thread.text;
      if (withImages) full.post_images = (thread?.images ?? []).map((b) => image(b));
      const { answers } = await this.client.systemOne({ state: full, questions });
      return {
        index: Number(String(answers.pick.choice).slice(1)),
        confidence: answers.pick.confidence,
        fits: answers.fits.noul,
      };
    };
    if (!thread?.images?.length) return run(false);
    try {
      return await run(true);
    } catch (err) {
      // An image Jev rejects (wrong format, too large) must not cost the whole answer.
      this.log(`Jev could not use the images (${(err as Error).message}); retrying with text only.`);
      return run(false);
    }
  }
}

/** Label options o0, o1, … so the answer maps straight back to a list index. */
function labelled(items: string[]): Record<string, string> {
  return Object.fromEntries(items.map((text, i) => [`o${i}`, text]));
}
