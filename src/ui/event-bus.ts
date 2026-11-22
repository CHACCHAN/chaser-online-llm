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
  /** thinking = 非同期モードでメインが裏で考えている（手は方策が決めた） */
  mainAction?: "continue" | "plan" | "thinking" | null;
  /** main なら「作戦どおり」等、solver なら代行理由（時間切れ・多忙など） */
  mainNote?: string | null;
  mainLatencyMs?: number | null;
  /** 現在の作戦目標（ローカル座標） */
  plan?: { target: [number, number]; note?: string } | null;
  /** このフェーズと前のターンの終わりに鳴った、試合中の LLM を呼ぶきっかけ（src/agent/triggers.ts） */
  triggers?: { id: string; label: string; detail: string }[];
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
  effort: string;
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
  /** 今の試合のエージェント使用量（トークン） */
  agentUsage: AgentUsageReport | null;
  /** メインが次のフェーズへ引き継ぐメモ */
  agentMemo: string;
  /** 今の試合で使っている方策のモデル（試合中の LLM が切り替える）と、LLM を呼ぶ時 */
  matchModel?: { id: string; name: string; callMode: "trigger" | "every" | null; switches: number } | null;
  /** 準備フェーズの状態（「開始」はこれが ready の時だけ。準備不要の設定なら required=false） */
  prep: PrepUiState;
  recentTurns: TurnRecord[];
  diagnosisMarkdown: string;
  roomProfiles: Record<string, RoomProfile>;
  /** 複数のルームを指定した時の並び（1試合ごとに次へ。1つだけなら空） */
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
  /** 準備の LLM が決めた試合の設定の要約（最初のモデル・使わないきっかけ・しきい値） */
  plan?: string | null;
}

export interface UiControlCommand {
  action: "prepare" | "start" | "stop" | "pause" | "resume" | "update_settings";
  room?: number;
  /** WebUI のルーム欄の入力（"719"・"555-560"・"555,568"、組み合わせも可） */
  rooms?: string;
  model?: string;
  effort?: string;
  turnBudgetSec?: number;
  maxTurns?: number | null;
  autoContinue?: boolean;
}

/** 範囲で指定できるルームの数の上限（打ち間違いで何千ものルームを回らないように） */
const MAX_ROOM_RANGE = 100;

/**
 * ルーム欄の入力を、回るルームの並びにする。"719" → [719]、"555-560" → [555..560]、"555,568" → [555,568]（組み合わせ・空白区切りも可）。
 * 正の整数だけ。重複は最初の1つだけ残す
 */
export function parseRoomQueue(v: unknown): number[] {
  const tokens = Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[\s,、]+/);
  const out: number[] = [];
  for (const t of tokens) {
    const m = /^(\d+)\s*[-~〜]\s*(\d+)$/.exec(t.trim());
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const step = a <= b ? 1 : -1;
      for (let n = a, k = 0; k < MAX_ROOM_RANGE; n += step, k++) {
        if (n > 0) out.push(n);
        if (n === b) break;
      }
    } else if (/^\d+$/.test(t.trim()) && Number(t) > 0) out.push(Number(t));
  }
  return out.filter((n, i) => out.indexOf(n) === i);
}

/** 並びを入力の形に戻す（続く番号は範囲にまとめる）。[555,556,557,568] → "555-557,568" */
export function formatRoomQueue(list: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j]! + 1) j++;
    parts.push(j - i >= 2 ? `${list[i]}-${list[j]}` : list.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
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
    effort: "",
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
      if (typeof cmd.rooms === "string") {
        const list = parseRoomQueue(cmd.rooms);
        if (list.length > 0) {
          patch.roomQueue = list.length > 1 ? list : [];
          if (!list.includes(this.state.room)) patch.room = list[0]!;
        }
      }
      if (typeof cmd.model === "string") patch.model = cmd.model.trim();
      if (typeof cmd.effort === "string") patch.effort = cmd.effort.trim();
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
      matchModel: null,
      updatedAt: new Date().toISOString(),
    };
    this.emit("state", this.state);
  }
}

export const uiBus = new UiEventBus();
