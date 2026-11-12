# odds-bot

An X bot that answers "@bot what are the odds of …?" with live Kalshi prices.

## How a reply is made

1. **Shortlist** – a local index of every open Kalshi event (about 21,000, refreshed every 6 hours)
   is searched by keyword, with heavily traded markets ranked higher. Top 10 go forward.
2. **Pick** – Jev (TypeSafe's System One model) chooses one of the 10 and reports a confidence.
   A second question in the same request asks whether any of them fits at all, because a
   Choice always picks something.
3. **Gate** – the bot only quotes a price when confidence ≥ `MIN_CONFIDENCE` and fit ≥ `MIN_FITS`.
   Otherwise it says it couldn't find a clear match (or stays quiet with `REPLY_WHEN_NOT_FOUND=false`).
4. **Price** – the event is fetched live. A named outcome ("Chiefs") gets its own price; a
   whole-event question gets the leading outcomes.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in the TypeSafe key and the four X keys.
   Generate the X access token while signed in as the bot account, with Read and Write permission.
3. Label the bot account as automated in its X profile settings, naming who runs it.

## Commands

| Command | What it does |
| --- | --- |
| `npm run ask -- "odds the Fed cuts in December?"` | Answers one question locally. Posts nothing. Shows the full trace. |
| `npm run poll -- --dry-run` | Reads new mentions and prints the replies it would post. |
| `npm run poll` | Reads new mentions once and replies. |
| `npm run poll -- --loop 60` | Keeps polling every 60 seconds. |
| `npm run refresh` | Rebuilds the Kalshi event index now. |
| `npm test` | Runs the tests (no keys or network needed). |

The first `poll` only records where the mention timeline currently ends, so old mentions are
never answered. `data/state.json` holds that position; keep it between runs.

## Before going live

- X's rules require written approval for "AI reply bots". Jev is a classifier, not a text
  generator, but whether that counts is X's call — check before launch.
- Kalshi's Developer Agreement should be read for its terms on publicly displaying prices.
- Each handled mention costs roughly a cent or two in X API fees; `MAX_REPLIES_PER_RUN` caps a run.
