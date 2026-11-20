import { getRoomProfile, saveRoomProfile } from "../memory/knowledge-store";

const DEFAULT_HOST_URL = "http://www7019ug.sakura.ne.jp/CHaserOnline003/user/";
const shiftJisDecoder = new TextDecoder("shift_jis");

export interface LiveMapScore {
  actionPoint: number;
  itemPoint: number;
  putPoint: number;
  putDamage: number;
  totalScore: number;
}

export interface WebMapScrapeResult {
  found: boolean;
  sourceUrl: string | null;
  method: "playwright" | "http" | "none";
  stageName: string | null;
  turn: number | null;
  grid: number[][] | null;
  dimensions: [number, number] | null;
  playerPos: [number, number] | null;
  liveScore: LiveMapScore | null;
  error?: string;
}

/**
 * CHaserOnline003 の MapView / WorldMap HTML（または汎用テーブルHTML）から
 * 2次元マップ配列、自機座標、ステージ名、リアルタイムスコアを抽出する。
 */
export function parseGridFromHtml(
  html: string,
  playerUser?: string,
): {
  grid: number[][] | null;
  playerPos: [number, number] | null;
  stageName: string | null;
  turn: number | null;
  liveScore: LiveMapScore | null;
} {
  const stageName =
    html.match(/対戦マップビュー[\s\S]*?\[([^\]]+)\]/i)?.[1]?.trim() ??
    (html.includes("World Map") ? "WorldMap" : null);

  const turnMatch = html.match(/turn\s*=\s*(\d+)/i)?.[1];
  const turn = turnMatch ? Number(turnMatch) : null;

  // プレイヤーのタイル番号 (例: 1000) とリアルタイムスコア (A:... I:... P:... PD:... T:...) を抽出
  let playerTileId = 1000;
  let liveScore: LiveMapScore | null = null;

  if (playerUser) {
    const escapedUser = playerUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const playerBlockRegex = new RegExp(
      `\\[<img[^>]+/img/(\\d+)\\.(?:gif|png|jpg)[^>]*>[\\s\\S]{0,120}?${escapedUser}([\\s\\S]{0,200}?)\\]`,
      "i",
    );
    const pm = html.match(playerBlockRegex);
    if (pm) {
      if (pm[1]) playerTileId = Number(pm[1]);
      const scoreBlock = pm[2] ?? "";
      const a = scoreBlock.match(/A:(-?\d+)/)?.[1];
      const i = scoreBlock.match(/I:(-?\d+)/)?.[1];
      const p = scoreBlock.match(/P:(-?\d+)/)?.[1];
      const pd = scoreBlock.match(/PD:(-?\d+)/)?.[1];
      const t = scoreBlock.match(/T:(-?\d+)/)?.[1];
      if (a !== undefined && i !== undefined && t !== undefined) {
        liveScore = {
          actionPoint: Number(a),
          itemPoint: Number(i),
          putPoint: Number(p ?? 0),
          putDamage: Number(pd ?? 0),
          totalScore: Number(t),
        };
      }
    }
  }

  // MapView の <table cellpadding="0" cellspacing="0"> は `<tr></tr><tr><td>...` のように
  // 閉じタグと開きタグが連続する箇所があるため `<tr[^>]*>` または `</tr>` で行分割して抽出する
  const tableRows: number[][] = [];
  let detectedPlayerPos: [number, number] | null = null;

  const rowChunks = html.split(/<\/?tr[^>]*>/i);
  for (const chunk of rowChunks) {
    if (!chunk.includes("<td") && !chunk.includes("<TD") && !chunk.includes("<th")) continue;
    const row: number[] = [];
    let colIdx = 0;

    for (const tdMatch of chunk.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      const attrs = tdMatch[1] ?? "";
      const cellHtml = tdMatch[2] ?? "";

      // ネストした別テーブルを含む外枠 <td> はスキップ
      if (/<table\b/i.test(cellHtml)) continue;

      const text = cellHtml
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .trim();

      if (
        playerUser &&
        (cellHtml.includes(playerUser) || attrs.includes(playerUser))
      ) {
        detectedPlayerPos = [colIdx, tableRows.length];
      }

      // 1) セルが純粋な整数
      if (/^-?\d+$/.test(text)) {
        const val = Number(text);
        if (val === playerTileId) {
          detectedPlayerPos = [colIdx, tableRows.length];
        }
        row.push(val);
        colIdx += 1;
        continue;
      }

      // 2) CHaserOnline003 標準の /img/012.gif, /img/001000.gif, tile_12.png 等からタイル番号を抽出
      const imgNum =
        cellHtml.match(/\/img\/0*(\d+)\.(?:gif|png|jpg|jpeg|svg)/i)?.[1] ??
        cellHtml.match(/(?:tile|map|chip|block|img|cell)[_-]?0*(\d+)\.(?:png|gif|jpg|jpeg|svg)/i)?.[1] ??
        attrs.match(/data-(?:tile|val|id)\s*=\s*["']?(-?\d+)/i)?.[1];

      if (imgNum !== undefined) {
        const val = Number(imgNum);
        if (val === playerTileId || (detectedPlayerPos === null && val >= 1000)) {
          detectedPlayerPos = [colIdx, tableRows.length];
        }
        row.push(val);
        colIdx += 1;
      }
    }

    if (row.length >= 5) {
      tableRows.push(row);
    }
  }

  if (tableRows.length >= 5) {
    const freq = new Map<number, number>();
    for (const r of tableRows) {
      freq.set(r.length, (freq.get(r.length) ?? 0) + 1);
    }
    let bestWidth = 0;
    let bestCount = 0;
    for (const [w, c] of freq.entries()) {
      if (c > bestCount && w >= 5) {
        bestWidth = w;
        bestCount = c;
      }
    }
    const uniformRows = tableRows.filter((r) => r.length === bestWidth);
    if (uniformRows.length >= 5) {
      // uniformRows フィルタ後の正確な自機座標を再計算
      let finalPlayerPos: [number, number] | null = detectedPlayerPos;
      for (let ry = 0; ry < uniformRows.length; ry++) {
        const r = uniformRows[ry]!;
        for (let rx = 0; rx < r.length; rx++) {
          if (r[rx] === playerTileId) {
            finalPlayerPos = [rx, ry];
            break;
          }
        }
      }
      return {
        grid: uniformRows,
        playerPos: finalPlayerPos,
        stageName,
        turn,
        liveScore,
      };
    }
  }

  return {
    grid: null,
    playerPos: null,
    stageName,
    turn,
    liveScore,
  };
}

/**
 * CHaserOnline003 Server の公式セッションフロー:
 * 1) Server/MapView.jsp → UserCheck?select=mapview (2段階セッション遷移) でリアルタイム対戦マップを取得
 * 2) 取得できない場合は vsResultViewWorld.jsp → UserCheckWorld → listWorldvsresult で World Map を取得
 */
async function tryScrapeChaserServerHttp(
  serverBase: URL,
  playerUser?: string,
  explicitUrl?: string,
): Promise<WebMapScrapeResult> {
  let cookie: string | null = null;
  const user = Bun.env.CHASER_USER ?? "";
  const pass = Bun.env.CHASER_PASS ?? "";

  const fetchWithSession = async (target: string): Promise<string> => {
    let current = target;
    for (let hop = 0; hop < 8; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        headers: cookie ? { Cookie: cookie } : {},
        signal: AbortSignal.timeout(5000),
      });
      const m = res.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
      if (m?.[1]) cookie = `JSESSIONID=${m[1]}`;
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return shiftJisDecoder.decode(await res.arrayBuffer());
    }
    throw new Error("Too many redirects");
  };

  // 明示指定 URL があれば最初に試す
  if (explicitUrl) {
    try {
      const html = await fetchWithSession(explicitUrl);
      const parsed = parseGridFromHtml(html, playerUser);
      if (parsed.grid && parsed.grid.length >= 5) {
        return {
          found: true,
          sourceUrl: explicitUrl,
          method: "http",
          stageName: parsed.stageName,
          turn: parsed.turn,
          grid: parsed.grid,
          dimensions: [parsed.grid[0]?.length ?? 0, parsed.grid.length],
          playerPos: parsed.playerPos,
          liveScore: parsed.liveScore,
        };
      }
    } catch {
      // continue to standard flow
    }
  }

  // Flow 1: リアルタイム対戦マップビュー (MapView.jsp -> UserCheck?select=mapview x2)
  if (user && pass) {
    try {
      const mapViewUrl = new URL("MapView.jsp", serverBase).toString();
      await fetchWithSession(mapViewUrl);

      const loginUrl = new URL("UserCheck", serverBase);
      loginUrl.searchParams.set("user", user);
      loginUrl.searchParams.set("pass", pass);
      loginUrl.searchParams.set("select", "mapview");

      // 1回目でログインフォーム状態へ遷移、2回目で認証完了＆マップHTML取得
      let html = await fetchWithSession(loginUrl.toString());
      if (html.includes('name="select" value="mapview"') || !html.includes("/img/")) {
        html = await fetchWithSession(loginUrl.toString());
      }

      const parsed = parseGridFromHtml(html, playerUser);
      if (parsed.grid && parsed.grid.length >= 5) {
        return {
          found: true,
          sourceUrl: mapViewUrl,
          method: "http",
          stageName: parsed.stageName,
          turn: parsed.turn,
          grid: parsed.grid,
          dimensions: [parsed.grid[0]?.length ?? 0, parsed.grid.length],
          playerPos: parsed.playerPos,
          liveScore: parsed.liveScore,
        };
      }
    } catch {
      // fallback to Flow 2
    }

    // Flow 2: World表示 (vsResultViewWorld.jsp -> UserCheckWorld -> listWorldvsresult)
    try {
      cookie = null;
      await fetchWithSession(new URL("vsResultViewWorld.jsp", serverBase).toString());

      const worldLoginUrl = new URL("UserCheckWorld", serverBase);
      worldLoginUrl.searchParams.set("user", user);
      worldLoginUrl.searchParams.set("pass", pass);
      worldLoginUrl.searchParams.set("select", "vsresultview");
      await fetchWithSession(worldLoginUrl.toString());

      const listWorldUrl = new URL("listWorldvsresult", serverBase);
      listWorldUrl.searchParams.set("endDate", "2027-12-31");
      listWorldUrl.searchParams.set("endTime", "23:59:59");
      const worldHtml = await fetchWithSession(listWorldUrl.toString());

      const parsed = parseGridFromHtml(worldHtml, playerUser);
      if (parsed.grid && parsed.grid.length >= 5) {
        return {
          found: true,
          sourceUrl: listWorldUrl.toString(),
          method: "http",
          stageName: parsed.stageName,
          turn: parsed.turn,
          grid: parsed.grid,
          dimensions: [parsed.grid[0]?.length ?? 0, parsed.grid.length],
          playerPos: parsed.playerPos,
          liveScore: parsed.liveScore,
        };
      }
    } catch {
      // ignore
    }
  }

  return {
    found: false,
    sourceUrl: null,
    method: "none",
    stageName: null,
    turn: null,
    grid: null,
    dimensions: null,
    playerPos: null,
    liveScore: null,
  };
}

/**
 * 指定されたルームに対して CHaserOnline003 サーバの Web マップ（対戦マップビュー / World表示）を取得する。
 */
export async function scrapeRoomWebMap(options: {
  room: number;
  webMapUrl?: string;
}): Promise<WebMapScrapeResult> {
  const rawHost = Bun.env.HOST_URL || DEFAULT_HOST_URL;
  const userBase = rawHost.endsWith("/") ? rawHost : `${rawHost}/`;
  const serverBase = new URL("../Server/", userBase);
  const playerUser = Bun.env.CHASER_USER;

  const result = await tryScrapeChaserServerHttp(
    serverBase,
    playerUser,
    options.webMapUrl,
  );

  const profile = getRoomProfile(options.room);
  profile.webMapAvailable = result.found;
  if (result.found && result.sourceUrl) {
    profile.webMapUrl = result.sourceUrl;
  }
  if (result.dimensions) {
    profile.mapDimensions = result.dimensions;
  }
  saveRoomProfile(profile);

  return result;
}
