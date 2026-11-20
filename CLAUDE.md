# CLAUDE.md — CHaserOnline003 自律プレイエージェント

CHaserOnline003 を、プロジェクト内の Claude Code CLI (`./node_modules/.bin/claude`) を**ハーネスとして**使ってプレイし、最高得点を更新し続ける実験プロジェクト。
モデルは `LLM_API_URL` のゲートウェイから選ぶ（`GET /api/models`）。通常の Claude Code の使い方（対話開発）はこのハーネスでは行わない。

- **試合中**: 常駐する**メインエージェント**が毎ターン「観測＋ソルバー候補」を受けて手を決める（手順は `agent/prompts/main.md`）。時間予算を超えたらソルバー手が自動送信される。調査・素材収集・ツール作成は**サブエージェント `sub`** に任せる（`agent/prompts/sub.md`）。
- **試合後**: 同じメインエージェントが振り返り、`src/solver/active-solver.ts` を改修する。リプレイ検証に失敗したら自動ロールバック。
- **セットアップ・自己レビュー**: `agent/SETUP.md` → `agent/SELF_CHECK.md`（実施後は両方を更新する）。
- 詳細仕様: [docs/README.md](docs/README.md)

## ディレクトリ
| パス | 内容 |
|---|---|
| `src/` | コードのみ（パスは `src/paths.ts` に集約） |
| `src/solver/active-solver.ts` | 進化対象のソルバー |
| `src/agent/` | 常駐 Claude セッション・メインエージェント・モデル一覧 |
| `knowledge/` | 永続知識（tiles.json, strategy.md, research/） |
| `agent/` | エージェント用手順書・プロンプト・`tools/`（エージェントが作るツール） |
| `assets/` | 公式タイル GIF（`assets/tiles/manifest.json`） |
| `var/` | 実行時データ（runs/, room-profiles.json, best-solvers/, claude-home/, current/snapshot.json）。git 管理外 |

## 1. CLI ツール (`bun src/cli.ts`)

```bash
bun src/cli.ts scrape-map --room 3                       # Web マップ (MapView.jsp) を HTTP で取得
bun src/cli.ts reference --tile 15                       # タイル・ルールの知識を検索
bun src/cli.ts upsert-tile --id 15 --name "special_15" --label "特殊(15)" --score 80 --passable true --hazard false --symbol "S"
bun src/cli.ts run-script --snapshot var/current/snapshot.json --code "return snapshot.tiles.filter(t => t.value >= 70);"
bun src/cli.ts verify --run-dir var/runs/<runId>         # 改修したソルバーを過去ログでリプレイ検証
bun src/cli.ts status --room 3                           # ルームの最高得点・発見タイル
bun run typecheck && bun test && bun run verify-solver   # 機械チェック一式
```
再利用したい処理は `agent/tools/<name>.ts` に書いて `bun agent/tools/<name>.ts` で実行する。

## 2. スコア計算式と絶対ルール
- **公式スコア式**: `合計得点 = 300 × 取得ターン数 + 動作得点 + アイテム得点 + プット得点 + プットダメージ`
- **生存最優先**: 毎ターン `+300` の基礎点が入るため、自爆やタイムアウトを防ぐ。
- **罠と壁の回避**:
  - `4` (ジオード: -1000), `12` (奈落: -600) は絶対踏まない。
  - `10` (岩盤: 通行不可 / -10), `1000+` (他プレイヤー: 衝突回避)。
  - `0` (穴: -20) の再踏破を最小限に抑え、一筆書きで未開拓領域（`2` 土 +10 等）や高得点アイテムへ進む。
- **CMD1 (`gr` vs `gru/grd/grl/grr`)**:
  - 隣接マスが安全かつプラス得点（`2`, `3`, `1`, `5-9`, `70-79`）なら `gru/grd/grl/grr` で移動＋観測し、CMD2 の `w*` と合わせて **1ターン2マス回収** する。
  - **静止 `gr` も穴への再着地扱いで `-20` 入る（実測）**。隣接が穴だけなら、目的地方向へ `gr*` で進む方が得（損失はほぼ同じで1マス前進）。静止 `gr` は進める安全マスが無い時だけ。
- **CMD2 の疲労コスト**:
  - 実測コスト: `gr` 動作 -20（＋穴再着地 -20）、`gr*`・`w*` 動作 -10（＋着地マス得点）。`agent/tools/score-model-check.ts` で過去試合と照合済み。
  - `d*`, `p*2w*`, `p*3s*`, `p*3l*`, `kei*` は1回約 `-250` の高疲労。それを上回るリターン（ジオーメタル `+400` へのショートカットや罠完全包囲からの脱出など）がある時のみ使う。

## 3. 進化対象の主要ファイル
1. **`src/solver/active-solver.ts`** — `decideTurnAction(worldMap, phase, turn)` のシグネチャを維持して改善。編集後は `bun src/cli.ts verify --run-dir <runDir>` と `bun run typecheck` を必ず通す。試合中は編集しない。
2. **`knowledge/tiles.json` / `knowledge/strategy.md`** — タイル得点・戦略知識（実測で更新する）。ルーム別の記録は `var/room-profiles.json`。
