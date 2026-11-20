# chaser-online-llm

CHaserOnline003 を、プロジェクト内に隔離した Claude Code CLI (`./node_modules/.bin/claude`) で自律的に攻略し、ルームの最高得点を更新し続けるプログラムです。

- 試合中は、Claude Code を **常駐メインエージェント** として走らせ、毎フェーズ「盤面 + ソルバー候補」を渡して手を決めさせる。
- 試合後は同じセッションに振り返りをさせ、`src/solver/active-solver.ts` を改修させる。改修はリプレイ検証で確かめ、失敗したら自動でロールバックする。
- 操作と監視はすべて Web ダッシュボード (`http://localhost:3456`) で行う。

## セットアップ

```bash
bun install
cp .env.example .env   # CHASER_USER / CHASER_PASS / LLM_API_URL / LLM_API_KEY などを記入
bun run start          # Web ダッシュボードを起動
```

ブラウザで `http://localhost:3456` を開き、ルームを選んで「開始」を押します。画面上の「設定」からは `.env` を直接編集して保存できます。

## 主なコマンド

| コマンド | 内容 |
| :--- | :--- |
| `bun run start` | Web ダッシュボード + 試合ループ（本番） |
| `bun test` | 単体テスト（client, world-map） |
| `bun run typecheck` | 型チェック |
| `bun run verify-solver` | ソルバーの読み込みと合法手のスモークテスト |
| `bun src/cli.ts <subcommand>` | エージェント用 CLI（詳細は [docs/claude-evolution.md](docs/claude-evolution.md)） |

起動オプション（`src/config.ts`）: `--room`, `--model`, `--sub-model`, `--effort`, `--turn-budget`（秒）, `--max-turns`, `--max-matches`, `--solver-only`（メインエージェントを使わずソルバーだけで打つ）, `--web-map-url`, `--port`。

## 設定 (.env)

| キー | 役割 |
| :--- | :--- |
| `HOST_URL`, `CHASER_USER`, `CHASER_PASS`, `CHASER_ROOM` | CHaserOnline003 の接続先・ログイン・ルーム |
| `LLM_API_URL`, `LLM_API_KEY` | Claude Code が使うゲートウェイと鍵 |
| `LLM_MODEL_NAME` / `LLM_SUB_MODEL_NAME` | メインのモデル / サブエージェントのモデル（空ならメインと同じ） |
| `LLM_MODEL_EFFORT` | `low` / `medium` / `high` / `xhigh` / `max` |
| `AGENT_TURN_BUDGET_SEC` | 1フェーズあたりの思考予算（既定 20 秒）。超えるとソルバー手を送る |

## ディレクトリ（要点）

| パス | 中身 | git |
| :--- | :--- | :--- |
| `src/` | 実装（コードのみ） | 管理 |
| `knowledge/` | タイル得点 `tiles.json`、戦略 `strategy.md`、公式調査の記録 `research/` | 管理 |
| `agent/` | メイン／サブエージェントのプロンプトと手順書（`prompts/`, `SETUP.md`, `SELF_CHECK.md`, `tools/`） | 管理 |
| `assets/` | 公式タイル GIF と `manifest.json` | 管理 |
| `docs/` | 仕様ドキュメント | 管理 |
| `var/` | 実行時データ: `runs/`（試合ログ）, `room-profiles.json`, `best-solvers/`, `claude-home/`（隔離 HOME）, `current/snapshot.json` | 除外 |

全パスは `src/paths.ts` に集約しています。

## ドキュメント

- [docs/README.md](docs/README.md): 索引と引き継ぎ（最初に読む）
- [docs/architecture.md](docs/architecture.md): 全体構成と試合のライフサイクル
- [docs/claude-evolution.md](docs/claude-evolution.md): 常駐メインエージェント、試合後の進化、リプレイ検証、CLI
- [docs/webui.md](docs/webui.md): ダッシュボードの API と SSE イベント
- [docs/chaser-protocol.md](docs/chaser-protocol.md): CHaserOnline003 の通信・マップ・スコア仕様

## 注意

- `var/` と `.env` は git 管理外です。鍵や認証情報をログや外部へ出さないでください。
- WebUI は認証がなく、`/api/env` は `.env` の値を平文で返し、`POST` で書き換えられます。ローカルでのみ使ってください。
