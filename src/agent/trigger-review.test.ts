import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNS_DIR } from "../paths";
import { aggregateReviews, renderTriggerReview, reviewRun, type ReviewTurn, roomTriggerHistoryText } from "./trigger-review";

/** 1ターン 10 点ずつ。T5 で敵が近い→呼んでハンターへ（その後 1ターン 30 点）、T20 で敵が近い→考え中で呼ばない */
function makeTurns(): ReviewTurn[] {
  const out: ReviewTurn[] = [];
  let est = 0;
  for (let t = 1; t <= 30; t++) {
    est += t >= 5 && t < 15 ? 30 : 10;
    const r: ReviewTurn = { turn: t, estimatedScoreAfter: est };
    if (t === 5 || t === 20) r.triggers = [{ id: "enemyNear", phase: "CMD1" }];
    if (t === 5) r.calledBy = { CMD1: ["enemyNear"] };
    if (t === 6) r.llmReplies = [{ asked: 5, phase: "CMD1", by: ["enemyNear"], action: "continue", model: "hunter", ms: 900 }];
    if (t >= 6) r.model = "hunter";
    if (t === 22) r.webScore = { putDamage: 0 };
    if (t === 24) r.webScore = { putDamage: -500 };
    out.push(r);
  }
  return out;
}

test("きっかけの評価: 鳴った・呼んだ・モデルの切り替えと、呼んだ後／呼ばなかった後の得点・当てられた回数", () => {
  const rv = reviewRun(makeTurns(), { runId: "r1", room: 5, policyModel: "standard", callMode: "trigger", matchPlan: { model: null, guide: { enemyNear: "攻める" }, triggers: { enabled: { heartbeat: false } } } });
  const t = rv.triggers.find((x) => x.id === "enemyNear")!;
  expect(t).toMatchObject({ fired: 2, called: 1, cont: 1, switched: 1, switchTo: { hunter: 1 } });
  // 呼んだ後は返答が届いた T6 から 10 ターン（T6〜T14 は 30 点、T15 は 10 点）
  expect(t.afterCalled).toEqual({ n: 1, perTurn: 28, hitAfter: 0 });
  expect(t.afterNotCalled).toEqual({ n: 1, perTurn: 10, hitAfter: 1 });
  expect(rv.calls).toBe(1);
  expect(rv.models.map((m) => [m.id, m.turns])).toEqual([["standard", 5], ["hunter", 25]]);
  expect(rv.matchPlan?.off).toEqual(["heartbeat"]);
  const md = renderTriggerReview(rv);
  expect(md).toContain("| 敵が近い | 2 | 1 | 0 | 1 | ハンター 1 | 0 | 28点/ターン（1回） | 10点/ターン（1回・当てられた 1） |");
  expect(md).toContain("目安 敵が近い「攻める」");
  const agg = aggregateReviews([rv, rv]);
  expect(agg[0]).toMatchObject({ id: "enemyNear", runs: 2, fired: 4, called: 2, switchTo: { hunter: 2 } });
  expect(agg[0]!.afterCalled).toEqual({ n: 2, perTurn: 28, hitAfter: 0 });
});

test("準備に見せる、このルームのきっかけの成績（過去の試合の trigger-review.json から）", () => {
  const room = 97531;
  expect(roomTriggerHistoryText(room)).toBe("");
  const dir = path.join(RUNS_DIR, `2026-02-03T04-05-06_room${room}`);
  mkdirSync(dir, { recursive: true });
  const rv = reviewRun(makeTurns(), { runId: path.basename(dir), room, policyModel: "standard", callMode: "trigger", matchPlan: { model: "guardian", guide: {}, triggers: {} } });
  writeFileSync(path.join(dir, "trigger-review.json"), JSON.stringify(rv));
  const text = roomTriggerHistoryText(room);
  expect(text).toContain("過去 1 試合");
  expect(text).toContain("| 敵が近い `enemyNear` | 1 | 2 (6.7) | 1 | 0/1/1（ハンター1） | 28点/ターン（1回） |");
  expect(text).toContain("最初のモデル ガーディアン");
});

test("LLM が呼ばれないまま点が増えなかった区間を出す（返答があった区間・短い区間は出さない）", async () => {
  const { silentStretches, renderTriggerReview, reviewRun } = await import("./trigger-review");
  const turns = Array.from({ length: 120 }, (_, i) => {
    const t = i + 1;
    // 1〜20: 点が増える / 21〜70: 増えない（呼ばれない）/ 71〜80: 増える / 81〜120: 増えないが T90 に返答あり
    const gain = t <= 20 || (t > 70 && t <= 80) ? 800 : 290;
    return { turn: t, gain, cmd1: "grl", cmd2: "wr", cmd2Reason: "出口のワープへ (0,10)300 見込み0", llmReplies: t === 90 ? [{ asked: 88, phase: "CMD1", by: ["noGain"], action: "plan" }] : [] };
  });
  let est = 0;
  const rows = turns.map((t) => ({ ...t, estimatedScoreAfter: (est += t.gain) }));
  const s = silentStretches(rows);
  expect(s.map((x) => [x.from, x.to])).toEqual([[21, 70]]);
  expect(s[0]!.topCmds).toContain("grl→wr");
  expect(s[0]!.topReason).toContain("出口のワープへ");
  const text = renderTriggerReview(reviewRun(rows, { runId: "r", room: 1, callMode: "trigger" }));
  expect(text).toContain("T21〜T70（50 ターン）");
});
