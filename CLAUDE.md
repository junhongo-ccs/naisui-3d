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
表示する市は `src/config.ts` の `ONLY_CITY`（今は鎌倉市 14204）。`null` にすると 28 市町村を選べ、`?city=<市区町村コード>` も効く。
市の中で見せる範囲は `AREA`（地面・浸水タイル・ピン・手の地図・VR で動ける範囲がこれに従う）、VR の出発点は `VR_START`。
出発点は道路の中心線の座標で決める（地理院の地名検索の点は建物の中にあることがあり、Google 3D だと壁の中に立ってしまう。若宮大路の点は道路から約 70 m 西だった）。
`?base=photo|pale|std` で背景地図を切り替えられる。
画面からの市町村の切り替えはページを読み込み直さない（`switchCity`。VR を切らずに移れるように）。
開発時は `window.app`（renderer, scene, world, camera, controls, legend, pins, minimap, toLocal, toLatLon, vr, city, terrain, buildings, floods）からコンソールで状態を見られる。

## 構成

| ファイル | 役割 |
|---|---|
| `src/config.ts` | 表示する市（`ONLY_CITY`）、範囲（`AREA`）、VR の出発点（`VR_START`） |
| `src/main.ts` | シーン、座標系、タイルセットの読み込み、浸水の色付け、UI、描画ループ |
| `src/places.ts` | 目印・避難所のピン（距離によらず同じ見かけの大きさ、他の物の手前に描く）と説明の札 |
| `src/terrain.ts` | 地理院 DEM（`dem_png`）を `TerrainRGBMeshPlugin` で地形にし、背景地図を貼る |
| `src/loading.ts` | 読み込み中の表示（画面上部と VR の目の前）。最初の読み込み（VR の出発点から見た建物も含む）が終わるまで VR ボタンを止める（時間の上限なし） |
| `src/flood.ts` | 浸水深ラベルの解析と配色 |
| `src/vr.ts` | Quest コントローラーでの移動、ボタン操作、指さし、操作説明の板 |
| `src/vr-debug.ts` | VR の診断ボード（X ボタン。エラー、入力、指さしの状態を左手の上に出す。エラーが出ると自動で開く） |
| `src/vr-menu.ts` | VR の市町村一覧パネル（右グリップで開き、右手で指してトリガーで選ぶ。市が一つのときは出さない） |
| `src/vr-minimap.ts` | VR の左手の地図（淡色地図に目印と避難所、現在地の矢印） |
| `src/data/cities.json` | 対象 28 市町村のタイルセット URL・中心・ジオイド高（`scripts/build-catalog.mjs` が生成。手で編集しない） |
| `src/data/places/<コード>.json` | 目印と指定避難所（町名・標高付き。`scripts/build-places.mjs` が生成。手で編集しない） |
| `src/data/stories/<コード>.json` | 解説スポット（手で書く）。地形・しくみ・想定・記録・対策に分けた文と出典 |
| `src/types/3d-tiles-renderer.d.ts` | ライブラリに型が無い `TerrainRGBMeshPlugin` の型宣言 |

ライブラリ: three 0.186、3d-tiles-renderer 0.5.3、three-mesh-bvh 0.9、Vite。UI フレームワークは使っていない（素の DOM）。

レイキャスト（タップ・VR の指さし・VR の足元の高さ）は Quest で毎秒何度も走るので重さに注意する。
浸水のメッシュには、読み込み時に BVH を作っている（`indexForRaycast`）。
PLATEAU のタイルは、`group` ではなく `group.children`（表示中のタイル）に当てる（`raycastTargets`）。
`group` に当てると、キャッシュ中の全タイルの木をたどるので遅い。
地形だけは必ず `group` に当てる。地形のメッシュは平らで、起伏は GPU で付けている。
起伏を反映した判定は、`group` 経由で呼ばれるプラグインの `raycastTile` だけが行う。
`children` に直接当てると、平らな面に当たる。

ピンの指さしは、レイキャストではなく、光線とラベルの中心のなす角で判定している（`pins.pick`。ピンは他の物の手前に描くので、建物の陰でも選べる）。
避難所の説明には、国土地理院が求める注意（最新でない場合がある、市町村に確認、指定緊急避難場所とは別）と出典を必ず入れる。
解説の札では、想定（PLATEAU のシミュレーション）と記録（実際にあった被害）を別の項目に書き、どちらにも出典を付ける。報道だけが出典のことは「（報道）」と書く。
写真は、許可の取れたものか自分で撮ったものだけ使う（鎌倉市のサイトの写真は無断転載不可。報道の写真も不可）。

VR で頭の位置・向きを取るときは `renderer.xr.getCamera()` ではなく `camera`（`rig` の子）を使う。
XR カメラには親が無く、`getWorldPosition` などがリグ基準の値を返す。

## 座標と高さ（ここを崩すと全部ずれる）

- `world` グループが ECEF を市町村中心の局所座標に変換する。x = 東、y = 上、z = 南（メートル）。
  y = 0 は浸水ポリゴンの最も低い楕円体高（`cities.json` の `groundHeight`）。
- PLATEAU の 3D Tiles の高さは**楕円体高**。地理院 DEM は**標高（ジオイド基準）**なので、
  `GSITerrainPlugin.decodeElevation` で市町村ごとのジオイド高（`geoidHeight`）を足して揃えている。
- 地理院 `dem_png` の符号化: x = R·2^16 + G·2^8 + B、h = x·0.01 m、2^23 以上は負、ちょうど 2^23 はデータなし（海）。
- 地理院は陸の無い DEM タイルと z0、航空写真・淡色地図の z0〜1 と海のタイルに 404（中身は XML）を返す。一枚でも失敗すると地形タイルごと（ルートも）失敗して何も出ない。`terrain.ts` が `window.fetch` を包み、DEM は「データなし」タイル、背景地図は淡い灰色のタイルに差し替えている（地形プラグインと重ねる地図がグローバル fetch を使うため）。ブラウザのコンソールに 404 が出るのは正常。

## PLATEAU データの癖

- b3dm の中身は Draco 圧縮 glTF ＋ `CESIUM_RTC`。`GLTFExtensionsPlugin({ rtc: true, dracoLoader })` が必須。
- 浸水深はバッチテーブルにある。標準区分は `uro:rank`（「0.5m未満」「0.5m以上3m未満」…）、自治体独自区分は `uro:rankOrg`。
  データセットによってどちらか一方だけが入っている。`featureLabel` は `rankOrg` を優先する。
- 独自区分の書き方は自治体ごとにばらばら（「5cm～20cm未満」「0.0m～0.2m未満の区域」「3.0m以上」）。`parseDepthLabel` で m 単位の範囲にしてから色を決める。
- カタログ API の `lod` は文字列（`"2"`）。建物は LOD2 テクスチャ付き → LOD2 → LOD1 の順に選ぶ。LOD2 のタイルセットは全部の建物を含み、LOD2 のモデルが無い建物は LOD1 の形で入っている。鎌倉市でテクスチャがあるのは中心部（鎌倉駅〜由比ヶ浜・材木座）、大船、腰越・七里ガ浜のあたり。
- 浸水ポリゴンは地表に貼り付いた面で、深さ方向の厚みは無い。地形と重なるので `polygonOffset` で手前に出している。
- ルートタイル（遠景）には一部の地物しか入っていない。近づくと子タイルが読まれ、凡例の区分が増える。

## 方針

- API キーが要らないこと（誰でも URL を開くだけで見られること）を優先してきたが、PLATEAU の建物が重すぎて Quest で出ないため、`google-3d` ブランチで Google Photorealistic 3D Tiles を試している（`VITE_GOOGLE_MAPS_API_KEY` が `.env` にあるときだけ。無ければ地理院＋PLATEAU）。キーは自分で扱わない（ユーザーが `.env` に書く。中身を表示・コピーしない）。Google を使うときは、表示中のタイルの提供元を画面の出典に出す。
- 浸水想定は自治体のシミュレーション結果。画面や文書で「実際の浸水」「予報」のように書かない。
- 出典表記（PLATEAU、地理院タイル）を画面から消さない。
