# naisui-3d

PLATEAU の内水浸水想定区域モデル（`ifld`）を、建物（`bldg`）と地理院タイルの地形に重ねて表示する 3D ビューア。
PC・スマホのブラウザと、Meta Quest（WebXR）で同じページを見る。
兄弟プロジェクト: [naisui](https://github.com/junhongo-ccs/naisui)（品川区 中延・二葉の内水氾濫 PoC）。

## コマンド

```bash
npm run dev         # http://localhost:5173/
npm run dev:https   # LAN 公開 + 自己署名 HTTPS（Quest 実機確認用）
npm run build       # tsc + vite build → dist/
npm run typecheck
npm run catalog     # src/data/cities.json を PLATEAU カタログ API から作り直す
```

テストは無い。変更後は `npm run typecheck` と、ブラウザで実際に表示して確認する。
`?city=<市区町村コード>&base=photo|pale|std` で市町村と背景地図を切り替えられる。
開発時は `window.app`（scene, world, camera, terrain, buildings, floods, legend）からコンソールで状態を見られる。

## 構成

| ファイル | 役割 |
|---|---|
| `src/main.ts` | シーン、座標系、タイルセットの読み込み、浸水の色付け、UI、描画ループ |
| `src/terrain.ts` | 地理院 DEM（`dem_png`）を `TerrainRGBMeshPlugin` で地形にし、背景地図を貼る |
| `src/flood.ts` | 浸水深ラベルの解析と配色 |
| `src/vr.ts` | Quest コントローラーでの移動 |
| `src/data/cities.json` | 対象 28 市町村のタイルセット URL・中心・ジオイド高（`scripts/build-catalog.mjs` が生成。手で編集しない） |
| `src/types/3d-tiles-renderer.d.ts` | ライブラリに型が無い `TerrainRGBMeshPlugin` の型宣言 |

ライブラリ: three 0.186、3d-tiles-renderer 0.5.3、Vite。UI フレームワークは使っていない（素の DOM）。

## 座標と高さ（ここを崩すと全部ずれる）

- `world` グループが ECEF を市町村中心の局所座標に変換する。x = 東、y = 上、z = 南（メートル）。
  y = 0 は浸水ポリゴンの最も低い楕円体高（`cities.json` の `groundHeight`）。
- PLATEAU の 3D Tiles の高さは**楕円体高**。地理院 DEM は**標高（ジオイド基準）**なので、
  `GSITerrainPlugin.decodeElevation` で市町村ごとのジオイド高（`geoidHeight`）を足して揃えている。
- 地理院 `dem_png` の符号化: x = R·2^16 + G·2^8 + B、h = x·0.01 m、2^23 以上は負、ちょうど 2^23 はデータなし（海）。
- 地理院は陸の無い DEM タイルと z0 に 404 を返す。`terrain.ts` が `window.fetch` を包んで「データなし」タイルに差し替えている（地形プラグインがグローバル fetch を使うため）。ブラウザのコンソールに 404 が出るのは正常。

## PLATEAU データの癖

- b3dm の中身は Draco 圧縮 glTF ＋ `CESIUM_RTC`。`GLTFExtensionsPlugin({ rtc: true, dracoLoader })` が必須。
- 浸水深はバッチテーブルにある。標準区分は `uro:rank`（「0.5m未満」「0.5m以上3m未満」…）、自治体独自区分は `uro:rankOrg`。
  データセットによってどちらか一方だけが入っている。`featureLabel` は `rankOrg` を優先する。
- 独自区分の書き方は自治体ごとにばらばら（「5cm～20cm未満」「0.0m～0.2m未満の区域」「3.0m以上」）。`parseDepthLabel` で m 単位の範囲にしてから色を決める。
- 浸水ポリゴンは地表に貼り付いた面で、深さ方向の厚みは無い。地形と重なるので `polygonOffset` で手前に出している。
- ルートタイル（遠景）には一部の地物しか入っていない。近づくと子タイルが読まれ、凡例の区分が増える。

## 方針

- API キーが要るデータ（Cesium Ion、Google Photorealistic 3D Tiles）は使わない。誰でも URL を開くだけで見られることを優先する。
- 浸水想定は自治体のシミュレーション結果。画面や文書で「実際の浸水」「予報」のように書かない。
- 出典表記（PLATEAU、地理院タイル）を画面から消さない。
