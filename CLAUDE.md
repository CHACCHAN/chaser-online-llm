# CLAUDE.md — CHaserOnline003 自律プレイハーネス（開発者向け）

このファイルは**このプロジェクトを開発する時**（Claude Code で対話開発する時）の説明書。
ハーネスが起動するエージェントのセッションには渡さない（`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`）。エージェント向けの説明は **`agent/AGENTS.md`** に書き、ハーネスが全セッションのシステムプロンプトに入れる。

## プロジェクト
CHaserOnline003 を、プロジェクト内の Claude Code CLI (`./node_modules/.bin/claude`) を**ハーネスとして**使ってプレイし、最高得点を更新し続ける実験プロジェクト。モデルは `LLM_API_URL` のゲートウェイから選ぶ（`GET /api/models`）。

- **準備**: WebUI の「準備」ボタン（押すと準備中→終わると「開始」に変わる）。ルームに入らずにメインが読むだけのツールでルール・過去の試合・作戦方針を調べ、最初のメモを作る。公式のバージョンも確認する（`agent/prompts/prep.md`、`AGENT_PREP`）。連続モードの次の試合は入室前に自動で準備し直す。
- **試合中（メイン）**: 毎フェーズ使い捨ての `claude -p`（前の会話なし・ツールなし）。引き継ぎはメモ・直近の経過・全体マップ。`continue` / `plan` / `command` を返す（`agent/prompts/main.md`）。直接指定が罠・通行不可ならハーネスが却下。
- **試合中（サブ）**: メインの `delegate` を依頼ごとに新しいセッションで処理（`agent/prompts/sub.md`）。
- **試合後**: メイン（ツールあり）が振り返り、`src/solver/active-solver.ts` を改修（リプレイ検証に失敗したら自動ロールバック）。その後、ハーネスの使い勝手をレビューし、`agent/REVIEW.md` に追記される。
- **起動**: `bun run start`（Web ダッシュボード）／ `bun run play --room N`（WebUI なしで1試合）。
- 詳細仕様: [docs/README.md](docs/README.md)

## 開発のルール
- **エージェントの声を参考にする**: 開発を始める前に `agent/REVIEW.md`（試合後にエージェントが書いた使い勝手の指摘・要望）を読み、対応したものは開発者が「対応済み」に印を付ける。
- **設定**: 全て `.env` から読む。項目・既定値・説明は `src/settings.ts` に一本化（コードに直書きしない）。追加したら `bun scripts/gen-env-example.ts`。
- **パス**: `src/paths.ts` に集約。
- **情報は1か所に**: ゲームのルール・コマンドは `knowledge/`（`commands.md`・`official-rules.md`・`tiles.json`）が唯一の置き場。`agent/AGENTS.md` は「どこを見るか」の案内で、同じ内容を書かない。ツールなしの試合中のメインには、ハーネスが必要なファイルの中身を入れて渡す（`main-agent.ts` の `begin`）。
- **エージェントの範囲**: エージェントが読み書きするのは `agent/`（手順書・ツール）・`knowledge/`・`var/`・ソルバーだけ。試合後の振り返り・試合中のサブがそれ以外を変えると `src/evolution/edit-guard.ts` が元に戻す。エージェントに伝えたいことは `agent/AGENTS.md` か `agent/prompts/` に書く（CLAUDE.md に書いても届かない）。
- **チェック**: `bun run typecheck && bun test && bun run verify-solver`。テストは一時ディレクトリで動く（`src/test-setup.ts`）。
- **セットアップ・自己レビュー**: `agent/SETUP.md` → `agent/SELF_CHECK.md`（実施後は両方を更新する）。
- **本番サーバ**: 実際の試合はユーザーが行う。ログインだけの確認はしない。`.env` の値は表示しない。

## ディレクトリ
| パス | 内容 |
|---|---|
| `src/` | ハーネスのコード |
| `src/solver/active-solver.ts` | 進化対象のソルバー（エージェントが試合後に改修） |
| `src/agent/` | Claude Code セッション・メインエージェント・サブ・準備・モデル一覧 |
| `agent/` | エージェント向け: `AGENTS.md`（説明書）・`prompts/`・`policies/`（ユーザーの作戦方針）・`tools/`（エージェントが作るツール）・`REVIEW.md`（エージェントからのレビュー）・`SETUP.md`/`SELF_CHECK.md` |
| `knowledge/` | 永続知識（tiles.json, strategy.md, research/, server.json） |
| `assets/` | 公式タイル GIF |
| `var/` | 実行時データ（runs/, room-profiles.json, best-solvers/, claude-home/, current/）。git 管理外 |
| `docs/` | 仕様書 |
