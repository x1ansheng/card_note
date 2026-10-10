/* ==================================================================
   app.js —— 界面逻辑
   ================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var R = window.NoteRender;

  // 界面版本号：手机上用它确认是不是拿到了最新代码
  var APP_VERSION = '2026-10-10-2';

  var PALETTE = ['#4b8dff', '#f4a83b', '#8b7cf6', '#12b8a6', '#f2708c', '#2fb3e8', '#5cc98a', '#ee8455'];

  /* 卡片墙密度：每档对应 style.css 里的 .board.d-xxx（字号 / 行数 / 留白会一起变） */
  var DENSITY = [
    { key: 'xs', label: '紧凑' },
    { key: 's', label: '小' },
    { key: 'm', label: '中' },
    { key: 'l', label: '大' },
    { key: 'xl', label: '特大' },
    { key: 'full', label: '单列' }
  ];
  /* 阅读区大小：面板宽度 + 正文字号基准（A+/A- 的倍数再叠乘上去） */
  var RSIZES = [
    { key: 'rs-0', label: '舒适', fs: 16.4 },
    { key: 'rs-1', label: '宽', fs: 17.4 },
    { key: 'rs-2', label: '全屏', fs: 18.6 }
  ];

  /* ---------------- 主题（五种配色，侧栏底部切换，记住选择） ---------------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('cn.theme', t); } catch (e) { /* 隐私模式写不进就算了 */ }
    $$('#themeDots .tdot').forEach(function (b) { b.classList.toggle('on', b.dataset.theme === t); });
  }
  function currentTheme() {
    try { return localStorage.getItem('cn.theme') || 'qing'; } catch (e) { return 'qing'; }
  }

  function readInt(key, def, min, max) {
    var v = parseInt(localStorage.getItem(key), 10);
    return (isFinite(v) && v >= min && v <= max) ? v : def;
  }

  var state = {
    cards: [],
    categories: [],
    current: '__all__',
    sort: localStorage.getItem('cn.sort') || 'updated',
    view: localStorage.getItem('cn.view') || 'grid',
    density: readInt('cn.density', 2, 0, DENSITY.length - 1),
    readerSize: readInt('cn.readerSize', 0, 0, RSIZES.length - 1),
    query: '',
    hits: null,          // 搜索结果
    selected: {},        // 被勾选的卡片 id
    selectMode: false,
    loading: false,
    sig: '',
    booted: false,
    lastSync: ''
  };

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- 小工具 ---------------- */
  function catColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  /** 按类别在列表里的顺序分配颜色，保证相邻类别颜色差别明显 */
  function buildColorMap() {
    state.colorMap = {};
    state.categories.forEach(function (c, i) { state.colorMap[c.name] = PALETTE[i % PALETTE.length]; });
  }
  function colorOf(name) {
    return (state.colorMap && state.colorMap[name]) || catColor(name || '未分类');
  }

  function parseTime(s) {
    if (!s) return null;
    var m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) { var d = new Date(s); return isNaN(d) ? null : d; }
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }

  function relTime(s) {
    var d = parseTime(s);
    if (!d) return s || '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < -60) return fmtDate(d);
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 2) return '昨天';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    if (diff < 86400 * 365) return Math.floor(diff / 86400 / 30) + ' 个月前';
    return fmtDate(d);
  }
  function fmtDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDateTime(d) {
    return fmtDate(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function toast(msg, kind) {
    var wrap = $('#toastWrap');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { el.remove(); }, 260);
    }, kind === 'err' ? 3600 : 2200);
  }

  function svgIcon(id) { return '<svg><use href="#' + id + '"/></svg>'; }

  /* ---------------- API ---------------- */
  // 两种运行模式：
  //   api   —— 电脑上跑着 Node 服务，数据是硬盘上的真实 .md 文件（原样不变）
  //   local —— 手机/Pad/纯网页，没有服务，数据存在浏览器本地，靠同步与云端对齐
  var MODE = { local: false };

  function detectMode() {
    // 调试/演示用：网址后加 ?local=1 可以强制走本地存储模式
    if (/[?&]local=1/.test(location.search)) { MODE.local = true; return Promise.resolve(); }
    if (location.protocol === 'file:') { MODE.local = true; return Promise.resolve(); }
    return fetch('/api/ping', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { MODE.local = !(j && j.ok); })
      .catch(function () { MODE.local = true; });
  }

  function api(path, opts) {
    opts = opts || {};
    // 任何"写操作"成功后，都安排一次延迟自动推送（改完 20 秒推到云端）
    var mutating = (opts.method || 'GET') === 'POST' && /^\/api\/(card|category|import)/.test(path);
    var done = function (j) {
      if (mutating) scheduleAutoSync();
      return j;
    };
    if (MODE.local && window.LocalAPI) {
      return Promise.resolve()
        .then(function () { return window.LocalAPI.handle(path, opts); })
        .then(done)
        .catch(function (e) { throw new Error(e && e.message ? e.message : String(e)); });
    }
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
        return j;
      });
    }).then(done);
  }

  /* ---------------- 加载 & 渲染 ---------------- */
  function load(silent) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    return api('/api/state').then(function (d) {
      var cards = d.cards || [];
      var sig = cards.map(function (c) { return c.id + ':' + c.updated + ':' + c.title + ':' + c.cat; }).join('|');
      var changed = sig !== state.sig;
      state.cards = cards;
      state.categories = d.categories || [];
      buildColorMap();
      // 注意：这里要的是"云端同步时间"，不是"刚刚刷新数据的时间"。
      // 电脑版由服务返回真实同步时间；手机版读本地记录的。
      state.lastSync = MODE.local ? (localStorage.getItem('cn.lastSync') || '') : (d.lastSync || '');
      state.sig = sig;
      state.loading = false;
      $('#brandSub').textContent = (MODE.local ? '本地存储 · ' : '文件夹 · ') +
        state.cards.length + ' 张 · ' + state.categories.length + ' 类';
      if (silent && !changed) {
        $('#toolsRight').innerHTML = state.lastSync ? ('云端同步 ' + state.lastSync.slice(11)) : '尚未同步';
        return;
      }
      renderSidebar();
      renderBoard();
      if (!state.booted) { state.booted = true; openFromHash(); }
    }).catch(function (e) {
      state.loading = false;
      $('#brandSub').textContent = '连接断开';
      boardMessage('无法连接到本地服务', '请确认后台的黑色命令行窗口还开着。如果已经关掉，双击「启动卡片笔记.bat」重新打开。');
    });
  }

  function currentCards() {
    if (state.hits) {
      var map = {};
      state.cards.forEach(function (c) { map[c.id] = c; });
      return state.hits.map(function (h) {
        var c = map[h.id] || { id: h.id, title: h.title, cat: h.cat, tags: [], updated: '' };
        return Object.assign({}, c, { _snippet: h.snippet, _count: h.count });
      });
    }
    var list = state.current === '__all__' ? state.cards.slice()
      : state.cards.filter(function (c) { return c.cat === state.current; });
    return sortCards(list);
  }

  function sortCards(list) {
    var s = state.sort;
    return list.slice().sort(function (a, b) {
      if (s === 'pinned') {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return a.updated < b.updated ? 1 : -1;
      }
      if (s === 'title') return String(a.title).localeCompare(String(b.title), 'zh');
      if (s === 'created') return (a.created || '') < (b.created || '') ? 1 : -1;
      return (a.updated || '') < (b.updated || '') ? 1 : -1;
    });
  }

  function renderSidebar() {
    var list = $('#catList');
    var frag = document.createDocumentFragment();

    var allCount = state.cards.length;
    var mk = function (name, count, color) {
      var b = document.createElement('button');
      b.className = 'cat-item' + (state.current === name ? ' on' : '');
      b.dataset.cat = name;
      b.innerHTML =
        (color ? '<span class="cat-dot" style="background:' + color + '"></span>'
               : '<span class="cat-dot" style="background:linear-gradient(135deg,#3ad2bd,#12b8a6)"></span>') +
        '<span class="cat-name"></span>' +
        '<span class="cat-count">' + count + '</span>' +
        (name === '__all__' ? '' : '<span class="cat-more" data-more="' + name + '" title="重命名 / 删除">' + svgIcon('i-menu') + '</span>');
      b.querySelector('.cat-name').textContent = name === '__all__' ? '全部卡片' : name;
      b.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-more]')) { openCatMenu(ev.target.closest('[data-more]'), name); return; }
        state.current = name;
        state.query = '';
        $('#searchInput').value = '';
        $('#btnClearSearch').hidden = true;
        clearSearch();
        clearSelection();
        renderSidebar();
        renderBoard();
        $('#board').scrollTop = 0;
      });
      if (name !== '__all__') {
        b.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          openCatMenu(b, name);
        });
      }
      return b;
    };

    frag.appendChild(mk('__all__', allCount, null));
    state.categories.forEach(function (c) { frag.appendChild(mk(c.name, c.count, colorOf(c.name))); });
    list.innerHTML = '';
    list.appendChild(frag);
  }

  function openCatMenu(anchor, name) {
    closeCatMenu();
    var r = anchor.getBoundingClientRect();
    var menu = document.createElement('div');
    menu.className = 'popmenu';
    menu.innerHTML =
      '<button data-act="rename">' + svgIcon('i-edit') + '<span>重命名类别</span></button>' +
      '<button data-act="new">' + svgIcon('i-plus') + '<span>在此类别新建卡片</span></button>' +
      '<button data-act="delete" class="danger">' + svgIcon('i-trash') + '<span>删除类别</span></button>';
    document.body.appendChild(menu);
    menu.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(r.bottom + 6, window.innerHeight - 160) + 'px';
    menu.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn) return;
      var act = btn.dataset.act;
      closeCatMenu();
      if (act === 'rename') renameCategory(name);
      if (act === 'new') openEditor(null, name);
      if (act === 'delete') deleteCategory(name);
    });
    setTimeout(function () { document.addEventListener('click', closeCatMenu, { once: true }); }, 0);
  }
  function closeCatMenu() {
    var m = $('.popmenu');
    if (m) m.remove();
  }

  /* ---------------- 手机端的抽屉侧栏 ----------------
     body 上挂 side-open 是为了两件事：
       1. 让遮罩淡入（CSS 里 body.side-open .side-backdrop）
       2. 抽屉打开时锁住底层页面滚动，手指在遮罩上乱划不会把卡片墙带动   */
  function openSide() {
    $('#sidebar').classList.add('open');
    document.body.classList.add('side-open', 'locked');
  }
  function closeSide() {
    var el = $('#sidebar');
    if (!el || !el.classList.contains('open')) return;
    el.classList.remove('open');
    document.body.classList.remove('side-open');
    // locked 是共用的：只有阅读页/编辑弹窗/设置弹窗都没开时才解开
    var busy = ed.open || !$('#reader').hidden || !$('#settings').hidden || !$('#modal').hidden;
    if (!busy) document.body.classList.remove('locked');
  }

  function boardMessage(title, sub, btnText, btnFn) {
    var board = $('#board');
    board.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = emptyArt() + '<h3></h3><p></p>';
    el.querySelector('h3').textContent = title;
    el.querySelector('p').textContent = sub || '';
    if (btnText) {
      var b = document.createElement('button');
      b.className = 'primary-btn';
      b.innerHTML = svgIcon('i-plus') + '<span></span>';
      b.querySelector('span').textContent = btnText;
      b.addEventListener('click', btnFn);
      el.appendChild(b);
    }
    board.appendChild(el);
  }

  function emptyArt() {
    return '<svg class="empty-art" viewBox="0 0 120 120" fill="none">' +
      '<rect x="18" y="26" width="66" height="80" rx="10" fill="#eef6f8"/>' +
      '<rect x="28" y="18" width="66" height="80" rx="10" fill="#ffffff" stroke="#e2eef2" stroke-width="2"/>' +
      '<circle cx="44" cy="40" r="6" fill="#bfe9e2"/>' +
      '<rect x="56" y="36" width="26" height="5" rx="2.5" fill="#dbe9ee"/>' +
      '<rect x="40" y="56" width="42" height="5" rx="2.5" fill="#e8f1f5"/>' +
      '<rect x="40" y="69" width="34" height="5" rx="2.5" fill="#e8f1f5"/>' +
      '<rect x="40" y="82" width="24" height="5" rx="2.5" fill="#e8f1f5"/>' +
      '<circle cx="96" cy="86" r="15" fill="#12b8a6"/>' +
      '<path d="M96 79v14M89 86h14" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>' +
      '</svg>';
  }

  /* ---------------- 卡片大小（密度） ---------------- */
  function applyDensity() {
    var board = $('#board');
    var d = DENSITY[state.density];
    DENSITY.forEach(function (x) { board.classList.remove('d-' + x.key); });
    board.classList.add('d-' + d.key);
    var label = $('#densLabel');
    if (label) label.textContent = d.label;
    var minus = $('#densMinus'), plus = $('#densPlus');
    if (minus) minus.disabled = state.density === 0;
    if (plus) plus.disabled = state.density === DENSITY.length - 1;
    var wrap = $('#densityWrap');
    if (wrap) wrap.hidden = state.view === 'list';   // 列表视图下没有"卡片大小"可言
    localStorage.setItem('cn.density', String(state.density));
  }

  function stepDensity(delta) {
    var next = Math.min(DENSITY.length - 1, Math.max(0, state.density + delta));
    if (next === state.density) return;
    state.density = next;
    applyDensity();
  }

  function renderBoard() {
    var board = $('#board');
    board.className = 'board ' + (state.view === 'list' ? 'list' : 'grid');
    applyDensity();

    var list = currentCards();
    var title = state.current === '__all__' ? '全部卡片' : state.current;

    if (state.hits) {
      $('#boardTitle').textContent = '搜索：' + state.query;
      $('#boardSub').textContent = '找到 ' + state.hits.length + ' 张相关卡片';
      $('#toolsRight').innerHTML = '按相关度排序 · 清空搜索可返回';
      $('#boardCount').textContent = state.hits.length + ' 张';
    } else {
      $('#boardTitle').textContent = title;
      var sub = list.length + ' 张卡片';
      if (state.current !== '__all__') {
        var cat = state.categories.filter(function (c) { return c.name === state.current; })[0];
        if (cat) sub = cat.count + ' 张卡片 · 文件夹：笔记/' + state.current + '/';
      }
      $('#boardSub').textContent = sub;
      $('#toolsRight').innerHTML = state.lastSync ? ('云端同步 ' + state.lastSync.slice(11)) : '尚未同步';
      // 手机上顶栏副标题被隐藏，卡片数量放到工具条里显示
      $('#boardCount').textContent = list.length + ' 张';
    }

    board.innerHTML = '';
    if (!list.length) {
      if (state.hits) boardMessage('没有找到匹配的内容', '换个关键词试试，或者清空搜索框。');
      else if (state.current === '__all__') {
        boardMessage('还没有任何卡片', '点击「新建卡片」写下第一张，它会自动保存成 笔记/类别/标题.md 文件。', '新建第一张卡片', function () { openEditor(null, ''); });
      } else {
        boardMessage('这个类别还是空的', '在这个类别下写第一张卡片吧。', '新建卡片', function () { openEditor(null, state.current); });
      }
      return;
    }

    var frag = document.createDocumentFragment();
    list.forEach(function (card, i) {
      var el = document.createElement('article');
      el.className = 'card';
      el.dataset.id = card.id;
      el.style.setProperty('--cat-color', colorOf(card.cat || '未分类'));
      el.style.animationDelay = Math.min(i * 26, 340) + 'ms';

      var tags = (card.tags || []).slice(0, 3).map(function (t) {
        return '<span class="tag">' + R.escapeHtml(t) + '</span>';
      }).join('');

      var main = document.createElement('div');
      main.className = 'card-main';
      main.innerHTML =
        '<div class="card-top">' +
          '<span class="card-cat"></span>' +
          (card.pinned ? '<span class="card-pin" title="已置顶">' + svgIcon('i-star') + '</span>' : '') +
          '<span class="card-date"></span>' +
        '</div>' +
        '<h3 class="card-title"></h3>' +
        '<p class="card-sum"></p>';
      main.querySelector('.card-cat').textContent = card.cat || '未分类';
      main.querySelector('.card-date').textContent = relTime(card.updated);
      main.querySelector('.card-title').textContent = card.title;
      var sumEl = main.querySelector('.card-sum');
      if (card._snippet) {
        sumEl.textContent = card._snippet;
        // 列表视图平时只显示标题，搜索命中时把这段正文显示出来
        el.classList.add('has-snippet');
      } else {
        sumEl.textContent = card.summary || '（还没有内容）';
      }

      var foot = document.createElement('div');
      foot.className = 'card-foot';
      foot.innerHTML = '<div class="tags">' + tags + '</div>' +
        '<span class="card-open">展开' + svgIcon('i-chev') + '</span>';

      // 右上角「⋯」：编辑 / 移动 / 复制 / 置顶 / 删除
      var more = document.createElement('button');
      more.className = 'card-more';
      more.title = '更多操作（也可以右键卡片）';
      more.innerHTML = svgIcon('i-dots');
      more.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openCardMenu(more, card);
      });

      var badge = document.createElement('span');
      badge.className = 'sel-badge';
      badge.innerHTML = svgIcon('i-check');

      if (state.selected[card.id]) el.classList.add('selected');
      el.appendChild(main);
      el.appendChild(foot);
      el.appendChild(more);
      el.appendChild(badge);
      el.addEventListener('click', function (ev) {
        if (ev.target.closest('.card-more')) return;
        if (state.selectMode || ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          toggleSelect(card.id, el);
          return;
        }
        openCard(card, el);
      });
      el.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        openCardMenu(el, card);
      });
      frag.appendChild(el);
    });
    board.appendChild(frag);
    updateSelBar();
  }

  /* ---------------- 勾选 / 移动 / 复制 ---------------- */
  var MENU_ICON = { open: 'i-chev' };

  function selectedIds() { return Object.keys(state.selected); }

  function toggleSelect(id, el) {
    if (state.selected[id]) delete state.selected[id];
    else state.selected[id] = true;
    if (el) el.classList.toggle('selected', !!state.selected[id]);
    updateSelBar();
  }

  function updateSelBar() {
    var n = selectedIds().length;
    var bar = $('#selbar');
    if (!bar) return;
    bar.hidden = n === 0;
    $('#selCount').textContent = '已选 ' + n + ' 张';
    var total = currentCards().length;
    $('#selAll').textContent = (n > 0 && n >= total) ? '取消全选' : '全选';
  }

  function clearSelection() {
    state.selected = {};
    state.selectMode = false;
    var btn = $('#btnSelectMode');
    if (btn) btn.classList.remove('on');
    $$('.card.selected').forEach(function (c) { c.classList.remove('selected'); });
    updateSelBar();
  }

  function positionMenu(menu, r, width) {
    var w = width || 210;
    var h = menu.offsetHeight || 250;
    var left = Math.max(10, Math.min(r.left, window.innerWidth - w - 12));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(10, r.top - h - 6);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }

  function openCardMenu(anchor, card) {
    closeCatMenu();
    var ids = state.selected[card.id] ? selectedIds() : [card.id];
    var menu = document.createElement('div');
    menu.className = 'popmenu';
    var multi = ids.length > 1;
    menu.innerHTML =
      '<button data-act="open">' + svgIcon(MENU_ICON.open) + '<span>打开阅读</span></button>' +
      '<button data-act="edit">' + svgIcon('i-edit') + '<span>编辑</span></button>' +
      '<button data-act="move">' + svgIcon('i-move') + '<span>' + (multi ? '把选中的 ' + ids.length + ' 张移到…' : '移动到其他类别…') + '</span></button>' +
      '<button data-act="copy">' + svgIcon('i-copy') + '<span>' + (multi ? '把选中的 ' + ids.length + ' 张复制到…' : '复制到其他类别…') + '</span></button>' +
      '<button data-act="pin">' + svgIcon('i-star') + '<span>' + (card.pinned ? '取消置顶' : '置顶') + '</span></button>' +
      '<button data-act="delete" class="danger">' + svgIcon('i-trash') + '<span>' + (multi ? '删除选中的 ' + ids.length + ' 张' : '删除（进回收站）') + '</span></button>';
    document.body.appendChild(menu);
    positionMenu(menu, anchor.getBoundingClientRect());
    menu.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn) return;
      var act = btn.dataset.act;
      closeCatMenu();
      if (act === 'open') openCard(card, $('.card[data-id="' + cssEsc(card.id) + '"]'));
      if (act === 'edit') openCardThenEdit(card);
      if (act === 'move') moveOrCopy(ids, 'move');
      if (act === 'copy') moveOrCopy(ids, 'copy');
      if (act === 'pin') togglePin(card);
      if (act === 'delete') { if (multi) deleteSelected(); else deleteCard(card.id, card.title); }
    });
    setTimeout(function () {
      document.addEventListener('click', closeCatMenu, { once: true });
      document.addEventListener('contextmenu', closeCatMenu, { once: true });
    }, 0);
  }

  function openCardThenEdit(card) {
    api('/api/card?id=' + encodeURIComponent(card.id)).then(function (d) {
      openEditor(d);
    }).catch(function (e) { toast('打不开：' + e.message, 'err'); });
  }

  function togglePin(card) {
    api('/api/card/update', { method: 'POST', body: { id: card.id, pinned: !card.pinned } }).then(function () {
      toast(card.pinned ? '已取消置顶' : '已置顶', 'ok');
      load(true);
    }).catch(function (e) { toast('操作失败：' + e.message, 'err'); });
  }

  /* ---------------- 选择目标类别 ---------------- */
  var pickerResolve = null;

  function pickCategory(title, sub) {
    return new Promise(function (resolve) {
      pickerResolve = resolve;
      $('#pickerTitle').textContent = title;
      $('#pickerSub').textContent = sub || '';
      var list = $('#pickerList');
      list.innerHTML = '';
      var frag = document.createDocumentFragment();
      state.categories.forEach(function (c) {
        var b = document.createElement('button');
        b.className = 'picker-item';
        b.innerHTML = '<span class="cat-dot" style="background:' + colorOf(c.name) + '"></span>' +
          '<span class="cat-name"></span><span class="cat-count">' + c.count + ' 张</span>';
        b.querySelector('.cat-name').textContent = c.name;
        b.addEventListener('click', function () { closePicker(c.name); });
        frag.appendChild(b);
      });
      list.appendChild(frag);
      if (!state.categories.length) {
        list.innerHTML = '<p class="picker-empty">还没有任何类别，在下面输入一个名字就会自动新建</p>';
      }
      $('#pickerNew').value = '';
      var el = $('#picker');
      el.hidden = false;
      requestAnimationFrame(function () { el.classList.add('open'); });
      setTimeout(function () { $('#pickerNew').focus(); }, 140);
    });
  }

  function closePicker(value) {
    var el = $('#picker');
    if (!el || el.hidden) return;
    el.classList.remove('open');
    setTimeout(function () { el.hidden = true; }, 190);
    var r = pickerResolve;
    pickerResolve = null;
    if (r) r(value === undefined ? null : value);
  }

  function moveOrCopy(ids, mode) {
    if (!ids || !ids.length) return;
    var isMove = mode === 'move';
    pickCategory(
      (isMove ? '移动' : '复制') + ' ' + ids.length + ' 张卡片到…',
      isMove ? '原类别里就不再有这些卡片了（文件会被搬走）'
             : '原类别里的卡片保留，目标类别里多出一份副本'
    ).then(function (cat) {
      if (!cat) return;
      return api('/api/card/' + mode, { method: 'POST', body: { ids: ids, to: cat } }).then(function (r) {
        var msg = (isMove ? '已移动 ' : '已复制 ') + r.ok + ' 张卡片到「' + r.category + '」';
        if (r.failed && r.failed.length) msg += '，' + r.failed.length + ' 张失败';
        toast(msg, (r.failed && r.failed.length) ? 'err' : 'ok');
        clearSelection();
        load(true);
      });
    }).catch(function (e) { toast('操作失败：' + e.message, 'err'); });
  }

  function deleteSelected() {
    var ids = selectedIds();
    if (!ids.length) return;
    if (!confirm('把选中的 ' + ids.length + ' 张卡片移入回收站？\n（文件会移动到 电子笔记/_回收站/，随时可以找回来）')) return;
    var chain = Promise.resolve();
    ids.forEach(function (id) {
      chain = chain.then(function () {
        return api('/api/card/delete', { method: 'POST', body: { id: id } }).catch(function () { /* 单张失败不打断 */ });
      });
    });
    chain.then(function () {
      toast('已把 ' + ids.length + ' 张卡片移入回收站', 'ok');
      clearSelection();
      load(true);
    });
  }

  /* ---------------- 搜索 ---------------- */
  var searchTimer = null;
  function onSearchInput() {
    var v = $('#searchInput').value.trim();
    $('#btnClearSearch').hidden = !v;
    clearTimeout(searchTimer);
    if (!v) { clearSearch(); renderBoard(); return; }
    searchTimer = setTimeout(function () {
      state.query = v;
      api('/api/search?q=' + encodeURIComponent(v)).then(function (d) {
        state.hits = d.hits || [];
        renderBoard();
      }).catch(function (e) { toast(e.message, 'err'); });
    }, 220);
  }
  function clearSearch() {
    state.hits = null;
    state.query = '';
  }

  /* ---------------- 阅读浮层 ---------------- */
  var reader = {
    el: null, panel: null, scroll: null, body: null,
    card: null, fontSize: parseFloat(localStorage.getItem('cn.fs') || '1')
  };

  function openCard(meta, originEl) {
    api('/api/card?id=' + encodeURIComponent(meta.id)).then(function (d) {
      try { history.replaceState(null, '', '#card=' + encodeURIComponent(meta.id)); } catch (e) { /* */ }
      showReader(d, originEl);
    }).catch(function (e) { toast('打不开这张卡片：' + e.message, 'err'); });
  }

  /** 支持用 .../#card=类别/标题.md 直接打开某张卡片（收藏夹、分享都用得上） */
  function openFromHash() {
    if (/^#new$/i.test(location.hash || '')) { openEditor(null, state.current === '__all__' ? '' : state.current); return true; }
    var m = /card=([^&]+)/.exec(location.hash || '');
    if (!m) return false;
    var id = decodeURIComponent(m[1]);
    var meta = state.cards.filter(function (c) { return c.id === id; })[0];
    if (!meta) { toast('没找到卡片：' + id, 'err'); return false; }
    openCard(meta, $('.card[data-id="' + cssEsc(id) + '"]'));
    return true;
  }

  function showReader(card, originEl) {
    reader.card = card;
    var el = reader.el || (reader.el = $('#reader'));
    reader.panel = reader.panel || $('#readerPanel');
    reader.scroll = reader.scroll || $('#readerScroll');
    reader.body = reader.body || $('#readerBody');
    var panel = reader.panel;

    $('#readerCat').textContent = card.cat || '未分类';
    $('#readerTitle').textContent = card.title;
    reader.scroll.scrollTop = 0;

    var w = R.countWords(card.content);
    var mins = Math.max(1, Math.round(w.total / 380));
    var metaHtml = [];
    metaHtml.push('<span>' + R.escapeHtml(card.cat || '未分类') + '</span>');
    metaHtml.push('<span class="dot"></span>');
    metaHtml.push('<span>创建于 ' + R.escapeHtml(card.created || card.mtime || '') + '</span>');
    metaHtml.push('<span class="dot"></span>');
    metaHtml.push('<span>最后修改 ' + R.escapeHtml(card.updated || '') + '</span>');
    metaHtml.push('<span class="dot"></span>');
    metaHtml.push('<span>' + w.total + ' 字 · 约 ' + mins + ' 分钟读完</span>');
    (card.tags || []).forEach(function (t) {
      metaHtml.push('<span class="tag">' + R.escapeHtml(t) + '</span>');
    });
    $('#readerMeta').innerHTML = metaHtml.join('');

    R.renderMarkdown(card.content, reader.body, { basePath: card.cat, collapsible: true });
    resolveLocalImages(reader.body);
    applyReaderSize();

    $('#readerFoot').innerHTML =
      '<button class="ghost-btn" data-act="edit">' + svgIcon('i-edit') + '<span>编辑</span></button>' +
      '<button class="ghost-btn" data-act="move">' + svgIcon('i-move') + '<span>移动到…</span></button>' +
      '<button class="ghost-btn" data-act="copy2">' + svgIcon('i-copy') + '<span>复制到…</span></button>' +
      '<button class="ghost-btn" data-act="reveal">' + svgIcon('i-folder') + '<span>文件夹</span></button>' +
      '<button class="ghost-btn" data-act="print"><span>打印 / 存 PDF</span></button>' +
      '<button class="ghost-btn" data-act="copy"><span>复制正文</span></button>' +
      '<button class="ghost-btn danger" data-act="delete" style="margin-left:auto">' + svgIcon('i-trash') + '<span>删除</span></button>';

    // 打开
    el.hidden = false;
    document.body.classList.add('locked');
    var target = panel.getBoundingClientRect();
    var from = originEl ? originEl.getBoundingClientRect() : null;

    if (from && !reduced) {
      panel.classList.add('flying');
      panel.style.transition = 'none';
      panel.style.transformOrigin = 'top left';
      panel.style.transform = 'translate(' + (from.left - target.left) + 'px,' + (from.top - target.top) + 'px) scale(' +
        Math.max(0.04, from.width / target.width) + ',' + Math.max(0.04, from.height / target.height) + ')';
      panel.style.opacity = '0.25';
      el.classList.add('open');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          panel.style.transition = 'transform .46s cubic-bezier(.16,1,.3,1), opacity .34s ease';
          panel.style.transform = 'none';
          panel.style.opacity = '1';
          setTimeout(function () { panel.classList.remove('flying'); }, 300);
          setTimeout(function () { clearInline(panel); }, 520);
        });
      });
    } else {
      panel.style.transform = '';
      panel.style.opacity = '';
      el.classList.add('open');
    }
  }

  function clearInline(panel) {
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.transformOrigin = '';
    panel.style.opacity = '';
  }

  function closeReader() {
    var el = reader.el;
    if (!el || el.hidden) return;
    var panel = reader.panel;
    var origin = reader.card ? $('.card[data-id="' + cssEsc(reader.card.id) + '"]') : null;
    var target = panel.getBoundingClientRect();

    if (origin && !reduced) {
      var r = origin.getBoundingClientRect();
      panel.classList.add('flying');
      panel.style.transformOrigin = 'top left';
      panel.style.transition = 'transform .38s cubic-bezier(.4,0,.2,1), opacity .3s ease';
      panel.style.transform = 'translate(' + (r.left - target.left) + 'px,' + (r.top - target.top) + 'px) scale(' +
        Math.max(0.04, r.width / target.width) + ',' + Math.max(0.04, r.height / target.height) + ')';
      panel.style.opacity = '0.15';
    }
    el.classList.remove('open');
    document.body.classList.remove('locked');
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* */ }
    setTimeout(function () {
      el.hidden = true;
      clearInline(panel);
      panel.classList.remove('flying');
      reader.card = null;
    }, origin && !reduced ? 380 : 200);
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function applyFontSize() {
    var fs = Math.min(1.5, Math.max(0.8, reader.fontSize));
    reader.fontSize = fs;
    var base = RSIZES[state.readerSize].fs;   // 阅读区越大，正文字号基准也越大，行宽才不至于拉得太长
    if (reader.body) reader.body.style.setProperty('--fs', (base * fs).toFixed(2) + 'px');
    localStorage.setItem('cn.fs', String(fs));
  }

  /** 阅读区：舒适 / 宽 / 全屏 */
  function applyReaderSize() {
    var panel = $('#readerPanel');
    RSIZES.forEach(function (s) { panel.classList.remove(s.key); });
    panel.classList.add(RSIZES[state.readerSize].key);
    var btn = $('#btnReaderSize');
    if (btn) btn.querySelector('span').textContent = RSIZES[state.readerSize].label;
    localStorage.setItem('cn.readerSize', String(state.readerSize));
    applyFontSize();
  }

  function cycleReaderSize() {
    state.readerSize = (state.readerSize + 1) % RSIZES.length;
    applyReaderSize();
    toast('阅读区：' + RSIZES[state.readerSize].label, 'ok');
  }

  /* ---------------- 编辑弹窗 ---------------- */
  var ed = { open: false, id: null, preview: false };

  function openEditor(card, presetCat) {
    ed.open = true;
    ed.id = card ? card.id : null;
    $('#modalTitle').textContent = card ? '编辑卡片' : '新建卡片';
    $('#fTitle').value = card ? card.title : '';
    $('#fCat').value = card ? (card.cat || '') : (presetCat || (state.current !== '__all__' ? state.current : ''));
    $('#fTags').value = card ? (card.tags || []).join(', ') : '';
    $('#fPinned').checked = card ? !!card.pinned : false;
    $('#fBody').value = card ? card.content : '';

    var dl = $('#catOptions');
    dl.innerHTML = state.categories.map(function (c) { return '<option value="' + R.escapeHtml(c.name) + '">'; }).join('');

    if (!card) {
      var draft = localStorage.getItem('cn.draft');
      if (draft) {
        try {
          var d = JSON.parse(draft);
          if (d && (d.title || d.body)) {
            $('#fTitle').value = d.title || $('#fTitle').value;
            $('#fBody').value = d.body || '';
            $('#fTags').value = d.tags || '';
            $('#fCat').value = d.cat || $('#fCat').value;
            setTimeout(function () { toast('已恢复上次未保存的草稿'); }, 260);
          }
        } catch (e) { /* ignore */ }
      }
    }

    var m = $('#modal');
    m.hidden = false;
    requestAnimationFrame(function () { m.classList.add('open'); });
    document.body.classList.add('locked');
    setTimeout(function () { $('#fTitle').focus(); }, 120);
    if (ed.preview) updatePreview();
  }

  function closeEditor(force) {
    if (!ed.open) return;
    if (!force && !ed.id) saveDraft();
    ed.open = false;
    var m = $('#modal');
    m.classList.remove('open');
    document.body.classList.remove('locked');
    setTimeout(function () { m.hidden = true; }, 220);
  }

  function saveDraft() {
    var t = $('#fTitle').value, b = $('#fBody').value;
    if (!t && !b) { localStorage.removeItem('cn.draft'); return; }
    localStorage.setItem('cn.draft', JSON.stringify({
      title: t, body: b, tags: $('#fTags').value, cat: $('#fCat').value
    }));
  }

  function collect() {
    return {
      id: ed.id,
      title: $('#fTitle').value.trim(),
      category: $('#fCat').value.trim(),
      tags: $('#fTags').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean),
      content: $('#fBody').value,
      pinned: $('#fPinned').checked
    };
  }

  function saveCard() {
    var d = collect();
    if (!d.title) { toast('给卡片起个标题吧', 'err'); $('#fTitle').focus(); return; }
    if (!d.category) { toast('填写一个类别，例如「自动控制原理」', 'err'); $('#fCat').focus(); return; }
    if (!d.content.trim()) { toast('内容还是空的', 'err'); $('#fBody').focus(); return; }

    var btn = $('#btnSave');
    btn.disabled = true;
    var p = d.id ? api('/api/card/update', { method: 'POST', body: d })
                 : api('/api/card', { method: 'POST', body: d });
    p.then(function (res) {
      btn.disabled = false;
      localStorage.removeItem('cn.draft');
      var card = res.card;
      toast(d.id ? '已保存' : '卡片已创建', 'ok');
      ed.id = card.id;
      closeEditor(true);
      return load(true).then(function () {
        var el = $('.card[data-id="' + cssEsc(card.id) + '"]');
        showReader(card, el);
      });
    }).catch(function (e) {
      btn.disabled = false;
      toast('保存失败：' + e.message, 'err');
    });
  }

  function deleteCard(id, title) {
    if (!confirm('把「' + title + '」移入回收站？\n（文件会移动到 电子笔记/_回收站/，随时可以找回来）')) return;
    api('/api/card/delete', { method: 'POST', body: { id: id } }).then(function () {
      toast('已移入回收站', 'ok');
      closeReader();
      load(true);
    }).catch(function (e) { toast('删除失败：' + e.message, 'err'); });
  }

  function renameCategory(name) {
    var v = prompt('重命名类别「' + name + '」为：', name);
    if (!v || v === name) return;
    api('/api/category/rename', { method: 'POST', body: { from: name, to: v } }).then(function (r) {
      if (state.current === name) state.current = r.name;
      toast('已重命名', 'ok');
      load(true);
    }).catch(function (e) { toast('重命名失败：' + e.message, 'err'); });
  }

  function deleteCategory(name) {
    if (!confirm('删除类别「' + name + '」？\n整个文件夹会被移动到 电子笔记/_回收站/，不会真的丢失。')) return;
    api('/api/category/delete', { method: 'POST', body: { name: name } }).then(function () {
      if (state.current === name) state.current = '__all__';
      toast('类别已移入回收站', 'ok');
      load(true);
    }).catch(function (e) { toast('删除失败：' + e.message, 'err'); });
  }

  function newCategory() {
    var v = prompt('新建类别（就是笔记文件夹里的一个子文件夹）：\n例如：自动控制原理、信号与系统', '');
    if (!v) return;
    api('/api/category', { method: 'POST', body: { name: v } }).then(function (r) {
      toast('类别「' + r.name + '」已创建', 'ok');
      state.current = r.name;
      return load(true);
    }).catch(function (e) { toast('创建失败：' + e.message, 'err'); });
  }

  /* ---------------- 编辑器：插入语法 / 图片 ---------------- */
  /** 在光标处插入 Markdown 片段；片段里的 $1 表示「光标最终停在 / 选中文字填入」的位置 */
  function insertAtCursor(snippet) {
    var ta = $('#fBody');
    var s = ta.selectionStart, e = ta.selectionEnd, val = ta.value;
    var sel = val.slice(s, e);
    var marker = snippet.indexOf('$1');
    var out, caretOffset;
    if (marker >= 0) {
      out = snippet.replace('$1', sel);
      caretOffset = sel ? out.length : marker;
    } else {
      out = snippet;
      caretOffset = out.length;
    }
    ta.value = val.slice(0, s) + out + val.slice(e);
    ta.focus();
    ta.setSelectionRange(s + caretOffset, s + caretOffset);
    schedulePreview();
  }

  var MD_SNIPPETS = {
    h2: '\n## $1\n',
    bold: '**$1**',
    ul: '\n- 第一点\n- 第二点\n',
    todo: '\n- [ ] 还没弄懂的点\n- [x] 已经想通的点\n',
    quote: '\n> $1\n',
    inlineMath: '$$1$',
    blockMath: '\n$$\n$1\n$$\n',
    code: '\n```python\n$1\n```\n',
    table: '\n| 项目 | 说明 |\n| --- | --- |\n| $1 |  |\n'
  };

  function handlePasteImage(e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    files.forEach(uploadImage);
  }

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('读取失败')); };
      fr.readAsDataURL(file);
    });
  }

  function uploadImage(file) {
    toast('正在保存图片…');
    var url = '/api/upload?name=' + encodeURIComponent(file.name || 'paste.png');
    var p;
    if (MODE.local && window.LocalAPI) {
      p = fileToDataUrl(file).then(function (dataUrl) {
        return window.LocalAPI.handle(url, { method: 'POST', body: dataUrl });
      });
    } else {
      p = fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file
      }).then(function (r) { return r.json(); });
    }
    p.then(function (d) {
      if (d.error) throw new Error(d.error);
      var cat = $('#fCat').value.trim();
      var rel = (cat ? '../' : '') + '_附件/' + d.name;
      insertAtCursor('\n![图片](' + rel + ')\n');
      toast(MODE.local ? '图片已存入本地并插入正文' : '图片已存入 笔记/_附件/ 并插入正文', 'ok');
    }).catch(function (e) { toast('图片保存失败：' + e.message, 'err'); });
  }

  /** 本地模式下，正文里的图片路径要换成存在浏览器里的那张图 */
  function resolveLocalImages(root) {
    if (!MODE.local || !window.LocalAPI || !root) return;
    $$('img', root).forEach(function (img) {
      var src = img.getAttribute('src') || '';
      if (src.indexOf('/files/') !== 0) return;
      var name = decodeURIComponent(src.split('/').pop());
      window.LocalAPI.getBlob(name).then(function (b) {
        if (b && b.data) img.src = b.data;
      }).catch(function () { /* 图片没同步过来就先空着 */ });
    });
  }

  /* ---------------- 导入 .md 文件 ---------------- */
  /** 读文本文件：先按 UTF-8 解，出现乱码字符就改用 GBK（Windows 上中文 md 常是 GBK） */
  function decodeTextFile(file) {
    return file.arrayBuffer().then(function (buf) {
      var text = '';
      try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (e) { text = ''; }
      var bad = (text.match(/\uFFFD/g) || []).length;
      if (bad > 0) {
        try {
          var alt = new TextDecoder('gbk', { fatal: false }).decode(buf);
          if ((alt.match(/\uFFFD/g) || []).length < bad) text = alt;
        } catch (e) { /* 浏览器不支持 gbk 就维持原样 */ }
      }
      return text.replace(/^\uFEFF/, '');
    });
  }

  function isMarkdownFile(f) {
    return /\.(md|markdown|txt)$/i.test(f.name || '') || /^text\/(markdown|plain)$/.test(f.type || '');
  }

  /** 从拖拽事件里取文件：优先 files，取不到就退回 items（不同来源行为不一样） */
  function filesFromDataTransfer(dt) {
    if (!dt) return [];
    if (dt.files && dt.files.length) return Array.prototype.slice.call(dt.files);
    var out = [];
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file') {
          var f = it.getAsFile ? it.getAsFile() : null;
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  function postText(url, text) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: text
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('导入失败 ' + r.status));
        return j;
      });
    });
  }

  /** 单个文件 → 解析后填进编辑表单，让用户过一眼再保存 */
  var fillSeq = 0;
  function fillFromMd(file) {
    var seq = ++fillSeq;
    return decodeTextFile(file).then(function (text) {
      var url = '/api/parse?name=' + encodeURIComponent(file.name || '') +
        '&mtime=' + (file.lastModified || '');
      return postText(url, text);
    }).then(function (j) {
      if (seq !== fillSeq) return;   // 期间又导入了别的文件，丢弃这次结果，避免旧结果覆盖新结果
      $('#fTitle').value = j.title || '';
      $('#fTags').value = (j.tags || []).join(', ');
      $('#fPinned').checked = !!j.pinned;
      $('#fBody').value = j.content || '';
      if (!$('#fCat').value.trim() && state.current !== '__all__') $('#fCat').value = state.current;
      schedulePreview();
      toast('已解析，检查后点「保存卡片」', 'ok');
    });
  }

  /** 多个文件 → 直接批量建卡 */
  function importMdFiles(files, category) {
    var ok = 0, fail = 0;
    toast('正在导入 ' + files.length + ' 个文件…');
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return decodeTextFile(f).then(function (text) {
          var url = '/api/import?name=' + encodeURIComponent(f.name || '') +
            '&category=' + encodeURIComponent(category || '未分类') +
            '&mtime=' + (f.lastModified || '');
          return postText(url, text);
        }).then(function () { ok++; })
          .catch(function (e) { fail++; console.error('导入失败:', f.name, e); });
      });
    });
    return chain.then(function () {
      return load(true);
    }).then(function () {
      if (ok && !fail) toast('已导入 ' + ok + ' 张卡片到「' + (category || '未分类') + '」', 'ok');
      else if (ok && fail) toast('导入成功 ' + ok + ' 张，失败 ' + fail + ' 张', 'err');
      else toast('导入失败，请检查文件', 'err');
    });
  }

  /** 拖拽进来的文件：.md 直接导入，图片则开一张新卡片把图放进去 */
  function handleDroppedFiles(files) {
    var mds = files.filter(isMarkdownFile);
    var imgs = files.filter(function (f) { return /^image\//.test(f.type || ''); });
    var cat = state.current === '__all__' ? '' : state.current;

    if (mds.length) {
      if (!cat) cat = (prompt('这些卡片放到哪个类别？（例如：自动控制原理）', '') || '未分类').trim();
      importMdFiles(mds, cat);
    }
    if (imgs.length) {
      openEditor(null, cat);
      imgs.forEach(uploadImage);
    }
    if (!mds.length && !imgs.length) toast('只认识 .md 笔记和图片文件', 'err');
  }

  var dragDepth = 0;
  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    return Array.prototype.indexOf.call(t, 'Files') >= 0;
  }
  function showDrop(on) {
    var dz = $('#dropzone');
    if (!dz) return;
    if (on) {
      var cat = state.current === '__all__' ? '' : state.current;
      $('#dropzoneHint').textContent = cat
        ? '松手后自动导入到「' + cat + '」'
        : '松手后自动解析成卡片（会先问你放进哪个类别）';
    }
    dz.hidden = !on;
  }

  /* ---------------- 编辑器预览 ---------------- */
  var previewTimer = null;
  function schedulePreview() {
    if (!ed.preview) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 220);
  }
  function updatePreview() {
    var pane = $('#previewPane');
    var cat = $('#fCat').value.trim();
    R.renderMarkdown($('#fBody').value, pane, { basePath: cat, collapsible: false });
    resolveLocalImages(pane);
  }

  /* ---------------- 图片灯箱 ---------------- */
  function openLightbox(src) {
    var lb = $('#lightbox');
    $('#lightboxImg').src = src;
    lb.hidden = false;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    $('#btnNew').addEventListener('click', function () { openEditor(null, state.current === '__all__' ? '' : state.current); });
    $('#btnNewSide').addEventListener('click', function () { openEditor(null, state.current === '__all__' ? '' : state.current); });
    $('#btnNewCat').addEventListener('click', newCategory);
    $('#btnRefresh').addEventListener('click', function () {
      load(true).then(function () { toast('已重新读取文件夹', 'ok'); });
    });
    $('#btnReveal').addEventListener('click', function () {
      api('/api/reveal', { method: 'POST', body: {} }).catch(function (e) { toast(e.message, 'err'); });
    });

    // 主题切换（外观色点）
    var dots = $('#themeDots');
    if (dots) {
      dots.addEventListener('click', function (e) {
        var b = e.target.closest('.tdot');
        if (b) applyTheme(b.dataset.theme);
      });
      applyTheme(currentTheme());
    }

    // 云同步
    $('#btnSync').addEventListener('click', function () { doSync(false); });
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnSettingsClose').addEventListener('click', closeSettings);
    $('#btnSettingsCancel').addEventListener('click', closeSettings);
    $('#settingsBackdrop').addEventListener('click', closeSettings);
    $('#btnSettingsSave').addEventListener('click', saveSettings);
    $('#btnTestConn').addEventListener('click', testConn);
    $('#btnCreateRepo').addEventListener('click', createRepoAndUpload);

    $('#searchInput').addEventListener('input', onSearchInput);
    $('#btnClearSearch').addEventListener('click', function () {
      $('#searchInput').value = '';
      $('#btnClearSearch').hidden = true;
      clearSearch();
      renderBoard();
    });
    $('#searchInput').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { this.value = ''; $('#btnClearSearch').hidden = true; clearSearch(); renderBoard(); this.blur(); }
    });

    // 批量整理（多选后移动 / 复制）
    $('#btnSelectMode').addEventListener('click', function () {
      state.selectMode = !state.selectMode;
      this.classList.toggle('on', state.selectMode);
      if (state.selectMode) {
        toast('勾选卡片，然后一起移动或复制', 'ok');
      } else {
        clearSelection();
      }
    });
    $('#selClear').addEventListener('click', clearSelection);
    $('#selMove').addEventListener('click', function () { moveOrCopy(selectedIds(), 'move'); });
    $('#selCopy').addEventListener('click', function () { moveOrCopy(selectedIds(), 'copy'); });
    $('#selDelete').addEventListener('click', deleteSelected);
    $('#selAll').addEventListener('click', function () {
      var list = currentCards();
      var all = selectedIds().length >= list.length;
      state.selected = {};
      if (!all) list.forEach(function (c) { state.selected[c.id] = true; });
      $$('.card').forEach(function (el) { el.classList.toggle('selected', !!state.selected[el.dataset.id]); });
      updateSelBar();
    });

    // 类别选择弹窗
    $('#pickerCancel').addEventListener('click', function () { closePicker(null); });
    $('#pickerBackdrop').addEventListener('click', function () { closePicker(null); });
    $('#pickerNewBtn').addEventListener('click', function () {
      var v = $('#pickerNew').value.trim();
      if (!v) { $('#pickerNew').focus(); return; }
      closePicker(v);
    });
    $('#pickerNew').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#pickerNewBtn').click(); }
      if (e.key === 'Escape') { e.preventDefault(); closePicker(null); }
    });

    // 卡片大小
    $('#densMinus').addEventListener('click', function () { stepDensity(-1); });
    $('#densPlus').addEventListener('click', function () { stepDensity(1); });
    $('#btnReaderSize').addEventListener('click', cycleReaderSize);

    $('#sortSel').value = state.sort;
    $('#sortSel').addEventListener('change', function () {
      state.sort = this.value;
      localStorage.setItem('cn.sort', state.sort);
      renderBoard();
    });

    $$('#viewSeg button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === state.view);
      b.addEventListener('click', function () {
        state.view = b.dataset.view;
        localStorage.setItem('cn.view', state.view);
        $$('#viewSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
        renderBoard();
      });
    });

    // 阅读浮层
    $('#btnReaderClose').addEventListener('click', closeReader);
    $('#readerBackdrop').addEventListener('click', closeReader);
    $('#btnEdit').addEventListener('click', function () {
      if (reader.card) { var c = reader.card; closeReader(); setTimeout(function () { openEditor(c); }, 200); }
    });
    $('#btnFontUp').addEventListener('click', function () { reader.fontSize += 0.06; applyFontSize(); });
    $('#btnFontDown').addEventListener('click', function () { reader.fontSize -= 0.06; applyFontSize(); });
    $('#btnFoldAll').addEventListener('click', function () {
      var folded = $('#readerBody').dataset.folded !== '1';
      $('#readerBody').dataset.folded = folded ? '1' : '0';
      R.foldAll($('#readerBody'), folded);
    });
    $('#readerFoot').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn || !reader.card) return;
      var act = btn.dataset.act;
      if (act === 'edit') { var c = reader.card; closeReader(); setTimeout(function () { openEditor(c); }, 200); }
      if (act === 'delete') deleteCard(reader.card.id, reader.card.title);
      if (act === 'move' || act === 'copy2') {
        var rid = reader.card.id;
        closeReader();
        setTimeout(function () { moveOrCopy([rid], act === 'move' ? 'move' : 'copy'); }, 220);
      }
      if (act === 'copy') {
        navigator.clipboard.writeText(reader.card.content).then(function () { toast('正文已复制', 'ok'); },
          function () { toast('复制失败', 'err'); });
      }
      if (act === 'reveal') {
        api('/api/reveal', { method: 'POST', body: { id: reader.card.id } }).catch(function (er) { toast(er.message, 'err'); });
      }
      if (act === 'print') {
        window.open('print.html?id=' + encodeURIComponent(reader.card.id), '_blank');
      }
    });
    $('#readerBody').addEventListener('click', function (e) {
      var img = e.target.closest('img');
      if (img) { e.stopPropagation(); openLightbox(img.src); return; }
      var a = e.target.closest('a');
      if (a && /^https?:/i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noreferrer'; }
    });
    $('#lightbox').addEventListener('click', function () { this.hidden = true; this.querySelector('img').src = ''; });

    // 编辑弹窗
    $('#btnModalClose').addEventListener('click', function () { closeEditor(); });
    $('#btnCancel').addEventListener('click', function () { closeEditor(); });
    $('#modalBackdrop').addEventListener('click', function () { closeEditor(); });
    $('#btnSave').addEventListener('click', saveCard);
    $('#fBody').addEventListener('input', schedulePreview);
    $('#fCat').addEventListener('input', schedulePreview);
    $('#fBody').addEventListener('paste', handlePasteImage);

    var editorBox = document.querySelector('.editor');
    ['dragenter', 'dragover'].forEach(function (t) {
      editorBox.addEventListener(t, function (e) {
        e.preventDefault(); e.stopPropagation(); editorBox.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      editorBox.addEventListener(t, function (e) {
        e.preventDefault(); e.stopPropagation(); editorBox.classList.remove('dragging');
      });
    });
    editorBox.addEventListener('drop', function (e) {
      var all = filesFromDataTransfer(e.dataTransfer);
      var mds = all.filter(isMarkdownFile);
      var imgs = all.filter(function (f) { return /^image\//.test(f.type || ''); });
      if (mds.length === 1) {
        fillFromMd(mds[0]).catch(function (er) { toast('解析失败：' + er.message, 'err'); });
        return;
      }
      if (mds.length > 1) {
        var cat = $('#fCat').value.trim() || (state.current !== '__all__' ? state.current : '');
        if (!cat) { toast('先在「所属类别」里填一个类别', 'err'); $('#fCat').focus(); return; }
        importMdFiles(mds, cat).then(function () { closeEditor(true); });
      }
      imgs.forEach(uploadImage);
    });

    // 导入 .md 文件
    $('#btnImportMd').addEventListener('click', function () { $('#mdPick').click(); });
    $('#mdPick').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (!files.length) return;
      if (files.length === 1) {
        fillFromMd(files[0]).catch(function (er) { toast('解析失败：' + er.message, 'err'); });
        return;
      }
      var cat = $('#fCat').value.trim() || (state.current !== '__all__' ? state.current : '');
      if (!cat) { toast('先在「所属类别」里填一个类别', 'err'); $('#fCat').focus(); return; }
      importMdFiles(files, cat).then(function () { closeEditor(true); });
    });

    // 把 .md 拖到卡片墙 / 窗口任意位置
    document.addEventListener('dragenter', function (e) {
      if (ed.open || !hasFiles(e)) return;
      dragDepth++;
      showDrop(true);
    });
    document.addEventListener('dragover', function (e) {
      if (ed.open || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', function () {
      if (ed.open) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) showDrop(false);
    });
    document.addEventListener('drop', function (e) {
      if (ed.open || !hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      showDrop(false);
      handleDroppedFiles(filesFromDataTransfer(e.dataTransfer));
    });

    $('#toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-md]');
      if (!btn) return;
      insertAtCursor(MD_SNIPPETS[btn.dataset.md] || '');
    });
    $('#btnPreview').addEventListener('click', function () {
      ed.preview = !ed.preview;
      this.classList.toggle('on', ed.preview);
      $('#previewPane').hidden = !ed.preview;
      if (ed.preview) updatePreview();
    });

    $('#filePick').addEventListener('change', function () {
      Array.prototype.slice.call(this.files).forEach(uploadImage);
      this.value = '';
    });

    // 移动端侧栏（抽屉）：点遮罩、点完类别、按 Esc 都要能收起来
    $('#btnOpenSide').addEventListener('click', function () { openSide(); });
    $('#btnCloseSide').addEventListener('click', function () { closeSide(); });
    var sb = $('#sideBackdrop');
    if (sb) sb.addEventListener('click', closeSide);
    $('#catList').addEventListener('click', function (e) {
      if (e.target.closest('.cat-more')) return;      // 点的是"⋯"就打开菜单，先别收
      if (e.target.closest('.cat-item')) closeSide();
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));

      if (e.key === 'Escape') {
        if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
        if (!$('#settings').hidden) { closeSettings(); return; }
        if (!$('#picker').hidden) { closePicker(null); return; }
        if (ed.open) { closeEditor(); return; }
        if (!$('#reader').hidden) { closeReader(); return; }
        if ($('#sidebar').classList.contains('open')) { closeSide(); return; }
        if (selectedIds().length) { clearSelection(); return; }
      }
      if (ed.open && (e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
        e.preventDefault(); saveCard(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); return;
      }
      if (!inField && !ed.open && e.key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
      if (!inField && !ed.open && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !$('#reader').hidden) {
        e.preventDefault();
        cycleReaderSize();
        return;
      }
      if (!inField && !ed.open && (e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openEditor(null, state.current === '__all__' ? '' : state.current);
      }
    });

    // 窗口重新获得焦点时同步（比如在别处改了 md 文件）
    window.addEventListener('focus', function () {
      if (!ed.open && $('#reader').hidden) load(true);
    });
    // 切走 / 关页面之前，把还没推的改动推上去（尽力而为，推不动下次打开也会补上）
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && dirty && !syncing) {
        clearTimeout(autoSyncTimer);
        doSync(true);
      }
    });
    window.addEventListener('pagehide', function () {
      if (dirty && !syncing) { clearTimeout(autoSyncTimer); doSync(true); }
    });
    setInterval(function () {
      if (!ed.open && $('#reader').hidden && document.visibilityState === 'visible') load(true);
    }, 45000);
  }

  /** 只有"独立运行"（手机/网页版）才装 Service Worker —— 电脑版不装，免得开发时缓存捣乱 */
  function registerSW() {
    if (!MODE.local) return;
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      try { reg.update(); } catch (e) { /* 忽略 */ }
    }).catch(function () { /* 装不上就算了，不影响使用 */ });
    // 新版本接管后自动刷新一次，避免一直停在旧代码上
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  /* ---------------- 云同步（Gitee） ---------------- */
  var syncing = false;
  var syncReady = false;      // 是否已配置好云同步
  var autoSyncTimer = null;
  var dirty = false;          // 本地有改动还没推上去

  /**
   * 改动后延迟自动推送。
   * 这一步很关键：以前只有"打开软件时"才同步，导致在电脑上改完、
   * 马上拿起手机，手机还是旧的。现在改完 20 秒后自动推一次。
   */
  function scheduleAutoSync() {
    if (!syncReady) return;
    dirty = true;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(function () { doSync(true); }, 20000);
  }

  function setSyncLabel(text) {
    var el = $('#syncLabel');
    if (el) el.textContent = text || '同步';
  }

  function updateSyncInfo() {
    var info = $('#syncInfo');
    if (MODE.local) {
      var S = window.GiteeSync;
      if (!S || !info) return;
      var c = S.getConfig();
      var last = localStorage.getItem('cn.lastSync') || '';
      syncReady = S.ready();
      info.textContent = syncReady
        ? ('仓库：' + c.owner + '/' + c.repo + (last ? '　上次同步：' + last : ''))
        : '还没有配置云同步';
      return;
    }
    // 文件夹模式：配置在电脑上的服务里，前端拿不到令牌
    api('/api/sync/status').then(function (s) {
      syncReady = !!s.configured;
      if (!info) return;
      if (!syncReady) { info.textContent = '还没有配置云同步'; return; }
      var auto = '';
      if (s.auto && s.auto.at) {
        auto = '　自动同步：' + s.auto.at.slice(11) + (s.auto.ok ? ' 成功' : ' 失败');
      }
      info.textContent = '仓库：' + s.owner + '/' + s.repo +
        (s.lastSync ? '　云端同步：' + s.lastSync : '') + auto;
    }).catch(function () { /* 忽略 */ });
  }

  function openSettings() {
    $('#sOwner').value = '';
    $('#sRepo').value = 'card-notes';
    $('#sBranch').value = '';
    $('#sToken').value = '';
    if (MODE.local) {
      var S = window.GiteeSync;
      var c = S ? S.getConfig() : {};
      $('#sOwner').value = c.owner || '';
      $('#sRepo').value = c.repo || 'card-notes';
      $('#sBranch').value = c.branch || '';
      $('#sToken').value = c.token || '';
    } else {
      api('/api/sync/status').then(function (s) {
        $('#sOwner').value = s.owner || '';
        $('#sRepo').value = s.repo || 'card-notes';
        $('#sBranch').value = s.branch || '';
      }).catch(function () { /* 忽略 */ });
    }
    var st = $('#settingsStatus');
    st.textContent = '';
    st.className = 'settings-status';
    var vt = $('#verTip');
    if (vt) vt.textContent = '版本 ' + APP_VERSION + (MODE.local ? ' · 本地模式' : ' · 文件夹模式');
    updateSyncInfo();
    var m = $('#settings');
    m.hidden = false;
    requestAnimationFrame(function () { m.classList.add('open'); });
    document.body.classList.add('locked');
  }

  function closeSettings() {
    var m = $('#settings');
    if (!m || m.hidden) return;
    m.classList.remove('open');
    document.body.classList.remove('locked');
    setTimeout(function () { m.hidden = true; }, 200);
  }

  function settingsStatus(text, kind) {
    var st = $('#settingsStatus');
    st.textContent = text;
    st.className = 'settings-status' + (kind ? ' ' + kind : '');
  }

  function readSettingsForm() {
    return {
      owner: $('#sOwner').value.trim(),
      repo: $('#sRepo').value.trim(),
      branch: $('#sBranch').value.trim(),
      token: $('#sToken').value.trim()
    };
  }

  function saveSettings() {
    var c = readSettingsForm();
    if (!c.owner || !c.repo || !c.token) { toast('用户名、仓库名、令牌都要填', 'err'); return; }
    if (MODE.local) {
      window.GiteeSync.setConfig(c);
      updateSyncInfo();
      closeSettings();
      toast('已保存，开始首次同步…', 'ok');
      setTimeout(function () { doSync(true); }, 400);
      return;
    }
    // 文件夹模式：配置交给电脑上的服务保存（令牌不会存到浏览器里）
    api('/api/sync/config', { method: 'POST', body: c }).then(function () {
      updateSyncInfo();
      closeSettings();
      toast('已保存，开始首次同步…', 'ok');
      setTimeout(function () { doSync(true); }, 400);
    }).catch(function (e) { toast('保存失败：' + e.message, 'err'); });
  }

  function testConn() {
    var c = readSettingsForm();
    if (!MODE.local) {
      // 文件夹模式：令牌留空也没关系 —— 直接用电脑上已经保存好的配置
      settingsStatus('正在连接…');
      api('/api/sync/test', { method: 'POST', body: c.token ? c : {} }).then(function (r) {
        settingsStatus('✅ 连接成功：' + r.full_name + '\n默认分支：' + r.branch, 'ok');
        updateSyncInfo();
      }).catch(function (e) { settingsStatus('❌ ' + e.message, 'err'); });
      return;
    }
    if (!c.token || !c.owner || !c.repo) { settingsStatus('用户名、仓库名、令牌都要填', 'err'); return; }
    settingsStatus('正在连接…');
    window.GiteeSync.setConfig(c);
    window.GiteeSync.testConnection(c).then(function (r) {
      settingsStatus('✅ 连接成功：' + r.full_name + '\n默认分支：' + r.branch, 'ok');
      updateSyncInfo();
    }).catch(function (e) { settingsStatus('❌ ' + e.message, 'err'); });
  }

  function createRepoAndUpload() {
    var c = readSettingsForm();
    if (!MODE.local) {
      if (!c.token) { settingsStatus('要新建仓库的话，需要把令牌也填上', 'err'); return; }
      settingsStatus('正在检查仓库…');
      api('/api/sync/test', { method: 'POST', body: c }).then(function () {
        closeSettings();
        toast('仓库就绪，开始同步…', 'ok');
        setTimeout(function () { doSync(true); }, 400);
      }).catch(function (e) {
        settingsStatus('❌ ' + e.message + '\n（仓库不存在的话，去 Gitee 网页上建一个私有的 card-notes 即可）', 'err');
      });
      return;
    }
    if (!c.token || !c.owner || !c.repo) { settingsStatus('用户名、仓库名、令牌都要填', 'err'); return; }
    window.GiteeSync.setConfig(c);
    settingsStatus('正在准备仓库…');
    window.GiteeSync.bootstrap(function (t) { settingsStatus(t); })
      .then(function () {
        closeSettings();
        toast('仓库就绪，开始上传本地卡片…', 'ok');
        setTimeout(function () { doSync(true); }, 400);
      })
      .catch(function (e) { settingsStatus('❌ ' + e.message, 'err'); });
  }

  function doSync(silent) {
    if (syncing) { if (!silent) toast('正在同步中…'); return Promise.resolve(); }
    syncing = true;
    setSyncLabel('同步中…');

    if (!MODE.local) {
      // 文件夹模式：交给电脑上的服务去读写真实文件
      return api('/api/sync', { method: 'POST', body: {} }).then(function (d) {
        syncing = false;
        dirty = false;
        setSyncLabel('同步');
        var r = d.result;
        updateSyncInfo();
        toast('同步完成：拉取 ' + r.pulled + ' · 上传 ' + r.pushed + (r.deleted ? ' · 删除 ' + r.deleted : ''), 'ok');
        if (r.conflicts && r.conflicts.length) {
          setTimeout(function () { toast('有 ' + r.conflicts.length + ' 张两端都改过，云端那份已存为「(云端副本)」', 'err'); }, 3000);
        }
        return load(true);
      }).catch(function (e) {
        syncing = false;
        setSyncLabel('同步');
        if (!silent) toast('同步失败：' + e.message, 'err');
        if (/还没配置/.test(e.message) && !silent) openSettings();
      });
    }

    var S = window.GiteeSync;
    if (!S.ready()) {
      syncing = false;
      setSyncLabel('同步');
      if (!silent) { toast('先配置云同步', 'err'); openSettings(); }
      return Promise.resolve();
    }
    return S.sync(function () { setSyncLabel('同步中…'); })
      .then(function (r) {
        syncing = false;
        dirty = false;
        setSyncLabel('同步');
        localStorage.setItem('cn.lastSync', window.LocalAPI.nowStr());
        updateSyncInfo();
        toast('同步完成：拉取 ' + r.pulled + ' · 上传 ' + r.pushed + (r.deleted ? ' · 删除 ' + r.deleted : ''), 'ok');
        if (r.conflicts.length) {
          setTimeout(function () {
            toast('有 ' + r.conflicts.length + ' 张两端都改过，云端那份已存为「(云端副本)」', 'err');
          }, 3000);
        }
        return load(true);
      })
      .catch(function (e) {
        syncing = false;
        setSyncLabel('同步');
        toast('同步失败：' + e.message, 'err');
      });
  }

  /* ---------------- 启动 ---------------- */
  bind();
  applyReaderSize();
  detectMode().then(function () {
    document.body.classList.toggle('local-mode', MODE.local);
    if (MODE.local) {
      var sub = $('#brandSub');
      if (sub) sub.textContent = '正在读取…';
    }
    registerSW();
    load().then(function () {
      updateSyncInfo();
      // 配好云同步的话，启动时自动对齐一次
      if (window.GiteeSync && window.GiteeSync.ready()) setTimeout(function () { doSync(true); }, 800);
    });
  });
  window.__cardnote = {
    state: state, load: load, render: renderBoard,
    // 给自动化测试/截图用：直接设定卡片大小档位（0=紧凑 … 5=单列）
    setDensity: function (i) { state.density = i; applyDensity(); renderBoard(); },
    // 同上：设定网格/列表视图（否则前一个页面改过的视图会被后面的页面继承）
    setView: function (v) {
      state.view = v === 'list' ? 'list' : 'grid';
      localStorage.setItem('cn.view', state.view);
      $$('#viewSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === state.view); });
      renderBoard();
    },
    setTheme: applyTheme,
    appVersion: APP_VERSION
  };
})();
