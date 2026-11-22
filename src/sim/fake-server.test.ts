import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, RUNS_DIR, SIM_MAPS_DIR } from "../paths";
import { totalScore } from "./engine";
import { startFakeServer, type FakeServer } from "./fake-server";
import { makeScenario } from "./mapgen";
import { makeRng } from "./rng";

/**
 * ハーネス全体（クライアント・Webマップ・WorldMap・方策・記録）を、シミュレータの偽サーバで1試合通す。本番サーバには触れない。
 * 試合は別のプロセス（bun src/play.ts）で行う（他のテストの mock.module が同じプロセスに残るため。本番の起動にも近い）。
 */
describe("偽サーバで1試合", () => {
  let server: FakeServer;

  beforeAll(() => {
    const scn = makeScenario(makeRng(11), { room: null });
    scn.webMap = true;
    server = startFakeServer({ port: 0, seed: 11, scenario: scn, totalTurns: 15 });
  });
  afterAll(() => server.stop());

  test("経路探索の方策で最後まで打ち、位置がずれず、罠を踏まない。地図を保存する", async () => {
    const proc = Bun.spawn(["bun", "src/play.ts", "--room", "901", "--login-wait-min", "0"], {
      cwd: PROJECT_ROOT,
      env: {
        ...Bun.env,
        HOST_URL: server.url,
        CHASER_USER: "sim",
        CHASER_PASS: "sim",
        CHASER_WEB_MAP_URL: "",
        CHASER_WEB_MAP_REFRESH: "every_turn",
        AGENT_USE_MAIN: "false",
        AGENT_PREP: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const line = out.split("\n").find((l) => l.startsWith('{"runId"'));
    expect(line).toBeDefined();
    const summary = JSON.parse(line!) as { runId: string; turns: number };
    expect(summary.turns).toBe(15);
    expect(server.game()!.over).toBe(true);

    // 最後の位置（Webマップで合わせた絶対座標）が偽サーバの本当の位置と同じ（位置がずれていない）
    const turns = (await Bun.file(path.join(RUNS_DIR, summary.runId, "turns.jsonl")).text()).trim().split("\n").map((l) => JSON.parse(l));
    const me = server.self()!;
    expect(turns.some((t) => t.globalPositionAfter)).toBe(true);
    const last = [...turns].reverse().find((t) => t.globalPositionAfter);
    if (last.turn === turns[turns.length - 1].turn) expect(last.globalPositionAfter).toEqual([me.x, me.y]);
    expect(totalScore(me.score)).toBeGreaterThan(0);
    // 罠は踏んでいない（偽サーバの本当の回数。ハーネスの数え方は端の観測で誤ることがある）
    expect(me.hazardHits).toBe(0);
    // 本物の試合と同じく、Webマップの地図を var/maps/ に保存する（シミュレータが混ぜて使う）
    expect(readdirSync(path.join(SIM_MAPS_DIR, "room901")).length).toBe(1);
  }, 90_000);
});
