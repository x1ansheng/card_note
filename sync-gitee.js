/* ==================================================================
   sync-gitee.js —— 用 Gitee 私有仓库做云端同步
   ------------------------------------------------------------------
   模型：本地优先。每台设备本地都有一份完整数据，打开时与云端对齐。
     · 拉取：一次请求拿到整个仓库的文件清单（树），只下载变了的文件
     · 推送：只上传改动过的卡片
     · 冲突：两边都改过 → 两份都留，绝不静默覆盖
     · 删除：用"墓碑"记录，避免被另一台设备同步回来
   ================================================================== */
(function (global) {
  'use strict';

  var CFG_KEY = 'cn.sync';
  var ST_KEY = 'sync.state';       // 存在 IndexedDB meta 里
  // 笔记统一放在仓库的这个目录下。这样仓库自带的 README 之类不会被当成卡片，
  // 你打开 Gitee 网页也能一眼看到自己的笔记。
  var FILE_PREFIX = '笔记/';
  var ATTACH_DIR = FILE_PREFIX + '_附件/';

  /* ---------------- 配置 ---------------- */
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setConfig(c) {
    localStorage.setItem(CFG_KEY, JSON.stringify(c || {}));
  }
  function ready() {
    var c = getConfig();
    return !!(c.token && c.owner && c.repo);
  }

  /* ---------------- base64（要正确处理中文） ---------------- */
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(String(b64 || '').replace(/[\r\n\s]/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function hash(s) {
    var h = 5381;
    s = String(s);
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16) + '-' + s.length;
  }
  /** 卡片"内容指纹"：正文 + 标题 + 标签 + 置顶（只算正文的话，改标题不会上传） */
  function cardHash(parsed) {
    return hash(parsed.meta.title + '\u0001' + (parsed.meta.tags || []).join(',') +
      '\u0001' + (parsed.meta.pinned ? '1' : '0') + '\u0002' + parsed.content);
  }
  function hashCard(card) {
    return cardHash({ meta: { title: card.title, tags: card.tags || [], pinned: !!card.pinned }, content: card.content });
  }

  /* ---------------- Gitee API ---------------- */
  function request(method, path, body, cfg) {
    cfg = cfg || getConfig();
    if (!cfg.token) return Promise.reject(new Error('没有填写 Gitee 令牌'));
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    var url = 'https://gitee.com/api/v5' + path + sep + 'access_token=' + encodeURIComponent(cfg.token);
    var init = { method: method, cache: 'no-store' };
    if (body) {
      init.headers = { 'Content-Type': 'application/json;charset=UTF-8' };
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* 非 JSON */ }
        if (!r.ok) {
          var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
          if (r.status === 401) msg = '令牌无效或已过期';
          if (r.status === 404) msg = '仓库或文件不存在（检查用户名/仓库名/分支）';
          throw new Error(msg);
        }
        return j;
      });
    });
  }

  function repoPath(p) { return '/repos/' + encodeURIComponent(getConfig().owner) + '/' + encodeURIComponent(getConfig().repo) + p; }

  /** 测试连接：返回仓库信息 */
  function testConnection(cfg) {
    cfg = cfg || getConfig();
    return request('GET', repoPath('/'), null, cfg).then(function (r) {
      return { ok: true, full_name: r.full_name, private: r.private, branch: cfg.branch || r.default_branch };
    });
  }

  /** 一次拿到整个仓库的文件清单（path -> {sha,size}） */
  function remoteTree(cfg) {
    cfg = cfg || getConfig();
    var branch = cfg.branch || 'master';
    return request('GET', repoPath('/git/trees/' + encodeURIComponent(branch) + '?recursive=1'), null, cfg)
      .then(function (r) {
        var map = {};
        (r.tree || []).forEach(function (n) {
          if (n.type === 'blob') map[n.path] = { sha: n.sha, size: n.size || 0 };
        });
        return { files: map, truncated: !!r.truncated, sha: r.sha };
      });
  }

  function getFile(path, cfg) {
    cfg = cfg || getConfig();
    return request('GET', repoPath('/contents/' + encodeURI(path) + '?ref=' + encodeURIComponent(cfg.branch || 'master')), null, cfg)
      .then(function (r) {
        if (Array.isArray(r)) throw new Error('这是个目录，不是文件: ' + path);
        return { content: b64decode(r.content), sha: r.sha };
      });
  }

  /**
   * 写入/更新文件。
   * 注意：Gitee 和 GitHub 不一样 —— 新建用 POST，更新要用 PUT（不是 POST 带 sha）。
   */
  function putFile(path, text, message, sha, cfg) {
    cfg = cfg || getConfig();
    var body = { content: b64encode(text), message: message || ('更新 ' + path), branch: cfg.branch || 'master' };
    if (sha) body.sha = sha;
    return request(sha ? 'PUT' : 'POST', repoPath('/contents/' + encodeURI(path)), body, cfg);
  }

  function delFile(path, sha, message, cfg) {
    cfg = cfg || getConfig();
    return request('DELETE', repoPath('/contents/' + encodeURI(path)),
      { sha: sha, message: message || ('删除 ' + path), branch: (cfg || getConfig()).branch || 'master' }, cfg);
  }

  /* ---------------- 同步状态 ---------------- */
  function loadState() {
    return global.LocalAPI.getMeta(ST_KEY).then(function (s) {
      return s || { files: {}, at: '' };
    });
  }
  function saveState(s) { return global.LocalAPI.putMeta(ST_KEY, s); }

  /* ---------------- 主同步流程 ---------------- */
  /**
   * onLog(text) 用来往界面上打进度
   * 返回 { pulled, pushed, deleted, conflicts, skipped, ms }
   */
  function sync(onLog) {
    var log = onLog || function () {};
    var t0 = Date.now();
    var cfg = getConfig();
    if (!ready()) return Promise.reject(new Error('还没配置 Gitee 仓库'));
    var branch = cfg.branch || 'master';
    var result = { pulled: 0, pushed: 0, deleted: 0, conflicts: [], skipped: 0, ms: 0 };

    var state, localCards, tombstones, localBlobs;

    return loadState()
      .then(function (s) { state = s; return global.LocalAPI.loadAll(); })
      .then(function (cards) { localCards = cards; return global.LocalAPI.getMeta('tombstones'); })
      .then(function (t) { tombstones = t || {}; return global.LocalAPI.listBlobs(); })
      .then(function (bs) { localBlobs = bs || []; })
      .then(function () {
        log('正在读取云端文件清单…');
        return remoteTree(cfg);
      })
      .then(function (tree) {
        var remote = tree.files;
        if (tree.truncated) log('⚠ 仓库文件太多，清单被截断了，建议分仓库存放');
        var remoteMd = {}, remoteBin = {};
        Object.keys(remote).forEach(function (p) {
          if (p.indexOf(FILE_PREFIX) !== 0) return;          // 只认「笔记/」目录下的东西
          if (/\.md$/i.test(p)) remoteMd[p] = remote[p];
          else if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) remoteBin[p] = remote[p];
        });
        log('云端 ' + Object.keys(remoteMd).length + ' 张卡片，本地 ' + localCards.length + ' 张');

        var localByPath = {};
        localCards.forEach(function (c) { localByPath[pathOf(c)] = c; });
        // 本地「类别/标题」索引，用来识别重命名
        var localByKey = {};
        localCards.forEach(function (c) { localByKey[c.cat + '/' + c.title] = c; });

        var jobs = [];

        /* ---- 1. 云端有、本地没有（或本地删过） ---- */
        Object.keys(remoteMd).forEach(function (p) {
          var local = localByPath[p];
          var st = state.files[p] || {};
          if (!local) {
            if (tombstones[localIdOf(p)]) { jobs.push({ type: 'delRemote', path: p, sha: remoteMd[p].sha }); return; }
            // 本地同类别下已经有同名卡片 → 是本地的重命名，把云端旧路径删掉即可
            if (localByKey[catOf(p) + '/' + baseName(p)]) {
              jobs.push({ type: 'delRemote', path: p, sha: remoteMd[p].sha, reason: '重命名' });
              return;
            }
            jobs.push({ type: 'pull', path: p, sha: remoteMd[p].sha });
            return;
          }
          if (!st.remoteSha && !st.localHash) {
            // 第一次见到这个文件（没有同步记录）：拉云端内容比一比，
            // 一样就只登记状态，绝不误判成"两边都改过"而生成冲突副本。
            jobs.push({ type: 'firstCheck', path: p, sha: remoteMd[p].sha, local: local });
            return;
          }
          var localChanged = hashCard(local) !== st.localHash;
          var remoteChanged = remoteMd[p].sha !== st.remoteSha;
          if (localChanged && remoteChanged) { jobs.push({ type: 'conflict', path: p, sha: remoteMd[p].sha, local: local }); }
          else if (remoteChanged) { jobs.push({ type: 'pull', path: p, sha: remoteMd[p].sha }); }
          else if (localChanged) { jobs.push({ type: 'push', path: p, local: local, sha: remoteMd[p].sha }); }
          else { result.skipped++; }
        });

        /* ---- 2. 本地有、云端没有 ---- */
        Object.keys(localByPath).forEach(function (p) {
          if (remoteMd[p]) return;
          if (state.files[p]) {
            // 同步过，现在云端没了 → 云端删除，本地也删（除非本地刚改过）
            var localChanged = hashCard(localByPath[p]) !== (state.files[p].localHash || '');
            if (localChanged) jobs.push({ type: 'push', path: p, local: localByPath[p], sha: null });
            else jobs.push({ type: 'delLocal', path: p });
          } else {
            jobs.push({ type: 'push', path: p, local: localByPath[p], sha: null });
          }
        });

        /* ---- 3. 附件（图片） ---- */
        var localBlobMap = {};
        localBlobs.forEach(function (b) { localBlobMap[ATTACH_DIR + b.name] = b; });
        Object.keys(remoteBin).forEach(function (p) {
          var st = state.files[p];
          if (!localBlobMap[p]) { jobs.push({ type: 'pullBin', path: p, sha: remoteBin[p].sha }); return; }
          if (!st || st.remoteSha !== remoteBin[p].sha) { jobs.push({ type: 'pullBin', path: p, sha: remoteBin[p].sha }); }
        });
        Object.keys(localBlobMap).forEach(function (p) {
          if (remoteBin[p]) return;
          jobs.push({ type: 'pushBin', path: p, blob: localBlobMap[p] });
        });

        log('需要处理 ' + jobs.length + ' 项');
        return runJobs(jobs, cfg, state, tombstones, result, log);
      })
      .then(function () {
        state.at = global.LocalAPI.nowStr();
        return saveState(state);
      })
      .then(function () {
        result.ms = Date.now() - t0;
        return result;
      });
  }

  /**
   * 本地卡片 → 仓库路径。
   * 一定要用 card.id（它由"类别/文件名"构成，创建时就做过非法字符清理），
   * 绝不能用 card.title —— 标题里可能带引号、斜杠（比如「被控对象：1/(s^2+3s+2)」），
   * 用标题当路径会把斜杠变成子目录，产生一堆畸形文件。
   */
  function pathOf(card) { return FILE_PREFIX + card.id; }
  /** 仓库路径 → 本地卡片 id（去掉「笔记/」前缀）。注意本地 id 是带 .md 的，别把后缀删掉，
      否则和"删除墓碑"里的键对不上，已删的卡片会被云端同步回来。 */
  function localIdOf(p) { return p.slice(FILE_PREFIX.length); }
  /** 仓库路径 → 类别名 */
  function catOf(p) {
    var a = p.slice(FILE_PREFIX.length).split('/');
    a.pop();
    return a.join('/') || '未分类';
  }

  /** 冲突处理：先比真内容；真一样就只更新状态，否则云端那份另存为「(云端副本)」 */
  function doConflict(job, cfg, state, result, log) {
    return getFile(job.path, cfg).then(function (f) {
      var remoteParsed = global.LocalAPI.parseNote(f.content, baseName(job.path));
      if (cardHash(remoteParsed) === hashCard(job.local)) {
        // 内容其实一模一样（只是同步记录过期了）→ 不算冲突
        state.files[job.path] = { remoteSha: job.sha, localHash: hashCard(job.local) };
        result.skipped++;
        return null;
      }
      log('⚠ 冲突 ' + job.path);
      var cat = catOf(job.path);
      var remoteTitle = (remoteParsed.meta.title || baseName(job.path)) + ' (云端副本)';
      var remoteId = cat + '/' + remoteTitle + '.md';
      return global.LocalAPI.putCard({
        id: remoteId, cat: cat, title: remoteTitle,
        tags: remoteParsed.meta.tags, created: remoteParsed.meta.created,
        updated: remoteParsed.meta.updated, pinned: !!remoteParsed.meta.pinned,
        content: remoteParsed.content
      }).then(function () {
        // 本地那份推上去覆盖云端
        return putFile(job.path, global.LocalAPI.serializeNote({
          title: job.local.title, tags: job.local.tags, created: job.local.created,
          updated: job.local.updated, pinned: job.local.pinned
        }, job.local.content), '解决冲突（保留本地版）', job.sha, cfg);
      }).then(function (res) {
        var sha = (res && res.content && res.content.sha) || (res && res.sha);
        state.files[job.path] = { remoteSha: sha, localHash: hashCard(job.local) };
        // 云端副本也要推到远端，否则下次同步它又会被当成"本地新增"
        var cpath = FILE_PREFIX + cat + '/' + remoteTitle + '.md';
        return putFile(cpath, global.LocalAPI.serializeNote({
          title: remoteTitle, tags: remoteParsed.meta.tags,
          created: remoteParsed.meta.created, updated: remoteParsed.meta.updated,
          pinned: !!remoteParsed.meta.pinned
        }, remoteParsed.content), '冲突副本', undefined, cfg).then(function (res2) {
          var sha2 = (res2 && res2.content && res2.content.sha) || (res2 && res2.sha);
          state.files[cpath] = { remoteSha: sha2, localHash: cardHash(remoteParsed) };
          result.conflicts.push({ path: job.path, savedAs: remoteTitle });
        });
      });
    });
  }

  function runJobs(jobs, cfg, state, tombstones, result, log) {
    var chain = Promise.resolve();
    jobs.forEach(function (job) {
      chain = chain.then(function () {
        switch (job.type) {
          case 'pull':
            log('↓ ' + job.path);
            return getFile(job.path, cfg).then(function (f) {
              var r = global.LocalAPI.parseNote(f.content, baseName(job.path));
              var cat = catOf(job.path);
              var title = r.meta.title || baseName(job.path);
              return global.LocalAPI.putCard({
                id: localIdOf(job.path), cat: cat, title: title,
                tags: r.meta.tags, created: r.meta.created, updated: r.meta.updated,
                pinned: !!r.meta.pinned, content: r.content
              }).then(function () {
                state.files[job.path] = { remoteSha: job.sha, localHash: cardHash(r) };
                result.pulled++;
              });
            });

          case 'push':
            log('↑ ' + job.path);
            return putFile(job.path, global.LocalAPI.serializeNote({
              title: job.local.title, tags: job.local.tags, created: job.local.created,
              updated: job.local.updated, pinned: job.local.pinned
            }, job.local.content), '更新 ' + job.local.title, job.sha || undefined, cfg)
              .then(function (res) {
                var sha = (res && res.content && res.content.sha) || (res && res.sha);
                state.files[job.path] = { remoteSha: sha, localHash: hashCard(job.local) };
                result.pushed++;
              });

          case 'firstCheck':
            // 首次见到这个文件：内容一致就只登记状态；不一致才算真冲突
            return getFile(job.path, cfg).then(function (f) {
              var rp = global.LocalAPI.parseNote(f.content, baseName(job.path));
              if (cardHash(rp) === hashCard(job.local)) {
                state.files[job.path] = { remoteSha: job.sha, localHash: hashCard(job.local) };
                result.skipped++;
                return null;
              }
              return doConflict(job, cfg, state, result, log);
            });

          case 'conflict':
            return doConflict(job, cfg, state, result, log);

          case 'delRemote':
            log('✕ 云端删除 ' + job.path);
            return delFile(job.path, job.sha, '删除卡片', cfg).then(function () {
              delete state.files[job.path];
              result.deleted++;
            });

          case 'delLocal':
            log('✕ 本地删除 ' + job.path);
            return global.LocalAPI.delCard(localIdOf(job.path)).then(function () {
              delete state.files[job.path];
              result.deleted++;
            });

          case 'pullBin':
            log('↓ 图片 ' + job.path);
            return getFile(job.path, cfg).then(function (f) {
              var name = job.path.split('/').pop();
              // 二进制图片：Gitee 返回的是 base64，直接拼成 dataURL 存起来
              var raw = f.content;    // b64decode 对二进制会丢字节，这里重新取一次原始 base64
              return request('GET', repoPath('/contents/' + encodeURI(job.path) + '?ref=' + encodeURIComponent(cfg.branch || 'master')), null, cfg)
                .then(function (meta) {
                  var dataUrl = 'data:image/' + ext2mime(job.path) + ';base64,' + String(meta.content || '').replace(/[\r\n\s]/g, '');
                  return global.LocalAPI.saveBlob(name, dataUrl).then(function () {
                    state.files[job.path] = { remoteSha: job.sha };
                    result.pulled++;
                  });
                });
            });

          case 'pushBin':
            log('↑ 图片 ' + job.path);
            return global.LocalAPI.getBlob(job.blob.name).then(function (b) {
              var b64 = String(b && b.data || '').split(',')[1] || '';
              return request('POST', repoPath('/contents/' + encodeURI(job.path)),
                { content: b64, message: '上传图片 ' + job.blob.name, branch: cfg.branch || 'master' }, cfg)
                .then(function (res) {
                  var sha = (res && res.content && res.content.sha) || (res && res.sha);
                  state.files[job.path] = { remoteSha: sha };
                  result.pushed++;
                });
            });

          default:
            return Promise.resolve();
        }
      }).catch(function (e) {
        log('⚠ 失败 ' + job.path + '：' + e.message);
      });
    });
    return chain;
  }

  function baseName(p) { return p.split('/').pop().replace(/\.md$/i, ''); }
  function dirName(p) { var a = p.split('/'); a.pop(); return a.join('/') || '未分类'; }
  function ext2mime(p) {
    var e = (p.split('.').pop() || 'png').toLowerCase();
    return e === 'jpg' ? 'jpeg' : e;
  }

  /** 首次配置：创建仓库（如果没有），并把本地卡片全部推上去 */
  function bootstrap(onLog) {
    var log = onLog || function () {};
    var cfg = getConfig();
    return request('GET', repoPath('/'), null, cfg).then(function (repo) {
      if (!cfg.branch) { cfg.branch = repo.default_branch || 'master'; setConfig(cfg); }
      return { created: false, repo: repo };
    }).catch(function (e) {
      if (String(e.message).indexOf('不存在') < 0) throw e;
      log('仓库不存在，正在创建…');
      return request('POST', '/user/repos', {
        name: cfg.repo, description: '卡片笔记的云端存储（.md 文件）',
        private: true, auto_init: true, gitignore_template: ''
      }, cfg).then(function (r) {
        cfg.branch = r.default_branch || 'master';
        setConfig(cfg);
        return { created: true, repo: r };
      });
    });
  }

  global.GiteeSync = {
    getConfig: getConfig,
    setConfig: setConfig,
    ready: ready,
    testConnection: testConnection,
    remoteTree: remoteTree,
    sync: sync,
    bootstrap: bootstrap,
    b64encode: b64encode,
    b64decode: b64decode,
    hash: hash
  };
})(window);
