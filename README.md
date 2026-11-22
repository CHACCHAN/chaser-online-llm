# chaser-online-llm

CHaserOnline003 を、プロジェクト内に隔離した Claude Code CLI (`./node_modules/.bin/claude`) をハーネスとして自律的に攻略し、ルームの最高得点を更新し続けるプログラムです。

- **試合中**: 常駐のメインエージェント（作戦係＋例外係）が毎フェーズ盤面を見て、`continue`（作戦のまま）/ `plan`（目標マスを変える）/ `command`（手を直接指定）のいずれかを返す。1手先の計算はソルバー (`src/solver/active-solver.ts`) が行う。
- **裏の仕事**: 時間のかかる調査・ログ分析・ツール作成は、メインが `delegate` でサブエージェント（SubWorker、別の常駐セッション）に依頼する。結果は後のターンのメッセージで届き、メインは待たない。
- **試合後**: 同じメインに振り返りと `active-solver.ts` の改修をさせる。リプレイ検証に失敗したら自動でロールバックする。
- **操作と監視**: Web ダッシュボード (`http://localhost:3456`)。WebUI なしで1試合だけ回すなら `bun run play`。

## セットアップ

```bash
bun install
cp .env.example .env   # CHASER_USER / CHASER_PASS / LLM_API_URL / LLM_API_KEY などを記入
bun run start          # Web ダッシュボードを起動
```

ブラウザで `http://localhost:3456` を開き、ルームを選んで「開始」を押します。画面上の「設定」からは `.env` を直接編集して保存できます。

### Docker（devcontainer を使わない場合）

```bash
cp .env.example .env                 # 先に .env を用意する（PORT もここから読む）
docker compose up -d --build         # サービスとして起動（再起動しても自動で上がる）
docker compose logs -f               # ログ
docker compose down                  # 止める
```

- イメージは `.devcontainer/Dockerfile`（Bun・git・ripgrep など実行に要るものだけ）。プロジェクトは `/app` にマウントするので、エージェントが書き換えたソルバー・`knowledge/`・`var/`（試合の記録）はそのまま手元に残る。依存は名前付きボリューム `node_modules` に入り、起動のたびに `bun install --frozen-lockfile` する。
- コンテナは root ではなく UID 1000 で動く（Claude Code は root では動かさない）。手元の UID が違う時は `UID=$(id -u) GID=$(id -g) docker compose up -d --build`。
- WebUI には認証が無く `.env`（鍵）も編集できるので、既定では `127.0.0.1` だけで開く。他のマシンから開く時は `compose.yaml` の `ports` を変える（その時は自分で守ること）。
- サブスクリプションでつなぐ時のログイン: `docker compose exec chaser bun run claude-login`（または `.env` の `LLM_OAUTH_TOKEN`）。
- ホストのローカル LLM につなぐ時、コンテナからは `localhost` ではなく `http://host.docker.internal:<port>` を `LLM_API_URL` にする（Linux では `compose.yaml` に `extra_hosts: ["host.docker.internal:host-gateway"]` を足す）。
- devcontainer の中から `docker compose up` すると、マウントの元がホストのパスとして解釈されて動かないことがある（docker-outside-of-docker のため）。devcontainer では `bun run start` を使う。

## 主なコマンド

| コマンド | 内容 |
| :--- | :--- |
| `bun run start` | Web ダッシュボード + 試合ループ（本番） |
| `bun run play --room 3 [--solver-only] [--evolve] [--login-wait-min 10]` | WebUI なしで1試合。`--evolve` で試合後の改修まで行う。二重ログイン時は指定分まで再試行 |
| `bun test` | 単体テスト（client, world-map） |
| `bun run typecheck` | 型チェック |
| `bun run verify-solver` | ソルバーの読み込みと合法手のスモークテスト |
| `bun src/cli.ts <subcommand>` | エージェント用 CLI（詳細は [docs/claude-evolution.md](docs/claude-evolution.md)） |

起動オプション（`src/config.ts`）: `--room`, `--model`, `--sub-model`, `--effort`, `--sub-effort`, `--turn-budget`（秒）, `--max-turns`, `--max-matches`, `--solver-only`（メインを使わずソルバーだけで打つ）, `--web-map-url`, `--port`, `--retry-ms`。

## 設定 (.env)

| キー | 役割 |
| :--- | :--- |
| `HOST_URL`, `CHASER_USER`, `CHASER_PASS`, `CHASER_ROOM` | CHaserOnline003 の接続先・ログイン・ルーム（ルーム既定値 3） |
| `LLM_AUTH_MODE` | `api`（Anthropic 互換 API）/ `subscription`（Claude のサブスクリプション）。詳細は [docs/claude-evolution.md](docs/claude-evolution.md) |
| `LLM_API_URL`, `LLM_API_KEY`, `LLM_API_HEADERS` | api: 接続先（空なら Anthropic API に直接）・鍵・送るヘッダ（`"名前: 値; 名前: 値"`、`{KEY}` が鍵に置き換わる。既定 `x-api-key: {KEY}`） |
| `LLM_OAUTH_TOKEN` | subscription: `claude setup-token` のトークン（空なら `bun run claude-login` でログインした情報） |
| `LLM_MODEL_NAME` / `LLM_SUB_MODEL_NAME` | メインのモデル / サブのモデル（サブが空ならメインと同じ） |
| `LLM_MODEL_EFFORT` / `LLM_SUB_MODEL_EFFORT` | `low` / `medium` / `high` / `xhigh` / `max`。既定は `medium`。サブが空ならメインと同じ |
| `AGENT_TURN_BUDGET_SEC` | 1フェーズあたりの思考予算（既定 20 秒）。超えるとソルバー手を送る |

## ディレクトリ（要点）

| パス | 中身 | git |
| :--- | :--- | :--- |
| `src/` | 実装（コードのみ） | 管理 |
| `knowledge/` | タイル得点 `tiles.json`、戦略 `strategy.md`、公式調査の記録 `research/`、サーバ仕様の実測 `server.json` | 管理 |
| `agent/` | メイン／サブのプロンプト（`prompts/`）、手順書（`SETUP.md`, `SELF_CHECK.md`）、エージェントが作るツール（`tools/`） | 管理 |
| `assets/` | 公式タイル GIF と `manifest.json` | 管理 |
| `docs/` | 仕様ドキュメント | 管理 |
| `var/` | 実行時データ: `runs/`（試合ログ）, `room-profiles.json`, `best-solvers/`, `claude-home/`（隔離 HOME）, `current/snapshot.json`（毎ターンの盤面） | 除外 |

全パスは `src/paths.ts` に集約しています。

## ドキュメント

- [docs/README.md](docs/README.md): 索引と引き継ぎ（最初に読む）
- [docs/architecture.md](docs/architecture.md): 全体構成（メイン／サブ／ソルバーの関係）と試合のライフサイクル
- [docs/claude-evolution.md](docs/claude-evolution.md): 常駐メインエージェント、サブ、試合後の進化、リプレイ検証、CLI
- [docs/webui.md](docs/webui.md): ダッシュボードの API と SSE イベント
- [docs/chaser-protocol.md](docs/chaser-protocol.md): CHaserOnline003 の通信・マップ・スコア仕様

## 注意

- `var/` と `.env` は git 管理外です。鍵や認証情報をログや外部へ出さないでください。
- WebUI は認証がなく、`/api/env` は `.env` の値を平文で返し、`POST` で書き換えられます。ローカルでのみ使ってください。
