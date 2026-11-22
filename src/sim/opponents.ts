import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { POLICY_LEAGUE_PATH } from "../paths";
import { clampParams, type Params } from "../solver/evaluator";
import { loadModelParams, loadStyles, STANDARD_MODEL } from "../solver/models";
import { makeRng, pickWeighted } from "./rng";
import { loadTrainConfig } from "./train-config";

/**
 * シミュレータの相手（自分以外のプレイヤー）の決め方と、自己対戦の相手の控え（リーグ）。
 *
 * 相手の種類:
 * - greedy（拾う）: 地図を全部知っていて、一番近い点のあるマスへ歩く
 * - hunter（狙う）: 近くのプレイヤーを追いかけ、隣に来たらアイテムを置いて当てる
 * - self（自分）: 自分と同じ方策（経路探索）。パラメータは今のもの（var/policy/params.json）か、前に採用したもの（リーグ）。
 *   自分と同じく観測と Webマップだけで動く
 *
 * どれを何人にするかは knowledge/train-config.json の重み（oppGreedy・oppHunter・oppSelf）。
 * 相手は地図の seed から決めるので、同じ地図なら比べる方策が変わっても同じ相手と戦う（比べ方が公平）。
 */

export type OpponentKind = "greedy" | "hunter" | "self";
export const OPPONENT_KINDS: OpponentKind[] = ["greedy", "hunter", "self"];

export interface OpponentSetup {
  kind: OpponentKind;
  /** self の時のパラメータ */
  params?: Params;
  /** self の時: どのパラメータか（"今" か リーグの何番目か） */
  label?: string;
}

export interface OpponentPlan {
  mix: Record<OpponentKind, number>;
  current: Params;
  league: { params: Params; label: string }[];
}

/** 自己対戦の相手の控え: 学習で採用されて置き換わった前のパラメータ（新しい順） */
export interface LeagueFile {
  version: 1;
  members: { params: Params; addedAt: string; note: string }[];
}

export function loadLeague(file = POLICY_LEAGUE_PATH): LeagueFile {
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as LeagueFile;
      if (Array.isArray(data.members)) return { version: 1, members: data.members.map((m) => ({ ...m, params: clampParams(m.params) })) };
    }
  } catch {
    // 読めなければ空
  }
  return { version: 1, members: [] };
}

/** リーグに足す（新しい順に max 人まで残す） */
export function addToLeague(params: Params, note: string, max: number, file = POLICY_LEAGUE_PATH): void {
  const league = loadLeague(file);
  league.members.unshift({ params: clampParams(params), addedAt: new Date().toISOString(), note });
  league.members = league.members.slice(0, Math.max(0, max));
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(league, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * 今の設定から相手の決め方を作る。「自分」の相手は、学習するモデルの今のパラメータ（current）と、
 * リーグ（前に採用したパラメータ）・ほかの特性のモデル（ハンターなど）から選ぶ。
 */
export function loadOpponentPlan(modelId: string = STANDARD_MODEL): OpponentPlan {
  const cfg = loadTrainConfig().config;
  const league = loadLeague().members.map((m, i) => ({ params: m.params, label: `${i + 1}つ前` }));
  const others = loadStyles()
    .filter((s) => s.id !== modelId)
    .map((s) => ({ params: loadModelParams(s.id), label: s.name }));
  return { mix: { greedy: cfg.oppGreedy, hunter: cfg.oppHunter, self: cfg.oppSelf }, current: loadModelParams(modelId), league: [...league, ...others] };
}

/** 地図（seed）ごとに相手を決める。self は半分が今のパラメータ、半分がリーグから（リーグが空なら今のもの） */
export function assignOpponents(seed: number, count: number, plan: OpponentPlan): OpponentSetup[] {
  const rng = makeRng((seed * 7919 + 104_729) >>> 0);
  const weights = OPPONENT_KINDS.map((k) => [k, Math.max(0, plan.mix[k] ?? 0)] as const);
  const total = weights.reduce((a, [, w]) => a + w, 0);
  const out: OpponentSetup[] = [];
  for (let i = 0; i < count; i++) {
    const kind: OpponentKind = total > 0 ? pickWeighted(rng, weights) : "greedy";
    if (kind !== "self") {
      out.push({ kind });
      continue;
    }
    if (plan.league.length > 0 && rng() < 0.5) {
      const m = plan.league[Math.floor(rng() * plan.league.length)]!;
      out.push({ kind, params: m.params, label: m.label });
    } else {
      out.push({ kind, params: plan.current, label: "今" });
    }
  }
  return out;
}

export const opponentLabel = (o: OpponentSetup) => (o.kind === "greedy" ? "拾う" : o.kind === "hunter" ? "狙う" : `自分(${o.label ?? "今"})`);
