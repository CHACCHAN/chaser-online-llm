import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURRENT_DIR, EVALUATOR_PATH, TACTICS_PATH } from "../paths";
import { logger } from "../tools";
import { uiBus } from "../ui/event-bus";

/**
 * 試合後の仕事（振り返り・ハーネスのレビュー・方策の学習・学習の LLM）を裏で順に行う（POST_MATCH_BACKGROUND）。
 * その間に次の試合を始められる。仕事は1つずつ（同時に2つの振り返りが評価関数を書き換えない）。
 * 進み具合は画面の状態（status）ではなく background に出す（試合の状態を上書きしない）。
 */

export interface BackgroundState {
  /** 今やっている仕事（どの試合の後か）と、その段階 */
  runId: string;
  message: string;
  startedAt: string;
  /** 待っている仕事の数 */
  pending: number;
}

interface Task {
  runId: string;
  work: (say: (message: string) => void) => Promise<void>;
}

const queue: Task[] = [];
let running: Task | null = null;
let current: BackgroundState | null = null;

function publish(): void {
  uiBus.patchState({ background: current ? { ...current, pending: queue.length } : queue.length ? { runId: queue[0]!.runId, message: "待っている", startedAt: new Date().toISOString(), pending: queue.length } : null });
}

/** 試合後の仕事を積む。前の仕事が終わってから始める */
export function enqueuePostMatch(runId: string, work: Task["work"]): void {
  queue.push({ runId, work });
  publish();
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  while (queue.length > 0) {
    const task = queue.shift()!;
    running = task;
    current = { runId: task.runId, message: "始めています", startedAt: new Date().toISOString(), pending: queue.length };
    publish();
    try {
      await task.work((message) => {
        if (current) current.message = message;
        publish();
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ runId: task.runId, err: msg }, "裏の試合後の仕事が失敗");
      uiBus.pushClaudeEvent({ context: "evolution", kind: "error", title: `試合後の仕事が失敗（${task.runId}）`, content: msg });
    }
    running = null;
    current = null;
    publish();
  }
}

/** 裏の仕事が動いている・待っているか */
export function postMatchBusy(): boolean {
  return running !== null || queue.length > 0;
}

/** 裏の仕事が全部終わるまで待つ（サーバーを閉じる時・テスト） */
export async function settlePostMatch(timeoutMs = Infinity): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (postMatchBusy() && Date.now() < until) await Bun.sleep(200);
}

/**
 * 評価関数を書き換えている間（振り返り・学習の LLM。確かめるまでは採用されていない）に始まった試合は、
 * 書き換える前の評価関数を使う。書き換えを始める時に、その時の評価関数を var/current/evaluator-verified.ts に写す
 * （相対の import は絶対パスに直す）。書き換えが終わったら（確かめて採用・戻した後）は、ふつうに evaluator.ts を読む。
 */
let editing = 0;
export const VERIFIED_EVALUATOR_PATH = path.join(CURRENT_DIR, "evaluator-verified.ts");
/** 作戦スクリプト（src/solver/tactics.ts）も同じ扱い */
export const VERIFIED_TACTICS_PATH = path.join(CURRENT_DIR, "tactics-verified.ts");

/** 相対の import を絶対パスに直して写す（別の場所から import できるように） */
function copyImportable(src: string, dest: string): void {
  const dir = path.dirname(src);
  const code = readFileSync(src, "utf-8").replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_m, a: string, rel: string, b: string) => `${a}${path.resolve(dir, rel)}${b}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, code);
}

export function beginEvaluatorEdit(): void {
  if (editing === 0) {
    for (const [src, dest] of [
      [EVALUATOR_PATH, VERIFIED_EVALUATOR_PATH],
      [TACTICS_PATH, VERIFIED_TACTICS_PATH],
    ] as const) {
      try {
        copyImportable(src, dest);
      } catch (err) {
        logger.warn({ file: src, err: err instanceof Error ? err.message : String(err) }, "書き換える前の写しを作れなかった");
      }
    }
  }
  editing += 1;
}

export function endEvaluatorEdit(): void {
  editing = Math.max(0, editing - 1);
}

/** 試合の始めに読む評価関数のファイル（書き換え中なら、書き換える前の写し） */
export function evaluatorPathForMatch(): string {
  return editing > 0 ? VERIFIED_EVALUATOR_PATH : EVALUATOR_PATH;
}

/** 試合の始めに読む作戦スクリプトのファイル（書き換え中なら、書き換える前の写し） */
export function tacticsPathForMatch(): string {
  return editing > 0 ? VERIFIED_TACTICS_PATH : TACTICS_PATH;
}

