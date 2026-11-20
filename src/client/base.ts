import { hostUrl } from "../settings";
import { GameOver, HTTPError } from "../tools";
import type { Status } from "../types/client";

const shiftJisDecoder = new TextDecoder("shift_jis");

// 基本関数を格納
export class Base {
  private status: Status = {
    webRelease: {
      cookie: null,
      beforeResBody: null,
      latestResBody: null,
    },
    game: {
      roomNumber: 0,
      phase: "IDLE",
      turn: 0,
    },
  };

  // 状態返却
  public get getStatus(): Status {
    return this.status;
  }

  // 状態更新
  public updateStatus(diff: { [K in keyof Status]?: Partial<Status[K]> }): Status {
    this.status = {
      webRelease: { ...this.status.webRelease, ...diff.webRelease },
      game: { ...this.status.game, ...diff.game },
    };
    return this.status;
  }

  // CHaserOnlineは競技Webのエンドポイントにクエリを添える仕様
  public async getReq(path: string, querys: Record<string, string>): Promise<string> {
    const rawHost = hostUrl();
    const baseUrl = rawHost.endsWith("/") ? rawHost : `${rawHost}/`;
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(querys)) {
      url.searchParams.set(k, v);
    }

    let targetUrl = url.toString();

    // リダイレクトを最大10回まで追跡
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(targetUrl, {
        redirect: "manual",
        headers: this.status.webRelease.cookie
          ? { Cookie: this.status.webRelease.cookie }
          : {},
      });

      // ヘッダからJava Servletの識別Cookieを抽出
      const m = res.headers.get("set-cookie")?.match(/JSESSIONID=([^;]+)/);
      if (m?.[1]) {
        this.updateStatus({ webRelease: { cookie: `JSESSIONID=${m[1]}` } });
      }

      const location = res.headers.get("location");

      // ステータス確認
      if (res.status >= 300 && res.status < 400 && location) {
        targetUrl = new URL(location, targetUrl).toString();
        continue;
      }
      if (res.status === 500) {
        this.updateStatus({ game: { phase: "GAME_OVER" } });
        throw new GameOver("HTTP 500");
      }
      if (!res.ok) {
        throw new HTTPError(`HTTP ${res.status} ${targetUrl}`);
      }

      const decoded = shiftJisDecoder.decode(await res.arrayBuffer());

      // ステータス更新
      this.updateStatus({
        webRelease: {
          beforeResBody: this.status.webRelease.latestResBody,
          latestResBody: decoded,
        },
      });

      return decoded;
    }

    throw new HTTPError(`Too many redirects: ${targetUrl}`);
  }
}
