import type { AgentUsageReport } from "../agent/main-agent";
import type { RoomProfile } from "../memory/knowledge-store";
import type { CandidateEvaluation, PathTarget, UiPlayerMarker } from "../memory/world-map";
import type { LiveMapScore } from "../perception/web-map-scraper";
import type { TurnRecord } from "../runner";

export type AgentRunStatus =
  | "idle"
  | "connecting"
  | "playing"
  /** 他プレイヤー待ち（複数人ルーム） */
  | "waiting"
  /** 準備フェーズ（「開始」より前。メインが資料・過去の試合を読んで最初のメモを作る） */
  | "preparing"
  /** 準備完了。「開始」で入室できる */
  | "standby"
  | "claude_in_game"
  | "evolving"
  | "cooldown"
  | "paused"
  | "error";

export interface UiMapState {
  source: "web_map" | "slam";
  stageName: string | null;
  width: number;
  height: number;
  grid: (number | null)[][];
  playerPos: [number, number] | null;
  trail: [number, number][];
  plannedPath: [number, number][];
  nextLandingPos: [number, number] | null;
  localAscii: string;
  /** 自機・他プレイヤー（表示座標） */
  players: UiPlayerMarker[];
  /** 盤面を最後に更新したターン */
  updatedTurn: number;
  /** 作戦目標の表示座標 */
  planCell: [number, number] | null;
}

export interface UiPredictionState {
  turn: number;
  phase: "CMD1" | "CMD2";
  command: string;
  reason: string;
  confidence: number;
  source: "solver" | "main" | "fallback";
  breakpointReasons: string[];
  topTargets: PathTarget[];
  nearestFrontiers: PathTarget[];
  candidates: CandidateEvaluation[];
  /** メインの返答種別 (continue / plan / command)。solver 単独なら null */
  mainAction?: "continue" | "plan" | "command" | null;
  /** main なら「作戦どおり」等、solver なら代行理由（時間切れ・多忙など） */
  mainNote?: string | null;
  mainLatencyMs?: number | null;
  /** 現在の作戦目標（ローカル座標） */
  plan?: { target: [number, number]; note?: string } | null;
  /** このフェーズでサブに依頼した仕事 */
  delegated?: string | null;
}

export interface UiSubTask {
  id: number;
  request: string;
  status: "queued" | "running" | "done" | "failed";
  result: string | null;
  durationMs: number | null;
}

export interface UiClaudeEvent {
  id: number;
  timestamp: string;
  context: "in_game" | "evolution" | "system";
  kind: "thinking" | "text" | "tool_use" | "tool_result" | "system" | "error";
  title?: string;
  content: string;
}

export interface UiScoresState {
  estimatedTotal: number;
  estimatedAction: number;
  estimatedItem: number;
  liveOfficial: LiveMapScore | null;
  lastOfficialTotal: number | null;
  roomHighScore: number | null;
  holeRevisits: number;
  hazardHits: number;
}

export interface UiDashboardState {
  status: AgentRunStatus;
  statusMessage: string;
  room: number;
  model: string;
  subModel: string;
  effort: string;
  subEffort: string;
  turnBudgetSec: number;
  maxTurns: number | null;
  matchIndex: number;
  runId: string | null;
  turn: number;
  phase: string;
  webMapDetected: boolean;
  autoContinue: boolean;
  running: boolean;
  pauseRequested: boolean;
  stopRequested: boolean;
  map: UiMapState | null;
  prediction: UiPredictionState | null;
  scores: UiScoresState;
  claudeStream: UiClaudeEvent[];
  /** サブエージェントの仕事一覧（今の試合） */
  subTasks: UiSubTask[];
  /** 今の試合のエージェント使用量（トークン） */
  agentUsage: AgentUsageReport | null;
  /** メインが次のフェーズへ引き継ぐメモ */
  agentMemo: string;
  /** 準備フェーズの状態（「開始」はこれが ready の時だけ。準備不要の設定なら required=false） */
  prep: PrepUiState;
  recentTurns: TurnRecord[];
  diagnosisMarkdown: string;
  roomProfiles: Record<string, RoomProfile>;
  /** 順に回るルーム（空=今のルームだけ） */
  roomQueue: number[];
  updatedAt: string;
}

export interface PrepUiState {
  required: boolean;
  state: "none" | "preparing" | "ready" | "failed";
  room: number | null;
  model: string | null;
  effort: string | null;
  at: string | null;
  durationMs: number | null;
  tokens: number | null;
  error: string | null;
  officialVersion: string | null;
  knownVersion: string | null;
  versionChanged: boolean;
}

export interface UiControlCommand {
  action: "prepare" | "start" | "stop" | "pause" | "resume" | "update_settings";
  room?: number;
  roomQueue?: number[];
  model?: string;
  subModel?: string;
  effort?: string;
  subEffort?: string;
  turnBudgetSec?: number;
  maxTurns?: number | null;
  autoContinue?: boolean;
}

/** 順に回るルームの並び（正の整数だけ。続けて同じ番号は1つにまとめる） */
export function parseRoomQueue(v: unknown): number[] {
  const list = (Array.isArray(v) ? v : String(v ?? "").split(/[\s,、]+/)).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return list.filter((n, i) => i === 0 || n !== list[i - 1]);
}

/** 順に回るルームで、今のルームの次（今のルームが並びに無ければ先頭）。並びが空なら null */
export function nextQueuedRoom(queue: number[], current: number): number | null {
  if (queue.length === 0) return null;
  const i = queue.indexOf(current);
  return queue[(i + 1) % queue.length]!;
}

type SseListener = (eventName: string, data: unknown) => void;
type ControlHandler = (cmd: UiControlCommand) => void;

class UiEventBus {
  private listeners = new Set<SseListener>();
  private controlHandler: ControlHandler | null = null;
  private claudeEventSeq = 0;

  private state: UiDashboardState = {
    status: "idle",
    statusMessage: "ダッシュボード待機中 — ルームを選択して「開始」を押してください",
    room: 3,
    model: "",
    subModel: "",
    effort: "",
    subEffort: "",
    turnBudgetSec: 20,
    maxTurns: null,
    matchIndex: 0,
    runId: null,
    turn: 0,
    phase: "IDLE",
    webMapDetected: false,
    autoContinue: true,
    running: false,
    pauseRequested: false,
    stopRequested: false,
    map: null,
    prediction: null,
    scores: {
      estimatedTotal: 0,
      estimatedAction: 0,
      estimatedItem: 0,
      liveOfficial: null,
      lastOfficialTotal: null,
      roomHighScore: null,
      holeRevisits: 0,
      hazardHits: 0,
    },
    claudeStream: [],
    subTasks: [],
    agentUsage: null,
    agentMemo: "",
    prep: { required: true, state: "none", room: null, model: null, effort: null, at: null, durationMs: null, tokens: null, error: null, officialVersion: null, knownVersion: null, versionChanged: false },
    recentTurns: [],
    diagnosisMarkdown: "",
    roomProfiles: {},
    roomQueue: [],
    updatedAt: new Date().toISOString(),
  };

  public getState(): UiDashboardState {
    return this.state;
  }

  public subscribe(listener: SseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setControlHandler(handler: ControlHandler): void {
    this.controlHandler = handler;
  }

  public dispatchControl(cmd: UiControlCommand): void {
    if (cmd.action === "update_settings") {
      const patch: Partial<UiDashboardState> = {};
      if (typeof cmd.room === "number" && Number.isInteger(cmd.room) && cmd.room > 0) {
        patch.room = cmd.room;
      }
      if (Array.isArray(cmd.roomQueue)) patch.roomQueue = parseRoomQueue(cmd.roomQueue);
      if (typeof cmd.model === "string") patch.model = cmd.model.trim();
      if (typeof cmd.subModel === "string") patch.subModel = cmd.subModel.trim();
      if (typeof cmd.effort === "string") patch.effort = cmd.effort.trim();
      if (typeof cmd.subEffort === "string") patch.subEffort = cmd.subEffort.trim();
      if (typeof cmd.turnBudgetSec === "number" && cmd.turnBudgetSec >= 3) patch.turnBudgetSec = cmd.turnBudgetSec;
      if (cmd.maxTurns !== undefined) {
        patch.maxTurns =
          cmd.maxTurns !== null && Number.isInteger(cmd.maxTurns) && cmd.maxTurns > 0
            ? cmd.maxTurns
            : null;
      }
      if (typeof cmd.autoContinue === "boolean") {
        patch.autoContinue = cmd.autoContinue;
      }
      this.patchState(patch);
    }
    if (cmd.action === "pause") {
      this.patchState({ pauseRequested: true, statusMessage: "現在の試合・進化が終わったら一時停止します..." });
    }
    if (cmd.action === "resume") {
      this.patchState({ pauseRequested: false, stopRequested: false });
    }
    if (cmd.action === "stop") {
      this.patchState({ stopRequested: true, pauseRequested: false, statusMessage: "停止リクエストを受け付けました..." });
    }
    if (this.controlHandler) {
      this.controlHandler(cmd);
    }
  }

  private emit(eventName: string, data: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(eventName, data);
      } catch {
        // ignore broken stream listeners
      }
    }
  }

  public patchState(partial: Partial<UiDashboardState>): void {
    this.state = {
      ...this.state,
      ...partial,
      updatedAt: new Date().toISOString(),
    };
    this.emit("state", this.state);
  }

  public updateScores(partial: Partial<UiScoresState>): void {
    this.state = {
      ...this.state,
      scores: {
        ...this.state.scores,
        ...partial,
      },
      updatedAt: new Date().toISOString(),
    };
    this.emit("scores", this.state.scores);
  }

  public updateMap(map: UiMapState): void {
    this.state = {
      ...this.state,
      map,
      updatedAt: new Date().toISOString(),
    };
    this.emit("map", map);
  }

  public updatePrediction(prediction: UiPredictionState): void {
    this.state = {
      ...this.state,
      prediction,
      updatedAt: new Date().toISOString(),
    };
    this.emit("prediction", prediction);
  }

  public pushTurnRecord(record: TurnRecord): void {
    const nextTurns = [...this.state.recentTurns.slice(-59), record];
    this.state = {
      ...this.state,
      turn: record.turn,
      recentTurns: nextTurns,
      updatedAt: new Date().toISOString(),
    };
    this.emit("turn", record);
  }

  public pushClaudeEvent(event: Omit<UiClaudeEvent, "id" | "timestamp">): void {
    const full: UiClaudeEvent = {
      id: ++this.claudeEventSeq,
      timestamp: new Date().toISOString(),
      ...event,
    };
    const nextStream = [...this.state.claudeStream.slice(-199), full];
    this.state = {
      ...this.state,
      claudeStream: nextStream,
      updatedAt: full.timestamp,
    };
    this.emit("claude", full);
  }

  public clearMatchLogs(room: number, matchIndex: number, runId: string): void {
    this.state = {
      ...this.state,
      room,
      matchIndex,
      runId,
      turn: 0,
      phase: "READY_CMD1",
      recentTurns: [],
      prediction: null,
      updatedAt: new Date().toISOString(),
    };
    this.emit("state", this.state);
  }
}

export const uiBus = new UiEventBus();
