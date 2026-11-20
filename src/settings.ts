/**
 * 実行時設定の唯一の定義場所。値は `.env`（= Bun.env）から読み、ここにある既定値はフォールバックだけに使う。
 * - 読み取りは呼び出し時に行うので、WebUI の「環境設定」で .env を保存すると次の読み取りから反映される。
 * - 新しい設定を足すときはここに1項目追加するだけで、WebUI の設定画面と `.env.example` の説明にも載る。
 * - CLI 引数（--room 等）がある場合は src/config.ts で CLI > .env > 既定値 の順に解決する。
 */

export type SettingGroup = "chaser" | "llm" | "other";

export interface SettingDef {
  group: SettingGroup;
  description: string;
  defaultValue: string;
  secret?: boolean;
}

export const SETTINGS = {
  // --- CHaserOnline サーバ ---
  HOST_URL: {
    group: "chaser",
    description: "CHaserOnline ユーザ接続ベースURL",
    defaultValue: "http://www7019ug.sakura.ne.jp/CHaserOnline003/user/",
  },
  CHASER_USER: { group: "chaser", description: "CHaserOnline ログインユーザ名", defaultValue: "" },
  CHASER_PASS: { group: "chaser", description: "CHaserOnline ログインパスワード", defaultValue: "", secret: true },
  CHASER_ROOM: { group: "chaser", description: "デフォルトのルーム番号", defaultValue: "3" },
  CHASER_WEB_MAP_URL: {
    group: "chaser",
    description: "Webマップ明示指定URL（空欄で MapView.jsp を自動探索）",
    defaultValue: "",
  },
  CHASER_WEB_MAP_REFRESH: {
    group: "chaser",
    description: "Webマップの取り直し: every_turn（毎ターン）| warp（ワープ時のみ）| off",
    defaultValue: "every_turn",
  },
  CHASER_WEB_MAP_RETRY_TURNS: {
    group: "chaser",
    description: "Webマップがまだ取れていない時に再挑戦する間隔（ターン）。サーバが重い時や複数人で開始待ちの時用",
    defaultValue: "5",
  },
  CHASER_WEB_MAP_TIMEOUT_SEC: {
    group: "chaser",
    description: "Webマップ取得の通信1回あたりのタイムアウト（秒）。取得は裏で行うので試合は待たない",
    defaultValue: "10",
  },
  CHASER_MAX_TURNS: { group: "chaser", description: "1試合の最大ターン数（空=サーバが終えるまで）", defaultValue: "" },
  CHASER_MAX_MATCHES: { group: "chaser", description: "連続モードの最大試合数（空=無制限）", defaultValue: "" },
  CHASER_RETRY_MS: { group: "chaser", description: "コマンド再送間隔（ミリ秒、50以上）", defaultValue: "250" },
  CHASER_PLAYER_WAIT_MIN: {
    group: "chaser",
    description: "入室後・各コマンド後に他プレイヤーを待つ上限（分、0=無制限）。複数人ルームでは相手の思考時間ぶん待たされる",
    defaultValue: "30",
  },
  CHASER_LOGIN_WAIT_MIN: {
    group: "chaser",
    description: "二重ログイン拒否時にログインを再試行し続ける時間（分）",
    defaultValue: "10",
  },
  CHASER_LOGIN_RETRY_SEC: { group: "chaser", description: "ログイン再試行の間隔（秒）", defaultValue: "45" },

  // --- Claude Code ハーネス / エージェント ---
  LLM_API_URL: { group: "llm", description: "LiteLLM / Gravitee ゲートウェイ URL", defaultValue: "" },
  LLM_API_KEY: {
    group: "llm",
    description: "API キー (ANTHROPIC_API_KEY / X-Gravitee-Api-Key として送信)",
    defaultValue: "",
    secret: true,
  },
  LLM_MODEL_NAME: { group: "llm", description: "メインエージェントのモデル（ゲートウェイの /models から選択）", defaultValue: "" },
  LLM_SUB_MODEL_NAME: { group: "llm", description: "サブエージェントのモデル（空ならメインと同じ）", defaultValue: "" },
  LLM_MODEL_EFFORT: { group: "llm", description: "メインの effort: low | medium | high | xhigh | max", defaultValue: "medium" },
  LLM_SUB_MODEL_EFFORT: { group: "llm", description: "サブの effort（空ならメインと同じ）", defaultValue: "" },
  AGENT_POLICY: {
    group: "llm",
    description: "使う作戦方針の名前（agent/policies/<名前>.md。WebUI の設定から編集・切替できる）",
    defaultValue: "default",
  },
  AGENT_USE_MAIN: { group: "llm", description: "メインエージェントを使う（false でソルバーのみ）", defaultValue: "true" },
  AGENT_TURN_BUDGET_SEC: {
    group: "llm",
    description: "メインの1フェーズあたりの思考予算（秒、3以上）。超えたらソルバー手を送信",
    defaultValue: "20",
  },
  AGENT_WARMUP_TIMEOUT_SEC: { group: "llm", description: "試合開始前のメイン準備の待ち上限（秒）", defaultValue: "90" },
  AGENT_SUB_TASK_TIMEOUT_MIN: { group: "llm", description: "サブの1仕事あたりの上限（分）", defaultValue: "10" },
  AGENT_POST_MATCH_TIMEOUT_MIN: { group: "llm", description: "試合後の振り返り・ソルバー改修の上限（分）", defaultValue: "15" },
  AGENT_COMPACT_AT_TOKENS: {
    group: "llm",
    description: "メインの会話がこのトークン数を超えたら、試合を止めずに裏で要約し、要約入りの新しいメインに入れ替える（0=しない）",
    defaultValue: "60000",
  },
  AGENT_MATCH_TOKEN_LIMIT: {
    group: "llm",
    description: "1試合で使うトークンの上限（メイン・サブ・要約の合計。キャッシュ分も含む。0=無制限）。超えたら残りはソルバーのみで続ける",
    defaultValue: "20000000",
  },
  AGENT_EVOLVE_MIN_TURNS: {
    group: "llm",
    description: "このターン数未満で終わった試合（待機切れ・接続失敗など）は振り返り・最高記録の更新をしない",
    defaultValue: "3",
  },
  AGENT_EVOLVE: {
    group: "llm",
    description: "WebUI 連続モードで試合後にソルバー改修（振り返り）を行う（bun run play は --evolve 指定時のみ）",
    defaultValue: "true",
  },
  LLM_MODELS_TIMEOUT_SEC: { group: "llm", description: "ゲートウェイ /models 取得のタイムアウト（秒）", defaultValue: "10" },

  // --- その他 ---
  PORT: { group: "other", description: "WebUI のポート", defaultValue: "3456" },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

/** .env の値（空なら既定値）。既定値も空なら undefined */
export function getSetting(key: SettingKey): string | undefined {
  const raw = Bun.env[key]?.trim();
  if (raw) return raw;
  const def = SETTINGS[key].defaultValue;
  return def ? def : undefined;
}

export function getNumberSetting(key: SettingKey, opts: { min?: number; integer?: boolean } = {}): number | undefined {
  const raw = getSetting(key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  const bad = !Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) || (opts.min !== undefined && n < opts.min);
  if (bad) throw new Error(`設定 ${key}=${raw} が不正です（${SETTINGS[key].description}）`);
  return n;
}

/** 数値設定（既定値ありの項目用）。不正値はエラー */
export function numSetting(key: SettingKey, opts: { min?: number; integer?: boolean } = {}): number {
  const n = getNumberSetting(key, opts);
  if (n === undefined) throw new Error(`設定 ${key} が未設定です`);
  return n;
}

export function boolSetting(key: SettingKey): boolean {
  const raw = (getSetting(key) ?? "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export function hostUrl(): string {
  return getSetting("HOST_URL")!;
}
