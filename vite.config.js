import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// ⚠️ 入口の HTML はここに並べたものだけが dist/ に出る。
//    privacy.html と terms.html を書き落とすと、置いてあるのに配信物へ入らず、
//    公開先（https://digitalcloset.giga-school.com/privacy.html）で 404 になる。
//    アプリ本体からリンクされていないので、消えても画面では気づけない。
//    ページを増やしたら、必ずここにも足すこと。
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
        terms: fileURLToPath(new URL('./terms.html', import.meta.url)),
      },
    },
  },
})
