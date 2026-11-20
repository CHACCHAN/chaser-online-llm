import path from "node:path";

/** プロジェクト内のパスはすべてここで定義する（各ファイルで import.meta.dir から組み立てない）。 */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

export const SOLVER_PATH = path.join(PROJECT_ROOT, "src/solver/active-solver.ts");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "src/ui/public");

/** 人間と Claude が読み書きする永続知識（git 管理） */
export const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, "knowledge");
export const TILES_PATH = path.join(KNOWLEDGE_DIR, "tiles.json");
export const STRATEGY_PATH = path.join(KNOWLEDGE_DIR, "strategy.md");

/** 静的素材（公式 GIF 等） */
export const ASSETS_DIR = path.join(PROJECT_ROOT, "assets");

/** エージェント用手順書・プロンプト */
export const AGENT_DIR = path.join(PROJECT_ROOT, "agent");
/** ユーザー定義の作戦方針 (agent/policies/<name>.md) */
export const POLICIES_DIR = path.join(AGENT_DIR, "policies");

/** 実行時データ（.gitignore 対象） */
export const VAR_DIR = path.join(PROJECT_ROOT, "var");
export const RUNS_DIR = path.join(VAR_DIR, "runs");
export const ROOM_PROFILES_PATH = path.join(VAR_DIR, "room-profiles.json");
export const BEST_SOLVERS_DIR = path.join(VAR_DIR, "best-solvers");
export const CLAUDE_HOME_DIR = path.join(VAR_DIR, "claude-home");
