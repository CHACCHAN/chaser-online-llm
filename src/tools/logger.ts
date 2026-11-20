import pino from "pino";

export const logger = pino();

export class GameOver extends Error {
  constructor(message = "Game Over!") {
    super(message);

    this.name = "GameOver";
    logger.info(this.message);
  }
}

export class HTTPError extends Error {
  constructor(message: string) {
    super(message);

    this.name = "HTTP ERROR";
    logger.error(this.message);
  }
}

export class LoginError extends Error {
  constructor(message = "Login failed") {
    super(message);

    this.name = "LOGIN ERROR";
    logger.error(this.message);
  }
}

export class GeneralError extends Error {
  constructor(message: string) {
    super(message);

    this.name = "Error";
    logger.error(this.message);
  }
}
