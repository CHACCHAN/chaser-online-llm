# AGENTS.md — CHaserOnline003 をプレイするエージェント向けの説明書

このファイルは、ハーネス（このプロジェクト）が起動する Claude Code セッション（準備・試合中のメイン／サブ・試合後の振り返り）に毎回渡される。
プロジェクトの開発者向けの説明（`CLAUDE.md`）は渡されない。ハーネスの使い勝手・不具合・欲しい機能は、試合後の振り返りで聞かれたら答える（`agent/REVIEW.md` にまとめられ、開発者が読む）。

## あなたの役割（フェーズごと）
| フェーズ | セッション | ツール | やること（手順書） |
|---|---|---|---|
| 準備（入室前） | メイン | Read / Glob / Grep | ルール・このルームの過去の試合・作戦方針を読み、試合開始時のメモを作る（`agent/prompts/prep.md`） |
| 試合中 | メイン（毎フェーズ使い捨て。前の会話なし） | なし | 盤面とソルバー候補を見て `continue` / `plan` / `command` を返す。引き継ぎはメモだけ（`agent/prompts/main.md`） |
| 試合中 | サブ（依頼ごとに新しいセッション） | あり | メインの `delegate` を裏で処理する（`agent/prompts/sub.md`） |
| 試合後 | メイン（新しいセッション） | あり | 振り返り、ソルバー改修、知識の更新、ハーネスへのレビュー |

- 作戦方針（ユーザー定義、`agent/policies/<名前>.md`）が渡されたら最優先で守る。
- 時間切れ・不正な応答のフェーズは、ソルバー手が自動で送られる。罠・通行不可への直接指定は、ソルバー手で避けられる時はハーネスが却下する。

## 触ってよい範囲
| パス | 内容 | 編集 |
|---|---|---|
| `knowledge/` | 永続知識（`tiles.json` タイル得点、`strategy.md` 戦略、`research/` 調査メモ） | 試合後・サブ |
| `agent/tools/` | エージェントが作るツール（`bun agent/tools/<name>.ts`。試合中に作るものは `@temporary`） | 試合後・サブ |
| `src/solver/active-solver.ts`（とそのテスト） | 進化対象のソルバー | **試合後だけ** |
| `var/` | 実行時データ（過去の試合・ルームの記録・試合中の今。下の「情報の在りか」） | 読むだけ |
| `agent/prompts/`・`agent/policies/`・`agent/AGENTS.md`・`agent/REVIEW.md`・`src/`（ソルバー以外）・`CLAUDE.md`・`.env` | ハーネス本体・手順書・ユーザーの方針 | **禁止**（変えても自動で元に戻される） |

- ログイン情報（`.env`）は読まない・出力しない・外部に送らない。CHaserOnline サーバにはログインしない（試合中のセッションを壊す）。
- 公式サイト（`http://www7019ug.sakura.ne.jp/CHaserOnline003/`）のログイン不要ページと、公式テキスト「ステップアップヒント」（`knowledge/official-rules.md` の出典）は見てよい。公式資料と実測が食い違ったら実測を優先し、`knowledge/official-rules.md` の「食い違い」に記録する。

## 情報の在りか（同じことを2か所に書かない。ルールはここに挙げたファイルを読む）
| 知りたいこと | 見るファイル |
|---|---|
| **ゲームのコマンド**（全61種の動き・観測・動作得点・ハーネスで送れるか） | `knowledge/commands.md` |
| **スコアの計算・守ること・タイル（キャラクタ）の公式の得点**、公式資料と実測の食い違い | `knowledge/official-rules.md` |
| タイル得点の実測データベース | `knowledge/tiles.json`（`bun src/cli.ts reference --tile ID`） |
| 戦略・過去の教訓 | `knowledge/strategy.md`、`knowledge/research/` |
| 通信・Webマップの仕様 | `docs/chaser-protocol.md` |
| 試合中のメインの返答形式（continue / plan / command / delegate / memo） | `agent/prompts/main.md` |
| 準備・サブの手順 | `agent/prompts/prep.md`、`agent/prompts/sub.md` |
| エージェントが作ったツールの一覧と規約 | `agent/tools/README.md` |
| ルームごとの記録 | `var/room-profiles.json`（`bun src/cli.ts status --room N`） |
| 過去の試合 | `var/runs/<runId>/`: `summary.json`（得点・終了理由）、`turns.jsonl`（毎ターンの手・観測・判断理由。大きいので Grep で）、`diagnosis.md`（失点の分析）、`MEMO.md`、`ASK_SUB.md`、`evolution-report.md`、`harness-review.md`、`final-map.txt`（最終盤面）、`solver-snapshot.ts`（その試合のソルバー） |
| 試合中の今 | `var/current/`: `snapshot.json`（盤面。毎ターン更新）、`MEMO.md`（メインのメモ）、`ASK_SUB.md`（サブへの依頼と結果） |

- 試合中のメインはファイルを読めないので、コマンドの表・作戦方針・戦略はハーネスが依頼文に入れて渡す。
- 未知のタイル・通らないコマンド・得点のずれに気付いたら記録する（公式の仕様が変わった可能性がある）。

## ハーネスの使い方
「場面」の略: **サ**=試合中のサブ、**後**=試合後の振り返り（準備は Read/Glob/Grep だけ、試合中のメインはツールなしなので実行できない）。

### プロジェクトの CLI（`bun src/cli.ts <サブコマンド>`、場面: サ・後）
| サブコマンド | 主な引数 | 何をする | 出力 |
|---|---|---|---|
| `status` | `--room N` | ルームの記録（最高得点・試合数・Webマップの有無・盤面の大きさ・発見タイル・ワープ）と、登録済みタイルの数 | JSON |
| `reference` | `--tile ID` / `--query 語` | `--tile`: `knowledge/tiles.json` の登録内容（得点・根拠・メモ）。`--query`: 公式の公開ページ（ログイン不要）の本文からその語を含む行を探す | JSON |
| `upsert-tile` | `--id ID --score 点 --name 英名 --label 表示名 --passable true/false --hazard true/false --symbol 1字 [--notes 根拠]` | `knowledge/tiles.json` にタイルを登録・更新（実測で分かったら） | 更新後の JSON |
| `run-script` | `--snapshot var/current/snapshot.json --code "<JS>"` | 盤面に対して JS を実行（変数 `snapshot`: `position`, `tiles[{x,y,value,visitedCount}]`, `warpLinks`, `stats`, `lastGrid`, `turn` 等。1行なら式、複数行なら `return` を書く） | 実行結果の JSON |
| `scrape-map` | `--room N [--url URL]` | Webマップ（MapView.jsp）を取る。試合中はハーネスが毎ターン自動で取っているので、普段は不要 | JSON |
| `verify` | `--run-dir var/runs/<runId>` | 今のソルバーを過去の試合で再生し、例外・不正な手が無いか確かめる（場面: 後） | JSON（失敗で終了コード1） |

### チェック（`bun run <名前>`、場面: 後）
| コマンド | 何をする |
|---|---|
| `bun run typecheck` | 型チェック（ソルバーを変えたら必ず） |
| `bun test` | テスト一式 |
| `bun run verify-solver` | 過去の試合全部でソルバーをリプレイ検証 |

`bun run start`（WebUI）・`bun run play`（試合）はユーザーが使うもの。エージェントは実行しない（サーバに接続して試合が始まる）。

## 試合後の改修
1. `src/solver/active-solver.ts` — `decideTurnAction(worldMap, phase, turn, plan)` のシグネチャを維持して改善し、`bun src/cli.ts verify --run-dir <runDir>` と `bun run typecheck` を通す（リプレイ検証に失敗すると自動で元に戻る）。
2. 実測で分かったことは「情報の在りか」の該当ファイルに残す（タイル得点は `upsert-tile`）。
3. 試合中に作った臨時ツール（`@temporary`）は、ソルバーへ組み込む／正式ツールにする／削除する、のどれかに決める。
