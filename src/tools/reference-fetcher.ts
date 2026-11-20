import { extractVisibleLines } from "../client/parser";
import { loadTilesKnowledge } from "../memory/knowledge-store";

const DEFAULT_HOST_URL = "http://www7019ug.sakura.ne.jp/CHaserOnline003/user/";
const shiftJisDecoder = new TextDecoder("shift_jis");

export interface ReferenceLookupInput {
  query?: string;
  tileId?: number;
  url?: string;
}

export interface ReferenceLookupResult {
  ok: boolean;
  tileKnowledge?: unknown;
  fetchedUrl?: string;
  matchedLines: string[];
  notes: string[];
}

export async function consultReference(
  input: ReferenceLookupInput,
): Promise<ReferenceLookupResult> {
  const notes: string[] = [];
  const matchedLines: string[] = [];
  const tilesDb = loadTilesKnowledge();

  let tileKnowledge: unknown = undefined;
  if (input.tileId !== undefined) {
    const key = String(input.tileId);
    if (tilesDb[key]) {
      tileKnowledge = tilesDb[key];
      notes.push(`Tile ${input.tileId} found in local tiles.json`);
    } else {
      notes.push(`Tile ${input.tileId} is not yet registered in local tiles.json`);
    }
  }

  const rawHost = Bun.env.HOST_URL || DEFAULT_HOST_URL;
  const userBase = rawHost.endsWith("/") ? rawHost : `${rawHost}/`;
  const serverBase = new URL("../Server/", userBase);
  const rootBase = new URL("../", userBase);

  const targetUrls: string[] = [];
  if (input.url) {
    targetUrls.push(input.url);
  } else if (Bun.env.CHASER_REFERENCE_URL) {
    targetUrls.push(Bun.env.CHASER_REFERENCE_URL);
  }
  targetUrls.push(
    rootBase.toString(),
    serverBase.toString(),
    userBase,
  );

  const searchTerms: string[] = [];
  if (input.query) {
    searchTerms.push(...input.query.split(/\s+/).filter(Boolean));
  }
  if (input.tileId !== undefined) {
    searchTerms.push(String(input.tileId));
  }

  let fetchedUrl: string | undefined;

  for (const url of targetUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      let html = new TextDecoder("utf-8").decode(buf);
      if (html.includes("Shift_JIS") || html.includes("shift_jis") || html.includes("")) {
        html = shiftJisDecoder.decode(buf);
      }
      const lines = extractVisibleLines(html);
      if (lines.length === 0) continue;

      fetchedUrl = url;
      if (searchTerms.length === 0) {
        matchedLines.push(...lines.slice(0, 25));
      } else {
        for (const line of lines) {
          if (searchTerms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) {
            matchedLines.push(`[${url}] ${line}`);
          }
        }
      }
      if (matchedLines.length >= 25) break;
    } catch {
      // ignore unreachable URLs
    }
  }

  return {
    ok: true,
    tileKnowledge,
    fetchedUrl,
    matchedLines: matchedLines.slice(0, 30),
    notes,
  };
}
