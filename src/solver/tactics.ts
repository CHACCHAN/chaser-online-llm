import type { TacticsAction, TacticsState } from "./tactics-runtime";

/**
 * 作戦スクリプト（LLM が書き換えてよい。試合後の振り返り・学習の LLM）。
 *
 * 試合中は毎フェーズの初めにハーネスが onPhase を呼び、返した行動をすぐ反映する（LLM の返事を待たない）。
 * シミュレータでも同じように動く（LLM はいないので askLlm は何もしない）。手そのものは経路探索の方策（planner.ts＋evaluator.ts）が出す。
 *
 * できること（TacticsAction。src/solver/tactics-runtime.ts）:
 * - model: 特性ごとのモデルを切り替える（knowledge/styles.json の id。s.models）
 * - target: 目標のマス（今の座標）。null で消す。着いた時・ワープで座標系が変わった時は消える。LLM の作戦目標があればそちらが先
 * - avoid: 通らないマス（今の座標）
 * - askLlm: 試合中の LLM を呼ぶ理由（LLM が空いていれば呼ぶ）。ハーネスのきっかけ（s.signals）を見て決める
 * - note: 記録に残すひとこと
 *
 * 決まり:
 * - 1フェーズ数ミリ秒で返す（重い探索をしない）。例外を投げたフェーズは使われない。状態は s.memory に残す（1試合の間）。
 * - 作戦方針（agent/policies/）をここに書き表す。準備の LLM が決めた切り替えの決まりは s.rules にある（あれば従う）。
 * - 直したら、ハーネスが試合の記録とシミュレータで改修前と比べ、弱ければ戻す。
 */

interface Memory {
  inRange?: boolean;
  lastInRange?: number;
  calmApplied?: boolean;
}

export function onPhase(s: TacticsState): TacticsAction {
  const out: TacticsAction = {};
  const m = s.memory as Memory;
  const has = (id: string | undefined) => !!id && s.models.some((x) => x.id === id);

  // 作戦方針（default）: 敵がいる時はハンター（put で攻める）、敵が離れたら元のモデル。
  // 準備の LLM が決めた切り替えの決まり（s.rules）があればそれに従う
  const enemyModel = s.rules?.enemy?.model ?? (has("hunter") ? "hunter" : undefined);
  const radius = s.rules?.enemy?.radius ?? 5;
  const calmModel = s.rules?.calm?.model ?? s.startModel;
  const calmAfter = s.rules?.calm?.afterTurns ?? 5;
  const near = s.nearestEnemy !== null && s.nearestEnemy <= radius;
  if (near) {
    m.lastInRange = s.turn;
    m.calmApplied = false;
    // 入った時だけ切り替える（入っている間は LLM の切り替えを上書きしない）
    if (!m.inRange) {
      m.inRange = true;
      if (has(enemyModel) && enemyModel !== s.model) {
        out.model = enemyModel;
        out.note = `敵まで ${s.nearestEnemy} マス`;
      }
    }
  } else {
    m.inRange = false;
    if (!m.calmApplied && m.lastInRange !== undefined && s.turn - m.lastInRange >= calmAfter) {
      m.calmApplied = true;
      if (has(calmModel) && calmModel !== s.model) {
        out.model = calmModel;
        out.note = `敵が離れて ${s.turn - m.lastInRange} ターン`;
      }
    }
  }

  // 試合中の LLM を呼ぶ: ハーネスのきっかけが鳴っていたら
  if (s.signals.length > 0) out.askLlm = s.signals.map((x) => x.label).join("・");
  return out;
}
