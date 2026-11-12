// Jev (TypeSafe's System One model) picks the market and tells us how sure it is.
// A Choice always picks something, so a companion Noul asks whether anything fits at all.
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { IndexedEvent } from "./kalshi.ts";

export interface Pick {
  /** Index into the list that was offered. */
  index: number;
  /** How concentrated Jev's probability is on that one option, 0 to 1. */
  confidence: number;
  /** Probability that one of the offered options really answers the question, 0 to 1. */
  fits: number;
}

export interface Matcher {
  pickEvent(question: string, candidates: IndexedEvent[]): Promise<Pick>;
  pickOutcome(question: string, eventTitle: string, outcomes: string[]): Promise<Pick>;
}

export class JevMatcher implements Matcher {
  private client: TypeSafeClient;

  constructor(model = process.env.JEV_MODEL ?? "jev-latest") {
    this.client = new TypeSafeClient({ defaultModel: model });
  }

  async pickEvent(question: string, candidates: IndexedEvent[]): Promise<Pick> {
    const options = labelled(
      candidates.map(
        (e) =>
          `${e.title}${e.subTitle ? ` (${e.subTitle})` : ""} [${e.category}]` +
          (e.outcomes.length > 1 ? ` Outcomes: ${e.outcomes.slice(0, 12).join(", ")}` : ""),
      ),
    );
    return this.ask(
      { question, note: "A person on social media is asking a bot for prediction-market odds." },
      "Which prediction market is the person asking about?",
      "Is at least one of the listed prediction markets about the same thing the person is asking about?",
      options,
    );
  }

  async pickOutcome(question: string, eventTitle: string, outcomes: string[]): Promise<Pick> {
    return this.ask(
      { question, market: eventTitle },
      "Which outcome of this market is the person asking about?",
      "Is the person asking about one specific listed outcome, rather than the market as a whole?",
      labelled(outcomes),
    );
  }

  private async ask(
    state: Record<string, string>,
    choiceQ: string,
    fitsQ: string,
    options: Record<string, string>,
  ): Promise<Pick> {
    const { answers } = await this.client.systemOne({
      state: { ...state, options },
      questions: { pick: choice(choiceQ, options), fits: noul(fitsQ) },
    });
    return {
      index: Number(String(answers.pick.choice).slice(1)),
      confidence: answers.pick.confidence,
      fits: answers.fits.noul,
    };
  }
}

/** Label options o0, o1, … so the answer maps straight back to a list index. */
function labelled(items: string[]): Record<string, string> {
  return Object.fromEntries(items.map((text, i) => [`o${i}`, text]));
}
