import { expect, test } from "bun:test";
import { formatActionLine } from "./action-log";

test("行動ログ: 1ターン1行に、手・得点の増減・誰が決めたか・理由・きっかけ・LLM の返答・モデルを書く", () => {
  const line = formatActionLine(
    {
      turn: 12, cmd1: "gr", cmd2: "wu", cmd2Reason: "指定の目標 (3,4)1000 見込み900", cmd2Source: "solver", estimatedScoreAfter: 1530,
      model: "hunter", triggers: [{ id: "enemyNear", label: "敵が近い" }],
      llmReplies: [{ asked: 10, phase: "CMD1", by: ["enemyNear"], action: "plan", target: [3, 4], model: "hunter" }],
    },
    1500,
    (id) => ({ hunter: "ハンター" })[id] ?? id,
  );
  expect(line).toBe("T12 gr→wu +30 (1530) [LLMの目標・ハンター] 指定の目標 (3,4)1000 見込み900 | きっかけ: 敵が近い | LLM（T10 CMD1 に聞いた分・enemyNear）: 目標 (3,4)・モデル→ハンター");
  expect(formatActionLine({ turn: 1, cmd1: "gr", cmd2: null, cmd1Reason: "初期観測", estimatedScoreAfter: -20, usedFallback: true, gameOverReason: "Game Over" }, 0))
    .toBe("T1 gr→- -20 (-20) [方策・安全手] 初期観測 | 終了: Game Over");
});
