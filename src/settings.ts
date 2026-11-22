/**
 * 実行時設定の唯一の定義場所。値は `.env`（= Bun.env）から読み、ここにある既定値はフォールバックだけに使う。
 * - 読み取りは呼び出し時に行うので、WebUI の「環境設定」で .env を保存すると次の読み取りから反映される。
 * - 新しい設定を足すときはここに1項目追加するだけで、WebUI の設定画面と `.env.example` の説明にも載る。
 * - CLI 引数（--room 等）がある場合は src/config.ts で CLI > .env > 既定値 の順に解決する。
 */

export type SettingGroup = "chaser" | "llm" | "other";

export interface SettingDef {
  /** 設定画面に出す短い名前 */
  label: string;
  group: SettingGroup;
  description: string;
  defaultValue: string;
  secret?: boolean;
  /** 選べる値（WebUI の設定で候補として出す） */
  options?: readonly string[];
}

export const SETTINGS = {
  // --- CHaserOnline サーバ ---
  HOST_URL: {
    label: "CHaser サーバの URL",
    group: "chaser",
    description: "CHaserOnline ユーザ接続ベースURL",
    defaultValue: "http://www7019ug.sakura.ne.jp/CHaserOnline003/user/",
  },
  CHASER_USER: { label: "ユーザ名", group: "chaser", description: "CHaserOnline ログインユーザ名", defaultValue: "" },
  CHASER_PASS: { label: "パスワード", group: "chaser", description: "CHaserOnline ログインパスワード", defaultValue: "", secret: true },
  CHASER_ROOM: { label: "いつものルーム", group: "chaser", description: "デフォルトのルーム番号", defaultValue: "3" },
  CHASER_WEB_MAP_URL: {
    label: "Webマップの URL（指定する時だけ）",
    group: "chaser",
    description: "Webマップ明示指定URL（空欄で MapView.jsp を自動探索）",
    defaultValue: "",
  },
  CHASER_WEB_MAP_REFRESH: {
    label: "Webマップを取り直す頻度",
    group: "chaser",
    description: "Webマップの取り直し: every_turn（毎ターン）| warp（ワープ時のみ）| off",
    defaultValue: "every_turn",
  },
  CHASER_WEB_MAP_RETRY_TURNS: {
    label: "Webマップを取り直すまでのターン数",
    group: "chaser",
    description: "Webマップがまだ取れていない時に再挑戦する間隔（ターン）。サーバが重い時や複数人で開始待ちの時用",
    defaultValue: "5",
  },
  CHASER_WEB_MAP_TIMEOUT_SEC: {
    label: "Webマップ取得の待ち時間（秒）",
    group: "chaser",
    description: "Webマップ取得の通信1回あたりのタイムアウト（秒）。取得は裏で行うので試合は待たない",
    defaultValue: "10",
  },
  CHASER_WARP_ALIGN_WAIT_SEC: {
    label: "ワープ直後に位置を合わせる待ち時間（秒）",
    group: "chaser",
    description: "ワープを踏んだ直後（着地先のまわりが分からない）、次の手を決める前に Webマップでの位置合わせを待つ上限（秒）。0=待たない",
    defaultValue: "5",
  },
  CHASER_HTTP_TIMEOUT_SEC: {
    label: "サーバ通信の待ち時間（秒）",
    group: "chaser",
    description: "CHaser サーバへの通信1回あたりのタイムアウト（秒、0=無制限）。サーバが応答しないまま試合が止まり続けるのを防ぐ（他プレイヤー待ちは別の仕組みなので影響しない）",
    defaultValue: "180",
  },
  CHASER_MAX_TURNS: { label: "1試合の最大ターン数", group: "chaser", description: "1試合の最大ターン数（空=サーバが終えるまで）", defaultValue: "" },
  CHASER_MAX_MATCHES: { label: "続けて行う試合の数", group: "chaser", description: "連続モードの最大試合数（空=無制限）", defaultValue: "" },
  CHASER_RETRY_MS: { label: "コマンドを送り直す間隔（ミリ秒）", group: "chaser", description: "コマンド再送間隔（ミリ秒、50以上）", defaultValue: "250" },
  CHASER_PLAYER_WAIT_MIN: {
    label: "他のプレイヤーを待つ上限（分）",
    group: "chaser",
    description: "入室後・各コマンド後に他プレイヤーを待つ上限（分、0=無制限）。複数人ルームでは相手の思考時間ぶん待たされる",
    defaultValue: "30",
  },
  CHASER_LOGIN_WAIT_MIN: {
    label: "二重ログインの時に待つ上限（分）",
    group: "chaser",
    description: "二重ログイン拒否時にログインを再試行し続ける時間（分）",
    defaultValue: "10",
  },
  CHASER_LOGIN_RETRY_SEC: { label: "ログインを試し直す間隔（秒）", group: "chaser", description: "ログイン再試行の間隔（秒）", defaultValue: "45" },

  // --- Claude Code ハーネス / エージェント ---
  LLM_AUTH_MODE: {
    label: "LLM のつなぎ方",
    group: "llm",
    description: "LLM のつなぎ方: api（Anthropic 互換の API。LLM_API_URL・LLM_API_KEY・LLM_API_HEADERS）| subscription（Claude のサブスクリプション。LLM_OAUTH_TOKEN）",
    defaultValue: "api",
    options: ["api", "subscription"],
  },
  LLM_API_URL: {
    label: "API の URL",
    group: "llm",
    description: "api: Anthropic 互換 API の URL（/v1/messages を持つもの。末尾の /v1 は有っても無くてもよい。空なら Anthropic API に直接）",
    defaultValue: "",
  },
  LLM_API_KEY: { label: "API キー", group: "llm", description: "api: API キー（LLM_API_HEADERS の {KEY} に入る。鍵の無いローカル LLM なら空でよい）", defaultValue: "", secret: true },
  LLM_API_HEADERS: {
    label: "送るヘッダ",
    group: "llm",
    description:
      "api: 送るヘッダ（\"名前: 値; 名前: 値\"。{KEY} は LLM_API_KEY に置き換わる）。例: Anthropic 直接 \"x-api-key: {KEY}\" / LiteLLM 等 \"Authorization: Bearer {KEY}\" / Gravitee \"x-api-key: {KEY}; X-Gravitee-Api-Key: {KEY}\"",
    defaultValue: "x-api-key: {KEY}",
  },
  LLM_OAUTH_TOKEN: {
    label: "トークン（setup-token）",
    group: "llm",
    description: "subscription: `claude setup-token` で作ったトークン（空なら、この画面の上の「Claude にログイン」か `bun run claude-login` でログインした情報を使う）",
    defaultValue: "",
    secret: true,
  },
  LLM_CONTEXT_WINDOW: {
    label: "コンテキストの大きさ",
    group: "llm",
    description:
      "モデルのコンテキストの大きさ（トークン。例 32768・128k）。自動コンパクトはこれを上限として会話を要約する（CLAUDE_CODE_AUTO_COMPACT_WINDOW）。空なら Claude Code の既定（知っているモデルはその大きさ、知らないモデルは Claude Code が仮定する大きさ）。ローカル LLM など小さいモデルで設定する",
    defaultValue: "",
  },
  LLM_AUTO_COMPACT: {
    label: "長くなったら自動で要約",
    group: "llm",
    description: "会話がコンテキストに近づいたら自動で要約する（Claude Code の自動コンパクト。準備・サブ・振り返りの長い会話に効く。試合中のメインは毎フェーズ新しい会話なので関係しない）",
    defaultValue: "true",
  },
  LLM_AUTO_COMPACT_PCT: {
    label: "自動要約を始める使用率（%）",
    group: "llm",
    description: "自動コンパクトを始める使用率（%、1〜100。空なら Claude Code の既定。CLAUDE_AUTOCOMPACT_PCT_OVERRIDE）",
    defaultValue: "",
  },
  LLM_MAX_OUTPUT_TOKENS: {
    label: "1回の応答の最大トークン",
    group: "llm",
    description: "1回の応答の最大トークン（空なら Claude Code の既定。CLAUDE_CODE_MAX_OUTPUT_TOKENS）。出力の上限が小さいモデルで設定する",
    defaultValue: "",
  },
  LLM_MODEL_NAME: { label: "LLM のモデル", group: "llm", description: "メインエージェントのモデル（api はゲートウェイの /models から、subscription は opus / sonnet / haiku など）", defaultValue: "" },
  LLM_SUB_MODEL_NAME: { label: "サブのモデル", group: "llm", description: "サブエージェントのモデル（空ならメインと同じ）", defaultValue: "" },
  LLM_MODEL_EFFORT: { label: "LLM の思考の深さ（effort）", group: "llm", description: "メインの effort: low | medium | high | xhigh | max", defaultValue: "medium" },
  LLM_SUB_MODEL_EFFORT: { label: "サブの思考の深さ（effort）", group: "llm", description: "サブの effort（空ならメインと同じ）", defaultValue: "" },
  AGENT_POLICY: {
    label: "作戦方針",
    group: "llm",
    description: "使う作戦方針の名前（agent/policies/<名前>.md。WebUI の設定から編集・切替できる）",
    defaultValue: "default",
  },
  AGENT_USE_MAIN: { label: "試合中に LLM を使う", group: "llm", description: "メインエージェントを使う（false でソルバーのみ）", defaultValue: "true" },
  AGENT_ASYNC: {
    label: "LLM を待たずに打つ",
    group: "llm",
    description: "メインを待たずに打つ（true）。手は毎フェーズ方策がすぐ決め、メインは裏で盤面を読んで作戦（目標）を出し、届いた時から反映する。false = 毎フェーズメインの返答を待つ（時間でターンが進むルームでは間に合わない）",
    defaultValue: "true",
  },
  AGENT_HEDGE_SEC: {
    label: "返答が遅い時に二重に聞くまでの秒数",
    group: "llm",
    description: "メインがこの秒数たっても返答しない時、同じ問い合わせをもう1つのプロセスにも送り、先に返った方を使う（ゲートウェイの詰まり対策。0=しない）",
    defaultValue: "15",
  },
  AGENT_TURN_BUDGET_SEC: {
    label: "1手の思考予算（秒）",
    group: "llm",
    description: "メインの1フェーズあたりの思考予算（秒、3以上）。超えたらソルバー手を送信",
    defaultValue: "20",
  },
  AGENT_PREP: {
    label: "試合前に準備する",
    group: "llm",
    description: "試合前の準備フェーズ（true/false）。入室前にメインがツール（読むだけ）でルール・ルームの過去の試合・作戦方針を調べ、最初のメモを作る",
    defaultValue: "true",
  },
  AGENT_PREP_TIMEOUT_SEC: { label: "準備の上限（秒）", group: "llm", description: "準備フェーズの上限（秒）。超えたらメモなしで試合を始める", defaultValue: "180" },
  AGENT_PREP_RETRY_MIN: { label: "準備に失敗した時の待ち（分）", group: "llm", description: "連続モードで次の試合の準備に失敗した時（LLM の利用制限・ゲートウェイの停止など）、この分だけ待って準備をやり直す（0=やり直さず止まる）", defaultValue: "5" },
  AGENT_PREP_PAST_RUNS: { label: "準備で読む過去の試合の数", group: "llm", description: "準備フェーズで読ませる、このルームの過去の試合の数（新しい順）", defaultValue: "5" },
  AGENT_MEMO_MAX_CHARS: {
    label: "引き継ぎメモの上限（字）",
    group: "llm",
    description: "メインが次のフェーズへ引き継ぐメモの上限（字）。メインは毎フェーズ前の会話なしで呼ばれ、メモ・直近の経過・現在の状況だけを受け取る",
    defaultValue: "2000",
  },
  AGENT_KNOWN_CELLS_RADIUS: { label: "見せるマスのメモの範囲（マス）", group: "llm", description: "試合中のメインに見せる「既知のワープ・マスのメモ」の範囲（今の位置からのマス数）", defaultValue: "12" },
  AGENT_RECENT_PHASES: { label: "見せる直近の経過（フェーズ数）", group: "llm", description: "メインに渡す「直近の経過」のフェーズ数", defaultValue: "20" },
  AGENT_SUB_TODO_ITEMS: { label: "見せるサブへの依頼の数", group: "llm", description: "メインに毎回渡す「サブへの依頼（TODO）」の件数（新しい順）", defaultValue: "10" },
  AGENT_SUB_CONCURRENCY: { label: "同時に動かすサブの数", group: "llm", description: "同時に動かすサブの数（依頼ごとに別のセッション）。超えた依頼は待機し、空いたら順に始める", defaultValue: "5" },
  AGENT_SUB_TASK_TIMEOUT_MIN: { label: "サブの1仕事の上限（分）", group: "llm", description: "サブの1仕事あたりの上限（分）", defaultValue: "10" },
  AGENT_POST_MATCH_TIMEOUT_MIN: { label: "試合後の振り返りの上限（分）", group: "llm", description: "試合後の振り返り・ソルバー改修の上限（分）", defaultValue: "15" },
  AGENT_MATCH_TOKEN_LIMIT: {
    label: "1試合のトークンの上限",
    group: "llm",
    description: "1試合で使うトークンの上限（メイン・サブの合計。キャッシュ分も含む。0=無制限）。超えたら残りはソルバーのみで続ける",
    defaultValue: "20000000",
  },
  AGENT_REVIEW: {
    label: "試合後に使い勝手をレビューする",
    group: "llm",
    description: "試合後の振り返りのあと、エージェントにハーネスの使い勝手・不具合・欲しい機能をレビューさせ agent/REVIEW.md に書く（true/false）",
    defaultValue: "true",
  },
  AGENT_REVIEW_TIMEOUT_SEC: { label: "レビューの上限（秒）", group: "llm", description: "ハーネスのレビューの上限（秒）", defaultValue: "240" },
  AGENT_REVIEW_KEEP: { label: "残すレビューの数", group: "llm", description: "agent/REVIEW.md に残すレビューの件数（新しい順）", defaultValue: "30" },
  AGENT_EVOLVE_MIN_TURNS: {
    label: "振り返る試合の最低ターン数",
    group: "llm",
    description: "このターン数未満で終わった試合（待機切れ・接続失敗など）は振り返り・最高記録の更新をしない",
    defaultValue: "3",
  },
  PLAY_POLICY: {
    label: "試合中に手を決めるもの",
    group: "other",
    description: "試合中に手を決める方策: planner（経路探索。評価関数 src/solver/evaluator.ts と学習したパラメータ var/policy/params.json）| solver（従来のソルバー src/solver/active-solver.ts）",
    defaultValue: "planner",
    options: ["planner", "solver"],
  },
  TRAIN_AFTER_MATCH_MIN: {
    label: "試合後の学習の時間（分）",
    group: "other",
    description: "試合後にシミュレータで方策のパラメータを学習する時間（分、0=しない）。その試合の地図（Webマップ）も学習に混ぜる。はっきり良くなった時だけ保存",
    defaultValue: "5",
  },
  TRAIN_IDLE: {
    label: "試合をしていない間も学習する",
    group: "other",
    description: "試合をしていない間もシミュレータで学習を続ける（WebUI の「学習」画面でも切り替えられる）。試合が始まると止まる",
    defaultValue: "false",
  },
  TRAIN_IDLE_CHUNK_MIN: {
    label: "空き時間の学習1回の時間（分）",
    group: "other",
    description: "試合をしていない間の学習の1回分の時間（分）。1回ごとに確かめ、はっきり良くなった時だけ保存する",
    defaultValue: "10",
  },
  LAB_COACH: {
    label: "学習のたびに学習の LLM が環境を直す",
    group: "other",
    description:
      "学習（「学習」画面・試合後・空き時間）が終わるたびに、学習の LLM（試合中の LLM とは別のセッション）が地図ごとの成績・足踏み・罠を読み、評価関数（src/solver/evaluator.ts）・地図の作り方（knowledge/sim-profiles.json）・学習のやり方（knowledge/train-config.json）を直す。評価関数は改修前と同じ地図で比べて弱ければ戻し、地図の作り方は本物の地図から遠ざかれば戻す。1回ごとにトークンを使う",
    defaultValue: "true",
    options: ["true", "false"],
  },
  LAB_COACH_MODEL: { label: "学習の LLM のモデル", group: "llm", description: "空なら LLM（LLM_MODEL_NAME）と同じ", defaultValue: "" },
  LAB_COACH_EFFORT: { label: "学習の LLM の思考の深さ（effort）", group: "llm", description: "空なら LLM（LLM_MODEL_EFFORT）と同じ", defaultValue: "" },
  LAB_COACH_TIMEOUT_MIN: { label: "学習の LLM の上限（分）", group: "other", description: "学習の LLM が1回に使える時間（分）。過ぎたら止め、それまでの改修を確かめる", defaultValue: "10" },
  SIM_MAX_TURNS: {
    label: "シミュレータの1試合のターン数",
    group: "other",
    description: "学習・比較のシミュレータで1試合を何ターンで打ち切るか（短いほど速い）",
    defaultValue: "200",
  },
  SIM_WORKERS: {
    label: "シミュレータを並列に回す数",
    group: "other",
    description: "シミュレータを並列に回す数（空 = CPU の数 − 2、最大16）",
    defaultValue: "",
  },
  AGENT_EVOLVE: {
    label: "試合後にソルバーを改修する",
    group: "llm",
    description: "WebUI 連続モードで試合後にソルバー改修（振り返り）を行う（bun run play は --evolve 指定時のみ）",
    defaultValue: "true",
  },
  LLM_MODELS_TIMEOUT_SEC: { label: "モデル一覧取得の待ち時間（秒）", group: "llm", description: "ゲートウェイ /models 取得のタイムアウト（秒）", defaultValue: "10" },

  // --- その他 ---
  PORT: { label: "WebUI のポート", group: "other", description: "WebUI のポート", defaultValue: "3456" },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;

/** WebUI の設定画面の分類（左の一覧）。ここに無い項目・カスタム変数は「その他」 */
export const SETTING_SECTIONS: { id: string; title: string; keys: SettingKey[] }[] = [
  { id: "server", title: "サーバ接続", keys: ["HOST_URL", "CHASER_USER", "CHASER_PASS", "CHASER_ROOM", "CHASER_HTTP_TIMEOUT_SEC", "CHASER_RETRY_MS"] },
  { id: "match", title: "試合の進行", keys: ["CHASER_MAX_TURNS", "CHASER_MAX_MATCHES", "CHASER_PLAYER_WAIT_MIN", "CHASER_LOGIN_WAIT_MIN", "CHASER_LOGIN_RETRY_SEC"] },
  { id: "webmap", title: "Webマップ", keys: ["CHASER_WEB_MAP_URL", "CHASER_WEB_MAP_REFRESH", "CHASER_WEB_MAP_RETRY_TURNS", "CHASER_WEB_MAP_TIMEOUT_SEC", "CHASER_WARP_ALIGN_WAIT_SEC"] },
  { id: "model", title: "LLM のつなぎ方・モデル", keys: ["LLM_AUTH_MODE", "LLM_API_URL", "LLM_API_KEY", "LLM_API_HEADERS", "LLM_OAUTH_TOKEN", "LLM_MODEL_NAME", "LLM_SUB_MODEL_NAME", "LLM_MODEL_EFFORT", "LLM_SUB_MODEL_EFFORT", "LLM_CONTEXT_WINDOW", "LLM_AUTO_COMPACT", "LLM_AUTO_COMPACT_PCT", "LLM_MAX_OUTPUT_TOKENS", "LLM_MODELS_TIMEOUT_SEC"] },
  { id: "learn", title: "方策・学習", keys: ["PLAY_POLICY", "TRAIN_AFTER_MATCH_MIN", "TRAIN_IDLE", "TRAIN_IDLE_CHUNK_MIN", "SIM_MAX_TURNS", "SIM_WORKERS"] },
  { id: "coach", title: "学習の LLM", keys: ["LAB_COACH", "LAB_COACH_MODEL", "LAB_COACH_EFFORT", "LAB_COACH_TIMEOUT_MIN"] },
  { id: "main", title: "LLM（試合中）", keys: ["AGENT_USE_MAIN", "AGENT_ASYNC", "AGENT_POLICY", "AGENT_TURN_BUDGET_SEC", "AGENT_HEDGE_SEC", "AGENT_MEMO_MAX_CHARS", "AGENT_RECENT_PHASES", "AGENT_KNOWN_CELLS_RADIUS", "AGENT_MATCH_TOKEN_LIMIT"] },
  { id: "prep", title: "準備フェーズ", keys: ["AGENT_PREP", "AGENT_PREP_TIMEOUT_SEC", "AGENT_PREP_RETRY_MIN", "AGENT_PREP_PAST_RUNS"] },
  { id: "sub", title: "サブエージェント", keys: ["AGENT_SUB_TODO_ITEMS", "AGENT_SUB_CONCURRENCY", "AGENT_SUB_TASK_TIMEOUT_MIN"] },
  { id: "post", title: "試合後（進化・レビュー）", keys: ["AGENT_EVOLVE", "AGENT_EVOLVE_MIN_TURNS", "AGENT_POST_MATCH_TIMEOUT_MIN", "AGENT_REVIEW", "AGENT_REVIEW_TIMEOUT_SEC", "AGENT_REVIEW_KEEP"] },
  { id: "other", title: "その他", keys: ["PORT"] },
];

export function settingSection(key: string): string {
  return SETTING_SECTIONS.find((s) => (s.keys as string[]).includes(key))?.id ?? "other";
}

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
