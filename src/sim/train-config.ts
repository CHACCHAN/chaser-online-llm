import { existsSync, readFileSync } from "node:fs";
import { TRAIN_CONFIG_PATH } from "../paths";

/**
 * 学習のやり方（knowledge/train-config.json）の読み込み。学習の LLM が直してよい。範囲の外の値は範囲に収める。
 */

/** 学習のやり方（knowledge/train-config.json）。読めない・範囲外の値は既定・範囲に収める */
export interface TrainConfig {
  popSize: number;
  batch: number;
  validation: number;
  sigmaStart: number;
  sigmaEnd: number;
  /** 相手の種類の重み（src/sim/opponents.ts）: 拾う・狙う・自分（自己対戦） */
  oppGreedy: number;
  oppHunter: number;
  oppSelf: number;
  /** 自己対戦の相手として残す、前に採用したパラメータの数（var/policy/league.json） */
  leagueSize: number;
  /** 保存の厳しさ: 確かめの差が標準誤差の何倍より大きければ保存するか（小さいほど甘い。雑音で弱い設定が入りやすくなる） */
  acceptZ: number;
  /** 保存の厳しさ: 罠を踏んだ回数が、前の (1 + hazardRatio) 倍 + hazardSlack 回までなら増えてもよい（罠の減点は得点にも入っている） */
  hazardRatio: number;
  hazardSlack: number;
}
export const TRAIN_CONFIG_DEFAULT: TrainConfig = { popSize: 16, batch: 12, validation: 24, sigmaStart: 0.15, sigmaEnd: 0.04, oppGreedy: 1, oppHunter: 1, oppSelf: 2, leagueSize: 6, acceptZ: 1.5, hazardRatio: 0.1, hazardSlack: 3 };
export const TRAIN_CONFIG_BOUNDS: Record<keyof TrainConfig, [number, number]> = {
  popSize: [4, 64],
  batch: [2, 48],
  validation: [8, 96],
  sigmaStart: [0.01, 0.5],
  sigmaEnd: [0.005, 0.5],
  oppGreedy: [0, 10],
  oppHunter: [0, 10],
  oppSelf: [0, 10],
  leagueSize: [0, 20],
  // 下限は、雑音だけで保存されないための底（1 未満にはさせない）
  acceptZ: [1, 3],
  hazardRatio: [0, 0.5],
  hazardSlack: [0, 10],
};

/** 学習のやり方を読む。problems に範囲外・読めなかった項目を返す（学習の LLM の改修の確かめに使う） */
export function loadTrainConfig(file = TRAIN_CONFIG_PATH): { config: TrainConfig; problems: string[] } {
  const problems: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    problems.push(`読めない: ${err instanceof Error ? err.message : String(err)}`);
  }
  const config = { ...TRAIN_CONFIG_DEFAULT };
  for (const k of Object.keys(TRAIN_CONFIG_DEFAULT) as (keyof TrainConfig)[]) {
    const v = raw[k];
    if (v === undefined) continue;
    const [lo, hi] = TRAIN_CONFIG_BOUNDS[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${k} が数でない`);
      continue;
    }
    if (v < lo || v > hi) problems.push(`${k}=${v} は範囲 ${lo}〜${hi} の外`);
    config[k] = Math.min(hi, Math.max(lo, v));
  }
  config.popSize = Math.max(4, Math.round(config.popSize / 2) * 2);
  config.batch = Math.round(config.batch);
  config.validation = Math.round(config.validation);
  config.leagueSize = Math.round(config.leagueSize);
  if (config.sigmaEnd > config.sigmaStart) {
    problems.push("sigmaEnd が sigmaStart より大きい");
    config.sigmaEnd = config.sigmaStart;
  }
  return { config, problems };
}
