/* ==================================================================
   store-local.js —— 浏览器本地存储（IndexedDB）
   ------------------------------------------------------------------
   把 server.js 提供的那套 /api/* 接口，在浏览器里完整实现一份。
   这样同一套界面代码：
     · 在电脑上（有 Node 服务）→ 走真实文件系统
     · 在手机/Pad 上（没有服务）→ 走这里，数据存在浏览器里
   两张模式对上层完全透明。
   ================================================================== */
(function (global) {
  'use strict';

  var DB_NAME = 'cardnote';
  var DB_VER = 1;
  var dbp = null;

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function run(storeName, mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var os = t.objectStore(storeName);
        var out;
        try { out = fn(os); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.__req ? out.__req.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  var req = function (r) { return { __req: r }; };

  var all = function (s) { return run(s, 'readonly', function (os) { return req(os.getAll()); }); };
  var get1 = function (s, k) { return run(s, 'readonly', function (os) { return req(os.get(k)); }); };
  var put1 = function (s, v, k) { return run(s, 'readwrite', function (os) { return k === undefined ? os.put(v) : os.put(v, k); }); };
  var del1 = function (s, k) { return run(s, 'readwrite', function (os) { return os.delete(k); }); };

  /* ---------------- 时间 / 命名工具（与 server.js 保持一致） ---------------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function nowStr() { return fmt(new Date()); }

  function sanitizeName(name) {
    var s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim();
    if (!s) s = '未命名卡片';
    if (s.length > 60) s = s.slice(0, 60).trim();
    return s;
  }
  function sanitizeCat(name) {
    var s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[._]+/, '').replace(/\.+$/, '').trim();
    if (!s) throw new Error('类别名不能为空');
    if (s.length > 40) s = s.slice(0, 40).trim();
    return s;
  }

  /* ---------------- .md 解析 / 生成（与 server.js 同规则） ---------------- */
  function parseFrontMatter(block) {
    var out = {}, cur = null;
    var lines = block.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+$/, '');
      if (!line.trim()) continue;
      var kv = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
      if (kv) { cur = kv[1].toLowerCase(); out[cur] = kv[2].trim(); continue; }
      var li = line.match(/^\s*-\s+(.*)$/);
      if (li && cur) { out[cur] = out[cur] ? out[cur] + ', ' + li[1].trim() : li[1].trim(); continue; }
      return null;
    }
    for (var k in out) if (Object.prototype.hasOwnProperty.call(out, k)) return out;
    return null;
  }

  function parseTagsValue(v) {
    var s = String(v || '').trim();
    if (/^\[[\s\S]*\]$/.test(s)) s = s.slice(1, -1);
    return s.split(/[,，]/).map(function (x) {
      return x.trim().replace(/^["']|["']$/g, '').trim();
    }).filter(Boolean);
  }

  /** 导入时去掉标题末尾的"废话后缀"（「xx · 理解笔记」「xx_我的理解整理」等） */
  function stripBoilerplate(title) {
    var t = String(title == null ? '' : title).trim();
    var cleaned = t.replace(/[\s·•・\-—_]+(理解笔记|我的理解整理|我的理解笔记|我的理解|理解整理|学习笔记|笔记)$/u, '').trim();
    return cleaned || t;
  }

  /** 去掉 YAML 转义留下的成对引号（可能套了两层，比如 "''标题''"） */
  function cleanTitle(s) {
    var t = String(s == null ? '' : s).trim();
    for (var i = 0; i < 2; i++) {
      if (t.length > 1 && /^["']/.test(t) && /["']$/.test(t)) {
        var inner = t.slice(1, -1).trim();
        if (inner.length > 1) t = inner; else break;
      } else break;
    }
    return t;
  }

  function parseNote(raw, fallbackTitle) {
    var text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    var meta = { title: fallbackTitle, tags: [], created: '', updated: '', pinned: false };
    var m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/);
    if (m) {
      var found = parseFrontMatter(m[1]);
      if (found) {
        text = text.slice(m[0].length);
        if (found.title) meta.title = cleanTitle(found.title);
        if (found.tags) meta.tags = parseTagsValue(found.tags);
        if (found.created) meta.created = found.created;
        if (found.updated) meta.updated = found.updated;
        if (found.pinned !== undefined) meta.pinned = /^(true|yes|1|是)$/i.test(found.pinned);
      }
    }
    if (!meta.title || meta.title === fallbackTitle) {
      var h1 = text.match(/^([ \t]{0,3})#\s+(.+?)[ \t]*$/m);
      if (h1) {
        meta.title = cleanTitle(h1[2]);
        text = text.slice(0, h1.index) + text.slice(h1.index + h1[0].length);
      }
    }
    return { meta: meta, content: text.replace(/^\n+/, '').replace(/\s+$/, '') + '\n' };
  }

  function escapeYaml(v) {
    var s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
    return /^[\w\u4e00-\u9fa5\s.,;:!?()（）【】\-+/%#]*$/.test(s) ? s : '"' + s.replace(/"/g, "'") + '"';
  }

  function serializeNote(meta, content) {
    return [
      '---',
      'title: ' + escapeYaml(meta.title),
      'tags: ' + (meta.tags || []).join(', '),
      'created: ' + escapeYaml(meta.created || nowStr()),
      'updated: ' + escapeYaml(meta.updated || nowStr()),
      'pinned: ' + (meta.pinned ? 'true' : 'false'),
      '---',
      '',
      String(content || '').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n'
    ].join('\n');
  }

  function summarize(md, n) {
    n = n || 120;
    var t = String(md || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\$\$[\s\S]*?\$\$/g, '')
      .replace(/\$[^$\n]{1,200}\$/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s*(.+?)\s*$/gm, '$1 · ')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+(\[[ xX]\]\s*)?/gm, '')
      .replace(/^\s*\|.*\|\s*$/gm, ' ')
      .replace(/^\s*[-:| ]{3,}\s*$/gm, ' ')
      .replace(/[*_`~]/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/([\u4e00-\u9fa5，。；：、！？（）《》「」])\s+([\u4e00-\u9fa5，。；：、！？（）《》「」])/g, '$1$2')
      .trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* ---------------- 卡片读写 ---------------- */
  function idOf(cat, title) { return (cat ? cat + '/' : '') + title + '.md'; }

  /** 新建/改回同名卡片时，把那条"删除墓碑"清掉，否则同步时会被当成已删除再删一次 */
  function clearTombstone(id) {
    return get1('meta', 'tombstones').then(function (t) {
      if (!t || !t[id]) return null;
      delete t[id];
      return put1('meta', t, 'tombstones');
    });
  }

  function metaOf(c, withSum) {
    var o = {
      id: c.id, cat: c.cat, title: c.title, tags: c.tags || [],
      created: c.created, updated: c.updated, pinned: !!c.pinned,
      size: (c.content || '').length
    };
    if (withSum) o.summary = summarize(c.content);
    return o;
  }

  function loadAll() { return all('cards'); }

  function uniqueTitle(cards, cat, base) {
    var taken = {};
    cards.forEach(function (c) { if (c.cat === cat) taken[c.title] = 1; });
    if (!taken[base]) return base;
    var i = 2;
    while (taken[base + ' (' + i + ')']) i++;
    return base + ' (' + i + ')';
  }

  /* ---------------- 附件（图片） ---------------- */
  function saveBlob(name, dataUrl) {
    return put1('blobs', { name: name, data: dataUrl, at: Date.now() }, name);
  }
  function getBlob(name) { return get1('blobs', name); }
  function listBlobs() { return all('blobs'); }
  function delBlob(name) { return del1('blobs', name); }

  /* ---------------- 与 server.js 对齐的接口实现 ---------------- */
  var handlers = {
    'GET /api/state': function () {
      return loadAll().then(function (cards) {
        var byCat = {};
        cards.forEach(function (c) { byCat[c.cat] = (byCat[c.cat] || 0) + 1; });
        var categories = Object.keys(byCat).map(function (k) { return { name: k, count: byCat[k] }; })
          .sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name, 'zh'); });
        var list = cards.map(function (c) { return metaOf(c, true); });
        list.sort(function (a, b) { return (a.updated || '') < (b.updated || '') ? 1 : -1; });
        return { cards: list, categories: categories, updatedAt: nowStr(), mode: 'local' };
      });
    },

    'GET /api/card': function (q) {
      var id = q.get('id');
      return get1('cards', id).then(function (c) {
        if (!c) throw new Error('卡片不存在');
        return Object.assign({}, metaOf(c, false), { content: c.content, mtime: c.updated });
      });
    },

    'POST /api/card': function (q, b) {
      var cat = sanitizeCat(b.category || '未分类');
      return loadAll().then(function (cards) {
        var title = uniqueTitle(cards, cat, sanitizeName(b.title || '未命名卡片'));
        var now = b.created || nowStr();
        var card = {
          id: idOf(cat, title), cat: cat, title: title,
          tags: b.tags || [], created: now, updated: b.updated || now,
          pinned: !!b.pinned,
          content: String(b.content || '').trim() + '\n'
        };
        return put1('cards', card).then(function () {
          return clearTombstone(card.id).then(function () {
            return { card: Object.assign({}, metaOf(card, false), { content: card.content }) };
          });
        });
      });
    },

    'POST /api/card/update': function (q, b) {
      if (!b.id) throw new Error('缺少 id');
      return get1('cards', b.id).then(function (old) {
        if (!old) throw new Error('卡片不存在');
        var cat = sanitizeCat(b.category || old.cat);
        var title = sanitizeName(b.title || old.title);
        return loadAll().then(function (cards) {
          var others = cards.filter(function (c) { return c.id !== old.id; });
          if (others.some(function (c) { return c.cat === cat && c.title === title; })) {
            title = uniqueTitle(others, cat, title);
          }
          var next = {
            id: idOf(cat, title), cat: cat, title: title,
            tags: b.tags == null ? old.tags : b.tags,
            created: old.created,
            updated: nowStr(),
            pinned: b.pinned == null ? old.pinned : !!b.pinned,
            content: b.content == null ? old.content : String(b.content).trim() + '\n'
          };
          var chain = put1('cards', next);
          if (next.id !== old.id) chain = chain.then(function () { return del1('cards', old.id); });
          return chain.then(function () {
            return clearTombstone(next.id).then(function () {
              return { card: Object.assign({}, metaOf(next, false), { content: next.content }) };
            });
          });
        });
      });
    },

    'POST /api/card/delete': function (q, b) {
      return get1('cards', b.id).then(function (c) {
        if (!c) throw new Error('卡片不存在');
        // 记录"墓碑"，同步时才知道这张卡是被删掉的，而不是还没上传
        return get1('meta', 'tombstones').then(function (t) {
          t = t || {};
          t[b.id] = nowStr();
          return put1('meta', t, 'tombstones').then(function () {
            return del1('cards', b.id).then(function () { return { ok: true }; });
          });
        });
      });
    },

    'POST /api/card/move': function (q, b) { return transfer(b, 'move'); },
    'POST /api/card/copy': function (q, b) { return transfer(b, 'copy'); },

    'POST /api/category': function (q, b) {
      var name = sanitizeCat(b.name);
      return put1('meta', name, 'cat:' + name).then(function () { return { ok: true, name: name }; });
    },

    'POST /api/category/rename': function (q, b) {
      var from = sanitizeCat(b.from), to = sanitizeCat(b.to);
      return loadAll().then(function (cards) {
        var hit = cards.filter(function (c) { return c.cat === from; });
        var chain = Promise.resolve();
        hit.forEach(function (c) {
          chain = chain.then(function () {
            var title = uniqueTitle(cards.filter(function (x) { return x.cat === to; }), to, c.title);
            var next = Object.assign({}, c, { cat: to, title: title, id: idOf(to, title) });
            return put1('cards', next).then(function () { return del1('cards', c.id); });
          });
        });
        return chain.then(function () { return { ok: true, name: to }; });
      });
    },

    'POST /api/category/delete': function (q, b) {
      var name = sanitizeCat(b.name);
      return loadAll().then(function (cards) {
        var hit = cards.filter(function (c) { return c.cat === name; });
        return Promise.all(hit.map(function (c) { return del1('cards', c.id); }))
          .then(function () { return { ok: true }; });
      });
    },

    'GET /api/search': function (q) {
      var needle = String(q.get('q') || '').trim().toLowerCase();
      if (!needle) return { hits: [] };
      return loadAll().then(function (cards) {
        var hits = [];
        cards.forEach(function (c) {
          var hay = (c.title + ' ' + (c.tags || []).join(' ') + ' ' + c.content).toLowerCase();
          var idx = hay.indexOf(needle);
          if (idx < 0) return;
          var plain = summarize(c.content, 100000);
          var p = plain.toLowerCase().indexOf(needle);
          var snippet = p < 0 ? summarize(c.content)
            : (p > 24 ? '…' + plain.slice(p - 24, p + 90) : plain.slice(0, 114)) + '…';
          var count = 0, pos = 0;
          while ((pos = hay.indexOf(needle, pos)) >= 0) { count++; pos += needle.length; }
          hits.push({ id: c.id, cat: c.cat, title: c.title, snippet: snippet, count: count });
        });
        hits.sort(function (a, b) { return b.count - a.count; });
        return { hits: hits.slice(0, 60) };
      });
    },

    'POST /api/parse': function (q, text) {
      var fileName = String(q.get('name') || '').replace(/\.(md|markdown|txt)$/i, '').trim() || '未命名卡片';
      var mtime = Number(q.get('mtime')) || 0;
      var r = parseNote(text, fileName);
      return {
        title: stripBoilerplate(r.meta.title || fileName),
        tags: r.meta.tags,
        pinned: !!r.meta.pinned,
        created: r.meta.created || (mtime ? fmt(new Date(mtime)) : ''),
        content: r.content.replace(/^\n+/, '')
      };
    },

    'POST /api/import': function (q, text) {
      var fileName = String(q.get('name') || '导入的卡片').replace(/\.(md|markdown|txt)$/i, '').trim() || '导入的卡片';
      var category = String(q.get('category') || '').trim() || '未分类';
      var mtime = Number(q.get('mtime')) || 0;
      var r = parseNote(text, fileName);
      return handlers['POST /api/card'](q, {
        category: category,
        title: stripBoilerplate(r.meta.title || fileName),
        content: r.content.replace(/^\n+/, ''),
        tags: r.meta.tags,
        pinned: r.meta.pinned,
        created: r.meta.created || (mtime ? fmt(new Date(mtime)) : '')
      });
    },

    'POST /api/upload': function (q, body) {
      var name = String(q.get('name') || 'image.png').replace(/[\\/:*?"<>|]/g, '_');
      var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      var ext = (name.match(/\.[a-z0-9]+$/i) || ['.png'])[0];
      var fname = 'img-' + stamp + '-' + Math.random().toString(36).slice(2, 7) + ext;
      // body 在本地模式下是 dataURL 字符串
      var dataUrl = (typeof body === 'string') ? body : (body && body.__dataUrl) || '';
      return saveBlob(fname, dataUrl).then(function () {
        return { url: '/files/_附件/' + encodeURIComponent(fname), name: fname, size: dataUrl.length };
      });
    },

    'POST /api/reveal': function () { return { ok: false, error: '手机/网页版没有"打开文件夹"这个功能' }; },
    'GET /api/ping': function () { return { ok: true, mode: 'local', version: 2 }; }
  };

  function transfer(b, mode) {
    var ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : (b.id ? [b.id] : []);
    if (!ids.length) throw new Error('没有选中卡片');
    if (!b.to) throw new Error('没有指定目标类别');
    var to = sanitizeCat(b.to);
    var done = [], failed = [];
    return loadAll().then(function (cards) {
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          var c = cards.filter(function (x) { return x.id === id; })[0];
          if (!c) { failed.push({ id: id, error: '卡片不存在' }); return; }
          if (mode === 'move' && c.cat === to) { done.push(metaOf(c, false)); return; }
          // 复制时原卡片还留在目标类别里，所以「已占用的名字」要把它算进去；
          // 移动时它要离开，就不算。搞错的话同类别复制会覆盖原卡片。
          var pool = mode === 'move' ? cards.filter(function (x) { return x.id !== id; }) : cards;
          var title = uniqueTitle(pool, to, c.title);
          var next = Object.assign({}, c, {
            id: idOf(to, title), cat: to, title: title,
            updated: mode === 'move' ? c.updated : nowStr()
          });
          var op = mode === 'move'
            ? put1('cards', next).then(function () { return del1('cards', c.id); })
            : put1('cards', next);
          return op.then(function () { done.push(metaOf(next, false)); });
        }).catch(function (e) { failed.push({ id: id, error: e.message }); });
      });
      return chain.then(function () {
        return { mode: mode, category: to, ok: done.length, failed: failed, cards: done };
      });
    });
  }

  /* ---------------- 对外入口：模拟 fetch 的 api(path, opts) ---------------- */
  var TEXT_ENDPOINTS = { '/api/parse': 1, '/api/import': 1, '/api/upload': 1 };

  function handle(path, opts) {
    var u = new URL(path, 'http://local/');
    var key = (opts && opts.method ? opts.method : 'GET') + ' ' + u.pathname;
    var h = handlers[key];
    if (!h) return Promise.reject(new Error('本地模式不支持该接口: ' + key));
    var arg = opts && opts.body;
    if (typeof arg === 'string' && !TEXT_ENDPOINTS[u.pathname]) {
      try { arg = JSON.parse(arg); } catch (e) { /* 保持原样 */ }
    }
    return Promise.resolve().then(function () { return h(u.searchParams, arg); });
  }

  global.LocalAPI = {
    handle: handle,
    // 供同步引擎使用
    loadAll: loadAll,
    putCard: function (c) { return put1('cards', c); },
    delCard: function (id) { return del1('cards', id); },
    getCard: function (id) { return get1('cards', id); },
    getMeta: function (k) { return get1('meta', k); },
    putMeta: function (k, v) { return put1('meta', v, k); },
    listBlobs: listBlobs,
    getBlob: getBlob,
    saveBlob: saveBlob,
    delBlob: delBlob,
    parseNote: parseNote,
    serializeNote: serializeNote,
    summarize: summarize,
    idOf: idOf,
    sanitizeName: sanitizeName,
    sanitizeCat: sanitizeCat,
    nowStr: nowStr
  };
})(window);
