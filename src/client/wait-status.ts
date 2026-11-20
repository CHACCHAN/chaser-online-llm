import { uiBus } from "../ui/event-bus";
import type { Config } from "../types/client";

/**
 * 他プレイヤー待ちを UI に出し、停止ボタンで待機を打ち切れるようにするクライアント設定。
 * 待機中は status=waiting になり、思考ログではなく「待機中 (経過)」が表示される。
 */
export function waitAwareClientConfig(retryIntervalMs: number): Config {
  let lastPush = 0;
  return {
    retryIntervalMs,
    onWaiting: ({ what, elapsedMs, limitMs }) => {
      // 最初の数秒は通常の応答待ちなので出さない。以降は2秒ごと
      if (elapsedMs < 3000 || Date.now() - lastPush < 2000) return;
      lastPush = Date.now();
      const limit = limitMs === null ? "上限なし" : `上限 ${Math.round(limitMs / 60_000)}分`;
      uiBus.patchState({
        status: "waiting",
        statusMessage: `他プレイヤー待ち: ${what} — ${Math.round(elapsedMs / 1000)}秒経過（${limit}）`,
      });
    },
    shouldAbortWait: () => uiBus.getState().stopRequested,
  };
}
