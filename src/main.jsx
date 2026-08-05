import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { registerServiceWorker } from './pwa.js'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// ⚠️ 登録は React の外側で行う（§3-6）。
//    useEffect の中に置くと、effect が走る時点で load はもう終わっているため
//    load リスナーが二度と呼ばれず、Service Worker が黙って登録されなくなる。
registerServiceWorker()
