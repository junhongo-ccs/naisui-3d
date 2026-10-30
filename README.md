# naisui-3d

国土交通省 PLATEAU の **内水浸水想定区域モデル** を、地面・建物の 3D と重ねて見るビューアです。
PC・スマホのブラウザで動き、Meta Quest のブラウザでは VR に入れます。

[naisui](https://github.com/junhongo-ccs/naisui)（品川区 中延・二葉の内水氾濫 PoC）の兄弟プロジェクトです。

## 表示しているもの

地面と建物は、Google Map Tiles API のキーがあるとき（公開版）は Google の 3D、無いときは地理院の地形と PLATEAU の建物です。ほかは同じです。

| レイヤー | 公開版（Google のキーあり） | キーなし | 形式 |
|---|---|---|---|
| 内水浸水想定区域（浸水深で色分け） | PLATEAU `ifld` | 同じ | 3D Tiles (b3dm) |
| 地面・建物・木 | Google Photorealistic 3D Tiles | 地形: 地理院タイル 標高タイル（`dem_png`）＋背景地図（航空写真・淡色地図・標準地図）<br>建物: PLATEAU `bldg`（LOD2 テクスチャ付き、無ければ LOD2、LOD1） | 3D Tiles |
| VR の左手の地図 | 地理院タイル（淡色地図） | 同じ | XYZ タイル |
| 目印（駅・寺社・海岸など） | 国土地理院 地名検索・逆ジオコーダー・標高 API | 同じ | ピン |
| 避難所 | 国土地理院 指定避難所データ | 同じ | ピン |
| 解説（地形、浸水のしくみ、過去の被害、市の対策） | 鎌倉市の下水道計画・雨水管理総合計画、報道、国土地理院の標高 | 同じ | ピン（青い i） |

今の公開版は **鎌倉市の中心部だけ**（北鎌倉・円覚寺〜材木座、長谷・大仏〜鎌倉宮）を表示します（VR で迷い出ないように）。
対象の市は `src/config.ts` の `ONLY_CITY`、市の中で見せる範囲は `AREA`、VR の出発点は `VR_START` で決めます。`null` にすると、PLATEAU に内水浸水想定区域モデルがある **28 市町村** すべてを選べます（目印・避難所・解説のピンは、データを作った市だけ）。
見る人に API キーやアカウントは要りません。

### Google 3D について

PLATEAU の建物は遠くから見ても細かいタイルを読むので重く、鎌倉市の最初の画面で 60 秒たっても読み終わりませんでした（建物だけで 60 MB 以上）。Quest では建物が出ませんでした。Google は粗いタイルから読むので、約 20 秒・7 MB で読み終わります（2026-10-30、同じ回線での比較）。そのため公開版は Google を使っています。

開発中は `.env`（git に入らない）に開発用のキーを書きます。公開版のビルドには、GitHub の Actions secret `VITE_GOOGLE_MAPS_API_KEY`（本番用のキー）を `.github/workflows/deploy.yml` が渡します。キーが無ければ、地理院の地形と PLATEAU の建物で動きます。

```
VITE_GOOGLE_MAPS_API_KEY=...
```

キーの扱い（[kosugi_3Dmap](https://github.com/junhongo-ccs/kosugi_3Dmap) と同じ方針）:

- キーは公開ページの JavaScript に入るので、見られる前提で扱う。`.env` はコミットしない
- 本番用と開発用でキーを分ける。本番用は公開 URL、開発用は `localhost` の HTTP リファラーだけを許可する
- キーで使える API は Map Tiles API に絞る
- Google Cloud で予算アラートとクォータ上限を設定する（今は 3D Tiles root requests を 1 日 30 回。ページを 1 回開くと 1 回数える。開発用のキーも同じ枠）
- 画面の出典に、表示中のタイルの提供元（Google と各データ提供者）を出す（`getAttributions()`）

浸水深の色は「水害ハザードマップ作成の手引き」の配色に合わせています。
自治体独自の区分（`uro:rankOrg`、例: 0.2m以上0.3m未満）がある場合はそちらで色分けし、標準区分の色の間を補間します。

## 使い方

```bash
npm install
npm run dev
```

`http://localhost:5173/` を開きます。URL の `?base=photo|pale|std` で背景地図を（Google のキーが無いときだけ）、`ONLY_CITY` が `null` のときは `?city=14204` で市町村（市区町村コード）を指定できます。

| 操作 | PC | スマホ |
|---|---|---|
| 回転 | 左ドラッグ | 1 本指ドラッグ |
| 移動 | 右ドラッグ | 2 本指ドラッグ |
| ズーム | ホイール | ピンチ |
| 浸水深を見る | クリック | タップ |
| ピンの説明を開く・閉じる | ピンをクリック | ピンをタップ |

### Quest で見る

WebXR は HTTPS が必要です。

- **公開版**：Quest のブラウザで https://junhongo-ccs.github.io/naisui-3d/ を開き、ENTER VR を押す（`main` に push すると、GitHub Actions がビルドしてここに公開する）。
- **開発中**：`npm run dev:https` で LAN に公開し、Quest から `https://<PCのIP>:5173/` を開く（自己署名証明書の警告を許可する）。

VR に入ると、若宮大路（小町二丁目のあたり）の道路に立ち、鶴岡八幡宮の方を向きます。
出発点から見える細かいタイルは、地図の画面を見ている間に先に読んでおきます。それが終わるまで ENTER VR は「読み込み中…」のままで押せません（速い回線で 40 秒ほど）。
左手の上に地図（赤い矢印が自分の位置と向き）と操作説明が出ます。
表示している範囲の外側 100 m より先と、高さ 2,000 m より上には動けません。

| コントローラー | 動き |
|---|---|
| 左スティック | 見ている方向に移動（速さは地面からの高さに比例。地上は 15 m/s） |
| 右スティック 左右 | 45° ずつ向きを変える |
| 右スティック 上下 | 上昇・下降 |
| トリガー（押しながら） | 5 倍速 |
| 右手で浸水域を指す | その地点の上に想定浸水深を表示（ボタン不要。ハンドトラッキングでも可） |
| 右手でピンを指して右トリガー | 目印・避難所・解説の札を開く・閉じる（ピンを指している間、右トリガーは加速にならない） |
| A ボタン | 水面を想定浸水深まで上げる／戻す（パネルの「水面を想定浸水深まで上げる」と同じ） |
| 右グリップ | 市町村の一覧（`ONLY_CITY` が `null` のときだけ。指してトリガーで移動） |
| X ボタン | 診断ボード（エラー、入力、指している先、地面のタイルの表示数と読み込み待ち）。エラーが出ると自動で開く |
| Y ボタン | スタート地点に戻る |
| B ボタン | VR を終了して地図の画面に戻る |

水面は浸水深の区分の上限まで上げます（「0.5m未満」なら 0.5m）。「3m以上」のように上限の無い区分は下限まで上げます。

## データ一覧の更新

`src/data/cities.json` は PLATEAU データカタログ API から作っています。PLATEAU が更新されたら作り直してください。

```bash
npm run catalog
```

目印と避難所のピンは `src/data/places/<市区町村コード>.json` で、`scripts/build-places.mjs` が国土地理院の API から作ります。目印にする場所の名前は、スクリプトの `LANDMARKS` に市ごとに書きます。

```bash
node --use-system-ca scripts/build-places.mjs 14204
```

解説のピン（青い i）は `src/data/stories/<市区町村コード>.json` に手で書きます。今は鎌倉市の4か所（中心部の地形、若宮大路・小町、由比ガ浜の海沿い、長谷・稲瀬川）です。
札は「地形」「しくみ」「この色（想定）」「実際の被害（記録）」「これからの対策」に分け、シミュレーションの結果と実際にあった被害を混ぜないようにしています。どの札にも出典を入れます。

## 注意

- 内水浸水想定区域は、自治体が想定した雨（多くは想定最大規模降雨）での**シミュレーション結果**です。実際の浸水や、今の雨での予測ではありません。
- 避難の判断には、自治体の公式ハザードマップと気象・避難情報を使ってください。
- 避難所は、市町村が国土地理院に登録した「指定避難所」です（鎌倉市は災害の種類ごとの「指定緊急避難場所」を公開していません）。最新でない場合があります。開設状況などは市町村に確認してください。

## 出典

- 内水浸水想定区域（キーなしのときは建物も）：[国土交通省 PLATEAU](https://www.mlit.go.jp/plateau/)（[サイトポリシー](https://www.mlit.go.jp/plateau/site-policy/)）
- 地面・建物の 3D（公開版）：Google（Map Tiles API。画面に、表示中のタイルの提供元を出す）
- VR の手の地図（キーなしのときは地形・背景地図も）：[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)
- 避難所：[指定緊急避難場所・指定避難所データ（国土地理院）](https://www.gsi.go.jp/bousaichiri/hinanbasho.html)
- 目印の位置・町名・標高：国土地理院 地名検索・逆ジオコーダー・標高 API
- 解説：鎌倉市 [下水道計画「基礎調査」](https://www.city.kamakura.kanagawa.jp/gesui/documents/kisochousa_1.pdf)、[雨水管理総合計画（2026 年 3 月）](https://www.city.kamakura.kanagawa.jp/gesui/documents/r7usuikanrisougoukeikaku.pdf)、[同 素案の概要](https://www.city.kamakura.kanagawa.jp/gesui/documents/1_1120.pdf)、[策定について（2024 年 10 月）](https://www.city.kamakura.kanagawa.jp/gesui/documents/1003_1-1.pdf)、[下水道事業運営審議会資料（2025 年 10 月）](https://www.city.kamakura.kanagawa.jp/gesui/documents/1003_3_1.pdf)、[タウンニュース鎌倉版（2026 年 10 月 2 日）](https://www.townnews.co.jp/0602/2026/10/02/855379.html)、[毎日新聞（2026 年 9 月）](https://news.yahoo.co.jp/articles/18854f8b762febaf82b67702c139310c8c9f075f)
- ジオイド高：[国土地理院 ジオイド計算 API](https://vldb.gsi.go.jp/sokuchi/surveycalc/main.html)
