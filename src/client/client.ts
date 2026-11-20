import { GameOver, GeneralError, logger, LoginError } from "../tools";
import type { Config, StepResult } from "../types/client";
import { numSetting } from "../settings";
import { Base } from "./base";
import { buildStepResult, extractVisibleLines, inspectFormMarkers } from "./parser";


export class Client extends Base {
  constructor(private readonly config: Config) {
    super();
  }

  /**
   * waitingMarker がレスポンスから消えるまで retryIntervalMs 間隔でポーリングする。
   */
  private async sendUntil(
    path: string,
    params: Record<string, string>,
    waitingMarker: string,
    maxWaitMsOverride?: number,
  ): Promise<string> {
    const start = Date.now();
    const maxWaitMs = maxWaitMsOverride ?? this.config.maxWaitMs ?? numSetting("CHASER_COMMAND_MAX_WAIT_SEC", { min: 1 }) * 1000;

    for (;;) {
      const body = await this.getReq(path, params);
      if (body.includes("user=")) {
        this.updateStatus({ game: { phase: "GAME_OVER" } });
        throw new GameOver("ログイン画面に戻されました");
      }
      if (!body.includes(waitingMarker)) {
        return body;
      }
      if (Date.now() - start >= maxWaitMs) {
        throw new GeneralError(`Timeout waiting for ${path}`);
      }
      await Bun.sleep(this.config.retryIntervalMs);
    }
  }

  // CHaserOnlineサーバにログインする
  public async login(): Promise<void> {
    await this.getReq("", {}); // JSESSIONIDを取得

    const body = await this.getReq("UserCheck", {
      user: Bun.env.CHASER_USER,
      pass: Bun.env.CHASER_PASS,
    });
    const markers = inspectFormMarkers(body);
    if (markers.hasUser || markers.hasPass) {
      throw new LoginError("ログインに失敗しました");
    }

    this.updateStatus({ game: { phase: "LOGGED_IN", turn: 0 } });
    logger.info(`Success Login: ${Bun.env.CHASER_USER}`);
  }

  // ルームに参加する
  public async enterRoom(roomNumber: string | number): Promise<StepResult> {
    const { phase } = this.getStatus.game;
    if (phase !== "LOGGED_IN") {
      throw new GeneralError(`Invalid phase ${phase} for enterRoom`);
    }

    this.updateStatus({ game: { roomNumber } });

    const start = Date.now();
    const maxWaitMs = this.config.maxWaitMs ?? numSetting("CHASER_COMMAND_MAX_WAIT_SEC", { min: 1 }) * 1000;

    for (;;) {
      const body = await this.getReq("RoomNumberCheck", {
        roomNumber: String(roomNumber),
      });
      const markers = inspectFormMarkers(body);

      if (markers.hasUser) {
        this.updateStatus({ game: { phase: "GAME_OVER" } });
        throw new GameOver("ルーム入室時にログイン画面へ戻されました");
      }
      if (markers.hasRoom && !markers.hasCmd1) {
        throw new GeneralError(`Don't join the room ${roomNumber}`);
      }
      if (markers.hasCmd1) {
        this.updateStatus({ game: { phase: "READY_CMD1", turn: 1 } });
        logger.info(`Success Join the Room ${roomNumber}`);
        return buildStepResult(body);
      }

      if (Date.now() - start >= maxWaitMs) {
        throw new GeneralError(`Timeout waiting for command1 in room ${roomNumber}`);
      }
      await Bun.sleep(this.config.retryIntervalMs);
    }
  }

  // GetReadyCheck (command1)
  public async command1(value: string, maxWaitMs?: number): Promise<StepResult> {
    const { phase } = this.getStatus.game;
    if (phase !== "READY_CMD1") {
      throw new GeneralError(`Invalid phase ${phase} for command1`);
    }

    const body = await this.sendUntil(
      "GetReadyCheck",
      { command1: value },
      "command1=",
      maxWaitMs,
    );
    const markers = inspectFormMarkers(body);

    if (markers.hasUser || !markers.hasCmd2) {
      const lines = extractVisibleLines(body);
      this.updateStatus({ game: { phase: "GAME_OVER" } });
      throw new GameOver(`Game over after command1(${value}): ${lines.join(" | ")}`);
    }

    this.updateStatus({ game: { phase: "READY_CMD2" } });
    logger.info(`Append Command1 ${value}`);
    return buildStepResult(body);
  }

  // CommandCheck (command2)
  public async command2(value: string, maxWaitMs?: number): Promise<StepResult> {
    const { phase } = this.getStatus.game;
    if (phase !== "READY_CMD2") {
      throw new GeneralError(`Invalid phase ${phase} for command2`);
    }

    const body = await this.sendUntil(
      "CommandCheck",
      { command2: value },
      "command2=",
      maxWaitMs,
    );
    const markers = inspectFormMarkers(body);

    if (markers.hasUser) {
      this.updateStatus({ game: { phase: "GAME_OVER" } });
      throw new GameOver(`Game over after command2(${value})`);
    }

    this.updateStatus({ game: { phase: "READY_CMD3" } });
    logger.info(`Append Command2 ${value}`);
    return buildStepResult(body);
  }

  // EndCommandCheck (command3)
  public async command3(value = "#"): Promise<StepResult> {
    const { phase, turn } = this.getStatus.game;
    if (phase !== "READY_CMD3") {
      throw new GeneralError(`Invalid phase ${phase} for command3`);
    }

    const body = await this.sendUntil("EndCommandCheck", { command3: value }, "command3=");
    const markers = inspectFormMarkers(body);

    if (markers.hasUser || !markers.hasCmd1) {
      const lines = extractVisibleLines(body);
      this.updateStatus({ game: { phase: "GAME_OVER" } });
      throw new GameOver(`Game over after command3: ${lines.join(" | ")}`);
    }

    this.updateStatus({ game: { phase: "READY_CMD1", turn: turn + 1 } });
    logger.info(`Append Command3 ${value}`);
    return buildStepResult(body);
  }
}
