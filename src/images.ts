// Download the images attached to a mention and its parent post so Jev can look at them.

const MAX_IMAGES = 2;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** X serves several sizes of each image; "medium" keeps text in graphics legible without the full file. */
function sized(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "pbs.twimg.com" && !u.searchParams.has("name")) u.searchParams.set("name", "medium");
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Fetch up to two images as PNG or JPEG blobs. Anything that fails, is too large, or is in
 * another format is skipped: images are a bonus for the pick, never a reason to drop a reply.
 */
export async function fetchImages(urls: string[], log: (msg: string) => void = () => {}): Promise<Blob[]> {
  const out: Blob[] = [];
  for (const url of urls.slice(0, MAX_IMAGES)) {
    try {
      const res = await fetch(sized(url), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const type = blob.type.split(";")[0];
      if (type !== "image/jpeg" && type !== "image/png") throw new Error(`unsupported type ${type || "unknown"}`);
      if (blob.size === 0 || blob.size > MAX_BYTES) throw new Error(`size ${blob.size} bytes`);
      out.push(blob);
    } catch (err) {
      log(`Skipped image ${url}: ${(err as Error).message}`);
    }
  }
  return out;
}
