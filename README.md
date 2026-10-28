# naisui-3d

国土交通省 PLATEAU の **内水浸水想定区域モデル** を、建物・地形と重ねて 3D で見るビューアです。
PC・スマホのブラウザで動き、Meta Quest のブラウザでは VR に入れます。

[naisui](https://github.com/junhongo-ccs/naisui)（品川区 中延・二葉の内水氾濫 PoC）の兄弟プロジェクトです。

## 表示しているもの

| レイヤー | 出典 | 形式 |
|---|---|---|
| 内水浸水想定区域（浸水深で色分け） | PLATEAU `ifld` | 3D Tiles (b3dm) |
| 建物 | PLATEAU `bldg`（LOD2 テクスチャなし、無ければ LOD1） | 3D Tiles (b3dm) |
| 地形 | 地理院タイル 標高タイル（`dem_png`） | PNG 標高タイル |
| 背景地図 | 地理院タイル（航空写真・淡色地図・標準地図） | XYZ タイル |

対象は、PLATEAU に内水浸水想定区域モデルがある **28 市町村**（31 データセット）です。
API キーやアカウントは要りません。

浸水深の色は「水害ハザードマップ作成の手引き」の配色に合わせています。
自治体独自の区分（`uro:rankOrg`、例: 0.2m以上0.3m未満）がある場合はそちらで色分けし、標準区分の色の間を補間します。

## 使い方

```bash
npm install
npm run dev
```

`http://localhost:5173/` を開きます。URL の `?city=14204&base=photo` で市町村（市区町村コード）と背景地図を指定できます。

| 操作 | PC | スマホ |
|---|---|---|
| 回転 | 左ドラッグ | 1 本指ドラッグ |
| 移動 | 右ドラッグ | 2 本指ドラッグ |
| ズーム | ホイール | ピンチ |
| 浸水深を見る | クリック | タップ |

### Quest で見る

WebXR は HTTPS が必要です。

- **公開版**：GitHub Pages（`main` に push すると `.github/workflows/deploy.yml` が公開）を Quest のブラウザで開き、ENTER VR を押す。
- **開発中**：`npm run dev:https` で LAN に公開し、Quest から `https://<PCのIP>:5173/` を開く（自己署名証明書の警告を許可する）。

VR に入ると、地図で見ていた中心の地面に立ちます。

| コントローラー | 動き |
|---|---|
| 左スティック | 見ている方向に移動 |
| 右スティック 左右 | 45° ずつ向きを変える |
| 右スティック 上下 | 上昇・下降 |
| トリガー（押しながら） | 10 倍速 |

## データ一覧の更新

`src/data/cities.json` は PLATEAU データカタログ API から作っています。PLATEAU が更新されたら作り直してください。

```bash
npm run catalog
```

## 注意

- 内水浸水想定区域は、自治体が想定した雨（多くは想定最大規模降雨）での**シミュレーション結果**です。実際の浸水や、今の雨での予測ではありません。
- 避難の判断には、自治体の公式ハザードマップと気象・避難情報を使ってください。

## 出典

- 3D 都市モデル：[国土交通省 PLATEAU](https://www.mlit.go.jp/plateau/)（[サイトポリシー](https://www.mlit.go.jp/plateau/site-policy/)）
- 地形・背景地図：[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)
- ジオイド高：[国土地理院 ジオイド計算 API](https://vldb.gsi.go.jp/sokuchi/surveycalc/main.html)
