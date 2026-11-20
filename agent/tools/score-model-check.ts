/**
 * score-model-check — 過去試合をすべて再生し、推定スコアと公式スコアが一致するか確かめる（SELF_CHECK §2）。
 * 使い方: bun agent/tools/score-model-check.ts
 * 出力: 試合ごとの JSON 1行と、最後に {"result": {"runs": n, "mismatches": m}}
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { WorldMap } from "../../src/memory/world-map";
import { RUNS_DIR as R } from "../../src/paths";
let runs = 0;
let mismatches = 0;
for (const d of readdirSync(R).sort()) {
  const sp = `${R}/${d}/summary.json`; if (!existsSync(sp)) continue;
  const s = JSON.parse(readFileSync(sp, "utf8")); const o = s.officialResult; if (!o) continue;
  const wm = new WorldMap();
  for (const t of readFileSync(`${R}/${d}/turns.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l))) {
    if (t.cmd1) wm.applyObservation("CMD1", t.cmd1, t.cmd1Values, t.turn);
    if (t.cmd2) wm.applyObservation("CMD2", t.cmd2, t.cmd2Values, t.turn);
  }
  const st = wm.getStats();
  runs++;
  const ok = st.estimatedTotalScore === o.totalScore && st.estimatedActionScore === o.actionPoint && st.estimatedItemScore === o.itemPoint;
  if (!ok) mismatches++;
  console.log(JSON.stringify({ run: d, ok, official: [o.totalScore, o.actionPoint, o.itemPoint], estimated: [st.estimatedTotalScore, st.estimatedActionScore, st.estimatedItemScore] }));
}
console.log(JSON.stringify({ result: { runs, mismatches } }));
