import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "../paths";
import { endKind, listRunStats, roomStats } from "./stats";

test("統計: 試合の記録から得点・ずれ・LLM の回数と動かした手を読み、ルームごとにまとめる", () => {
  const dir = path.join(RUNS_DIR, "2026-01-02T03-04-05_room98765");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      runId: "2026-01-02T03-04-05_room98765", room: 98765, turns: 10, startedAt: "2026-01-02T03:04:05Z", gameOverReason: "HTTP 500", policyModel: "hunter",
      estimatedScore: { estimatedTotalScore: 5000 },
      officialResult: { totalScore: 1000, acquiredTurns: 10, itemPoint: 3000, actionPoint: -100, putPoint: 0, putDamage: -4000 },
      agent: { enabled: true, model: "m", effort: "low", usage: { total: { calls: 4, costUsd: 0.123, inputTokens: 10, outputTokens: 5 } } },
    }),
  );
  writeFileSync(
    path.join(dir, "turns.jsonl"),
    [
      { turn: 1, cmd1: "gr", cmd2: "wu", cmd1Source: "solver", cmd2Source: "solver", cmd2Reason: "指定の目標 (1,1)" },
      { turn: 2, cmd1: "grd", cmd2: "wd", cmd1Source: "main", cmd2Source: "solver", cmd2Reason: "回収" },
    ].map((o) => JSON.stringify(o)).join("\n"),
  );
  const run = listRunStats().find((r) => r.room === 98765)!;
  expect(run.official).toBe(1000);
  expect(run.gap).toBe(-4000);
  expect(run.perTurn).toBe(100);
  expect(run.putDamage).toBe(-4000);
  expect(run.llm).toMatchObject({ calls: 4, costUsd: 0.12, directedPhases: 2, phases: 4 });
  const room = roomStats([run]).find((r) => r.room === 98765)!;
  expect(room).toMatchObject({ matches: 1, avgPerTurn: 100, putDamage: -4000, endReasons: { "HTTP N": 1 } });
  expect(endKind("Reached --max-turns (1)")).toBe("Reached --max-turns");
});
