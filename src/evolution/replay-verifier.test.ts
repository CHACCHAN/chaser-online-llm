import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifySolverWithReplay } from "./replay-verifier";

test("改修前のソルバーと同じ地図で手を選ばせ、罠と分かっているマスへ動く手の回数を比べる", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "replay-"));
  // 上が罠(4)、他は土。記録の手は動かない gr と、横に歩く wr
  const rec = (turn: number) =>
    JSON.stringify({ turn, cmd1: "gr", cmd1Values: [2, 4, 2, 2, 1000, 2, 2, 2, 2], cmd2: "wr", cmd2Values: [2, 4, 2, 2, 0, 2, 2, 2, 2] });
  writeFileSync(path.join(dir, "turns.jsonl"), [rec(1), rec(2), rec(3)].join("\n"));
  // いつも上へ動く（罠へ入る）ソルバーを比べる元にする
  const reckless = `export function decideTurnAction(_wm, phase) { return { command: phase === "CMD1" ? "gru" : "wu", reason: "", confidence: 1 }; }`;
  const res = await verifySolverWithReplay(dir, { baselineCode: reckless });
  expect(res.baselineHazardLandings).toBeGreaterThanOrEqual(3);
  // 今のソルバーが罠へ入る回数が元より多くなければ合格
  expect(res.hazardLandings!).toBeLessThanOrEqual(res.baselineHazardLandings!);
  expect(res.ok).toBe(true);
});
