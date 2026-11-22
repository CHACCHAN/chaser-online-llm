import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EVALUATOR_PATH } from "../paths";
import { verifyPolicyWithReplay } from "./replay-verifier";

function replayDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "replay-"));
  // 上が罠(4)、他は土。記録の手は動かない gr と、横に歩く wr
  const rec = (turn: number) =>
    JSON.stringify({ turn, cmd1: "gr", cmd1Values: [2, 4, 2, 2, 1000, 2, 2, 2, 2], cmd2: "wr", cmd2Values: [2, 4, 2, 2, 0, 2, 2, 2, 2] });
  writeFileSync(path.join(dir, "turns.jsonl"), [rec(1), rec(2), rec(3)].join("\n"));
  return dir;
}

test("試合の記録の盤面で方策を動かし、合法手を返し罠へ入らないことを確かめる。改修前の評価関数とも比べる", async () => {
  const res = await verifyPolicyWithReplay(replayDir(), { baselineEvaluatorCode: readFileSync(EVALUATOR_PATH, "utf-8") });
  expect(res.turnsTested).toBe(3);
  expect(res.hazardLandings).toBe(0);
  expect(res.baselineHazardLandings).toBe(0);
  expect(res.ok).toBe(true);
});

test("評価関数が読めなければ不合格", async () => {
  const dir = replayDir();
  const broken = path.join(dir, "evaluator.ts");
  writeFileSync(broken, "export const nothing = 1;\n");
  const res = await verifyPolicyWithReplay(dir, { evaluatorPath: broken });
  expect(res.ok).toBe(false);
  expect(res.errors[0]).toContain("stepCost");
});
