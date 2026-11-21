import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendReview, readReviewEntries } from "./harness-review";

test("REVIEW.md: 新しい順に追記し、AGENT_REVIEW_KEEP 件を超えた古いものは消す", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "review-")), "REVIEW.md");
  Bun.env.AGENT_REVIEW_KEEP = "2";
  for (const n of [1, 2, 3]) appendReview({ runId: `run${n}`, room: 3, model: "m", text: `### 欲しい機能・改善案\n- 指摘${n}` }, file);
  delete Bun.env.AGENT_REVIEW_KEEP;
  const entries = readReviewEntries(file);
  expect(entries.length).toBe(2);
  expect(entries[0]).toContain("run3");
  expect(entries[0]).toContain("指摘3");
  expect(entries[1]).toContain("run2");
});
