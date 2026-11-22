import type { Cmd1Command, Cmd2Command } from "../memory/world-map";

/** 試合中の LLM が出す作戦目標（今の区画の座標）。方策はここへ向かう手を優先する */
export interface AgentPlan {
  target: [number, number];
  note?: string;
}

/** 方策が決めた手 */
export interface SolverDecision {
  command: Cmd1Command | Cmd2Command;
  reason: string;
  confidence: number;
  triggerHarness?: boolean;
  triggerReason?: string;
}
