import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { numSetting } from "../settings";
import { POLICY_MODEL_PROFILES_PATH } from "../paths";
import { loadModelParams, loadStyles, STANDARD_MODEL } from "../solver/models";
import type { EpisodeResult } from "./episode";
import { loadProfile } from "./mapgen";
import { loadOpponentPlan, type OpponentPlan } from "./opponents";
import type { SimPool } from "./pool";
import { evaluatePolicy, perTurn, type EvalSet } from "./train";

/**
 * モデルの特性を測る。全部のモデルを、同じ地図・同じ相手（拾う・狙う・標準のモデルの「自分」）で打たせて、
 * 点・回収・攻撃（当てた回数）・被弾（当てられた回数）・勝ち・罠を比べる。特性の札（攻撃的など）は、ほかのモデルと比べて付ける。
 */

export interface ModelProfile {
  id: string;
  measuredAt: string;
  maps: number;
  /** 1ターンあたりの得点 */
  perTurn: number;
  /** 1ターンあたりのアイテム得点 */
  itemPerTurn: number;
  /** 100 ターンあたりに当てた回数・当てられた回数 */
  hitsPer100: number;
  hitByPer100: number;
  /** 相手に勝った割合（0〜1） */
  winRate: number;
  /** 100 ターンあたりに罠を踏んだ回数 */
  hazardsPer100: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const MEASURE_SEED = 3_300_000;

/** 測る地図の組（毎回同じ地図。モデルどうし・前回と比べられる） */
export function measureSet(n = 24): EvalSet {
  return { seeds: Array.from({ length: n }, (_, i) => MEASURE_SEED + i), rooms: Array.from({ length: n }, () => null), maxTurns: numSetting("SIM_MAX_TURNS", { min: 10, integer: true }) };
}

/** 測る時の相手（どのモデルにも同じ相手: 標準のモデルの今のパラメータ。前の自分・ほかのモデルは混ぜない） */
export function measureOpponents(): OpponentPlan {
  const plan = loadOpponentPlan(STANDARD_MODEL);
  return { ...plan, league: [] };
}

export function profileOf(id: string, rs: EpisodeResult[]): ModelProfile {
  const putHit = Math.max(1, loadProfile(null).putHit ?? 1);
  const turns = Math.max(1, rs.reduce((s, r) => s + r.totalTurns, 0));
  const vs = rs.filter((r) => r.won !== null && r.won !== undefined);
  return {
    id,
    measuredAt: new Date().toISOString(),
    maps: rs.length,
    perTurn: r1(rs.reduce((s, r) => s + perTurn(r), 0) / Math.max(1, rs.length)),
    itemPerTurn: r1(rs.reduce((s, r) => s + r.item, 0) / turns),
    hitsPer100: r1((rs.reduce((s, r) => s + (r.put ?? 0), 0) / putHit / turns) * 100),
    hitByPer100: r1((rs.reduce((s, r) => s - (r.putDamage ?? 0), 0) / putHit / turns) * 100),
    winRate: vs.length ? Math.round((vs.filter((r) => r.won).length / vs.length) * 100) / 100 : 0,
    hazardsPer100: r1((rs.reduce((s, r) => s + r.hazardHits, 0) / turns) * 100),
  };
}

export function loadModelProfiles(file = POLICY_MODEL_PROFILES_PATH): Record<string, ModelProfile> {
  try {
    if (existsSync(file)) return (JSON.parse(readFileSync(file, "utf-8")) as { profiles?: Record<string, ModelProfile> }).profiles ?? {};
  } catch {
    // 読めなければ空
  }
  return {};
}

function saveModelProfiles(profiles: Record<string, ModelProfile>, file = POLICY_MODEL_PROFILES_PATH): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** モデルの特性を測って保存する（ids が無ければ全部） */
export async function measureModels(pool: SimPool, ids?: string[], n = 24): Promise<Record<string, ModelProfile>> {
  const styles = loadStyles().filter((s) => !ids || ids.includes(s.id));
  const set = measureSet(n);
  const opponents = measureOpponents();
  const results = await Promise.all(styles.map((s) => evaluatePolicy(pool, { kind: "planner", params: loadModelParams(s.id) }, set, opponents)));
  const profiles = loadModelProfiles();
  styles.forEach((s, i) => {
    profiles[s.id] = profileOf(s.id, results[i]!);
  });
  saveModelProfiles(profiles);
  return profiles;
}

/** 特性の札: ほかのモデルと比べて目立つもの（測ったモデルが2つ以上ある時） */
export function traitTags(id: string, profiles: Record<string, ModelProfile>): string[] {
  const all = Object.values(profiles);
  const me = profiles[id];
  if (!me || all.length < 2) return [];
  const avg = (k: keyof ModelProfile) => all.reduce((s, p) => s + Number(p[k]), 0) / all.length;
  const tags: string[] = [];
  if (me.hitsPer100 >= 1 && me.hitsPer100 >= avg("hitsPer100") * 1.3) tags.push("攻撃的");
  if (me.hitsPer100 < 0.5) tags.push("当てない");
  if (me.hitByPer100 <= avg("hitByPer100") * 0.75) tags.push("打たれにくい");
  if (me.hitByPer100 >= avg("hitByPer100") * 1.3) tags.push("打たれやすい");
  if (me.itemPerTurn >= avg("itemPerTurn") * 1.1) tags.push("回収が多い");
  if (me.winRate === Math.max(...all.map((p) => p.winRate)) && me.winRate > 0) tags.push("勝負強い");
  if (me.perTurn === Math.max(...all.map((p) => p.perTurn))) tags.push("得点が一番");
  if (me.hazardsPer100 > avg("hazardsPer100") * 1.5 && me.hazardsPer100 > 0.5) tags.push("罠を踏みがち");
  return tags;
}
