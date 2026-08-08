# デジタルワードローブ

手持ちの服を写真で登録し、コーデ・着用記録・使用頻度をまとめて見渡せる、
あなただけのクローゼット帳です。

- 公開先: `https://gigayama.github.io/DigitalCloset/`
- 使い方は **[MANUAL.md](./MANUAL.md)**
- 品質の実測値は **[AUDIT.md](./AUDIT.md)**
- 導入したときの記録は **[ROLLOUT.md](./ROLLOUT.md)**

---

## できること

服を1着ずつ写真で登録すると、「何を持っているか」「いつ着たか」「何と合わせたか」が
ひとつづきの記録になります。画面は下のタブで5つに分かれています。

| 画面 | できること |
|---|---|
| **クローゼット** | 服の一覧（2列のカード）。アイテム名とブランドでの検索、カテゴリ／色／シーズン／購入年での絞り込み、登録日・価格・名前での並べ替え |
| **コーデ** | 手持ちから2着以上を選んで組み合わせを保存。★5段階で評価できる。★4以上は AI に相談するとき「好みの傾向」として渡される |
| **カレンダー** | 月ごとの表。日を押して「その日に着た服」を記録する。1日に何着でも登録でき、あとから1件ずつ消せる |
| **ダッシュボード** | 手持ち／廃棄済みの点数、金額（現在のクローゼット・廃棄済み・累計）、着用回数 Top 5（カテゴリで絞れる）、カテゴリ別の割合 |
| **設定** | ホーム画面への追加、Gemini API キー、使うモデル、カテゴリと色の候補、書き出し・読み込み、廃棄済みの確認 |

アイテムの詳細（一覧のカードを押す）では、価格・着用回数・**CPW（1回あたりの単価）**・
色・シーズン・素材・購入年に加えて、AI のコーデ提案とお手入れ、
**そのアイテムを使ったコーデの一覧**が出ます。編集と廃棄もここから行います。

服は「廃棄」しても消えません。廃棄済みへ移るだけで、いつでも戻せます。
完全に消えるのは、廃棄済みの一覧からもう一度「削除」を選んだときだけです。

### AI を使う機能

**利用者が自分で入れた Gemini API キーがあるときだけ**動きます。
キーが無くても、登録・記録・ふりかえりはすべて使えます。

| 機能 | どこから | 何をするか |
|---|---|---|
| 写真の読み取り | アイテム追加／編集の「AIで解析」 | 名前・カテゴリ・色・季節・素材・ブランド・推定価格・購入年・コーデ提案・お手入れを埋める。複数枚まとめて渡せる（タグやロゴの写真を足すと精度が上がる） |
| AI スタイリスト | コーデの「AI提案」／一覧のカード右上の ✨ | 基準にする1着と要望を渡すと、**手持ちの服だけ**を使ったコーデを最大3通り提案する。そのままマイコーデに保存できる |
| 相談 | クローゼット右上の吹き出し → 💬 | 手持ちと★4以上のコーデを踏まえて質問に答える。画像も添えられる |
| 買わないストッパー | 同 → 🛑 | 買おうか迷っている服の写真を渡すと、手持ちと突き合わせて辛口に判定する（画像が必須） |
| 逆引きコーデ | 同 → 🔍 | 憧れのスナップ写真を渡すと、手持ちで再現できる組み合わせを出す（画像が必須） |
| モデルの選択 | 設定の「AIモデル」→「取得」 | そのキーで使えるモデルを一覧し、選んだものを以後の呼び出しに使う（既定は `gemini-2.5-flash`） |

読み取りも提案も、**確認してから保存する**形にしてあります。
自動では保存されません。AI が返した ID のうち手元に無いものは、保存前に落としています。

---

## どういう作りか

GIGA Standard v5 の **B型**（Vite + React、静的サイト）です。
サーバーを持ちません。**データはすべて使っている端末の中だけ**にあります。

| もの | 置き場所 | 外に出るか |
|---|---|---|
| 服の写真・登録内容・コーデ・着用記録 | ブラウザの IndexedDB（`GigaClosetDB` v2 / `items`・`wear_logs`・`coordinates`） | 出ない |
| Gemini API キー | `localStorage['giga_closet_api_key']` | Google の API へ送る以外は出ない |
| カテゴリ・色の候補、選んだモデル | `localStorage['giga_closet_custom_categories' / 'giga_closet_custom_colors' / 'giga_closet_gemini_model']` | 出ない |

写真は取り込んだ時点で**長辺 800px・JPEG 品質 0.7 に縮めて** data URL で持ちます。
元の大きさのままは保存しません。

AI の機能（上の表の6つ）を使うときだけ、
**利用者が自分で入れた API キー**で Google の Gemini API に問い合わせます。
キーはリポジトリにもコードにも書かれていません。

### 構成

```
index.html                  CSP・PWA の <head>・install-hook の読み込み
vite.config.js              base は /DigitalCloset/（GitHub Pages のサブパス）
src/
  main.jsx                  入口。Service Worker の登録もここ（React の外側）
  App.jsx                   本体（画面はすべてこの中）
  pwa.js                    Service Worker の登録と更新の案内
  index.css                 Part I §2 の土台（dvh / safe-area / clamp / tap-44 ほか）
public/
  manifest.webmanifest      id / scope / start_url は /DigitalCloset/ の絶対パス
  sw.js                     Service Worker（版と先読み一覧はビルド時に埋まる）
  offline.html              圏外のときに出す画面。外部資産にも JS にも頼らない
  install-hook.js           beforeinstallprompt の捕捉（インラインにしない）
  icons/                    192 / 512 / maskable ×2 / apple-touch-icon
  favicon.png               生成物
tools/
  src-icon.png              アイコンの原本。全サイズはここ1枚から作られる
  build-icons.mjs           アイコン生成＋セーフゾーンの画素計測
  build-sw.mjs              sw.js の APP_VERSION と先読み一覧を実バイトから埋める
  measure.mjs               実ブラウザでコントラスト・タップ領域・横スクロールを測る
  measure-pwa.mjs           PWA の挙動を測る（サーバーを止めて圏外を作る）
  measure-csp.mjs           CSP が本当に効いているかを確かめる
scripts/
  check-project.mjs         品質ゲート（CI と同じもの）
  lib/giga-v5-checks.mjs    Part I の静的検査
  verify-gate.mjs           検査そのものをわざと壊して確かめる
.github/
  workflows/ci.yml          build → check → verify-gate（push と pull_request）
  workflows/deploy.yml      main への push で dist/ を GitHub Pages へ出す
  dependabot.yml            依存の更新
quality.config.json         上限値と「このアプリでは対象外」の理由
MANUAL.md                   使い方（利用者向け）
AUDIT.md                    実測値
ROLLOUT.md                  導入したときの記録
```

### 原本と生成物

| ファイル | 編集してよいか |
|---|---|
| `src/**` `index.html` `public/sw.js` `public/manifest.webmanifest` `tools/**` | **ここを直す** |
| `public/icons/**` `public/favicon.png` | **手で編集しない**（`npm run icons` の生成物） |
| `dist/**` | **手で編集しない**（`npm run build` の生成物） |

**アイコンの原本は `tools/src-icon.png` の1枚だけ**です。
ここを差し替えて `npm run icons` を走らせると、全サイズが作り直されます。

---

## 開発

```bash
npm ci
npm run dev        # 開発サーバー（Service Worker は登録しない）
npm run build      # dist/ を作り、sw.js の版と先読み一覧を埋める
npm run preview    # dist/ を配って確かめる
npm run icons      # tools/src-icon.png から全サイズを作り直す
```

### 出す前に通すもの

```bash
npm run build
npm run check          # 品質ゲート（CI と同じもの）
npm run verify-gate    # 検査そのものが働いていることを確かめる
```

### 実ブラウザで測る（読むだけでは分からないもの）

`playwright` が要ります（`npm i -g playwright` でも `npm i -D playwright` でも動きます）。

```bash
npm run preview &                       # 別の端末で
npm run measure                         # 既定の宛先は http://localhost:4173/DigitalCloset/
npm run measure -- --url http://127.0.0.1:4173/DigitalCloset/   # 宛先を変えるとき
npm run measure:pwa                     # サーバーは自分で起こすので preview は不要
npm run measure:csp                     # 同上
```

- `measure` … 全画面を歩いて **コントラスト比** と **タップ領域 44px** を測る。
  色は文字列から数値を拾わず、1px 実際に塗って読み返す（`oklch()` でも壊れない）
- `measure:pwa` … 登録・初回リロード・更新・他アプリのキャッシュ・圏外を測る。
  **圏外はサーバーを止めて作る。**`setOffline` はページ側にしか効かず、
  Service Worker は本物のサーバーへ取りに行ってしまうため
- `measure:csp` … インラインの `<script>` と許していない CDN が
  **実際に止まること**を見る

---

## リリース手順

1. `src/**` を直す
2. `npm run build`
   - `sw.js` の `APP_VERSION` は**中身から自動で作られる**ので、手で上げる必要はない。
     中身が1バイトでも変われば必ず変わり、変わらなければ変わらない
3. `npm run check` と `npm run verify-gate` を通す
4. 表示や PWA を触ったなら `npm run measure` / `measure:pwa` / `measure:csp` を走らせ、
   結果を AUDIT.md に反映する
5. `main` に入ると GitHub Actions が `dist/` を GitHub Pages へ出す

---

## 気をつけること

### 同一オリジンを共有している

`gigayama.github.io` は数十個のアプリが**同じオリジンを共有**しています。そのため:

- `manifest` の `id` / `scope` / `start_url` は
  **`/DigitalCloset/` の絶対パス**にしてあります。省略すると別アプリと取り違えられます
- `sw.js` は `caches.keys()` を全消ししません。
  `digital-closet-` で始まるキャッシュだけを消します。
  全消しすると**他のアプリがオフラインで起動しなくなります**
- `localStorage.clear()` は使いません。自アプリの接頭辞のキーだけを扱います

### CSP を触るとき

`index.html` の CSP は `script-src 'self'` です。
**`'unsafe-inline'` を足して解決してはいけません。**それでは入れた意味がほとんど無くなります。
インラインの `<script>` と `onclick=` は使えないので、外部ファイルと `addEventListener` にします。

`connect-src` は `'self'` と `https://generativelanguage.googleapis.com` だけです。
別の宛先へ問い合わせる機能を足すときは、ここも足さないと**黙って止まります**。

`frame-ancestors` は `<meta>` では無視されるので書いていません。
埋め込みを止めるには HTTP ヘッダーが要りますが、GitHub Pages では足せません。
独自ドメインや CDN を挟むときに設定してください。

### Service Worker の登録位置

登録は `src/main.jsx` の**一番外側**で行っています。
React の `useEffect` に移すと、effect が走る時点で `load` はもう終わっているため、
リスナーが二度と呼ばれず**黙って登録されなくなります**。
`src/pwa.js` の `readyState` の分岐を消さないでください。

新しい版は**押されるまで切り替わりません**（`sw.js` は `install` で `skipWaiting` しない）。
服の登録や AI との相談の途中で画面が入れ替わると、打ちかけの入力が消えるためです。

---

## 制限

- **1つの端末の中だけ**で完結します。端末をまたいだ同期はありません。
  機種を変えるときは設定画面の書き出し・読み込みを使ってください
- iOS Safari は使っていない状態が7日続くと `localStorage` を消すことがあります（ITP）。
  ホーム画面に追加しておくと消えにくくなります。
  服の写真そのものは IndexedDB にあるため対象外ですが、
  大事な記録は書き出しておくのが安全です
- Gemini API の呼び出し回数・速度は Google 側の制限に従います

---

## ライセンス

MIT License / Copyright (c) 2026 GIGAyama
</content>
</invoke>
