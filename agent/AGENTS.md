# AGENTS.md

CHaserOnline003 を自動でプレイするハーネス。フェーズ: 準備（入室前、読むだけ）→ 試合中のメイン（毎フェーズ使い捨て、ツールなし）とサブ（依頼ごと）→ 試合後の振り返り。手順はそれぞれ `agent/prompts/` にある。

試合中の手は経路探索の方策（`src/solver/planner.ts`、評価関数 `src/solver/evaluator.ts`、学習したパラメータ `var/policy/params.json`）が毎フェーズすぐ出す。メインは方策を待たせず裏で作戦を出す。試合後はシミュレータ（`src/sim/`）で学習する。仕組みは `docs/learning.md`。ユーザーは WebUI の「学習」画面で、作った地図を並べて方策が動くところ・学習・地図ごとの学習前→後を見ている。

## 触ってよい範囲
| パス | 編集 |
|---|---|
| `knowledge/`、`agent/tools/` | 試合後・サブ |
| `src/solver/evaluator.ts`（方策の評価関数） | 試合後だけ。改修前と同じ地図で比べ、弱くなっていれば自動で元に戻る |
| `src/solver/active-solver.ts`（とテスト） | 試合後だけ（`PLAY_POLICY=solver` の時の手） |
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
| シミュレータの地図の作り方 | `knowledge/sim-profiles.json`（本物の地図 `var/maps/` と見比べて直してよい） |
| 方策の学習の記録 | `var/policy/params.json`（今のパラメータ）、`var/policy/train-log.jsonl` |
| 方策の学習のやり方 | `knowledge/train-config.json`（候補・地図・確かめの数、探す幅） |
| 学習の LLM の記録 | `var/lab-coach/`（学習ごとの統計 report.md・再生 traces.json・結果 log.jsonl）。学習の LLM の手順は `agent/prompts/lab-coach.md` |
| 作業用の置き場 | `var/tmp/`（試合の写しで試す時などはここに。`var/runs/` に置くと過去の試合として数えられる） |

## CLI（`bun src/cli.ts <サブコマンド>`）
| サブコマンド | 引数 | 内容 |
|---|---|---|
| `reference` | `--tile ID` / `--query 語` | タイルの登録内容 / 公式ページの検索 |
| `upsert-tile` | `--id --score --name --label --passable --hazard --symbol [--notes]` | タイルを登録・更新 |
| `tile-scores` | `--run-dir var/runs/…` | Webマップの公式のアイテム得点から測ったタイルの得点（読むだけ。試合の終わりにハーネスが `tiles.json` へ `source: "measured"` で残す。measured の得点は推測で書き換えない） |
| `cells` | `--room N [--near x,y --radius r]` | ワープの実測（入口→着地、回数、タイル番号ごとの飛び方）とマスのメモ |
| `cell-note` | `--room N --x X --y Y --note "…"` | マスにメモを足す（`--note ""` で消す。1件160字まで） |

| `verify` | `--run-dir var/runs/<runId>` | ソルバーのリプレイ検証 |
| `sim` | `--room N --n 8 [--seed S --policy solver --max-turns 200]` | 方策をシミュレータで打たせる（地図は毎回ランダム＋本物の地図） |
| `bench` | `--room N --n 24 [--evaluator <file>]` | 同じ地図で比べる（既定は solver と planner。`--evaluator` で今の evaluator.ts と別ファイル。改修を試す時は `var/tmp/` に写して直し、ここで比べる） |
| `train` | `--room N --minutes 5 [--dry-run]` | 方策のパラメータを学習（はっきり良くなった時だけ保存） |

`cells`・`cell-note` の座標は `var/current/snapshot.json` の `position` と同じ座標（今の区画）。ハーネスが絶対座標（Webマップの列・行）に直して保存するので、試合をまたいで使える。過去の試合のログ（`turns.jsonl` の `globalPositionAfter` など）の絶対座標を使う時は `--abs`。Webマップで位置合わせできていない時は記録できない。

チェック: `bun run typecheck`、`bun test`、`bun run verify-solver`。
