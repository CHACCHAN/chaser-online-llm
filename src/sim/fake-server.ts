import { CMD1_COMMANDS, CMD2_COMMANDS } from "../memory/world-map";
import { runBotTurn } from "./episode";
import { SimGame, totalScore, type SimPlayer } from "./engine";
import { makeScenario, type Scenario } from "./mapgen";
import { makeRng } from "./rng";

/**
 * シミュレータを CHaserOnline003 サーバの形で出す偽サーバ（手元でハーネス全体を通して試すため。本番サーバには触れない）。
 *
 *   bun scripts/sim-server.ts --port 3990 --seed 1
 *   HOST_URL=http://localhost:3990/CHaserOnline003/user/ CHASER_TEST_VAR_DIR=var/tmp/sim-var bun run play --room 1 --solver-only
 *
 * - user/: UserCheck・RoomNumberCheck・GetReadyCheck（command1）・CommandCheck（command2）・EndCommandCheck（command3）
 * - Server/: MapView.jsp（Webマップ。webMap の時だけ）
 * - 時間でターンが進むルーム（room455）は、本物の振る舞い（途中のフェーズの扱い）が分からないので、まだ再現しない
 */

export interface FakeServerOptions {
  port: number;
  seed: number;
  room?: number | null;
  /** 地図を作る代わりに使う設定（テスト用） */
  scenario?: Scenario;
  webMap?: boolean;
  totalTurns?: number;
  /** Webマップの得点欄に出す名前（既定 sim。ハーネスの CHASER_USER と同じにする） */
  user?: string;
}

export interface FakeServer {
  url: string;
  game: () => SimGame | null;
  /** ハーネスが動かしているプレイヤー */
  self: () => SimPlayer | null;
  stop: () => void;
}

const page = (body: string) => new Response(`<html><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=Shift_JIS", "Set-Cookie": "JSESSIONID=sim; Path=/" } });
/** 入力欄（クライアントは本文の `command1=` などで次に送るものを見分ける） */
const form = (name: string) => `<form action="?${name}="><input type="text" name="${name}"></form>`;
const gif = (v: number) => `<img src="/CHaserOnline003/img/${String(v).padStart(v >= 1000 ? 6 : 3, "0")}.gif">`;

export function startFakeServer(opts: FakeServerOptions): FakeServer {
  // ハーネス側も CHASER_USER=sim にする（Webマップの得点欄の名前で自分を見分けるため）
  const user = opts.user ?? "sim";
  let game: SimGame | null = null;
  let scn: Scenario | null = null;
  let phase: "CMD1" | "CMD2" | "CMD3" = "CMD1";

  const me = () => game!.players[scn!.self]!;
  const finishTurn = () => {
    const g = game!;
    g.endTurn(me());
    for (const p of g.players) if (p !== me()) runBotTurn(g, p);
    g.nextTurn();
    phase = "CMD1";
  };
  const start = () => {
    scn = opts.scenario ?? makeScenario(makeRng(opts.seed), { room: opts.room ?? null });
    if (opts.webMap !== undefined) scn.webMap = opts.webMap;
    game = new SimGame(scn.grid, scn.starts, opts.totalTurns ?? scn.totalTurns);
    phase = "CMD1";
  };
  const ret = (vals: number[]) => `ReturnCode=${vals.join(",")}\n`;

  const mapView = () => {
    const g = game!;
    const web = g.webGrid();
    const rows = web.map((r) => `<tr>${r.map((v) => `<td>${gif(v)}</td>`).join("")}</tr>`).join("");
    const p = me();
    const s = p.score;
    return page(
      `<H1>対戦マップビュー [Sim_${scn!.name}]</H1><p>turn=${Math.max(0, g.totalTurns - g.turn + 1)} Next=${user}</p>` +
        `<table cellpadding="0" cellspacing="0">${rows}</table>` +
        `<p>[${gif(p.id)} ${user} A:${s.action} I:${s.item} P:${s.put} PD:${s.putDamage} T:${totalScore(s)}]</p>`,
    );
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const q = url.searchParams;
      const name = url.pathname.replace(/^\/CHaserOnline003\//, "");
      if (name === "user/" || name === "user") return page(form("user") + form("pass"));
      if (name === "user/UserCheck") return page(`ようこそ ${form("roomNumber")}`);
      if (name === "user/RoomNumberCheck") {
        if (!game) start();
        return page(form("command1"));
      }
      if (!game) return page(form("user"));
      if (game.over) return page(`ゲーム終了 ${form("user")}`);
      if (name === "user/GetReadyCheck") {
        const cmd = q.get("command1") ?? "";
        if (phase !== "CMD1" || !(CMD1_COMMANDS as readonly string[]).includes(cmd)) return page(form("command1"));
        phase = "CMD2";
        return page(ret(game.act(me(), "CMD1", cmd)) + form("command2"));
      }
      if (name === "user/CommandCheck") {
        const cmd = q.get("command2") ?? "";
        if (phase !== "CMD2" || !(CMD2_COMMANDS as readonly string[]).includes(cmd)) return page(form(phase === "CMD1" ? "command1" : "command2"));
        phase = "CMD3";
        return page(ret(game.act(me(), "CMD2", cmd)) + form("command3"));
      }
      if (name === "user/EndCommandCheck") {
        if (Bun.env.SIM_SERVER_TRACE) console.log(JSON.stringify({ turn: game.turn, pos: [me().x, me().y], id: me().id, score: totalScore(me().score), item: me().score.item }));
        if (phase === "CMD3") finishTurn();
        return game.over ? page(`ゲーム終了 ${form("user")}`) : page(form("command1"));
      }
      if (name === "Server/MapView.jsp") return page("対戦マップビュー");
      if (name === "Server/UserCheck" && q.get("select") === "mapview") return scn?.webMap ? mapView() : page("対戦マップビュー");
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/CHaserOnline003/user/`,
    game: () => game,
    self: () => (game ? me() : null),
    stop: () => server.stop(true),
  };
}
