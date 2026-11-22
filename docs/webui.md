# Web ダッシュボード

起動: `bun run start` → `http://localhost:3456`（`--port` または `PORT` で変更）。実装は `src/ui/server.ts`（HTTP と SSE）、`src/ui/event-bus.ts`（状態と配信）、`src/ui/public/index.html`（単一ファイルの画面）。

## 画面の構成

- **ヘッダ**: 状態（待機・接続中・対戦中・思考中・進化中・停止など）と現在のルーム。
- **準備 → 開始（1つのボタン）**: 最初は「準備」。押すとくるくる（準備中…）になり、メインがルール・ルームの過去の試合・作戦方針を読んで最初のメモを作る（ルームには入らない。公式のバージョンも確認）。終わると同じボタンが「開始」に変わり、隣にスタンバイOK（所要時間・トークン、公式バージョンの変更があれば赤）が出る。ルーム・モデル・effort を変えると「準備」に戻る。`AGENT_PREP=false` なら最初から「開始」。
- **スクロール**: 中央はターン履歴の表だけ、右列は列全体の1本だけがスクロールする（欄ごとのスクロールは作らない）。スクロールバーは細く、ホバー時だけ表示。
- **試合**: ルーム選択、メイン／サブのモデル（候補はゲートウェイの一覧から）、effort、ターン予算、最大ターン数、「試合後に自動で次へ」。開始・停止、「試合後に一時停止」。
- **スコア推移**: ターンごとの推定スコア。ターン単位と試合単位（比較）を切り替える。main の判断率と応答時間も見える。
- **いまの判断**: 現在フェーズのソルバー手、メインの決定、候補手の即時得点、高得点目標と最寄りの未探索点。
- **マップ**: Canvas に盤面、自機・敵（`players`。公式のプレイヤー GIF、自機は青枠・敵は赤枠、古い目撃は半透明、ID 不明の敵は仮アイコン）、軌跡、予測ルート、次の着地点、作戦目標（`planCell`）を描画。ヘッダに「更新: T<n>・Webマップ/自前マップ」。Web マップのあるルームは毎ターン取り直し（`CHASER_WEB_MAP_REFRESH`）、無いルームは観測ごとに自前マップを送る。公式タイル画像は `/assets/tiles/*.gif` を使う。
- **いまの判断 / サブの仕事**: メインの返答種別（作戦どおり／作戦変更／直接指定／solver 代行と理由）、作戦目標、応答時間。サブへの依頼とその状態・結果。
- **メインのメモ**: 試合開始時は準備フェーズで作ったメモ。メインが次のフェーズへ引き継ぐメモ（`var/current/MEMO.md` と同じ）。メインは毎フェーズ前の会話なしで呼ばれるので、何を覚えているかはここで分かる。
- **トークン**: この試合でメイン・サブが使った合計と上限、メイン1回あたりの入力量。詳細はマウスオーバー。
- **マップの黄色の線**: 作戦目標（なければソルバーの当面の目標）までの実際の経路。
- **思考ログ**: Claude の思考、本文、ツール呼び出し、ツール結果。コンテキスト（対戦中・進化・システム）で絞り込み、折りたたみ可能。
- **ターン履歴 / 診断と進化レポート**: 選んだ試合のターン表と、`diagnosis.md` / `evolution-report.md`。
- **設定ダイアログ**: 左に分類（操作・作戦方針・`.env` の分類）、右にその中身。`.env` の分類は `src/settings.ts` の `SETTING_SECTIONS`（サーバ接続・試合の進行・Webマップ・モデル・メイン・準備・サブ・試合後・その他）。分類をまたいで編集でき、未保存の変更は分類に点で示し、まとめて「.env を保存」（再起動なしで反映）。閉じる時に未保存なら確認する。操作は「選択ルームのマップを取得」（`/api/action/preview-map`）・「ソルバーを検証」（`/api/action/verify-solver`）・「モデル一覧を再取得」（`/api/models`）。最後に開いた分類を覚える。

## REST API

| メソッド・パス | 内容 |
| :--- | :--- |
| `GET /` | 画面（`index.html`） |
| `GET /assets/*` | `assets/` 配下の静的ファイル（パストラバーサルは 403） |
| `GET /api/state` | 現在の `UiDashboardState`（ルーム別成績を含む） |
| `GET /api/models` | ゲートウェイのモデル一覧と effort 候補 |
| `GET /api/runs` | ルーム別成績と直近 25 試合の要約 |
| `GET /api/runs/:id/turns` | その試合の `turns.jsonl` |
| `GET /api/runs/:id/diagnosis` | `diagnosis.md` と `evolution-report.md` |
| `POST /api/control` | 操作（下表） |
| `GET /api/claude-auth` / `POST /api/claude-auth` | サブスクリプションのログイン状態（`loggedIn`・`tokenSet`・`login.state`）と、WebUI からのログイン（`action`: `start` で URL を出す / `code` で貼ったコードを送る / `cancel` / `logout`） |
| `GET /api/env` / `POST /api/env` | `.env` の取得と保存。保存時は CHASER_ROOM と LLM_MODEL_NAME を実行中の設定にも反映 |
| `POST /api/action/preview-map` | 指定ルームの Web マップを取得し、盤面に表示 |
| `POST /api/action/verify-solver` | ソルバーのスモークテスト（リプレイ検証の結果を返す） |
| `GET /api/events` | SSE。接続直後に `state` を送り、以降は差分を流す |

### `POST /api/control` の action

| action | 挙動 |
| :--- | :--- |
| `start` | 設定を反映して試合ループを起こす |
| `stop` | 次のターン境界で止める。試合後の進化は行わない |
| `pause` | 現在の試合と進化が終わったら止める |
| `resume` | 一時停止・停止の要求を解除する |
| `update_settings` | room, model, subModel, effort, turnBudgetSec, maxTurns, autoContinue を更新する |

`start` と `update_settings` の値は次の試合から効く。進行中の試合のモデルは変わらない。

## SSE イベント

| イベント名 | データ |
| :--- | :--- |
| `state` | `UiDashboardState` 全体（接続時と状態変化時） |
| `map` | `UiMapState`（盤面、`players` 自機・敵、`planCell`、`updatedTurn`、軌跡、予測ルート） |
| `prediction` | `UiPredictionState`（フェーズ、手、理由、候補、高得点目標、ブレークポイント理由） |
| `scores` | 推定・公式・最高得点などの数値 |
| `turn` | 完了した `TurnRecord` 1 件 |
| `claude` | Claude の思考・ツールログ 1 件（`UiClaudeEvent`）。ソルバー失敗、リプレイ結果、.env 更新なども同じ経路 |

接続は 15 秒ごとに keepalive を送る。

## 注意

- `Bun.serve` は hostname を指定していない。現状は全インターフェースで待ち受ける（`agent/SELF_CHECK.md` の「127.0.0.1 のみ」とは一致しない）。外部に公開しないこと。
- `GET /api/env` は値を平文で返す（画面では `secret` の項目を伏せて表示する）。認証はない。
- `POST /api/env` は `.env` を書き換える。ローカル以外から叩けない状態で使うこと。
