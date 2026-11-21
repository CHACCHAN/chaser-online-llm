import { webMapRefreshMode } from "../config";
import type { WorldMap } from "../memory/world-map";
import { numSetting } from "../settings";
import { logger } from "../tools";
import { uiBus } from "../ui/event-bus";
import type { ScoreSample } from "../memory/tile-measure";
import { scrapeRoomWebMap, type WebMapScrapeResult } from "./web-map-scraper";

/**
 * Web マップの取得を試合の進行と切り離して裏で行う。
 * - 取得は同時に1つだけ。終わっていなければ次の依頼は見送る（重いサーバを叩き続けない）
 * - まだ取れていない間は CHASER_WEB_MAP_RETRY_TURNS ターンごとに再挑戦（サーバが重い・複数人で開始待ち等）
 * - 取れてからは CHASER_WEB_MAP_REFRESH に従って取り直す（every_turn / warp / off）
 * - 取得開始時点の自機位置を基準に盤面を合わせるので、取得中に動いてもずれない。取得中にワープしたら捨てる
 */
/**
 * Webマップの `turn=` は残りターン数（このターンを含む）。取りに行った時のハーネスのターンと足して全ターン数を出す。
 * 実測（room719、全1579ターン）: ハーネス T31 → turn=1549、T253 → turn=1327（どれも足して 1580）。
 */
export function totalTurnsFromWeb(t: { ourTurn: number; webTurn: number | null } | null): number | null {
  return t && t.webTurn !== null && t.webTurn > 0 ? t.ourTurn + t.webTurn - 1 : null;
}

export class WebMapRefresher {
  private inFlight: Promise<void> | null = null;
  private found = false;
  private lastSourceUrl: string | null = null;
  private lastStageName: string | null = null;
  private consecutiveFailures = 0;
  private lastSeenTurn: { ourTurn: number; webTurn: number | null } | null = null;
  private lastScoreSample: ScoreSample | null = null;
  private attempts = 0;
  /** 取得中にワープした時、終わったらすぐ取り直す */
  private rerunAfter: { turn: number; reason: string } | null = null;

  constructor(
    private readonly room: number,
    private readonly webMapUrl: string | undefined,
    private readonly worldMap: WorldMap,
    private readonly onUpdated: (r: WebMapScrapeResult) => void,
  ) {}

  get available(): boolean {
    return this.found;
  }

  get sourceUrl(): string | null {
    return this.lastSourceUrl;
  }

  get stageName(): string | null {
    return this.lastStageName;
  }

  /** 最後に取れた Webマップの `turn=` の値と、それを取りに行った時のハーネスのターン（意味の確認用に記録する） */
  get lastTurn(): { ourTurn: number; webTurn: number | null } | null {
    return this.lastSeenTurn;
  }

  /** 最後に取れた公式のアイテム得点（I:）と残りターン数。タイルの得点の実測に使う（取れるたびに新しいオブジェクトになる） */
  get lastScore(): ScoreSample | null {
    return this.lastScoreSample;
  }

  /** 試合開始時: 取得を始め、タイムアウト1回分だけ結果を待つ（間に合わなければ裏で続行） */
  async start(): Promise<void> {
    if (webMapRefreshMode() === "off") return;
    this.request(0, "開始時");
    const waitMs = numSetting("CHASER_WEB_MAP_TIMEOUT_SEC", { min: 1 }) * 1000;
    await Promise.race([this.inFlight, Bun.sleep(waitMs)]);
  }

  /** 各ターンの頭で呼ぶ */
  onTurnStart(turn: number): void {
    const mode = webMapRefreshMode();
    if (mode === "off") return;
    if (!this.found) {
      const every = numSetting("CHASER_WEB_MAP_RETRY_TURNS", { min: 1, integer: true });
      if (turn % every === 0) this.request(turn, "再挑戦");
      return;
    }
    if (mode === "every_turn") this.request(turn, "定期");
  }

  /** ワープ直後: 位置合わせのためすぐ取り直す */
  onWarp(turn: number): void {
    if (webMapRefreshMode() === "off") return;
    // 取得中なら、その結果は座標系が変わって捨てられるので、終わったらすぐ取り直す
    if (this.inFlight) this.rerunAfter = { turn, reason: "ワープ（取得中だったので取り直し）" };
    else this.request(turn, "ワープ");
  }

  /** 位置合わせ（自機の絶対座標）が決まるまで待つ。決まれば true */
  async waitForAlignment(maxMs: number): Promise<boolean> {
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      if (this.worldMap.getGlobalPosition() !== null) return true;
      await Bun.sleep(50);
    }
    return this.worldMap.getGlobalPosition() !== null;
  }

  /** 試合終了時: 実行中の取得が終わるのを少しだけ待つ（ログ・プロファイルの書き込みを揃える） */
  async drain(): Promise<void> {
    if (this.inFlight) await Promise.race([this.inFlight, Bun.sleep(3000)]);
  }

  private request(turn: number, reason: string): void {
    if (this.inFlight) return;
    const capturePos = this.worldMap.getPosition();
    const captureFrame = this.worldMap.frameVersion;
    this.attempts += 1;
    const startedAt = Date.now();
    this.inFlight = (async () => {
      try {
        const r = await scrapeRoomWebMap({ room: this.room, webMapUrl: this.webMapUrl });
        if (!r.found || !r.grid) {
          this.onFailure(reason, r.error ?? "マップが見つからない", startedAt);
          return;
        }
        // ワープ（新しい区画・前に来た区画へ戻る）で座標系が変わったら、取得開始時の位置は使えないので捨てる
        if (this.worldMap.frameVersion !== captureFrame) {
          logger.info({ reason }, "Web map discarded: warped while fetching");
          return;
        }
        this.worldMap.setGlobalGrid(r.grid, r.playerPos, r.stageName, turn, r.selfTileId, capturePos);
        this.consecutiveFailures = 0;
        this.lastSeenTurn = { ourTurn: turn, webTurn: r.turn };
        if (r.liveScore && r.turn !== null) this.lastScoreSample = { ourTurn: turn, webTurn: r.turn, itemPoint: r.liveScore.itemPoint };
        this.lastSourceUrl = r.sourceUrl;
        this.lastStageName = r.stageName;
        if (!this.found) {
          this.found = true;
          uiBus.pushClaudeEvent({
            context: "system",
            kind: "system",
            title: "Web マップを取得",
            content: `${reason}（T${turn}、${Math.round((Date.now() - startedAt) / 1000)}秒）。以降は ${webMapRefreshMode()} で更新`,
          });
          uiBus.patchState({ webMapDetected: true });
        }
        this.onUpdated(r);
      } catch (err) {
        this.onFailure(reason, err instanceof Error ? err.message : String(err), startedAt);
      } finally {
        this.inFlight = null;
        const rerun = this.rerunAfter;
        this.rerunAfter = null;
        if (rerun) this.request(rerun.turn, rerun.reason);
      }
    })();
  }

  private onFailure(reason: string, error: string, startedAt: number): void {
    this.consecutiveFailures += 1;
    logger.warn(
      { reason, error, ms: Date.now() - startedAt, consecutiveFailures: this.consecutiveFailures, attempts: this.attempts },
      "Web map fetch failed (play continues with own map)",
    );
  }
}
