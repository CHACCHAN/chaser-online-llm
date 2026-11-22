/**
 * measure-turn-timeout — 1ターンの許容思考時間をサーバで実測する（agent/SETUP.md §1-4）。
 *
 * 使い方: bun agent/tools/measure-turn-timeout.ts --room 3 --delays 5,15,30,60,90,120 [--phase CMD1|CMD2]
 * 手は既定ソルバーで決め、指定ターンから順に「手を送る前に delay 秒待つ」。切断されたらその遅延で終了。
 * 出力: 各ターンの JSON 行と、最後に {"result": {...}} の1行。
 * 注意: 実サーバに接続し、計測した試合は低得点になる。
 */
import { parseArgs } from "node:util";
import { Client } from "../../src/client";
import { WorldMap } from "../../src/memory/world-map";
import { makePlannerPolicy } from "../../src/solver/policy";

// 手は方策（経路探索。active-solver.ts は 2026-11-22 に外した）
const planner = makePlannerPolicy();
const decideTurnAction = (wm: Parameters<typeof planner>[0], phase: "CMD1" | "CMD2", turn: number) => planner(wm, phase, turn, { totalTurns: null });
import { GameOver } from "../../src/tools";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    room: { type: "string", default: "3" },
    delays: { type: "string", default: "5,15,30,60,90,120" },
    phase: { type: "string", default: "CMD1" },
  },
});
const room = Number(values.room);
const delays = String(values.delays).split(",").map(Number);
const delayPhase = values.phase === "CMD2" ? "CMD2" : "CMD1";

const out = (o: unknown) => console.log(JSON.stringify(o));
const client = new Client({ retryIntervalMs: 250 });
const map = new WorldMap();
await client.login();
await client.enterRoom(room);

let lastOkDelay = 0;
let failedDelay: number | null = null;
let failReason: string | null = null;
let turn = 1;

try {
  for (; ; turn++) {
    // ターン1は通常進行、ターン2以降で遅延を順に試す
    const delaySec = turn >= 2 ? delays[turn - 2] ?? null : 0;
    if (delaySec === null) break;

    for (const phase of ["CMD1", "CMD2"] as const) {
      const cmd =
        phase === "CMD1" && turn === 1 ? "gr" : decideTurnAction(map, phase, turn).command;
      if (phase === delayPhase && delaySec > 0) await Bun.sleep(delaySec * 1000);
      const t0 = Date.now();
      const r = phase === "CMD1" ? await client.command1(cmd) : await client.command2(cmd);
      map.applyObservation(phase, cmd, r.values, turn);
      out({ turn, phase, cmd, delaySec: phase === delayPhase ? delaySec : 0, responseMs: Date.now() - t0 });
    }
    await client.command3("#");
    if (delaySec > 0) lastOkDelay = delaySec;
  }
} catch (err) {
  failReason = err instanceof Error ? err.message : String(err);
  failedDelay = turn >= 2 ? delays[turn - 2] ?? null : 0;
  out({ turn, error: failReason, gameOver: err instanceof GameOver });
}

out({
  result: {
    room,
    delayPhase,
    turnsPlayed: turn,
    maxSurvivedDelaySec: lastOkDelay,
    failedAtDelaySec: failedDelay,
    failReason,
    note:
      failedDelay === null
        ? "全遅延で切断なし"
        : "failedAtDelaySec で切断。ただし試合の自然終了（規定ターン数）と区別すること",
  },
});
process.exit(0);
