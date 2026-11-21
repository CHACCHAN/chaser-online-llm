import { numSetting } from "../settings";
import { HTTPError } from "../tools";
import type { Client } from "./client";

export interface LoginRetryOptions {
  /** 再試行し続ける上限（ミリ秒）。既定は CHASER_LOGIN_WAIT_MIN */
  waitMs?: number;
  /** 再試行の間隔（ミリ秒）。既定は CHASER_LOGIN_RETRY_SEC */
  intervalMs?: number;
  /** true を返したら待つのをやめる（停止ボタンなど） */
  shouldStop?: () => boolean;
  /** 失敗して待つ時に呼ぶ（画面・ログ用） */
  onRetry?: (info: { attempt: number; waitedMs: number; remainingMs: number; error: string }) => void;
}

/**
 * ログインする。サーバは同一ユーザーの二重ログインを拒否し、途中で終わった試合（停止・ターン上限）の
 * セッションは数分で切れるので、CHASER_LOGIN_WAIT_MIN の間は CHASER_LOGIN_RETRY_SEC ごとにやり直す。
 * 停止（shouldStop / client.abort）されたらすぐ投げる。
 */
export async function loginWithRetry(client: Client, opts: LoginRetryOptions = {}): Promise<{ attempts: number; waitedMs: number }> {
  const waitMs = opts.waitMs ?? numSetting("CHASER_LOGIN_WAIT_MIN", { min: 0 }) * 60_000;
  const intervalMs = opts.intervalMs ?? numSetting("CHASER_LOGIN_RETRY_SEC", { min: 1 }) * 1000;
  const stopped = () => client.aborted || (opts.shouldStop?.() ?? false);
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login();
      return { attempts: attempt, waitedMs: Date.now() - start };
    } catch (err) {
      if (stopped()) throw new HTTPError("停止ボタンでログインを中断");
      const waited = Date.now() - start;
      if (waited + intervalMs > waitMs) throw err;
      opts.onRetry?.({ attempt, waitedMs: waited, remainingMs: waitMs - waited, error: err instanceof Error ? err.message : String(err) });
      // 停止をすぐ反映できるよう細かく眠る
      const until = Date.now() + intervalMs;
      while (Date.now() < until) {
        if (stopped()) throw new HTTPError("停止ボタンでログインを中断");
        await Bun.sleep(Math.min(500, until - Date.now()));
      }
    }
  }
}
