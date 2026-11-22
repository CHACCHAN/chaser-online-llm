import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { defaultParams } from "../solver/evaluator";
import { applyFixed, getStyle, loadModelParams, loadStyles, saveModelParams, STANDARD_MODEL } from "../solver/models";
import type { EpisodeResult } from "./episode";
import { profileOf, traitTags, type ModelProfile } from "./model-traits";
import { objectiveOf, perTurn } from "./train";

const run = (o: Partial<EpisodeResult>): EpisodeResult => ({
  scenario: "t", webMap: true, totalTurns: 100, score: 30000, action: -1000, item: 5000, hazardHits: 1, policyErrors: 0, msPerPhase: 1,
  opponents: [20000], opponentKinds: ["狙う"], put: 10000, putDamage: -5000, won: true, ...o,
});

describe("特性ごとのモデル", () => {
  test("定義: knowledge/styles.json のモデルを読み、標準のモデルはいつも先頭。読めない・無い時は標準だけ", () => {
    const styles = loadStyles();
    expect(styles[0]!.id).toBe(STANDARD_MODEL);
    expect(styles.map((s) => s.id)).toEqual(expect.arrayContaining(["hunter", "collector", "guardian"]));
    const file = `${process.env.CHASER_TEST_VAR_DIR ?? "/tmp"}/styles-broken-${Date.now()}.json`;
    writeFileSync(file, "{ broken");
    expect(loadStyles(file).map((s) => s.id)).toEqual([STANDARD_MODEL]);
    expect(getStyle("no-such-model").id).toBe(STANDARD_MODEL);
  });

  test("学習の目的: 標準は 1ターンあたりの得点、ハンターは当てた得点を足す、ガーディアンは当てられた得点と罠を足す", () => {
    const r = run({});
    expect(objectiveOf(getStyle(STANDARD_MODEL))(r)).toBe(perTurn(r));
    expect(objectiveOf(getStyle("hunter"))(r)).toBe((30000 + 10000) / 100);
    expect(objectiveOf(getStyle("guardian"))(r)).toBe((30000 - 5000 - 500) / 100);
    expect(objectiveOf(getStyle("collector"))(r)).toBe((30000 + 2500) / 100);
  });

  test("動かさないパラメータ（コレクターは当てない）は、読み込み・保存のどちらでも当てはまる", () => {
    const c = getStyle("collector");
    expect(applyFixed({ ...defaultParams(), attackGain: 3000 }, c).attackGain).toBe(0);
    expect(loadModelParams("collector").attackGain).toBe(0);
    saveModelParams("collector", { ...defaultParams(), attackGain: 5000, distWeight: 2 }, "test");
    const p = loadModelParams("collector");
    expect(p.attackGain).toBe(0);
    expect(p.distWeight).toBe(2);
  });

  test("特性: 測った結果から当てた・当てられた回数を出し、ほかのモデルと比べて札を付ける", () => {
    const p = profileOf("hunter", [run({ put: 50000, putDamage: -5000 })]);
    expect(p.hitsPer100).toBe(10); // putHit 5000 で 10 回 / 100 ターン
    expect(p.hitByPer100).toBe(1);
    const base: ModelProfile = { ...p, id: "standard", hitsPer100: 2, hitByPer100: 4, itemPerTurn: 40, perTurn: 300, winRate: 0.5 };
    const profiles = { standard: base, hunter: { ...p, perTurn: 280, winRate: 0.6 }, collector: { ...base, id: "collector", hitsPer100: 0, itemPerTurn: 60 } };
    expect(traitTags("hunter", profiles)).toEqual(expect.arrayContaining(["攻撃的", "打たれにくい", "勝負強い"]));
    expect(traitTags("collector", profiles)).toEqual(expect.arrayContaining(["当てない", "回収が多い"]));
  });
});
