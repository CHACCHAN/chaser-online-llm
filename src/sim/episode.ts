import { CMD1_COMMANDS, CMD2_COMMANDS, WorldMap } from "../memory/world-map";
import type { EvaluatorModule } from "../solver/planner";
import { makePlannerPolicy, type PolicyFn } from "../solver/policy";
import { runBotTurn, runHunterTurn } from "./bots";
import { DEFAULT_RULES, SimGame, totalScore, type SimPlayer } from "./engine";
import type { Scenario } from "./mapgen";
import { opponentLabel, type OpponentSetup } from "./opponents";

/**
 * シミュレータで1試合を行う。自分の手は本番と同じ WorldMap（観測の反映・位置合わせ）と方策で決める。
 * Webマップのある試合では、本番と同じく毎ターンの初めとワープの直後に全体マップを渡す。
 */

export interface EpisodeResult {
  scenario: string;
  webMap: boolean;
  totalTurns: number;
  score: number;
  action: number;
  item: number;
  hazardHits: number;
  /** 方策が合法でない手を返した・例外を投げた回数（安全な手で続けた） */
  policyErrors: number;
  /** 方策の判断にかかった時間（1フェーズの平均、ms） */
  msPerPhase: number;
  /** 他プレイヤーの得点 */
  opponents: number[];
  /** 他プレイヤーの種類（拾う・狙う・自分(今/n つ前)） */
  opponentKinds: string[];
  /** 自分が相手に当てた得点（+）・当てられた得点（−） */
  put: number;
  putDamage: number;
  /** 自分の得点が他の全員より高かった（相手がいない時は null） */
  won: boolean | null;
  /** 再生用の記録（trace を頼んだ時だけ） */
  trace?: EpisodeTrace;
}

/** 1試合の再生用の記録（WebUI の「学習」画面で再生する） */
export interface EpisodeTrace {
  width: number;
  height: number;
  /** 始まりの地図 */
  grid: number[][];
  players: { id: number; self: boolean; kind?: string }[];
  frames: {
    turn: number;
    /** 各プレイヤーの位置（players と同じ順） */
    pos: [number, number][];
    scores: number[];
    /**
     * 自分の当てた・当てられた得点の累計 [put, putDamage]。同じターンに当て合うと scores の差では見えない
     * （学習の LLM の要望 2026-11-23: report の当てた／当てられたと traces が合わないように見えた）
     */
    hits?: [number, number];
    /** 自分の CMD1・CMD2 */
    cmds: [string, string];
    /** 方策の判断の理由（CMD2） */
    reason: string;
    /** このターンに変わったマス [x, y, 新しい値] */
    changed: [number, number, number][];
  }[];
}

export { runBotTurn } from "./bots";

export interface EpisodeOptions {
  maxTurns?: number;
  onTurn?: (turn: number, game: SimGame) => void;
  trace?: boolean;
  /** 自分以外のプレイヤー（starts の順、自分を除く）。足りない分・無ければ「拾う」 */
  opponents?: OpponentSetup[];
  /** 相手の「自分」が使う評価関数（既定は今の evaluator.ts） */
  opponentEvaluator?: EvaluatorModule;
  /** 理論値の目安: 自分は地図にある全部のワープの行き先を初めから知っている（Webマップは呼ぶ側が毎ターン見せる） */
  knowAllWarps?: boolean;
}

/** 相手の「自分」: 自分と同じく、自分の観測と Webマップだけで方策が動く */
interface PolicyOpponent {
  wm: WorldMap;
  policy: PolicyFn;
}

export function runEpisode(scn: Scenario, policy: PolicyFn, opts: EpisodeOptions = {}): EpisodeResult {
  const putHit = scn.putHit ?? 0;
  const rules = { ...DEFAULT_RULES, putHitItem: putHit, putHitSoil: putHit };
  const game = new SimGame(scn.grid, scn.starts, opts.maxTurns ? Math.min(opts.maxTurns, scn.totalTurns) : scn.totalTurns, rules);
  const me = game.players[scn.self]!;
  const others = game.players.filter((p) => p !== me);
  const setups = new Map<SimPlayer, OpponentSetup>(others.map((p, i) => [p, opts.opponents?.[i] ?? { kind: "greedy" }]));
  const selfOpps = new Map<SimPlayer, PolicyOpponent>();
  for (const [p, o] of setups) {
    if (o.kind === "self") selfOpps.set(p, { wm: new WorldMap(), policy: makePlannerPolicy(o.params, ...(opts.opponentEvaluator ? [opts.opponentEvaluator] : [])) });
  }
  const wm = new WorldMap();
  if (opts.knowAllWarps) wm.setKnownGlobalWarps(game.knownWarps());
  let policyErrors = 0;
  let phases = 0;
  let ms = 0;
  let lastReason = "";
  const trace: EpisodeTrace | undefined = opts.trace
    ? { width: game.width, height: game.height, grid: game.grid.map((r) => [...r]), players: game.players.map((p) => ({ id: p.id, self: p === me, ...(p === me ? {} : { kind: opponentLabel(setups.get(p)!) }) })), frames: [] }
    : undefined;
  let prevGrid = trace ? game.grid.map((r) => [...r]) : null;
  const web = () => {
    if (scn.webMap) wm.setGlobalGrid(game.webGrid(), [me.x, me.y], scn.name, game.turn, me.id, wm.getPosition());
  };
  const decide = (phase: "CMD1" | "CMD2"): string => {
    const legal: readonly string[] = phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    const t0 = performance.now();
    let cmd: string;
    try {
      const d = policy(wm, phase, game.turn, { totalTurns: game.totalTurns });
      cmd = d.command;
      lastReason = d.reason;
    } catch {
      cmd = "";
    }
    ms += performance.now() - t0;
    phases += 1;
    if (!legal.includes(cmd)) {
      policyErrors += 1;
      cmd = wm.pickSafeFallback(phase);
    }
    return cmd;
  };

  let cmds: [string, string] = ["", ""];
  while (!game.over) {
    for (const p of game.players) {
      if (p !== me) {
        const opp = selfOpps.get(p);
        if (opp) runPolicyOpponentTurn(game, p, opp, scn.webMap);
        else if (setups.get(p)?.kind === "hunter") runHunterTurn(game, p);
        else runBotTurn(game, p);
        continue;
      }
      web();
      const c1 = decide("CMD1");
      wm.applyObservation("CMD1", c1, game.act(me, "CMD1", c1), game.turn);
      if (wm.getLastEventFlags().warpPending) web();
      const c2 = decide("CMD2");
      wm.applyObservation("CMD2", c2, game.act(me, "CMD2", c2), game.turn);
      game.endTurn(me);
      cmds = [c1, c2];
    }
    if (trace && prevGrid) {
      const changed: [number, number, number][] = [];
      for (let y = 0; y < game.height; y++) {
        for (let x = 0; x < game.width; x++) {
          const v = game.grid[y]![x]!;
          if (prevGrid[y]![x] !== v) {
            changed.push([x, y, v]);
            prevGrid[y]![x] = v;
          }
        }
      }
      trace.frames.push({ turn: game.turn, pos: game.players.map((p) => [p.x, p.y]), scores: game.players.map((p) => totalScore(p.score)), hits: [me.score.put, me.score.putDamage], cmds, reason: lastReason.slice(0, 160), changed });
    }
    opts.onTurn?.(game.turn, game);
    game.nextTurn();
  }
  return {
    scenario: scn.name,
    webMap: scn.webMap,
    totalTurns: game.totalTurns,
    score: totalScore(me.score),
    action: me.score.action,
    item: me.score.item,
    hazardHits: me.hazardHits,
    policyErrors,
    msPerPhase: phases ? Math.round((ms / phases) * 100) / 100 : 0,
    opponents: others.map((p) => totalScore(p.score)),
    opponentKinds: others.map((p) => opponentLabel(setups.get(p)!)),
    put: me.score.put,
    putDamage: me.score.putDamage,
    won: others.length ? others.every((p) => totalScore(p.score) < totalScore(me.score)) : null,
    ...(trace ? { trace } : {}),
  };
}

/** 相手の「自分」の1ターン（例外・合法でない手は安全な手で続ける） */
function runPolicyOpponentTurn(game: SimGame, p: SimPlayer, opp: PolicyOpponent, webMap: boolean): void {
  const { wm } = opp;
  const web = () => {
    if (webMap) wm.setGlobalGrid(game.webGrid(), [p.x, p.y], "sim", game.turn, p.id, wm.getPosition());
  };
  const decide = (phase: "CMD1" | "CMD2"): string => {
    const legal: readonly string[] = phase === "CMD1" ? CMD1_COMMANDS : CMD2_COMMANDS;
    let cmd = "";
    try {
      cmd = opp.policy(wm, phase, game.turn, { totalTurns: game.totalTurns }).command;
    } catch {
      cmd = "";
    }
    return legal.includes(cmd) ? cmd : wm.pickSafeFallback(phase);
  };
  web();
  const c1 = decide("CMD1");
  wm.applyObservation("CMD1", c1, game.act(p, "CMD1", c1), game.turn);
  if (wm.getLastEventFlags().warpPending) web();
  const c2 = decide("CMD2");
  wm.applyObservation("CMD2", c2, game.act(p, "CMD2", c2), game.turn);
  game.endTurn(p);
}
