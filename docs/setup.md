# セットアップ・起動・設定

## ローカル（Bun）

```bash
bun install
cp .env.example .env   # CHASER_USER / CHASER_PASS と LLM のつなぎ方（下記）を記入
bun run start          # Web ダッシュボードを起動
```

ブラウザで `http://localhost:3456`（`.env` の `PORT`）を開き、ルームを選んで「準備」→「開始」を押す。画面上の「設定」から `.env` を直接編集して保存できる（再起動なしで次の読み取りから反映）。設定は `.env` だけで、`.env.local` などが残っていても `.env` の値を使う（起動時にその旨を出す）。

## Docker（devcontainer を使わない場合）

```bash
cp .env.example .env                 # 先に .env を用意する（PORT もここから読む）
docker compose up -d --build         # サービスとして起動（再起動しても自動で上がる）
docker compose logs -f               # ログ
docker compose down                  # 止める
```

- イメージは `.devcontainer/Dockerfile`（Bun・git・ripgrep など実行に要るものだけ）、起動の定義は `compose.yaml`。プロジェクトは `/app` にマウントするので、エージェントが書き換えたソルバー・`knowledge/`・`var/`（試合の記録）はそのまま手元に残る。依存は名前付きボリューム `node_modules` に入り、起動のたびに `bun install --frozen-lockfile` する（`.devcontainer/chaser-entrypoint.sh`）。
- コンテナは root ではなく UID 1000 で動く（Claude Code は root では動かさない）。手元の UID が違う時は `UID=$(id -u) GID=$(id -g) docker compose up -d --build`。
- WebUI には認証が無く `.env`（鍵）も編集できるので、既定では `127.0.0.1` だけで開く。他のマシンから開く時は `compose.yaml` の `ports` を変える（その時は自分で守ること）。
- サブスクリプションでつなぐ時のログイン: `docker compose exec chaser bun run claude-login`（または `.env` の `LLM_OAUTH_TOKEN`）。
- ホストのローカル LLM につなぐ時、コンテナからは `localhost` ではなく `http://host.docker.internal:<port>` を `LLM_API_URL` にする（Linux では `compose.yaml` に `extra_hosts: ["host.docker.internal:host-gateway"]` を足す）。
- devcontainer の中から `docker compose up` すると、マウントの元がホストのパスとして解釈されて動かないことがある（docker-outside-of-docker のため）。devcontainer では `bun run start` を使う。

## コマンド

| コマンド | 内容 |
| :--- | :--- |
| `bun run start` | Web ダッシュボード + 試合ループ（本番） |
| `bun run play --room 3 [--solver-only] [--evolve] [--login-wait-min 10]` | WebUI なしで1試合。`--evolve` で試合後の改修まで行う。二重ログイン時は指定分まで再試行 |
| `bun run claude-login [status\|logout]` | ハーネスの Claude Code（`var/claude-home`）をサブスクリプションにログインさせる |
| `bun test` / `bun run typecheck` | 単体テスト / 型チェック |
| `bun run verify-solver` | ソルバーの読み込みと合法手のスモークテスト |
| `bun src/cli.ts <subcommand>` | エージェント用 CLI（[claude-evolution.md](claude-evolution.md)） |

起動オプション（`src/config.ts`。`.env` より優先）: `--room`, `--model`, `--sub-model`, `--effort`, `--sub-effort`, `--turn-budget`（秒）, `--max-turns`, `--max-matches`, `--solver-only`（メインを使わずソルバーだけで打つ）, `--web-map-url`, `--port`, `--retry-ms`。

## 設定（.env）

全項目の説明と既定値は `.env.example`（`src/settings.ts` から `bun scripts/gen-env-example.ts` で生成）と WebUI の「設定」にある。値は CLI 引数 > `.env` > 既定値 の順で効く。主なもの:

| キー | 役割 |
| :--- | :--- |
| `HOST_URL`, `CHASER_USER`, `CHASER_PASS`, `CHASER_ROOM` | CHaserOnline003 の接続先・ログイン・ルーム（ルーム既定値 3） |
| `LLM_AUTH_MODE` | `api`（Anthropic 互換 API）/ `subscription`（Claude のサブスクリプション） |
| `LLM_API_URL`, `LLM_API_KEY`, `LLM_API_HEADERS` | api: 接続先（空なら Anthropic API に直接）・鍵（鍵の無いローカル LLM なら空）・送るヘッダ（`"名前: 値; 名前: 値"`、`{KEY}` が鍵に置き換わる。既定 `x-api-key: {KEY}`） |
| `LLM_OAUTH_TOKEN` | subscription: `claude setup-token` のトークン（空なら `bun run claude-login` でログインした情報） |
| `LLM_MODEL_NAME` / `LLM_SUB_MODEL_NAME` | メインのモデル / サブのモデル（サブが空ならメインと同じ） |
| `LLM_MODEL_EFFORT` / `LLM_SUB_MODEL_EFFORT` | `low` / `medium` / `high` / `xhigh` / `max`。既定は `medium`。サブが空ならメインと同じ |
| `LLM_CONTEXT_WINDOW`, `LLM_AUTO_COMPACT`, `LLM_AUTO_COMPACT_PCT`, `LLM_MAX_OUTPUT_TOKENS` | コンテキストの大きさ・自動コンパクト・出力の上限（ローカル LLM など小さいモデル向け） |
| `AGENT_TURN_BUDGET_SEC` | 1フェーズあたりの思考予算（既定 20 秒）。超えるとソルバー手を送る |

LLM のつなぎ方（送るヘッダの例・サブスクリプション・コンテキスト）の詳細は [claude-evolution.md](claude-evolution.md) の冒頭。

## ディレクトリ（要点）

| パス | 中身 | git |
| :--- | :--- | :--- |
| `src/` | 実装（コードのみ） | 管理 |
| `knowledge/` | タイル得点 `tiles.json`、戦略 `strategy.md`、公式調査の記録 `research/`、サーバ仕様の実測 `server.json` | 管理 |
| `agent/` | メイン／サブのプロンプト（`prompts/`）、手順書（`SETUP.md`, `SELF_CHECK.md`）、エージェントが作るツール（`tools/`） | 管理 |
| `assets/` | 公式タイル GIF と `manifest.json` | 管理 |
| `docs/` | 仕様ドキュメント | 管理 |
| `var/` | 実行時データ: `runs/`（試合ログ）, `room-profiles.json`, `best-solvers/`, `claude-home/`（隔離 HOME）, `current/snapshot.json`（毎ターンの盤面）, `tmp/`（作業用） | 除外 |

全パスは `src/paths.ts` に集約している。

## 注意

- `var/` と `.env` は git 管理外。鍵や認証情報をログや外部へ出さない。
- WebUI は認証がなく、`/api/env` は `.env` の値を平文で返し、`POST` で書き換えられる。ローカルでのみ使う。
