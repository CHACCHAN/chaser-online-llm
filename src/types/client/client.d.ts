export interface Config {
  retryIntervalMs: number;
  maxWaitMs?: number;
  /** 他プレイヤー待ちの間、定期的に呼ばれる（UI 表示用）。what = 待っている操作 */
  onWaiting?: (info: { what: string; elapsedMs: number; limitMs: number | null }) => void;
  /** true を返すと待機を打ち切る（停止ボタン） */
  shouldAbortWait?: () => boolean;
}
