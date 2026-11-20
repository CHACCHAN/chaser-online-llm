export type GamePhase =
  | "IDLE"
  | "LOGGED_IN"
  | "READY_CMD1"
  | "READY_CMD2"
  | "READY_CMD3"
  | "GAME_OVER";

export interface StepResult {
  body: string;
  values: number[] | null;
  rawReturnCode: string | null;
  textLines: string[];
}

export interface Status {
  webRelease: {
    cookie: string | null;
    beforeResBody: string | null;
    latestResBody: string | null;
  };
  game: {
    roomNumber: string | number;
    phase: GamePhase;
    turn: number;
  };
}
