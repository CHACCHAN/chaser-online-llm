import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AGENT_REVIEW_PATH } from "../paths";
import { numSetting } from "../settings";

/**
 * agent/REVIEW.md: 試合後にエージェント（ハーネスの利用者）が書いた、ハーネスの使い勝手の指摘・不具合・欲しい機能。
 * 開発者が開発時に読む。新しい順に並べ、AGENT_REVIEW_KEEP 件を超えた古いものは消す。
 * エージェントはこのファイルを直接編集できない（edit-guard で保護）。ハーネスが返答を書き込む。
 */
const HEADER = [
  "# REVIEW.md — エージェントからハーネスへのレビュー",
  "",
  "試合後の振り返りのあと、プレイしたエージェントがハーネス（このプロジェクト）の使い勝手・不具合・欲しい機能を書く。新しい順。",
  "開発者は開発の前に読み、対応したら項目の先頭に `[対応済み]` を付ける（エージェントは次のレビューでそれを確かめる）。",
  "",
].join("\n");
const ENTRY_MARK = "<!-- review-entry -->";

export function readReviewEntries(file = AGENT_REVIEW_PATH): string[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf-8");
  return text
    .split(ENTRY_MARK)
    .slice(1)
    .map((e) => e.trim())
    .filter(Boolean);
}

export function appendReview(entry: { runId: string; room: number; model: string | null; text: string; at?: Date }, file = AGENT_REVIEW_PATH): void {
  const at = (entry.at ?? new Date()).toISOString().slice(0, 16).replace("T", " ");
  const body = [`## ${at} / ${entry.runId}（room ${entry.room} / ${entry.model ?? "既定のモデル"}）`, "", entry.text.trim()].join("\n");
  const keep = numSetting("AGENT_REVIEW_KEEP", { min: 1, integer: true });
  const entries = [body, ...readReviewEntries(file)].slice(0, keep);
  writeFileSync(file, `${HEADER}\n${entries.map((e) => `${ENTRY_MARK}\n${e}\n`).join("\n")}`, "utf-8");
}
