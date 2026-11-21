# CHaserOnline003 通信・Webマップ・ルール仕様書（実測確定版）

本ドキュメントは、対象サーバ `http://www7019ug.sakura.ne.jp/CHaserOnline003/`（ver `20260217`）に対して実際に通信・スクレイピング検証して確定した仕様をまとめたものです。

---

## 1. 対戦プロトコル (`user/`)

- **文字コード**: `Shift_JIS`（`TextDecoder("shift_jis")` でデコード）
- **セッション維持**: レスポンスの `Set-Cookie: JSESSIONID=...` を全リクエストに付与し、302 リダイレクトを最大10ホップ追跡（[src/client/base.ts](../src/client/base.ts)）。
- **1ターンのステートマシン**（[src/client/client.ts](../src/client/client.ts)）:
  1. `GET /user/` → `JSESSIONID` 取得
  2. `GET /user/UserCheck?user=...&pass=...` → ログイン
  3. `GET /user/RoomNumberCheck?roomNumber=...` → `command1=` が出るまでポーリング
  4. `GET /user/GetReadyCheck?command1=<CMD1>` → `command2=` が出るまでポーリング、`ReturnCode=`（9要素の周囲3×3配列）を受信
  5. `GET /user/CommandCheck?command2=<CMD2>` → `command3=` が出るまでポーリング、`ReturnCode=`（9要素または直線配列）を受信
  6. `GET /user/EndCommandCheck?command3=#` → ターン確定、`command1=` が出れば次ターンへ、`user=` が出れば `GAME_OVER`

---

## 2. Web マップ画面のスクレイピング仕様 (`Server/`)

`http://www7019ug.sakura.ne.jp/CHaserOnline003/Server/` には以下の4画面が存在します：
- `MapView.jsp`（**リアルタイム対戦マップビュー**）
- `vsResultView.jsp`（**公式成績一覧 `listvsresult`**）
- `vsResultViewWorld.jsp`（**World 表示 `listWorldvsresult`**）
- `Ranking.jsp`（合計得点ランキング）

### 2.1 `MapView.jsp` の2段階セッション認証（重要）
[src/perception/web-map-scraper.ts](../src/perception/web-map-scraper.ts) に実装済みの実測手順：
1. `GET /Server/MapView.jsp`（Cookie 取得）
2. `GET /Server/UserCheck?user=<USER>&pass=<PASS>&select=mapview`（1回目: セッションを `mapview` 認証フォーム状態へ遷移させる）
3. `GET /Server/UserCheck?user=<USER>&pass=<PASS>&select=mapview`（2回目: 認証完了し、リアルタイム対戦マップ HTML を返す）

### 2.2 `MapView.jsp` HTML から抽出できる情報
- **ステージ名**: `<H1>対戦マップビュー [Renshuu_x5]</H1>`
- **現在ターン**: `turn=4 Next=<USER>`
- **盤面グリッド**: `<table cellpadding="0" cellspacing="0">` 内の各 `<td>` に `<img src="/CHaserOnline003/img/012.gif">` や `<img src="/CHaserOnline003/img/001000.gif">` の形式で全マスが並ぶ。
  - 注意: JSP の出力仕様上、`<tr></tr><tr><td>...` のように閉じタグと開きタグが連続するため、パーサは `/<\/?tr[^>]*>/i` で行分割してから `/\/img\/0*(\d+)\.(?:gif|png|jpg)/i` で数値化する。
  - 自機タイル（例: `1000`）の座標 `(col, row)` がそのまま絶対座標 `playerPos` になる。
- **リアルタイム公式スコア**: 盤面横のテーブルに以下の形式で出力される：
  ```text
  [<img src="/CHaserOnline003/img/001000.gif"> 3416kancho_fkmt A:-1050 I:-1010 P:0 PD:0 T:8740]
  ```
  - `A`: ActionPoint（動作得点）
  - `I`: ItemPoint（アイテム得点）
  - `P`: PutPoint（プット得点）
  - `PD`: PutDamage（プットダメージ）
  - `T`: TotalScore（合計得点）

### 2.3 Web マップが無いルームでのフォールバック（ReturnCode SLAM）
- `MapView.jsp` / `listWorldvsresult` から盤面が取得できないルームでは、[src/memory/world-map.ts](../src/memory/world-map.ts) が `ReturnCode=` の 3×3 観測および直線サーチから相対座標マップを構築します。
- ワープ（`20-53`）やブラックスター（`60-63`）で観測パターンが3マス以上不整合になった場合、新セグメントを作成し、既存セグメントの既知3×3パターンと一意に一致した時点で座標系を統合（Loop Closure）します。
- Web マップがあるルームでワープが発生した場合は、[src/runner.ts](../src/runner.ts) が即座に `MapView.jsp` を再スクレイピングしてワープ後の絶対座標へ再ロックします。

---

## 3. 公式スコア計算式・タイル定義・コマンド一覧

### 3.1 公式スコア式
```text
合計得点 = 300 × 取得ターン数 + 動作得点 + アイテム得点 + プット得点 + プットダメージ
```

### 3.2 タイル ID 一覧（初期値: [knowledge/tiles.json](../knowledge/tiles.json)）
| タイルID | 名称 | 推定得点 | 通行可否 | 危険(罠) | 備考 |
| :--- | :--- | :---: | :---: | :---: | :--- |
| `0` | 穴 | `-20` | 可 | いいえ | 既通過マス。再踏破を最小限にする |
| `1` | ターゲット | `+50` | 可 | いいえ | |
| `2` | 土 | `+10` | 可 | いいえ | 未開拓の通常マス |
| `3` | アイテム | `+30` | 可 | いいえ | Put3 で設置可能 |
| `4` | ジオード | `-1000` | 可 | **はい** | 絶対回避 |
| `5`..`8` | 化石1〜4 | `+125`..`+200` | 可 | いいえ | 高得点 |
| `9` | アンモナイト | `+100` | 可 | いいえ | |
| `10` | 岩盤 | `-10` | **不可** | いいえ | 壁・移動ブロック |
| `12` | 奈落 | `-600` | 可 | **はい** | 絶対回避（ステージ外周・仕切り壁等） |
| `20`..`53` | ワープ | `+5` | 可 | いいえ | 別座標へワープ |
| `60`..`63` | ブラックスター | `+5` | 可 | いいえ | 部屋間ジャンプ等（例: `Renshuu_x5` の4部屋接続） |
| `70`..`79` | ジオーメタル | `+400` | 可 | いいえ | 最高得点帯 |
| `1000`+ | プレイヤー | `0` | **不可** | いいえ | 自機・他機 |

### 3.3 コマンドと疲労コスト（動作得点）
コマンド（公式の全61種）の動き・観測・動作得点・ハーネスで送れるかは [knowledge/commands.md](../knowledge/commands.md) に一本化している（ここには書かない）。
スコア・タイルは [knowledge/official-rules.md](../knowledge/official-rules.md)、公式資料の出典と実測との食い違いは [knowledge/research/official-sources.md](../knowledge/research/official-sources.md)。
ハーネスの内部表現（移動量・観測の位置・推定動作得点）は `src/memory/world-map.ts` の `CMD1_SPECS` / `CMD2_SPECS`。

---

## 4. 実測に基づく追記（2026-11-20）

- **タイル得点は公式根拠なし・実測値**: 公式の公開ページにタイルごとの得点表は見当たらない。本節の推定得点と `knowledge/tiles.json` の値は、試合ログと公式成績の突合から得た実測値として扱い、新しい試合で差が出たら更新する。
- **実測コスト（2026-11-20, 6試合で公式と完全一致）**: 静止 `gr` は動作 -20 ＋ 現在地(穴)への再着地 -20 = -40。`gr*`・`w*` は動作 -10 ＋ 着地マス得点。検証: `bun agent/tools/score-model-check.ts`
