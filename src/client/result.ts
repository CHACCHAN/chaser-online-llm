const DEFAULT_HOST_URL = "http://www7019ug.sakura.ne.jp/CHaserOnline003/user/";
const shiftJisDecoder = new TextDecoder("shift_jis");

export interface OfficialResult {
  room: string;
  startedAt: string;
  endedAt: string;
  acquiredTurns: number;
  remainingTurns: number;
  totalScore: number;
  actionPoint: number;
  itemPoint: number;
  putPoint: number;
  putDamage: number;
}

/**
 * listvsresult の HTML テーブルから指定ユーザ（および任意でルーム番号）の最新公式成績を抽出する。
 */
export function parseVsResultTable(
  html: string,
  userName: string,
  roomNumber?: string | number,
): OfficialResult | null {
  const roomFilter = roomNumber !== undefined ? String(roomNumber) : null;
  let currentRoom = "";
  let currentStartedAt = "";
  let currentEndedAt = "";
  let latest: OfficialResult | null = null;

  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1] ?? "";
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      (c[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/[\s\u3000]+/g, " ")
        .trim(),
    );

    if (cells.length === 0) continue;
    const joined = cells.join(" ");
    if (joined.includes("ルーム番号") || joined.includes("合計得点")) {
      continue;
    }

    if (cells.length >= 12) {
      const roomCell = cells[0] ?? "";
      const startCell = cells[1] ?? "";
      const endCell = cells[2] ?? "";
      const userCell = cells[4] ?? "";

      if (roomCell !== "") currentRoom = roomCell;
      if (startCell !== "") currentStartedAt = startCell;
      if (endCell !== "") currentEndedAt = endCell;

      if (!userCell || userCell !== userName) continue;
      if (roomFilter !== null && currentRoom !== roomFilter) continue;

      const acquiredTurns = Number(cells[5]);
      const remainingTurns = Number(cells[6]);
      const totalScore = Number(cells[7]);
      const actionPoint = Number(cells[8]);
      const itemPoint = Number(cells[9]);
      const putPoint = Number(cells[10]);
      const putDamage = Number(cells[11]);

      if (
        [
          acquiredTurns,
          remainingTurns,
          totalScore,
          actionPoint,
          itemPoint,
          putPoint,
          putDamage,
        ].some(Number.isNaN)
      ) {
        continue;
      }

      latest = {
        room: currentRoom,
        startedAt: currentStartedAt,
        endedAt: currentEndedAt,
        acquiredTurns,
        remainingTurns,
        totalScore,
        actionPoint,
        itemPoint,
        putPoint,
        putDamage,
      };
    } else if (cells.length >= 5) {
      // 他プレイヤー行などの短縮列に対応する場合に備えた引き継ぎ処理
      const userCell = cells[1] ?? "";
      if (userCell !== userName) continue;
      if (roomFilter !== null && currentRoom !== roomFilter) continue;

      const acquiredTurns = Number(cells[2]);
      const remainingTurns = Number(cells[3]);
      const totalScore = Number(cells[4]);
      if ([acquiredTurns, remainingTurns, totalScore].some(Number.isNaN)) {
        continue;
      }

      latest = {
        room: currentRoom,
        startedAt: currentStartedAt,
        endedAt: currentEndedAt,
        acquiredTurns,
        remainingTurns,
        totalScore,
        actionPoint: Number(cells[5] ?? 0) || 0,
        itemPoint: Number(cells[6] ?? 0) || 0,
        putPoint: Number(cells[7] ?? 0) || 0,
        putDamage: Number(cells[8] ?? 0) || 0,
      };
    }
  }

  return latest;
}

/**
 * Server/vsResultView.jsp → UserCheck?select=vsresultview → listvsresult の 2段階で公式スコアを取得する。
 * 取得失敗やパース不可の場合は例外を投げず null を返す。
 */
export async function fetchLatestResult(
  roomNumber?: string | number,
): Promise<OfficialResult | null> {
  try {
    const rawHost = Bun.env.HOST_URL || DEFAULT_HOST_URL;
    const userBase = rawHost.endsWith("/") ? rawHost : `${rawHost}/`;
    const serverBase = new URL("../Server/", userBase);

    let cookie: string | null = null;

    const fetchWithSession = async (target: string): Promise<string> => {
      let current = target;
      for (let hop = 0; hop < 10; hop++) {
        const res = await fetch(current, {
          redirect: "manual",
          headers: cookie ? { Cookie: cookie } : {},
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
      throw new Error("too many redirects");
    };

    // 1. セッション取得 & UserCheck?select=vsresultview で検索フォーム HTML 取得
    await fetchWithSession(new URL("vsResultView.jsp", serverBase).toString());

    const loginUrl = new URL("UserCheck", serverBase);
    loginUrl.searchParams.set("user", Bun.env.CHASER_USER);
    loginUrl.searchParams.set("pass", Bun.env.CHASER_PASS);
    loginUrl.searchParams.set("select", "vsresultview");

    const formHtml = await fetchWithSession(loginUrl.toString());
    if (formHtml.includes("user=") && formHtml.includes("pass=")) {
      return null;
    }

    // 2. listvsresult へフォームを送信
    const listUrl = new URL("listvsresult", serverBase);
    const nowYear = new Date().getFullYear();
    const minDate = `${nowYear - 1}-01-01`;
    const maxDate = `${nowYear + 1}-12-31`;

    for (const m of formHtml.matchAll(/<input([^>]*)>/gi)) {
      const attrs = m[1] ?? "";
      const name = attrs.match(/name\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      if (!name) continue;

      const quotedVal = attrs.match(/value\s*=\s*["']([^"']*)["']/i)?.[1];
      const unquotedVal = attrs.match(/value\s*=\s*([^\s>]+)/i)?.[1];
      const val = quotedVal ?? unquotedVal ?? "";

      if (name === "minStartDate" || name === "minEndDate") {
        listUrl.searchParams.set(name, minDate);
      } else if (name === "maxStartDate" || name === "maxEndDate") {
        listUrl.searchParams.set(name, maxDate);
      } else if (
        roomNumber !== undefined &&
        (name === "minRoomNumber" || name === "maxRoomNumber")
      ) {
        listUrl.searchParams.set(name, String(roomNumber));
      } else {
        listUrl.searchParams.set(name, val);
      }
    }

    const resHtml = await fetchWithSession(listUrl.toString());
    return parseVsResultTable(resHtml, Bun.env.CHASER_USER, roomNumber);
  } catch {
    return null;
  }
}
