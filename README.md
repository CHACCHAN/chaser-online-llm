# chaser-online-llm

CHaserOnline003 を、プロジェクト内に隔離した Claude Code CLI をハーネスとして自律的に攻略し、ルームの最高得点を更新し続けるプログラムです。試合中はメインエージェントが作戦を決めてソルバーが手を打ち、試合後はエージェントがソルバーを改修します。

## 起動

```bash
bun install
cp .env.example .env   # CHASER_USER / CHASER_PASS と LLM のつなぎ方を記入
bun run start          # http://localhost:3456 でダッシュボード
```

Docker なら `cp .env.example .env && docker compose up -d --build`。

## ドキュメント

- [docs/setup.md](docs/setup.md): セットアップ（Bun / Docker）・コマンド・設定・ディレクトリ
- [docs/README.md](docs/README.md): 索引と引き継ぎ（開発する時に最初に読む）
- [docs/architecture.md](docs/architecture.md): 全体構成と試合のライフサイクル
- [docs/claude-evolution.md](docs/claude-evolution.md): LLM のつなぎ方・メイン／サブエージェント・試合後の進化・CLI
- [docs/webui.md](docs/webui.md): ダッシュボードの API と SSE イベント
- [docs/chaser-protocol.md](docs/chaser-protocol.md): CHaserOnline003 の通信・マップ・スコア仕様

WebUI には認証がありません。ローカルでのみ使ってください。
