/* ==================================================================
   sw.js —— Service Worker：离线可用 + 能可靠更新到新版本
   ------------------------------------------------------------------
   策略（重要）：
     · 应用外壳（html/js/css/manifest）：**网络优先**，拿不到才用缓存
       —— 这样每次联网打开都是最新代码，不会卡在旧版本上
     · 其它资源（公式字体、图标、第三方库）：缓存优先，快且省流量
     · /api/ 和 /files/ 永远走网络，不缓存（那是电脑版的数据接口）
   ================================================================== */
var VERSION = 'cardnote-v13';

var SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'render.js',
  'store-local.js',
  'sync-gitee.js',
  'print.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'lib/marked.min.js',
  'lib/katex.min.js',
  'lib/katex.min.css',
  'lib/auto-render.min.js',
  'lib/highlight.min.js',
  'lib/hljs-github.css'
];

/** 判断是不是"应用外壳"（这些必须优先从网络取，否则会一直用旧版） */
function isShell(url) {
  var p = url.pathname;
  if (/\/$/.test(p)) return true;                       // 目录首页
  return /(index\.html|app\.js|render\.js|store-local\.js|sync-gitee\.js|style\.css|sw\.js|manifest\.webmanifest)$/.test(p);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) {
        return Promise.all(SHELL.map(function (u) {
          return c.add(new Request(u, { cache: 'reload' })).catch(function () { /* 个别文件缺失不影响安装 */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })    // 立刻接管，不等旧页面关闭
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VERSION; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })  // 立刻接管现有页面
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') >= 0 || url.pathname.indexOf('/files/') >= 0) return;

  if (isShell(url)) {
    // 网络优先：保证联网时永远是最新代码；断网时回落到缓存。
    // ⚠ `cache:'no-store'` 是必须的（2026-10-11 补）：GitHub Pages 的 HTML/JS/CSS 带
    //   `Cache-Control: max-age=600`，不绕开浏览器 HTTP 缓存的话，即使"网络优先"
    //   也会把 10 分钟内的旧文件当成"网络拿到的新内容"返回 —— 表现就是
    //   "电脑上网页明明更新了，手机重装图标也还是旧的、版本号不变"。
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
    );
    return;
  }

  // 其它资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
