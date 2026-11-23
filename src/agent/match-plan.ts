import { getStyle, loadModelParamsFile, loadStyles, playModelId } from "../solver/models";
import { loadModelProfiles, traitTags } from "../sim/model-traits";
import { defaultTriggerConfig, normalizeTriggerConfig, type TriggerConfig, TRIGGER_DEFS, type TriggerId } from "./triggers";

/**
 * 試合の設定（準備の LLM が決める）: 最初に使うモデル・試合中の LLM を呼ぶきっかけ（使うか・しきい値）・
 * きっかけごとの判断の目安。準備の返答の JSON から読み、範囲の外は範囲に収め、知らない項目は捨てる。
 */
export interface MatchPlan {
  /** 最初に使うモデル（knowledge/styles.json の id。null なら設定の POLICY_MODEL） */
  model: string | null;
  triggers: TriggerConfig;
  /** きっかけごとの判断の目安（試合中の LLM に、そのきっかけで呼んだ時に見せる） */
  guide: Partial<Record<TriggerId, string>>;
  /**
   * モデルの切り替えの決まり（作戦方針の「敵がいる時はハンター」など）。作戦スクリプト（src/solver/tactics.ts）が s.rules で受け取り、
   * 毎フェーズ LLM の返事を待たずに切り替える（返事は 40〜90 秒遅れるので、敵が近づいてから聞いても間に合わない。room460 T62）
   */
  modelRules: ModelRules | null;
  /** 読んだ時に直したこと（範囲に収めた・知らないモデルなど） */
  notes: string[];
}

export interface ModelRules {
  /** 直近（このターンか前のターン）に見た敵が radius マス（上下左右の歩数）以内に入ったら model にする */
  enemy?: { model: string; radius: number };
  /** 敵が radius の外に出て afterTurns ターン経ったら model にする */
  calm?: { model: string; afterTurns: number };
}

export const MODEL_RULE_LIMITS = { radius: { min: 1, max: 12, default: 5 }, afterTurns: { min: 1, max: 50, default: 5 } } as const;

const GUIDE_MAX = 160;

export function defaultMatchPlan(): MatchPlan {
  return { model: null, triggers: defaultTriggerConfig(), guide: {}, modelRules: null, notes: [] };
}

/** 準備の返答の JSON（memo と同じ行）から試合の設定を読む */
export function parseMatchPlan(obj: unknown): MatchPlan {
  const plan = defaultMatchPlan();
  if (!obj || typeof obj !== "object") return plan;
  const o = obj as { model?: unknown; triggers?: unknown; guide?: unknown; modelRules?: unknown };
  if (typeof o.model === "string" && o.model.trim()) {
    const id = o.model.trim();
    if (loadStyles().some((s) => s.id === id)) plan.model = id;
    else plan.notes.push(`知らないモデル "${id.slice(0, 32)}" は使わなかった`);
  }
  if (o.triggers !== undefined) {
    plan.triggers = normalizeTriggerConfig(o.triggers);
    const t = o.triggers as { thresholds?: Record<string, unknown> };
    for (const d of TRIGGER_DEFS) {
      const v = t?.thresholds?.[d.id];
      if (typeof v === "number" && d.param && plan.triggers.thresholds[d.id] !== v) plan.notes.push(`${d.label} のしきい値 ${v} は範囲 ${d.param.min}〜${d.param.max} に収めた（${plan.triggers.thresholds[d.id]}）`);
    }
  }
  if (o.guide && typeof o.guide === "object" && !Array.isArray(o.guide)) {
    for (const [k, v] of Object.entries(o.guide as Record<string, unknown>)) {
      const d = TRIGGER_DEFS.find((x) => x.id === k);
      if (!d || typeof v !== "string" || !v.trim()) continue;
      plan.guide[d.id] = v.trim().slice(0, GUIDE_MAX);
    }
  }
  if (o.modelRules && typeof o.modelRules === "object") plan.modelRules = parseModelRules(o.modelRules as Record<string, unknown>, plan.notes);
  return plan;
}

const clampInt = (v: unknown, lim: { min: number; max: number; default: number }) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(lim.max, Math.max(lim.min, Math.round(v))) : lim.default;

function parseModelRules(o: Record<string, unknown>, notes: string[]): ModelRules | null {
  const known = (id: unknown): string | null => {
    if (typeof id !== "string" || !id.trim()) return null;
    if (loadStyles().some((s) => s.id === id.trim())) return id.trim();
    notes.push(`切り替えの決まりの知らないモデル "${String(id).slice(0, 32)}" は使わなかった`);
    return null;
  };
  const out: ModelRules = {};
  const e = o.enemy as { model?: unknown; radius?: unknown } | undefined;
  const em = e && typeof e === "object" ? known(e.model) : null;
  if (em) out.enemy = { model: em, radius: clampInt(e!.radius, MODEL_RULE_LIMITS.radius) };
  const c = o.calm as { model?: unknown; afterTurns?: unknown } | undefined;
  const cm = c && typeof c === "object" ? known(c.model) : null;
  if (cm) out.calm = { model: cm, afterTurns: clampInt(c!.afterTurns, MODEL_RULE_LIMITS.afterTurns) };
  return out.enemy || out.calm ? out : null;
}

/** 切り替えの決まりの文（画面・試合中の LLM に見せる） */
export function modelRulesText(r: ModelRules | null): string {
  if (!r) return "";
  return [
    r.enemy ? `敵が ${r.enemy.radius} マス以内に入ったら ${getStyle(r.enemy.model).name}` : "",
    r.calm ? `敵が離れて ${r.calm.afterTurns} ターン経ったら ${getStyle(r.calm.model).name}` : "",
  ]
    .filter(Boolean)
    .join("、");
}

/** 画面・記録に出す1行 */
export function summarizeMatchPlan(plan: MatchPlan): string {
  const off = TRIGGER_DEFS.filter((d) => !plan.triggers.enabled[d.id]).map((d) => d.label);
  const changed = TRIGGER_DEFS.filter((d) => d.param && plan.triggers.thresholds[d.id] !== d.param.default).map((d) => `${d.label} ${plan.triggers.thresholds[d.id]}`);
  return [
    `最初のモデル: ${plan.model ? getStyle(plan.model).name : "設定のまま"}`,
    off.length ? `使わない: ${off.join("・")}` : "",
    changed.length ? `しきい値: ${changed.join("・")}` : "",
    Object.keys(plan.guide).length ? `目安 ${Object.keys(plan.guide).length} 件` : "",
    plan.modelRules ? `切り替え: ${modelRulesText(plan.modelRules)}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

/** 準備の LLM に見せる、選べるモデルときっかけの一覧 */
export function matchPlanChoicesText(): string {
  const profiles = loadModelProfiles();
  const models = loadStyles().map((s) => {
    const p = profiles[s.id];
    const file = loadModelParamsFile(s.id);
    const trained = s.id === "standard" ? !!file : file?.source === "train";
    const tags = traitTags(s.id, profiles);
    return `- \`${s.id}\` ${s.name}（${s.trait}）: ${s.description}${trained ? "" : "【まだ学習していない＝バランスと同じ手】"}${p ? ` / シミュレータ: 点/ターン ${p.perTurn}・当てた ${p.hitsPer100}・当てられた ${p.hitByPer100}・罠 ${p.hazardsPer100}（100ターンあたり）・勝ち ${Math.round(p.winRate * 100)}%` : ""}${tags.length ? ` / 特性: ${tags.join("・")}` : ""}`;
  });
  const triggers = TRIGGER_DEFS.map(
    (d) => `- \`${d.id}\` ${d.label}: ${d.doc}${d.param ? `（${d.param.name}。既定 ${d.param.default}、範囲 ${d.param.min}〜${d.param.max}${d.param.unit ? ` ${d.param.unit}` : ""}）` : ""}`,
  );
  return [`### 選べるモデル（同じ方策を、目的を変えて学習したもの。設定 POLICY_MODEL は \`${playModelId()}\`。model を書かなければこれ）`, ...models, "", "### 試合中の LLM を呼ぶきっかけ", ...triggers, `- 同じきっかけが続けて鳴らない間 \`cooldownTurns\`（既定 ${defaultTriggerConfig().cooldownTurns}、範囲 0〜50 ターン）`].join("\n");
}
