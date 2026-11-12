// The local search index: every source's open events in one cached file.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { kalshi } from "./kalshi.ts";
import { polymarket } from "./polymarket.ts";
import type { IndexedEvent, Source, SourceName } from "./types.ts";

export const SOURCES: Source[] = [kalshi, polymarket];

export function sourceFor(name: SourceName): Source {
  const s = SOURCES.find((x) => x.name === name);
  if (!s) throw new Error(`Unknown source: ${name}`);
  return s;
}

interface IndexFile {
  fetchedAt: number;
  events: IndexedEvent[];
}

/** Load the event index from disk, refreshing it from every source when older than maxAgeMs. */
export async function loadIndex(
  file: string,
  maxAgeMs: number,
  log: (msg: string) => void = () => {},
  sources: Source[] = SOURCES,
): Promise<IndexedEvent[]> {
  let cached: IndexFile | undefined;
  try {
    cached = JSON.parse(await readFile(file, "utf8")) as IndexFile;
  } catch {
    // no cache yet
  }
  const complete = cached && sources.every((s) => cached.events.some((e) => e.source === s.name));
  if (cached && complete && Date.now() - cached.fetchedAt < maxAgeMs) return cached.events;

  log("Refreshing event index…");
  const events: IndexedEvent[] = [];
  let anyFresh = false;
  for (const s of sources) {
    try {
      const fresh = await s.fetchOpenEvents();
      events.push(...fresh);
      anyFresh = true;
      log(`Indexed ${fresh.length} open ${s.label} events.`);
    } catch (err) {
      // One source being down must not take the others with it: keep its last known events.
      const stale = cached?.events.filter((e) => e.source === s.name) ?? [];
      events.push(...stale);
      log(`${s.label} refresh failed (${(err as Error).message}); kept ${stale.length} cached events.`);
    }
  }
  if (events.length === 0) throw new Error("No events could be loaded from any source.");
  if (anyFresh) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), events } satisfies IndexFile));
  }
  return events;
}
