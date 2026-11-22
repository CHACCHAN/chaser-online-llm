import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { POLICY_MODELS_DIR, POLICY_PARAMS_PATH, POLICY_STYLES_PATH } from "../paths";
import { getSetting } from "../settings";
import { clampParams, type Params } from "./evaluator";
import { loadPolicyParams, loadPolicyParamsFile, savePolicyParams, type PolicyParamsFile } from "./policy";

/**
 * 特性ごとのモデル。方策（経路探索＋評価関数）は同じで、パラメータを目的を変えて別々に学習する
 * （例: ハンター＝当てた得点を重く見る）。定義は knowledge/styles.json、パラメータは var/policy/models/<id>.json
 * （標準のモデル standard は今までどおり var/policy/params.json）。試合で使うモデルは設定の POLICY_MODEL。
 */

export type ObjectiveKey = "item" | "put" | "putDamage" | "hazard";
export const OBJECTIVE_KEYS: ObjectiveKey[] = ["item", "put", "putDamage", "hazard"];

export interface StyleDef {
  id: string;
  name: string;
  /** 特性をひとことで（攻撃型など） */
  trait: string;
  description: string;
  /** 学習の目的に足す重み（自分の得点 + Σ 重み × 値） */
  objective: Partial<Record<ObjectiveKey, number>>;
  /** 学習で動かさないパラメータ */
  fixed?: Partial<Params>;
}

export const STANDARD_MODEL = "standard";
const STANDARD: StyleDef = { id: STANDARD_MODEL, name: "バランス", trait: "標準", description: "自分の得点だけを目的に学習する", objective: {} };

/** モデルの定義を読む（読めない・無い時は標準だけ。standard はいつも先頭にある） */
export function loadStyles(file = POLICY_STYLES_PATH): StyleDef[] {
  let list: StyleDef[] = [];
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as { styles?: unknown };
      if (Array.isArray(raw.styles)) {
        list = (raw.styles as Partial<StyleDef>[])
          .filter((s) => typeof s.id === "string" && /^[a-z0-9_-]{1,32}$/.test(s.id) && typeof s.name === "string")
          .map((s) => ({
            id: s.id!,
            name: s.name!,
            trait: typeof s.trait === "string" ? s.trait : "",
            description: typeof s.description === "string" ? s.description : "",
            objective: Object.fromEntries(OBJECTIVE_KEYS.filter((k) => typeof s.objective?.[k] === "number" && Number.isFinite(s.objective[k])).map((k) => [k, s.objective![k]!])),
            ...(s.fixed && typeof s.fixed === "object" ? { fixed: s.fixed } : {}),
          }));
      }
    }
  } catch {
    // 読めなければ標準だけ
  }
  const seen = new Set<string>();
  list = list.filter((s) => !seen.has(s.id) && seen.add(s.id));
  const std = list.find((s) => s.id === STANDARD_MODEL) ?? STANDARD;
  return [std, ...list.filter((s) => s.id !== STANDARD_MODEL)];
}

export function getStyle(id: string | null | undefined): StyleDef {
  const styles = loadStyles();
  return styles.find((s) => s.id === id) ?? styles[0]!;
}

export const modelParamsPath = (id: string) => (id === STANDARD_MODEL ? POLICY_PARAMS_PATH : path.join(POLICY_MODELS_DIR, `${id}.json`));

/** 動かさないパラメータを当てはめる */
export function applyFixed(params: Params, style: StyleDef): Params {
  return style.fixed ? clampParams({ ...params, ...style.fixed }) : params;
}

/** モデルのパラメータ。まだ学習していないモデルは標準のモデルから始める（動かさない値は当てはめる） */
export function loadModelParams(id: string): Params {
  const style = getStyle(id);
  if (style.id === STANDARD_MODEL) return loadPolicyParams();
  const file = modelParamsPath(style.id);
  return applyFixed(existsSync(file) ? loadPolicyParams(file) : loadPolicyParams(), style);
}

export function loadModelParamsFile(id: string): PolicyParamsFile | null {
  return loadPolicyParamsFile(modelParamsPath(getStyle(id).id));
}

export function saveModelParams(id: string, params: Params, source: string, bench?: PolicyParamsFile["bench"]): void {
  const style = getStyle(id);
  savePolicyParams(applyFixed(params, style), source, bench, modelParamsPath(style.id));
}

/** 試合で使うモデル（設定の POLICY_MODEL。無い・知らない名前なら標準） */
export function playModelId(): string {
  return getStyle(getSetting("POLICY_MODEL") || STANDARD_MODEL).id;
}
