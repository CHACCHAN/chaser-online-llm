import path from "node:path";

/** プロジェクト内のパスはすべてここで定義する（各ファイルで import.meta.dir から組み立てない）。 */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

export const SOLVER_PATH = path.join(PROJECT_ROOT, "src/solver/active-solver.ts");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "src/ui/public");

/** 人間と Claude が読み書きする永続知識（git 管理） */
export const KNOWLEDGE_DIR = path.join(PROJECT_ROOT, "knowledge");
export const TILES_PATH = path.join(KNOWLEDGE_DIR, "tiles.json");
export const STRATEGY_PATH = path.join(KNOWLEDGE_DIR, "strategy.md");
/** ゲームのコマンド（公式の全61種）の唯一の置き場。試合中のメインにはこれをそのまま渡す */
export const COMMANDS_PATH = path.join(KNOWLEDGE_DIR, "commands.md");
/** ゲームのルール（スコア・タイル・公式資料との食い違い）の唯一の置き場。試合中のメインにはこれもそのまま渡す */
export const OFFICIAL_RULES_PATH = path.join(KNOWLEDGE_DIR, "official-rules.md");

/** 静的素材（公式 GIF 等） */
export const ASSETS_DIR = path.join(PROJECT_ROOT, "assets");

/** エージェント用手順書・プロンプト */
export const AGENT_DIR = path.join(PROJECT_ROOT, "agent");
/** ユーザー定義の作戦方針 (agent/policies/<name>.md) */
export const POLICIES_DIR = path.join(AGENT_DIR, "policies");
/** エージェント向けの説明書（全セッションのシステムプロンプトに入る） */
export const AGENTS_GUIDE_PATH = path.join(AGENT_DIR, "AGENTS.md");
/** 試合後にエージェントが書くハーネスへのレビュー（開発者が読む） */
export const AGENT_REVIEW_PATH = path.join(AGENT_DIR, "REVIEW.md");

/** 実行時データ（.gitignore 対象） */
// テスト（bun test）は src/test-setup.ts が一時ディレクトリを指定し、試合中の var/ を書き換えない
export const VAR_DIR = Bun.env.CHASER_TEST_VAR_DIR ? path.resolve(Bun.env.CHASER_TEST_VAR_DIR) : path.join(PROJECT_ROOT, "var");
export const RUNS_DIR = path.join(VAR_DIR, "runs");
/** ハーネスが起動したエージェント（準備・サブ・振り返り）のツール呼び出しの記録（使われている機能を調べるため） */
export const AGENT_TOOL_LOG_PATH = path.join(VAR_DIR, "agent-tool-log.jsonl");
/** 保護ファイルを元に戻す前の中身の控え（src/evolution/edit-guard.ts） */
export const EDIT_GUARD_BACKUP_DIR = path.join(VAR_DIR, "edit-guard-backup");
export const ROOM_PROFILES_PATH = path.join(VAR_DIR, "room-profiles.json");
export const BEST_SOLVERS_DIR = path.join(VAR_DIR, "best-solvers");
export const CLAUDE_HOME_DIR = path.join(VAR_DIR, "claude-home");
/** 試合中の現在の状態（毎フェーズ更新。試合後に var/runs/<runId>/ へコピー） */
export const CURRENT_DIR = path.join(VAR_DIR, "current");
/** メインが次のフェーズへ引き継ぐメモ */
export const CURRENT_MEMO_PATH = path.join(CURRENT_DIR, "MEMO.md");
/** サブへの依頼一覧と結果 */
export const CURRENT_ASK_SUB_PATH = path.join(CURRENT_DIR, "ASK_SUB.md");
