# 👗 デジタルワードローブ (Digital Wardrobe)

**「デジタルワードローブ」** は、単なる服の管理ツールを超え、あなたの生活様式や価値観をアップデートする「究極のAIコンシェルジュ」を搭載した次世代のクローゼット管理SPA（Single Page Application）です。

## ✨ 主な革新機能 (Revolutionary Features)

### 🤖 3つのAIスタイリスト機能 (Powered by Gemini 2.5 Flash)

*   **💬 AIコーデ相談:** 手持ちのアイテムを基準に、AIがその日の気分や天候に合わせた最適なコーディネートを提案します。
    
*   **🛑 買わないストッパー:** お店で迷っている服の写真を撮ると、AIがあなたのクローゼットを分析し、「手持ちの服と被っている」「着回しにくい」など客観的かつ辛口に判定。無駄遣いや衝動買いを防ぎます。
    
*   **🔍 逆引きコーデ:** 街やSNSで見かけた素敵なスナップ写真をアップロードすると、**手持ちの服だけを使ってその雰囲気を再現**できる組み合わせをAIが導き出します。
    

### 📊 資産価値と循環の可視化 (Dashboard & Stats)

*   **CPW（Cost Per Wear）トラッキング:** アイテムごとに「1回あたりの着用コスト」を自動計算。高価なコートも着るたびにCPWが下がるため、服を長く大切に着るモチベーションを高めます。
    
*   **投資総額・カテゴリ分析:** アクティブな服、廃棄済みの服の総額や、着用回数トップ5をカテゴリ別に可視化します。
    

### ⚡ 快適で堅牢なローカルファースト設計

*   **IndexedDBによる完全ローカル保存:** 画像やログなどの全データはブラウザ内に保存されます。サーバー通信を待つストレスがなく、オフラインでも超高速に動作します。
    
*   **スマホ最適化UI:** アプリのようなボトムナビゲーション、画像のスケルトンロード、数値入力キーボードの最適化など、ネイティブアプリに匹敵する滑らかなUXを実現しています。
    

## 🛠️ 技術スタック (Tech Stack)

*   **Frontend:** React (Hooks, functional components)
    
*   **Styling:** Tailwind CSS
    
*   **Icons:** `lucide-react`
    
*   **Database:** IndexedDB (Local-First Architecture)
    
*   **AI Integration:** Google Generative AI (Gemini 2.5 Flash)
    
*   **Image Processing:** HTML5 Canvas API (Client-side automatic resizing & compression)
    

## 🚀 ローカルでの動かし方 (Getting Started)

このプロジェクトは Vite + React の環境で簡単に動かすことができます。

### 1. プロジェクトのセットアップ

```
# Viteを使ってReactプロジェクトを作成
npm create vite@latest digital-wardrobe -- --template react

# ディレクトリに移動
cd digital-wardrobe

# 依存関係のインストール
npm install
npm install lucide-react
npm install -D tailwindcss postcss autoprefixer

# Tailwind CSSの初期化
npx tailwindcss init -p
```

### 2. Tailwind CSS の設定

`tailwind.config.js` を開き、以下の内容に書き換えます。

```
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

`src/index.css` の先頭に以下を追加します。

```
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### 3. アプリケーションコードの配置

このリポジトリの `App.jsx` を、プロジェクトの `src/App.jsx` に上書き保存します。

### 4. 起動

```
npm run dev
```

ブラウザで `http://localhost:5173` にアクセスするとアプリが起動します。

## 💡 使い方 (How to Use)

1.  **APIキーの登録**: 初回起動時、右下の「設定」タブからご自身の [Google AI Studio](https://aistudio.google.com/app/apikey "null") で取得した Gemini APIキー を登録してください。
    
2.  **カテゴリと色のカスタマイズ**: 同じく「設定」タブから、自分の持っている服の系統に合わせてカテゴリ名や色名を自由に変更できます。
    
3.  **服の登録**: 真ん中の「＋」ボタンから、服を撮影またはアップロードします。「AIで解析して保存」を押すと、背景で画像を圧縮し、Geminiが自動的に名前・色・カテゴリ・素材・お手入れ方法を抽出してデータベースに保存します（手動入力も可能です）。
    
4.  **カレンダーへの記録**: 着用した日は「カレンダー」タブから記録をつけることで、ダッシュボードのCPW（Cost Per Wear）や着用ランキングが自動更新されていきます。
    

## 📦 データのエクスポート/インポート

端末の変更やバックアップの際は、「設定」タブの「データ管理」から全てのデータをJSON形式でエクスポート・インポートすることが可能です。 複数の分割ファイル出力・読み込みにも対応しているため、高画質な画像を大量に保存していても安全に移行できます。

## 📄 License

This project is licensed under the MIT License.
