# AGENTS.md

CHaserOnline003 を自動でプレイするハーネス。フェーズ: 準備（入室前、読むだけ）→ 試合中のメイン（毎フェーズ使い捨て、ツールなし）とサブ（依頼ごと）→ 試合後の振り返り。手順はそれぞれ `agent/prompts/` にある。

## 触ってよい範囲
| パス | 編集 |
|---|---|
| `knowledge/`、`agent/tools/` | 試合後・サブ |
| `src/solver/active-solver.ts`（とテスト） | 試合後だけ |
| `var/` | 読むだけ（CLI の `cell-note` での記録は可） |
| それ以外（`src/`、`agent/prompts/`、`agent/policies/`、`agent/AGENTS.md`、`agent/REVIEW.md`、`CLAUDE.md`、`.env`） | 禁止（自動で元に戻される） |

- `.env` は読まない・出力しない。CHaserOnline サーバにはログインしない。`bun run start`・`bun run play` は実行しない。

## 情報の在りか
| 内容 | ファイル |
|---|---|
| ルール（スコア・タイル） | `knowledge/official-rules.md` |
| コマンド | `knowledge/commands.md` |
| タイル得点の実測 | `knowledge/tiles.json` |
| 戦略・調査メモ（公式資料の出典・実測との食い違いは `research/official-sources.md`） | `knowledge/strategy.md`、`knowledge/research/` |
| 通信・Webマップの仕様 | `docs/chaser-protocol.md` |
| ツール一覧 | `agent/tools/README.md` |
| ルームの記録（ワープの実測 `warps`・マスのメモ `cellNotes` を含む。座標は絶対座標＝Webマップの列・行） | `var/room-profiles.json` |
| 過去の試合 | `var/runs/<runId>/`（`summary.json`、`turns.jsonl`、`diagnosis.md`、`MEMO.md`、`ASK_SUB.md`、`evolution-report.md`、`final-map.txt`） |
| 試合中の今 | `var/current/`（`snapshot.json`、`MEMO.md`、`ASK_SUB.md`） |

## CLI（`bun src/cli.ts <サブコマンド>`）
| サブコマンド | 引数 | 内容 |
|---|---|---|
| `status` | `--room N` | ルームの記録 |
| `reference` | `--tile ID` / `--query 語` | タイルの登録内容 / 公式ページの検索 |
| `upsert-tile` | `--id --score --name --label --passable --hazard --symbol [--notes]` | タイルを登録・更新 |
| `run-script` | `--snapshot var/current/snapshot.json --code "<JS>"` | 盤面（変数 `snapshot`）に JS を実行 |
| `cells` | `--room N [--near x,y --radius r]` | ワープの実測（入口→着地、回数、タイル番号ごとの飛び方）とマスのメモ |
| `cell-note` | `--room N --x X --y Y --note "…"` | マスにメモを足す（`--note ""` で消す）。絶対座標 |
| `scrape-map` | `--room N` | Webマップを取得 |
| `verify` | `--run-dir var/runs/<runId>` | ソルバーのリプレイ検証 |

チェック: `bun run typecheck`、`bun test`、`bun run verify-solver`。
