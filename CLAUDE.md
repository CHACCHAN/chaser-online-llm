# CLAUDE.md — CHaserOnline003 自律プレイハーネス（開発者向け）

このファイルは**このプロジェクトを開発する時**（Claude Code で対話開発する時）の説明書。
ハーネスが起動するエージェントのセッションには渡さない（`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`）。エージェント向けの説明は **`agent/AGENTS.md`** に書き、ハーネスが全セッションのシステムプロンプトに入れる。

## プロジェクト
CHaserOnline003 を、プロジェクト内の Claude Code CLI (`./node_modules/.bin/claude`) を**ハーネスとして**使ってプレイし、最高得点を更新し続ける実験プロジェクト。モデルは `LLM_API_URL` のゲートウェイから選ぶ（`GET /api/models`）。

- **準備**: WebUI の「準備」ボタン（押すと準備中→終わると「開始」に変わる）。ルームに入らずに LLM が読むだけのツールでルール・過去の試合・作戦方針を調べ、最初のメモと試合の設定（最初のモデル・試合中の LLM を呼ぶきっかけとしきい値・きっかけごとの目安。`src/agent/match-plan.ts`）を作る。公式のバージョンも確認する（`agent/prompts/prep.md`、`AGENT_PREP`）。連続モードの次の試合は入室前に自動で準備し直す。
- **試合中の手**: 経路探索の方策（`src/solver/planner.ts`＋評価関数 `evaluator.ts`＋学習したパラメータ `var/policy/params.json`、数ミリ秒）が毎フェーズすぐ出す。詳細は [docs/learning.md](docs/learning.md)。
- **試合中の LLM（作戦係）**: 使い捨ての `claude -p`（前の会話なし・ツールなし）。きっかけ（`src/agent/triggers.ts`: モデルの不一致・敵が近い・当てられた など）が鳴った時だけ呼ばれ（`AGENT_CALL_MODE`）、手を待たせず裏で盤面を読み、届いた `plan`（目標）と `model`（特性ごとのモデル）を反映する（`agent/prompts/main.md`）。毎フェーズの判断（モデルの切り替え・目標・LLM を呼ぶか）は、LLM が書く**作戦スクリプト** `src/solver/tactics.ts` をハーネスが動かして決める（`src/solver/tactics-runtime.ts`。LLM を待たない。シミュレータでも動き、改修は改修前と比べて弱ければ戻す）。作戦方針はスクリプトに書き表す。試合後にきっかけごとの効き目を評価し（`src/agent/trigger-review.ts`、`trigger-review.json`）、次の準備に渡す。引き継ぎはメモ・直近の経過・全体マップ。
- **試合後**: 試合中の LLM（ツールあり）が振り返り、`src/solver/evaluator.ts` を改修（試合の記録の盤面での確かめ `verify` と、シミュレータでの改修前との比較のどちらかに落ちたら戻す）。続けてシミュレータ（`src/sim/`、地図は毎回ランダム＋本物の地図）で方策を学習する（`TRAIN_AFTER_MATCH_MIN`）。その後、ハーネスの使い勝手をレビューし、`agent/REVIEW.md` に追記される。これらは裏で順に行い、その間に次の試合を始める（`POST_MATCH_BACKGROUND`、`src/evolution/post-match-queue.ts`。書き換え中に始まった試合は書き換える前の評価関数の写しを使う）。
- **学習の LLM**: 試合中の LLM とは別のセッション。学習が終わるたびに統計（理論値の目安との差 `src/sim/oracle.ts` を含む）を読み、評価関数・地図の作り方（`knowledge/sim-profiles.json`）・学習のやり方（`knowledge/train-config.json`）・モデル（`knowledge/styles.json`）を直す。直したものは確かめて、弱ければ／本物の地図から遠ざかれば／範囲外なら戻す。ハーネスでしか直らないことは `agent/REVIEW.md` に要望として載る（`src/sim/lab-coach.ts`、`agent/prompts/lab-coach.md`、`LAB_COACH`）。
- **起動**: `bun run start`（Web ダッシュボード。ヘッダで「試合」「学習」「統計」を切り替える。「学習」は地図を作って並べ（全部同時に再生）→ その地図で学習 → 地図ごとの学習前→後。ずっと（試合中も）学習を続けられる `TRAIN_IDLE`・`TRAIN_DURING_MATCH`。「統計」はルーム・試合の成績、試合の記録、学習の推移、モデルの特性、試合中の LLM の費用と効き目）／ `bun run play --room N`（WebUI なしで1試合）。
- 詳細仕様: [docs/README.md](docs/README.md)

## 開発のルール
- **エージェントの声を参考にする**: 開発を始める前に `agent/REVIEW.md`（試合後にエージェントが書いた使い勝手の指摘・要望）を読み、対応したものは開発者が「対応済み」に印を付ける。
- **設定**: 全て `.env` から読む（`.env.local` などが残っていても `.env` の値を使う。`src/env-files.ts`）。項目・画面の名前（`label`）・既定値・説明は `src/settings.ts` に一本化（コードに直書きしない）。追加したら `bun scripts/gen-env-example.ts`。
- **パス**: `src/paths.ts` に集約。
- **情報は1か所に**: ゲームのルール・コマンドは `knowledge/`（`commands.md`・`official-rules.md`・`tiles.json`）が唯一の置き場。`agent/AGENTS.md` は「どこを見るか」の案内で、同じ内容を書かない。ツールなしの試合中のメインには、ハーネスが必要なファイルの中身を入れて渡す（`main-agent.ts` の `begin`）。
- **エージェントの範囲**: エージェントが読み書きするのは `agent/`（手順書・ツール）・`knowledge/`・`var/`・ソルバーだけ。試合後の振り返り・試合中のサブがそれ以外を変えると `src/evolution/edit-guard.ts` が元に戻す。エージェントに伝えたいことは `agent/AGENTS.md` か `agent/prompts/` に書く（CLAUDE.md に書いても届かない）。
- **試合中に開発する時**: 保護対象（`src/`・`agent/prompts/` など）の変更は**コミットしておく**。試合の終わり・振り返りの後に、ガードが試合開始時の内容へ戻す。スナップショットの後のコミットは戻さない。コミットしていない変更は戻され、`var/edit-guard-backup/<日時>/` に控えが残る。
- **チェック**: `bun run typecheck && bun test && bun run verify-policy`。テストは一時ディレクトリで動く（`src/test-setup.ts`）。ハーネス全体は偽サーバ（`src/sim/fake-server.ts`、`scripts/sim-server.ts`）で手元で通せる（本番サーバに触れない）。
- **セットアップ・自己レビュー**: `agent/SETUP.md` → `agent/SELF_CHECK.md`（実施後は両方を更新する）。
- **本番サーバ**: 実際の試合はユーザーが行う。ログインだけの確認はしない。`.env` の値は表示しない。

## ディレクトリ
| パス | 内容 |
|---|---|
| `src/` | ハーネスのコード |
| `src/solver/planner.ts`・`evaluator.ts` | 試合中の手を出す経路探索の方策（ハーネス）と、その評価関数（試合後の振り返り・学習の LLM が改修） |
| `src/solver/tactics.ts`・`tactics-runtime.ts` | 作戦スクリプト（LLM が改修）と、それを毎フェーズ動かすハーネス |
| `src/sim/` | シミュレータ・学習・偽サーバ |
| `src/agent/` | Claude Code セッション・試合中の LLM・準備・モデル一覧 |
| `agent/` | エージェント向け: `AGENTS.md`（説明書）・`prompts/`・`policies/`（ユーザーの作戦方針）・`tools/`（エージェントが作るツール）・`REVIEW.md`（エージェントからのレビュー）・`SETUP.md`/`SELF_CHECK.md` |
| `knowledge/` | 永続知識（tiles.json, strategy.md, research/, server.json） |
| `assets/` | 公式タイル GIF |
| `var/` | 実行時データ（runs/, room-profiles.json, policy/, lab-coach/, maps/, claude-home/, current/）。git 管理外 |
| `docs/` | 仕様書 |
