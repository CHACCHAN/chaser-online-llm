# SETUP.md — セットアップ手順（エージェント専用）

> このファイルはエージェントが**何をするか**を残す手順書。実行して変更が出たら、このファイルと `SELF_CHECK.md` の両方を更新する。
> 最終更新: 2026-11-20 / v1（常駐メインエージェント構成に更新）

## 0. 前提
- Bun がインストール済み、`bun install` 済み
- `.env` に `CHASER_USER` / `CHASER_PASS` / `HOST_URL` / `LLM_API_URL` / `LLM_API_KEY` / `LLM_MODEL_NAME` が設定済み（値は出力・送信しない）。雛形は `.env.example`
- python3 は devcontainer の python feature で導入（補助スクリプト用。プロジェクト本体は Bun のみ）

## 1. 公式情報の確認（毎回）
| # | 確認内容 | 方法 | 合格条件 |
|---|---|---|---|
| 1-1 | サーバのバージョン | トップ `CHaserOnline003/` の `ver XXXXXXXX` | `knowledge/server.json` の `version` と一致。違えば §4 へ |
| 1-2 | 公開ルーム一覧 | `MeetingPlace/` の表 | 使用ルームが公開中・マップ表示の可否を `room-profiles` に反映 |
| 1-3 | ログイン〜入室 | `bun src/cli.ts status --room <N>` | 入室成功 |
| 1-3b | ゲートウェイとモデル | `curl -s localhost:3456/api/models`（または `src/agent/models.ts`） | 使用モデルが一覧にある |
| 1-3c | 常駐セッション | メインエージェントに2往復させる（`src/agent/claude-session.ts`） | 2回とも応答し、2回目が1回目を覚えている。応答時間を記録 |
| 1-4 | 1ターンの許容時間 | `bun agent/tools/measure-turn-timeout.ts --room <N> --delays 5,15,30,60,90,120` | 切断されない最大遅延を `knowledge/server.json` に記録（バージョンが変わった時だけ再計測） |

**既知の事実（2026-11-20 時点）**
- サーバ `ver 20260217`
- 制限時間は公開情報に記載なし。**実測（2026-11-20, room3）: CMD1 を120秒遅らせても切断なし**。サーバ応答は1コマンド約1.6秒で一定
- 常駐セッションの応答時間（gpt-6.2-sol, effort=xhigh, オフライン盤面）: 起動準備 約6秒、1手 約2〜5秒
- タイル得点は公式公開ページに根拠なし。`tiles.json` は実測値で管理する

## 2. 描画素材の確認
- 素材置き場: `assets/tiles/*.gif`（取得元 `CHaserOnline003/img/<3桁ID>.gif`、プレイヤーは `<6桁>.gif`）
- `assets/tiles/manifest.json` に全ファイルの元URL・推定タイルID・`verified` を記録
- 手順: `tiles.json` の全タイルIDについて画像の有無を突合 → 不足を下表に記録 → 不足分は UI 側で色＋記号の代替描画にする

**不足素材（2026-11-20）**: `010`（岩盤）, `018`, `019`, `024`, `034-039`, `044-049`, `054-059`, `064-069`, `080+`, プレイヤー `1001+`
**要確認**: `004.gif` の見た目が「ジオード」と合わない可能性 / `070-079` が同一画像の可能性

## 3. 動作確認
1. `bun test` — 全通過
2. `bun run typecheck` — エラー0
3. `bun run verify-solver` — `replaySmokeTest.ok: true`
4. `bun run start` → `http://127.0.0.1:3456` でマップが画像タイル (`/assets/tiles/*.gif`) で描画されること
5. オフライン判断テスト: 過去の `var/runs/<runId>/turns.jsonl` を WorldMap に再生し、数ターン分 `MainAgent.decide()` を呼ぶ → 全て `source=main`、合法手、予算内

## 4. 変更があった場合
- 差分（バージョン・プロトコル・タイル・素材）を `knowledge/` に反映
- `SELF_CHECK.md` を実施して合格まで繰り返す
- 本ファイルの「既知の事実」「不足素材」を更新し、最終更新日を書き換える
