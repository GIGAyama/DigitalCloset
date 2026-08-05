/*
 * インストールの合図を「いちばん先に」受け取るための小さな外部ファイル。
 *
 * Chrome は条件が揃うと即座に beforeinstallprompt を出す。
 * React のバンドル（250KB）を読んだあとに登録したのでは、通信の遅い端末で
 * 合図を取りこぼし、「インストール」ボタンが出なくなる。
 *
 * インラインの <script> にすると CSP の script-src 'self' で止まるため、
 * わざわざ外部ファイルにして <head> の先頭で同期読み込みしている。
 */
(function () {
  window.__pwaInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__pwaInstallPrompt = e;
    window.dispatchEvent(new Event('pwa-install-available'));
  });

  window.addEventListener('appinstalled', function () {
    window.__pwaInstallPrompt = null;
    window.dispatchEvent(new Event('pwa-installed'));
  });
})();
