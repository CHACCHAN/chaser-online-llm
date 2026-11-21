import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "./client";
import { extractVisibleLines, parseReturnCode } from "./parser";
import { parseVsResultTable } from "./result";
import { GameOver, GeneralError, LoginError } from "../tools";

const originalFetch = globalThis.fetch;
const originalHostUrl = Bun.env.HOST_URL;
const originalUser = Bun.env.CHASER_USER;
const originalPass = Bun.env.CHASER_PASS;

function htmlResponse(
  html: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(html, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

describe("parser", () => {
  test("parses 9-element ReturnCode", () => {
    const body = "<html>ReturnCode=0,2,3,2,1000,2,1,0,12<br></html>";
    const parsed = parseReturnCode(body);
    expect(parsed.raw).toBe("0,2,3,2,1000,2,1,0,12");
    expect(parsed.values).toEqual([0, 2, 3, 2, 1000, 2, 1, 0, 12]);
  });

  test("parses 10-element ReturnCode with whitespace", () => {
    const body = "ReturnCode= 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 \r\n";
    const parsed = parseReturnCode(body);
    expect(parsed.raw).toBe("1, 2, 3, 4, 5, 6, 7, 8, 9, 10");
    expect(parsed.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("returns null values for malformed or missing ReturnCode", () => {
    expect(parseReturnCode("ReturnCode=abc,1").values).toBeNull();
    expect(parseReturnCode("ReturnCode=")).toEqual({ raw: null, values: null });
    expect(parseReturnCode("<html>no code</html>")).toEqual({
      raw: null,
      values: null,
    });
  });

  test("extractVisibleLines strips tags and keeps readable lines", () => {
    const lines = extractVisibleLines(
      "<html><body><h1>Title</h1><p>Turn: 1<br>Score: 120</p></body></html>",
    );
    expect(lines).toEqual(["Title", "Turn: 1", "Score: 120"]);
  });
});

describe("Client", () => {
  beforeEach(() => {
    Bun.env.HOST_URL = "http://example.test/CHaserOnline003/user/";
    Bun.env.CHASER_USER = "test_user";
    Bun.env.CHASER_PASS = "test_pass";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.env.HOST_URL = originalHostUrl;
    Bun.env.CHASER_USER = originalUser;
    Bun.env.CHASER_PASS = originalPass;
  });

  test("completes login -> enterRoom -> command1 -> command2 -> command3 with polling", async () => {
    const calls: { url: string; cookie: string | null }[] = [];
    let getReadyCount = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      calls.push({ url, cookie: headers.get("Cookie") });

      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname.split("/").pop() ?? "";

      if (path === "") {
        return htmlResponse('<form action="UserCheck"><input name="user"><input name="pass"></form>', {
          headers: { "set-cookie": "JSESSIONID=ABC123; Path=/CHaserOnline003" },
        });
      }
      if (path === "UserCheck") {
        return htmlResponse('<form action="RoomNumberCheck"><input name="roomNumber"></form>');
      }
      if (path === "RoomNumberCheck") {
        return htmlResponse('<form action="GetReadyCheck">command1=<input name="command1"></form>');
      }
      if (path === "GetReadyCheck") {
        getReadyCount += 1;
        if (getReadyCount === 1) {
          // まだ待機中（command1= フォームが残っている）
          return htmlResponse('waiting... command1=<input name="command1" value="gr">');
        }
        return htmlResponse(
          'ReturnCode=2,3,2,0,1000,1,2,2,2<br><form action="CommandCheck">command2=<input name="command2"></form>',
        );
      }
      if (path === "CommandCheck") {
        return htmlResponse(
          'ReturnCode=2,3,2,0,1000,0,2,2,2<br><form action="EndCommandCheck">command3=<input name="command3"></form>',
        );
      }
      if (path === "EndCommandCheck") {
        return htmlResponse('<form action="GetReadyCheck">command1=<input name="command1"></form>');
      }
      return htmlResponse("Not Found", { status: 404 });
    }) as unknown as typeof fetch;

    const client = new Client({ retryIntervalMs: 1, maxWaitMs: 1000 });
    await client.login();
    expect(client.getStatus.game.phase).toBe("LOGGED_IN");

    await client.enterRoom(3);
    expect(client.getStatus.game.phase).toBe("READY_CMD1");
    expect(client.getStatus.game.turn).toBe(1);

    const r1 = await client.command1("gr");
    expect(getReadyCount).toBe(2);
    expect(r1.values).toEqual([2, 3, 2, 0, 1000, 1, 2, 2, 2]);
    expect(client.getStatus.game.phase).toBe("READY_CMD2");

    const r2 = await client.command2("wr");
    expect(r2.values).toEqual([2, 3, 2, 0, 1000, 0, 2, 2, 2]);
    expect(client.getStatus.game.phase).toBe("READY_CMD3");

    await client.command3("#");
    expect(client.getStatus.game.phase).toBe("READY_CMD1");
    expect(client.getStatus.game.turn).toBe(2);

    expect(calls[1]?.cookie).toBe("JSESSIONID=ABC123");
    expect(calls.some((c) => c.url.includes("GetReadyCheck?command1=gr"))).toBe(true);
    expect(calls.some((c) => c.url.includes("CommandCheck?command2=wr"))).toBe(true);
    expect(calls.some((c) => c.url.includes("EndCommandCheck?command3=%23"))).toBe(true);
  });

  test("follows redirects and enforces phase guards", async () => {
    let step = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      step += 1;
      if (step === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "/CHaserOnline003/user/index.jsp",
            "set-cookie": "JSESSIONID=REDIR999; Path=/",
          },
        });
      }
      if (url.endsWith("index.jsp")) {
        return htmlResponse("ok");
      }
      return htmlResponse('<form action="RoomNumberCheck">roomNumber=</form>');
    }) as unknown as typeof fetch;

    const client = new Client({ retryIntervalMs: 1 });
    await expect(client.enterRoom(3)).rejects.toThrow(GeneralError);

    await client.login();
    expect(client.getStatus.webRelease.cookie).toBe("JSESSIONID=REDIR999");

    await expect(client.command1("gr")).rejects.toThrow(GeneralError);
  });

  test("throws LoginError when login form persists", async () => {
    globalThis.fetch = (async () =>
      htmlResponse('user=<input name="user"> pass=<input name="pass">')
    ) as unknown as typeof fetch;

    const client = new Client({ retryIntervalMs: 1 });
    await expect(client.login()).rejects.toThrow(LoginError);
  });

  test("throws GameOver on user= redirect-back or HTTP 500", async () => {
    let mode: "user_form" | "http_500" = "user_form";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("UserCheck")) return htmlResponse("logged in");
      if (url.includes("RoomNumberCheck")) return htmlResponse("command1=<input>");
      if (url.includes("GetReadyCheck")) {
        if (mode === "http_500") return htmlResponse("err", { status: 500 });
        return htmlResponse('session expired user=<input name="user">');
      }
      return htmlResponse("ok");
    }) as unknown as typeof fetch;

    const client1 = new Client({ retryIntervalMs: 1 });
    await client1.login();
    await client1.enterRoom(3);
    await expect(client1.command1("gr")).rejects.toThrow(GameOver);
    expect(client1.getStatus.game.phase).toBe("GAME_OVER");

    mode = "http_500";
    const client2 = new Client({ retryIntervalMs: 1 });
    await client2.login();
    await client2.enterRoom(3);
    await expect(client2.command1("gr")).rejects.toThrow(GameOver);
    expect(client2.getStatus.game.phase).toBe("GAME_OVER");
  });

  test("preserves READY_CMD2 on command2 timeout so caller can recover with another command", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url).pathname.split("/").pop() ?? "";
      if (path === "UserCheck") return htmlResponse("logged in");
      if (path === "RoomNumberCheck") return htmlResponse("command1=<input>");
      if (path === "GetReadyCheck") return htmlResponse("ReturnCode=0,0,0,0,1000,0,0,0,0<br>command2=<input>");
      if (path === "CommandCheck") {
        if (url.includes("command2=sr")) {
          return htmlResponse("command2=<input>");
        }
        return htmlResponse("ReturnCode=0,0,0,0,0,0,0,0,0<br>command3=<input>");
      }
      if (path === "EndCommandCheck") {
        return htmlResponse("command1=<input>");
      }
      return htmlResponse("ok");
    }) as unknown as typeof fetch;

    const client = new Client({ retryIntervalMs: 5, maxWaitMs: 500 });
    await client.login();
    await client.enterRoom(3);
    await client.command1("gr");
    expect(client.getStatus.game.phase).toBe("READY_CMD2");

    await expect(client.command2("sr", 20)).rejects.toThrow(GeneralError);
    expect(client.getStatus.game.phase).toBe("READY_CMD2");

    const recovered = await client.command2("wr");
    expect(recovered.values).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(client.getStatus.game.phase).toBe("READY_CMD3");

    await client.command3("#");
    expect(client.getStatus.game.phase).toBe("READY_CMD1");
    expect(client.getStatus.game.turn).toBe(2);
  });
  test("他プレイヤー待ち: 待機を UI に通知し、停止要求で打ち切れる", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url).pathname.split("/").pop() ?? "";
      if (path === "") return htmlResponse("<form></form>");
      if (path === "UserCheck") return htmlResponse('<form action="RoomNumberCheck"><input name="roomNumber"></form>');
      if (path === "RoomNumberCheck") return htmlResponse('<form action="GetReadyCheck">command1=<input name="command1"></form>');
      // ずっと待機中（相手がまだ手を打っていない）
      return htmlResponse('waiting... command1=<input name="command1">');
    }) as unknown as typeof fetch;

    const waits: number[] = [];
    let stop = false;
    const client = new Client({
      retryIntervalMs: 5,
      maxWaitMs: 60_000,
      onWaiting: ({ elapsedMs }) => {
        waits.push(elapsedMs);
        if (waits.length >= 3) stop = true;
      },
      shouldAbortWait: () => stop,
    });
    await client.login();
    await client.enterRoom(3);
    await expect(client.command1("gr")).rejects.toThrow(/Stopped while waiting/);
    expect(waits.length).toBe(3);
  });
});

describe("parseVsResultTable", () => {
  test("extracts latest matching result including rowspan/omitted room number rows", () => {
    const html = `
      <table border="1">
        <tr>
          <td>ルーム番号</td><td>開始</td><td>終了</td><td>接続順</td><td>ユーザ名</td>
          <td>取得ターン数</td><td>残りターン数</td><td>合計得点</td><td>動作得点</td>
          <td>アイテム得点</td><td>プット得点</td><td>プットダメージ</td>
        </tr>
        <tr>
          <td>1</td><td>2026-11-19 10:57:30.895</td><td>2026-11-19 11:02:54.621</td>
          <td>1</td><td>3416kancho_fkmt</td><td>10</td><td>0</td><td>2420</td>
          <td>-210</td><td>-370</td><td>0</td><td>0</td>
        </tr>
        <tr>
          <td>3</td><td>2026-11-20 12:23:36.88</td><td>2026-11-20 12:27:18.765</td>
          <td>1</td><td>3416kancho_fkmt</td><td>6</td><td>4</td><td>370</td>
          <td>-1270</td><td>-160</td><td>0</td><td>0</td>
        </tr>
        <tr>
          <td>\u3000</td><td>2026-11-20 12:31:51.197</td><td>2026-11-20 12:32:52.54</td>
          <td>1</td><td>3416kancho_fkmt</td><td>10</td><td>0</td><td>720</td>
          <td>-1350</td><td>-930</td><td>0</td><td>0</td>
        </tr>
      </table>
    `;

    const resRoom3 = parseVsResultTable(html, "3416kancho_fkmt", 3);
    expect(resRoom3).toEqual({
      room: "3",
      startedAt: "2026-11-20 12:31:51.197",
      endedAt: "2026-11-20 12:32:52.54",
      acquiredTurns: 10,
      remainingTurns: 0,
      totalScore: 720,
      actionPoint: -1350,
      itemPoint: -930,
      putPoint: 0,
      putDamage: 0,
    });

    const resRoom1 = parseVsResultTable(html, "3416kancho_fkmt", "1");
    expect(resRoom1?.totalScore).toBe(2420);
    expect(parseVsResultTable(html, "other_user")).toBeNull();
  });
});

test("CHaser サーバが応答しない時は CHASER_HTTP_TIMEOUT_SEC で打ち切り、停止ボタンでも中断できる", async () => {
  const { Base } = await import("./base");
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((_u: string, init?: RequestInit) =>
    new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
  try {
    const b = new Base();
    const p = b.getReq("x", {});
    setTimeout(() => b.abort(), 20);
    await expect(p).rejects.toThrow("停止ボタン");
    Bun.env.CHASER_HTTP_TIMEOUT_SEC = "0.05";
    const b2 = new Base();
    await expect(b2.getReq("x", {})).rejects.toThrow("応答しない");
  } finally {
    globalThis.fetch = origFetch;
    delete Bun.env.CHASER_HTTP_TIMEOUT_SEC;
  }
});

test("公式成績は取得ターン数がこの試合と合う時だけ使う（前の対戦の行を取り違えない）", async () => {
  const { isResultForRun } = await import("./result");
  const r = { room: "586", startedAt: "2026-11-22 00:31:03.353", endedAt: "2026-11-22 00:51:35.025", acquiredTurns: 147, remainingTurns: 0, totalScore: 96055, actionPoint: 0, itemPoint: 0, putPoint: 0, putDamage: 0 };
  expect(isResultForRun(r, 147)).toBe(true);
  expect(isResultForRun(r, 148)).toBe(true);
  expect(isResultForRun(r, 1)).toBe(false);
  // 前の試合で使った行（開始時刻が同じ）は、ターン数が同じでも使わない
  expect(isResultForRun(r, 147, r.startedAt)).toBe(false);
  expect(isResultForRun(r, 147, "2026-11-21 23:00:00.000")).toBe(true);
});
