import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { KNOWLEDGE_DIR } from "../paths";
import { hostUrl, numSetting } from "../settings";

export interface OfficialVersionCheck {
  /** 公式トップに表示されているバージョン（取れなければ null） */
  version: string | null;
  /** knowledge/server.json に記録しているバージョン */
  knownVersion: string | null;
  /** 両方取れていて違う */
  changed: boolean;
  error: string | null;
}

const SERVER_JSON = path.join(KNOWLEDGE_DIR, "server.json");

/**
 * 公式トップ（ログイン不要の公開ページ）の `ver XXXXXXXX` を読み、knowledge/server.json の記録と比べる。
 * 変わっていたら、アイテムID・コマンド・ルールが変わった可能性がある（knowledge/ や CLAUDE.md の見直しが必要）。
 */
export async function checkOfficialVersion(): Promise<OfficialVersionCheck> {
  let knownVersion: string | null = null;
  try {
    if (existsSync(SERVER_JSON)) knownVersion = (JSON.parse(readFileSync(SERVER_JSON, "utf-8")) as { version?: string }).version ?? null;
  } catch {
    // 読めなければ比較しない
  }
  // HOST_URL は .../CHaserOnline003/user/ なので、その1つ上が公式トップ
  const top = new URL("../", hostUrl().endsWith("/") ? hostUrl() : `${hostUrl()}/`).toString();
  try {
    const res = await fetch(top, { signal: AbortSignal.timeout(numSetting("CHASER_WEB_MAP_TIMEOUT_SEC", { min: 1 }) * 1000) });
    const html = new TextDecoder("shift_jis").decode(await res.arrayBuffer());
    const version = html.match(/ver\s*(\d{6,})/)?.[1] ?? null;
    return { version, knownVersion, changed: version !== null && knownVersion !== null && version !== knownVersion, error: version ? null : "バージョン表記が見つからない" };
  } catch (err) {
    return { version: null, knownVersion, changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}
