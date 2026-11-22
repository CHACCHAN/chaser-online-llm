# agent/tools — エージェントが作る再利用ツール

メイン／サブエージェントが試合中・試合後に作るツールの置き場。`bun agent/tools/<name>.ts [args]` で実行する。

## 規約
- 1ファイル1ツール。先頭コメントに「目的・引数・出力例」を書く。
- 入力は基本 `var/current/snapshot.json`（毎ターン更新される盤面）か `var/runs/<runId>/turns.jsonl`。
- 出力は JSON 1行（メインが読みやすいように）。
- 実行時間は 2 秒以内を目安（試合中に使うため）。
- 作ったら下の一覧に1行追記する。

## 一覧
| ツール | 目的 |
|---|---|
| `score-model-check.ts` | 全過去試合を再生し、推定スコアと公式スコア（動作・アイテム）が一致するか確認 |
| `measure-turn-timeout.ts` | 1ターンの許容思考時間を実サーバで計測（SETUP §1-4） |
| `local-grid.ts` | 現在 pos 周辺のタイルを座標付き数字格子で出力（引数: 半径 or x0 x1 y0 y1） |
| `pickup-route.ts` | (臨時) 未回収アイテム/罠(3)までの奈落(12)回避最短路をJSON出力（引数: [snapshot] [x0 x1 y0 y1]） |
- `snap-grid.ts` (臨時): 保存済み盤面ファイル（sub-snapshots 等）を座標付き格子で表示。`bun agent/tools/snap-grid.ts <snap.json> x0 x1 y0 y1`
- `route-gband.ts` (臨時) — 77/79 帯の貪欲一筆書きルート（task-20 で作成）
- `gband-snake.ts` (臨時): 既知の通行可能マスの最大連結成分を蛇行一筆書きした経由点列。`bun agent/tools/gband-snake.ts <snap.json>`
- `snake-cells.ts` (臨時): 生き残りマスの連結成分と蛇行の上下ウィンドウ。`bun agent/tools/snake-cells.ts <snap.json> x0 x1 y0 y1`
- `sweep-route.ts` (臨時): 未回収77/75/79を罠(4)・壁(12)回避で一筆書き回収（DFS最良・始点への最終1歩可）。`bun agent/tools/sweep-route.ts <snap.json> [x0 x1 y0 y1]` → `{"targets","reached","steps","via","missed"}`（経由点は回収マスのみ）
- `ham-route.ts` (臨時): 指定区画の全マス一筆書き（再訪なし）で75/77/79回収を最大化。`bun agent/tools/ham-route.ts <snap.json> x0 x1 y0 y1 [--block x,y]…` → `{"targets","reached","steps","via","missed","path"}`
- `mid-cands.ts` (臨時): 罠4の隣接マスごとに pos からの距離と抜け道の最短長を出す（蛇行の罠の角の折返し用）。`all` で全区画。
- `route-cells.ts` (臨時): セル列(`{"cells":[[x,y],...],"region":[x0,x1,y0,y1]}`)が罠4/奈落12を通らないか・隣接が飛んでないか・区画の75/77/79の取りこぼしを検査。
- `full-cover.ts` (臨時): 区画の罠(1/5)以外の全マスを再訪なしで1本の道で覆えるか厳密探索（--block で罠/マスを封鎖し代替路を探す）。`bun agent/tools/full-cover.ts <snap.json> x0 x1 y0 y1 [--block x,y]...`
