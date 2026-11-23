import path from "node:path";

/** プロジェクト内のパスはすべてここで定義する（各ファイルで import.meta.dir から組み立てない）。 */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "..");

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
/** var/runs/ の試合の記録のフォルダ名（<日時>_room<N>）か。エージェントが作った写し（zz-selftest など）は試合として数えない */
export const isRunDirName = (name: string): boolean => /^\d{4}-\d{2}-\d{2}[^/]*_room\d+$/.test(name);
/** ハーネスが起動したエージェント（準備・サブ・振り返り）のツール呼び出しの記録（使われている機能を調べるため） */
export const AGENT_TOOL_LOG_PATH = path.join(VAR_DIR, "agent-tool-log.jsonl");
/** 保護ファイルを元に戻す前の中身の控え（src/evolution/edit-guard.ts） */
export const EDIT_GUARD_BACKUP_DIR = path.join(VAR_DIR, "edit-guard-backup");
export const ROOM_PROFILES_PATH = path.join(VAR_DIR, "room-profiles.json");
/** シミュレータの地図の作り方（エージェントが本物と見比べて直してよい） */
export const SIM_PROFILES_PATH = path.join(KNOWLEDGE_DIR, "sim-profiles.json");
/** 本物の地図（試合中の Webマップの最初の1枚、var/maps/room<N>/<runId>.json）。シミュレータで使う */
export const SIM_MAPS_DIR = path.join(VAR_DIR, "maps");
/** 方策の学習のやり方（1世代の候補・地図の数、確かめ用の地図の数、探す幅）。学習の LLM が直してよい */
export const TRAIN_CONFIG_PATH = path.join(KNOWLEDGE_DIR, "train-config.json");
/** 学習の LLM の作業場所（統計・再生の記録を書き出す）と記録 */
export const LAB_COACH_DIR = path.join(VAR_DIR, "lab-coach");
export const LAB_COACH_LOG_PATH = path.join(VAR_DIR, "lab-coach", "log.jsonl");
/** 学習した方策のパラメータ（src/solver/evaluator.ts の PARAM_SPACE の値）と、その成績 */
export const POLICY_DIR = path.join(VAR_DIR, "policy");
export const POLICY_PARAMS_PATH = path.join(POLICY_DIR, "params.json");
/** 学習の記録（1回ごとに1行） */
/** 特性ごとのモデル（ハンター・コレクターなど）の定義 */
export const POLICY_STYLES_PATH = path.join(KNOWLEDGE_DIR, "styles.json");
/** 保存しなかった学習の続き（モデルごと）。次の学習はここから続ける。本番では使わない */
export const POLICY_CANDIDATES_DIR = path.join(POLICY_DIR, "candidates");
/** 特性ごとのモデルのパラメータ（標準のモデルは params.json） */
export const POLICY_MODELS_DIR = path.join(POLICY_DIR, "models");
/** モデルごとに同じ地図・同じ相手で測った特性（攻撃・被弾・回収・勝ち） */
export const POLICY_MODEL_PROFILES_PATH = path.join(POLICY_DIR, "model-profiles.json");
/** 自己対戦の相手（前に採用したパラメータの控え） */
export const POLICY_LEAGUE_PATH = path.join(POLICY_DIR, "league.json");
export const POLICY_TRAIN_LOG_PATH = path.join(POLICY_DIR, "train-log.jsonl");
/** 経路探索の評価関数（エージェントが試合後に改修してよい。シミュレータの成績で採否を決める） */
export const EVALUATOR_PATH = path.join(PROJECT_ROOT, "src/solver/evaluator.ts");
export const CLAUDE_HOME_DIR = path.join(VAR_DIR, "claude-home");
/** 試合中の現在の状態（毎フェーズ更新。試合後に var/runs/<runId>/ へコピー） */
export const CURRENT_DIR = path.join(VAR_DIR, "current");
/** 試合中の盤面（毎ターン更新） */
export const CURRENT_SNAPSHOT_PATH = path.join(CURRENT_DIR, "snapshot.json");
/** メインが次のフェーズへ引き継ぐメモ */
export const CURRENT_MEMO_PATH = path.join(CURRENT_DIR, "MEMO.md");
