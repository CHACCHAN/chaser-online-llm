/**
 * CMD1 の選び方を、試合の観測（turns.jsonl）で比べる。
 *
 * 各ターンの観測を順に WorldMap へ流し、その時点の地図を JSON で控えてから、
 * 候補（ソルバーが選ぶ手 / 実際に打った手 / 全 `gr*`）ごとに地図を作り直して
 * そのターンの CMD1 → CMD2 を流し、公式の数え方（WorldMap の記録）で採点する:
 *   - itemScore: このターン動いて出た得点（着地したマス。その場に残った `gr` は +0）
 *   - holeRevisits / hazardHits
 *   - CMD2 の後、次ターンに中心3×3で見える未視マスの数（探索の進み）
 *
 * CMD2 も候補ごとに同じ記録を使って流す（CMD1 の着地で地図が変わるため）。
 *
 * 使い方: bun agent/tools/cmd1-bench.ts --run-dir var/runs/… [--all] [--verbose]
 *   --all  実際に打った手だけでなく、全 CMD1 候補を採点して「最良」と比べる
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { WorldMap } from "../../src/memory/world-map";
import type { TurnRecord } from "../../src/runner";
import { decideTurnAction, type AgentPlan } from "../../src/solver/active-solver";

const CANDIDATES = ["gr", "gru", "grd", "grl", "grr"] as const;

const argv = Bun.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runDir = arg("--run-dir");
if (!runDir) {
  console.error("usage: bun agent/tools/cmd1-bench.ts --run-dir var/runs/<runId> [--all] [--verbose]");
  process.exit(1);
}
const verbose = argv.includes("--verbose");
// 候補の CMD1 がワープ/衝突と誤判定されると経路が変わって採点にならないので、既定では数から外す。
const loose = argv.includes("--loose");
const scoreAll = argv.includes("--all");

type Rec = TurnRecord & { mainActions?: unknown; globalPositionAfter?: [number, number] };
const turnsPath = existsSync(path.join(runDir, "turns.jsonl"))
  ? path.join(runDir, "turns.jsonl")
  : path.join(runDir, "turns.json");
const records: Rec[] = existsSync(turnsPath)
  ? readFileSync(turnsPath, "utf-8").split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as Rec)
  : (JSON.parse(readFileSync(turnsPath.replace(/\.jsonl$/, ".json"), "utf-8")) as Rec[]);

const planFrom = (rec: Rec): AgentPlan | null => {
  const m = /plan\(@(-?\d+),(-?\d+)/.exec(JSON.stringify(rec.mainActions ?? rec.cmd1Reason ?? ""));
  return m ? { target: [Number(m[1]), Number(m[2])] } : null;
};

function replayFresh(n: number): WorldMap {
  const map = new WorldMap();
  for (const r of records.slice(0, n)) {
    if (!r.cmd1Values) continue;
    map.applyObservation("CMD1", r.cmd1, r.cmd1Values, r.turn);
    if (r.cmd2Values) map.applyObservation("CMD2", r.cmd2, r.cmd2Values, r.turn);
  }
  return map;
}

/** 先頭から n 件の観測を流し直した地図（WorldMap に複製 API が無いため、観測列で作り直す）。 */
const replayCache = new Map<number, WorldMap>();
function replayTo(n: number): WorldMap {
  const hit = replayCache.get(n);
  if (hit) return hit;
  const map = new WorldMap();
  for (const r of records.slice(0, n)) {
    if (!r.cmd1Values) continue;
    map.applyObservation("CMD1", r.cmd1, r.cmd1Values, r.turn);
    if (r.cmd2Values) map.applyObservation("CMD2", r.cmd2, r.cmd2Values, r.turn);
  }
  if (replayCache.size > 2) replayCache.clear();
  replayCache.set(n, map);
  return map;
}

interface Stats {
  turns: number;
  gain: number;
  frontier: number;
  holes: number;
  hazards: number;
}
const blank = (): Stats => ({ turns: 0, gain: 0, frontier: 0, holes: 0, hazards: 0 });
const add = (a: Stats, b: Stats) => {
  for (const k of Object.keys(a) as (keyof Stats)[]) a[k] += b[k];
};
const fmt = (s: Stats) =>
  `gain ${String(Math.round(s.gain)).padStart(7)}  frontier=${String(s.frontier).padStart(4)}` +
  `  holes=${String(s.holes).padStart(3)}  hazard=${s.hazards}  (${s.turns} turns)`;

/** その時点の控えから、指定の CMD1 + 実際の CMD2 を流して、このターンの結果を採点する。 */
function evaluate(n: number, cmd1: string, rec: Rec): Stats {
  const out = blank();
  out.turns = 1;
  const map = replayFresh(n);
  const before = map.getStats() as { estimatedItemScore?: number; holeRevisits?: number; hazardHits?: number };
  // 候補もこのターンの値・ターン番号で流す（前ターンの番号だとワープ待ちの判定がずれる）
  map.applyObservation("CMD1", cmd1, rec.cmd1Values, rec.turn);
  // その手が実際に動けたかは、次のターンの中心（着地マス）が見えるかで判断できる。
  const next = records[n + 1];
  const flags = map.getLastEventFlags();
  if (cmd1 !== "gr") {
    if (!next?.cmd1Values) return out;
    if (!loose && (flags.warped || flags.blocked || flags.warpPending)) return out;
  }
  if (rec.cmd2Values) map.applyObservation("CMD2", rec.cmd2, rec.cmd2Values, rec.turn);
  const after = map.getStats() as { estimatedItemScore?: number; holeRevisits?: number; hazardHits?: number };
  out.gain = (after.estimatedItemScore ?? 0) - (before.estimatedItemScore ?? 0);
  out.holes = (after.holeRevisits ?? 0) - (before.holeRevisits ?? 0);
  out.hazards = (after.hazardHits ?? 0) - (before.hazardHits ?? 0);
  const [x, y] = map.getPosition();
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (map.getTile(x + dx, y + dy) === undefined) out.frontier += 1;
  }
  return out;
}

const actual = blank();
const solver = blank();
const best = blank();
const detail: string[] = [];
for (const [i, rec] of records.entries()) {
  if (!rec.cmd1Values) continue;
  const plan = planFrom(rec);
  let pick = "";
  let reason = "";
  try {
    const d = decideTurnAction(replayTo(i), "CMD1", rec.turn, plan);
    pick = d.command;
    reason = d.reason;
  } catch (err) {
    reason = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  const per = new Map<string, Stats>();
  for (const cmd of new Set([...CANDIDATES, rec.cmd1, pick])) {
    if (!cmd) continue;
    per.set(cmd, evaluate(i, cmd, rec));
  }
  const a = per.get(rec.cmd1) ?? blank();
  const s = (pick && per.get(pick)) || blank();
  add(actual, a);
  add(solver, s);
  if (scoreAll) {
    let top: Stats | null = null;
    for (const st of per.values()) {
      if (!top || st.gain + st.frontier * 5 > top.gain + top.frontier * 5) top = st;
    }
    if (top) add(best, top);
  }
  if (pick && pick !== rec.cmd1 && s.gain > a.gain) {
    detail.push(`T${rec.turn} solver ${pick} gain=${s.gain} > actual ${rec.cmd1} gain=${a.gain}  (${reason})`);
  }
  replayTo(i + 1);
}
console.log(`actual : ${fmt(actual)}`);
console.log(`solver : ${fmt(solver)}`);
if (scoreAll) console.log(`best*5: ${fmt(best)}`);
console.log(`\nソルバーの方が得点が高いターン: ${detail.length}`);
if (verbose) for (const d of detail.slice(0, 50)) console.log("  " + d);
