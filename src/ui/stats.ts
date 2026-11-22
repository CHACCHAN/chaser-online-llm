import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadRoomProfiles } from "../memory/knowledge-store";
import { isRunDirName, POLICY_TRAIN_LOG_PATH, RUNS_DIR } from "../paths";
import { lab } from "../sim/lab";

/**
 * 「統計」画面の中身（GET /api/stats）。試合の記録（var/runs/*）・ルームの記録（room-profiles.json）・
 * 学習の記録（train-log.jsonl）・モデルの特性を読むだけで、何も書かない。
 */

export interface RunStat {
  runId: string;
  room: number | null;
  startedAt: string | null;
  turns: number;
  /** 公式の合計（取れた時だけ）と、ハーネスの推定 */
  official: number | null;
  estimated: number | null;
  /** 1ターンあたり（公式があれば公式、なければ推定） */
  perTurn: number | null;
  itemPoint: number | null;
  actionPoint: number | null;
  putPoint: number | null;
  putDamage: number | null;
  /** 公式 − 推定（ずれが大きい＝推定が見落としたもの。当てられた得点など） */
  gap: number | null;
  endReason: string | null;
  policyModel: string | null;
  hazardHits: number;
  holeRevisits: number;
  llm: {
    enabled: boolean;
    model: string | null;
    effort: string | null;
    calls: number;
    costUsd: number;
    tokens: number;
    avgLatencyMs: number | null;
    /** LLM が動かした手（LLM が手を決めた・LLM の目標で方策が動いた）の数と、全部の手の数 */
    directedPhases: number;
    phases: number;
  };
}

export interface RoomStat {
  room: number;
  matches: number;
  highScore: number | null;
  bestRunId: string | null;
  bestPerTurn: number | null;
  avgPerTurn: number | null;
  lastAt: string | null;
  totalTurns: number | null;
  mapDimensions: [number, number] | null;
  webMap: boolean | null;
  endReasons: Record<string, number>;
  putDamage: number;
  llmCostUsd: number;
}

export interface TrainStat {
  at: string;
  model: string;
  trigger: string | null;
  room: number | null;
  accepted: boolean;
  a: number;
  b: number;
  diff: number;
  se: number;
  generations: number;
  episodes: number;
  ms: number;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** turns.jsonl から LLM が動かした手を数える（前の構成では LLM が手を決めた＝source main、今は LLM の目標で方策が動いた＝理由が「指定の目標」。大きいので、ファイルが変わった時だけ読み直す） */
const phaseCache = new Map<string, { key: string; directed: number; phases: number }>();
function countDirected(runDir: string): { directed: number; phases: number } {
  const file = path.join(runDir, "turns.jsonl");
  if (!existsSync(file)) return { directed: 0, phases: 0 };
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = phaseCache.get(runDir);
  if (hit?.key === key) return hit;
  let directed = 0;
  let phases = 0;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { cmd1?: string | null; cmd2?: string | null; cmd1Reason?: string; cmd2Reason?: string; cmd1Source?: string; cmd2Source?: string; usedHarness?: boolean };
      for (const [c, r, src] of [
        [o.cmd1, o.cmd1Reason, o.cmd1Source],
        [o.cmd2, o.cmd2Reason, o.cmd2Source],
      ] as const) {
        if (!c) continue;
        phases += 1;
        const main = src ? src === "main" : o.usedHarness === true;
        if (main || (typeof r === "string" && r.includes("指定の目標"))) directed += 1;
      }
    } catch {
      // 壊れた行は飛ばす
    }
  }
  const v = { key, directed, phases };
  phaseCache.set(runDir, v);
  return v;
}

export function listRunStats(limit = 500): RunStat[] {
  if (!existsSync(RUNS_DIR)) return [];
  const names = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isRunDirName(d.name))
    .map((d) => d.name)
    .sort()
    .reverse()
    .slice(0, limit);
  const out: RunStat[] = [];
  for (const name of names) {
    const dir = path.join(RUNS_DIR, name);
    const file = path.join(dir, "summary.json");
    if (!existsSync(file)) continue;
    try {
      const s = JSON.parse(readFileSync(file, "utf-8")) as Record<string, any>;
      const off = s.officialResult ?? null;
      const official = num(off?.totalScore);
      const estimated = num(s.estimatedScore?.estimatedTotalScore);
      const turns = num(off?.acquiredTurns) ?? num(s.turns) ?? 0;
      const score = official ?? estimated;
      const usage = s.agent?.usage ?? {};
      const total = usage.total ?? usage.main ?? {};
      const dp = countDirected(dir);
      out.push({
        runId: s.runId ?? name,
        room: num(s.room),
        startedAt: s.startedAt ?? null,
        turns,
        official,
        estimated,
        perTurn: score !== null && turns > 0 ? Math.round(score / turns) : null,
        itemPoint: num(off?.itemPoint),
        actionPoint: num(off?.actionPoint),
        putPoint: num(off?.putPoint),
        putDamage: num(off?.putDamage),
        gap: official !== null && estimated !== null ? official - estimated : null,
        endReason: typeof s.gameOverReason === "string" ? s.gameOverReason : null,
        policyModel: typeof s.policyModel === "string" ? s.policyModel : null,
        hazardHits: num(s.hazardHits) ?? 0,
        holeRevisits: num(s.holeRevisits) ?? 0,
        llm: {
          enabled: s.agent?.enabled !== false,
          model: s.agent?.model ?? s.model ?? null,
          effort: s.agent?.effort ?? null,
          calls: num(total.calls) ?? 0,
          costUsd: Math.round((num(total.costUsd) ?? 0) * 100) / 100,
          tokens: num(usage.totalTokens) ?? (num(total.inputTokens) ?? 0) + (num(total.outputTokens) ?? 0) + (num(total.cacheReadTokens) ?? 0) + (num(total.cacheCreationTokens) ?? 0),
          avgLatencyMs: num(s.agent?.avgLatencyMs),
          directedPhases: dp.directed,
          phases: dp.phases,
        },
      });
    } catch {
      // 壊れた summary は飛ばす
    }
  }
  return out;
}

/** 終わり方をまとめる（「Reached --max-turns (1)」などの数字を落とす） */
export const endKind = (r: string | null): string => (r ? r.replace(/\(\d+\)/g, "").replace(/\d+/g, "N").trim() : "不明");

export function roomStats(runs: RunStat[]): RoomStat[] {
  const profiles = loadRoomProfiles().rooms;
  const ids = new Set<number>([...Object.keys(profiles).map(Number), ...runs.map((r) => r.room).filter((r): r is number => r !== null)]);
  const out: RoomStat[] = [];
  for (const room of ids) {
    const p = profiles[String(room)];
    const rs = runs.filter((r) => r.room === room);
    // 1ターンで止めた試し打ちなどは平均に入れない
    const real = rs.filter((r) => r.turns >= 5 && r.perTurn !== null);
    const endReasons: Record<string, number> = {};
    for (const r of rs) endReasons[endKind(r.endReason)] = (endReasons[endKind(r.endReason)] ?? 0) + 1;
    out.push({
      room,
      matches: Math.max(p?.matchesPlayed ?? 0, rs.length),
      highScore: p?.highScore ?? null,
      bestRunId: p?.bestRunId ?? null,
      bestPerTurn: real.length ? Math.max(...real.map((r) => r.perTurn!)) : null,
      avgPerTurn: real.length ? Math.round(real.reduce((s, r) => s + r.perTurn!, 0) / real.length) : null,
      lastAt: rs[0]?.startedAt ?? p?.updatedAt ?? null,
      totalTurns: p?.totalTurns ?? null,
      mapDimensions: p?.mapDimensions ?? null,
      webMap: p?.webMapAvailable ?? null,
      endReasons,
      putDamage: rs.reduce((s, r) => s + (r.putDamage ?? 0), 0),
      llmCostUsd: Math.round(rs.reduce((s, r) => s + r.llm.costUsd, 0) * 100) / 100,
    });
  }
  return out.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

export function trainStats(limit = 500): TrainStat[] {
  if (!existsSync(POLICY_TRAIN_LOG_PATH)) return [];
  const out: TrainStat[] = [];
  for (const line of readFileSync(POLICY_TRAIN_LOG_PATH, "utf-8").trim().split("\n")) {
    try {
      const o = JSON.parse(line) as Record<string, any>;
      if (!o.generations || o.dryRun) continue;
      out.push({
        at: o.at,
        model: o.model ?? "standard",
        trigger: o.trigger ?? null,
        room: num(o.room),
        accepted: !!o.accepted,
        a: num(o.comparison?.a) ?? 0,
        b: num(o.comparison?.b) ?? 0,
        diff: num(o.comparison?.diff) ?? 0,
        se: num(o.comparison?.se) ?? 0,
        generations: o.generations,
        episodes: num(o.episodes) ?? 0,
        ms: num(o.ms) ?? 0,
      });
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out.slice(-limit).reverse();
}

export function statsOverview() {
  const runs = listRunStats();
  const m = lab.models();
  return {
    rooms: roomStats(runs),
    runs,
    training: trainStats(),
    models: { play: m.play, list: m.models.map((x) => ({ id: x.id, name: x.name, trait: x.trait, trained: x.trained, updatedAt: x.updatedAt, profile: x.profile, tags: x.tags })) },
  };
}
