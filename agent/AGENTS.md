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
| `var/` | 実行時データ（`runs/<runId>/` 過去の試合、`room-profiles.json`、`current/snapshot.json`・`MEMO.md`・`ASK_SUB.md`） | 読むだけ |
| `agent/prompts/`・`agent/policies/`・`agent/AGENTS.md`・`agent/REVIEW.md`・`src/`（ソルバー以外）・`CLAUDE.md`・`.env` | ハーネス本体・手順書・ユーザーの方針 | **禁止**（変えても自動で元に戻される） |

- ログイン情報（`.env`）は読まない・出力しない・外部に送らない。CHaserOnline サーバにはログインしない（試合中のセッションを壊す）。
- 公式サイト（`http://www7019ug.sakura.ne.jp/CHaserOnline003/`）のログイン不要ページは見てよい。公式の仕様書は手に入らないので、得点・ルールは実測で確かめて `knowledge/` に残す。

## CLI ツール（`bun src/cli.ts`）
```bash
bun src/cli.ts scrape-map --room 3                       # Web マップ (MapView.jsp) を HTTP で取得
bun src/cli.ts reference --tile 15                       # タイル・ルールの知識を検索
bun src/cli.ts upsert-tile --id 15 --name "special_15" --label "特殊(15)" --score 80 --passable true --hazard false --symbol "S"
bun src/cli.ts run-script --snapshot var/current/snapshot.json --code "return snapshot.tiles.filter(t => t.value >= 70);"
bun src/cli.ts verify --run-dir var/runs/<runId>         # 改修したソルバーを過去ログでリプレイ検証
bun src/cli.ts status --room 3                           # ルームの最高得点・発見タイル
bun run typecheck && bun test && bun run verify-solver   # 機械チェック一式
```

## スコア計算式と絶対ルール
- **公式スコア式**: `合計得点 = 300 × 取得ターン数 + 動作得点 + アイテム得点 + プット得点 + プットダメージ`
- **生存最優先**: 毎ターン `+300` の基礎点が入るため、自爆やタイムアウトを防ぐ。
- **罠と壁の回避**:
  - `4` (ジオード: -1000), `12` (奈落: -600) は絶対踏まない。
  - `10` (岩盤: 通行不可 / -10), `1000+` (他プレイヤー: 衝突回避)。
  - `0` (穴: -20) の再踏破を最小限に抑え、一筆書きで未開拓領域（`2` 土 +10 等）や高得点アイテムへ進む。
- **CMD1 (`gr` vs `gru/grd/grl/grr`)**:
  - 隣接マスが安全かつプラス得点（`2`, `3`, `1`, `5-9`, `70-79`）なら `gru/grd/grl/grr` で移動＋観測し、CMD2 の `w*` と合わせて **1ターン2マス回収** する。
  - **静止 `gr` も穴への再着地扱いで `-20` 入る（実測）**。隣接が穴だけなら、目的地方向へ `gr*` で進む方が得。静止 `gr` は進める安全マスが無い時だけ。
- **CMD2 の疲労コスト**:
  - 実測: `gr` 動作 -20（＋穴再着地 -20）、`gr*`・`w*` 動作 -10（＋着地マス得点）。`agent/tools/score-model-check.ts` で過去試合と照合済み。
  - `d*`, `p*2w*`, `p*3s*`, `p*3l*`, `kei*` は1回約 `-250` の高疲労。それを上回るリターン（ジオーメタル `+400` へのショートカットや罠完全包囲からの脱出など）がある時のみ使う。
- 未知のタイル・通らないコマンド・得点のずれに気付いたら記録する（公式の仕様が変わった可能性がある）。

## 試合後の改修
1. **`src/solver/active-solver.ts`** — `decideTurnAction(worldMap, phase, turn, plan)` のシグネチャを維持して改善。`bun src/cli.ts verify --run-dir <runDir>` と `bun run typecheck` を必ず通す（リプレイ検証に失敗すると自動で元に戻る）。
2. **`knowledge/tiles.json` / `knowledge/strategy.md`** — 実測で分かったタイル得点・戦略を残す。
3. 試合中に作った臨時ツール（`@temporary`）は、ソルバーへ組み込む／正式ツールにする／削除する、のどれかに決める。
