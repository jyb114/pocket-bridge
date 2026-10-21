(function (global) {
  'use strict';

  // Image bytes enter only through the caller's authenticated loader. This
  // module never fetches paths, remote URLs, or stores content on its own.
  var MAX_IMAGE = 8 * 1024 * 1024;
  var MIME = /^image\/(png|jpeg|webp|gif)$/;

  function create(options) {
    options = options || {};
    var root = options.root;
    if (!root || typeof root.addEventListener !== 'function' || typeof options.load !== 'function' ||
        typeof options.getContext !== 'function') throw new TypeError('Image view requires a root, context and loader');
    var t = typeof options.translate === 'function' ? options.translate : function (value) { return value; };
    var document = root.ownerDocument;
    var disposed = false;
    var epoch = 0;
    var context = readContext();
    var figures = new Set();
    var targets = new WeakMap();
    var viewers = new Set();
    var jobs = new Map();
    var queue = [];
    var active = 0;
    var observer = null;
    var removals = null;
    var urlImages = new Map();
    var imageBindings = new WeakMap();
    var fallbackFrame = null;
    var fallbackNodes = [];
    var fallbackIndex = 0;
    var caches = {
      thumbnail: { entries: new Map(), bytes: 0, count: 24, maximum: 8 * 1024 * 1024 },
      original: { entries: new Map(), bytes: 0, count: 2, maximum: 16 * 1024 * 1024 }
    };

    function readContext() {
      try { var value = options.getContext(); return typeof value === 'string' && value ? value : null; }
      catch (_) { return null; }
    }
    function element(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(className, text) {
      var node = element('button', className, text);
      node.type = 'button';
      node.style.minHeight = '44px'; node.style.minWidth = '44px';
      return node;
    }
    function errorMessage(error) {
      return error && typeof error.userMessage === 'string' && error.userMessage.trim()
        ? error.userMessage.trim().slice(0, 300) : t('无法加载图片，请重试。');
    }
    function abortError() { var error = new Error('Image view cancelled'); error.name = 'AbortError'; return error; }
    function unsupported() { var error = new Error('Unsupported image'); error.userMessage = t('图片格式或大小不受支持。'); return error; }
    function safeName(value) {
      var name = typeof value === 'string' ? value.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().slice(0, 180) : '';
      return name || 'image.png';
    }
    function sourceCopy(source) {
      if (!source || (source.kind !== 'path' && source.kind !== 'attachment')) throw new TypeError('Invalid image source');
      var value = source.kind === 'path' ? source.path : source.attachmentId;
      if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Invalid image identity');
      var copy = { kind: source.kind, name: safeName(source.name) };
      copy[source.kind === 'path' ? 'path' : 'attachmentId'] = value;
      return copy;
    }
    function keyFor(source, variant) { return JSON.stringify([source.kind, source.path || source.attachmentId, variant]); }
    function current(capturedEpoch, capturedContext) {
      return !disposed && capturedEpoch === epoch && capturedContext !== null && capturedContext === context && readContext() === capturedContext;
    }
    function revoke(entry) {
      if (!entry || entry.revoked) return;
      entry.revoked = true;
      var bindings = urlImages.get(entry.url);
      if (bindings) {
        Array.from(bindings).forEach(function (binding) {
          unbindImage(binding.image);
          binding.image.onload = binding.image.onerror = null; binding.image.removeAttribute('src');
          if (binding.onEvict) binding.onEvict();
        });
      }
      global.URL.revokeObjectURL(entry.url);
    }
    function unbindImage(image) {
      var binding = imageBindings.get(image);
      if (!binding) return;
      var bindings = urlImages.get(binding.url);
      if (bindings) { bindings.delete(binding); if (!bindings.size) urlImages.delete(binding.url); }
      imageBindings.delete(image);
    }
    function bindImage(image, entry, onEvict) {
      unbindImage(image);
      var binding = { image: image, url: entry.url, onEvict: onEvict };
      if (!urlImages.has(entry.url)) urlImages.set(entry.url, new Set());
      urlImages.get(entry.url).add(binding); imageBindings.set(image, binding);
      image.src = entry.url;
    }
    function removeCached(variant, key, expected) {
      var cache = caches[variant]; var entry = cache.entries.get(key);
      if (!entry || (expected && entry !== expected)) return;
      cache.entries.delete(key); cache.bytes -= entry.blob.size; revoke(entry);
    }
    function cached(variant, key) {
      var cache = caches[variant]; var entry = cache.entries.get(key);
      if (!entry) return null;
      cache.entries.delete(key); cache.entries.set(key, entry);
      return entry;
    }
    function store(job, result) {
      var blob = result && result.blob;
      if (!(blob instanceof global.Blob) || !MIME.test(blob.type) || blob.size <= 0 || blob.size > MAX_IMAGE) throw unsupported();
      var cache = caches[job.variant];
      while (cache.entries.size >= cache.count || cache.bytes + blob.size > cache.maximum) {
        removeCached(job.variant, cache.entries.keys().next().value);
      }
      var entry = { blob: blob, name: safeName(result.name || job.source.name), url: global.URL.createObjectURL(blob), revoked: false };
      cache.entries.set(job.key, entry); cache.bytes += blob.size;
      return entry;
    }
    function finish(job, error, entry) {
      if (job.finished) return;
      job.finished = true;
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      if (job.started && job.epoch === epoch) active--;
      job.consumers.forEach(function (consumer) {
        if (consumer.done) return;
        consumer.done = true;
        if (error) consumer.reject(error); else consumer.resolve(entry);
      });
      job.consumers.clear();
      pump();
    }
    function pump() {
      if (disposed) return;
      while (active < 2 && queue.length) {
        var job = queue.shift();
        if (job.finished) continue;
        if (!current(job.epoch, job.context)) { finish(job, abortError()); continue; }
        job.started = true; active++;
        (function (running) {
          Promise.resolve().then(function () {
            if (!current(running.epoch, running.context) || running.controller.signal.aborted) throw abortError();
            return options.load(running.source, running.variant, { signal: running.controller.signal });
          }).then(function (result) {
            if (!current(running.epoch, running.context) || running.controller.signal.aborted || running.finished) throw abortError();
            finish(running, null, store(running, result));
          }).catch(function (error) { finish(running, error); });
        })(job);
      }
    }
    function acquire(source, variant) {
      syncContext();
      if (disposed || context === null) return { promise: Promise.reject(abortError()), cancel: function () {} };
      var key = keyFor(source, variant);
      var entry = cached(variant, key);
      if (entry) return { promise: Promise.resolve(entry), cancel: function () {} };
      var job = jobs.get(key);
      if (!job) {
        job = { key: key, source: source, variant: variant, epoch: epoch, context: context,
          controller: new global.AbortController(), consumers: new Set(), started: false, finished: false };
        jobs.set(key, job);
        if (variant === 'original') queue.unshift(job); else queue.push(job);
      }
      var consumer = { done: false };
      var promise = new Promise(function (resolve, reject) { consumer.resolve = resolve; consumer.reject = reject; });
      job.consumers.add(consumer);
      pump();
      return { promise: promise, cancel: function () {
        if (consumer.done) return;
        consumer.done = true; job.consumers.delete(consumer); consumer.reject(abortError());
        if (!job.consumers.size && !job.finished) { job.controller.abort(); finish(job, abortError()); }
      } };
    }
    function download(entry) {
      if (entry.revoked) throw abortError();
      var link = element('a'); link.href = entry.url; link.download = entry.name;
      link.hidden = true; document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    }
    function retire(holder) {
      if (holder.retired) return;
      holder.retired = true;
      if (holder.task) holder.task.cancel();
      if (holder.saveTask) holder.saveTask.cancel();
      if (holder.retryTimer !== null) global.clearTimeout(holder.retryTimer);
      unbindImage(holder.image);
      holder.image.onload = holder.image.onerror = null; holder.image.removeAttribute('src');
      holder.preview.disabled = holder.save.disabled = holder.retry.disabled = true;
      holder.status.textContent = t('图片已过期，请重新打开会话。');
      if (observer) observer.unobserve(holder.figure);
      figures.delete(holder);
    }
    function live(holder) {
      if (!current(holder.epoch, holder.context) || holder.retired) return false;
      if (holder.figure.isConnected) holder.mounted = true;
      else if (holder.mounted) { retire(holder); return false; }
      return true;
    }
    function thumbnailFailure(holder, error) {
      if (!live(holder) || error && error.name === 'AbortError') return;
      holder.task = null; holder.loading = false; holder.ready = false;
      unbindImage(holder.image);
      holder.image.onload = holder.image.onerror = null; holder.image.removeAttribute('src');
      holder.status.textContent = errorMessage(error);
      if (holder.attempts < 2) {
        holder.retryTimer = global.setTimeout(function () {
          holder.retryTimer = null;
          if (live(holder)) loadThumbnail(holder);
        }, 250);
      } else holder.retry.hidden = false;
    }
    function loadThumbnail(holder) {
      syncContext();
      if (!live(holder) || holder.loading || holder.ready || holder.attempts >= 2) return;
      holder.attempts++; holder.loading = true; holder.retry.hidden = true;
      holder.status.textContent = t('正在加载图片…');
      var task = acquire(holder.source, 'thumbnail'); holder.task = task;
      task.promise.then(function (entry) {
        if (!live(holder) || holder.task !== task) return;
        if (entry.revoked) { thumbnailFailure(holder, new Error('Image cache expired')); return; }
        holder.task = null;
        holder.image.onload = function () {
          if (!live(holder)) return;
          holder.image.onload = holder.image.onerror = null;
          holder.loading = false; holder.ready = true; holder.status.textContent = '';
        };
        holder.image.onerror = function () {
          unbindImage(holder.image);
          removeCached('thumbnail', keyFor(holder.source, 'thumbnail'), entry);
          thumbnailFailure(holder, unsupported());
        };
        bindImage(holder.image, entry, function () {
          if (!live(holder)) return;
          holder.loading = false; holder.ready = false; holder.attempts = 2;
          holder.status.textContent = t('预览已释放，点击重新加载。'); holder.retry.hidden = false;
        });
      }).catch(function (error) { thumbnailFailure(holder, error); });
    }
    function saveOriginal(holder) {
      syncContext();
      if (!live(holder) || holder.saveTask) return;
      holder.save.disabled = true; holder.status.textContent = t('正在读取原图…');
      var task = acquire(holder.source, 'original'); holder.saveTask = task;
      task.promise.then(function (entry) {
        if (!live(holder) || holder.saveTask !== task) return;
        download(entry); holder.status.textContent = '';
      }).catch(function (error) {
        if (live(holder) && error.name !== 'AbortError') holder.status.textContent = errorMessage(error);
      }).then(function () {
        if (holder.saveTask === task) holder.saveTask = null;
        if (live(holder)) holder.save.disabled = false;
      });
    }
    function openViewer(holder) {
      syncContext();
      if (!live(holder) || typeof options.openOverlay !== 'function') return;
      var viewer = { epoch: epoch, context: context, tasks: [], closed: false, handle: null };
      viewers.add(viewer);
      function valid() { return !viewer.closed && current(viewer.epoch, viewer.context); }
      function close() {
        if (viewer.closed) return;
        viewer.closed = true;
        viewer.tasks.forEach(function (task) { task.cancel(); }); viewer.tasks = [];
        if (viewer.clear) viewer.clear();
        viewers.delete(viewer);
      }
      viewer.cancel = close;
      try {
        viewer.handle = options.openOverlay(holder.source.name || t('图片预览'), function (dialog) {
          var body = dialog.body;
          if (typeof dialog.onClose === 'function') dialog.onClose(close);
          var wrap = element('div', 'dsh-image-viewer');
          var image = element('img', 'dsh-image-original'); image.alt = holder.source.name;
          var status = element('p', 'dsh-image-status', t('正在读取原图…')); status.setAttribute('role', 'status');
          var save = button('dsh-image-save', t('下载原图')); save.disabled = true;
          var retry = button('dsh-image-retry', t('重试图片')); retry.hidden = true;
          wrap.appendChild(image); wrap.appendChild(status); wrap.appendChild(retry); wrap.appendChild(save); body.appendChild(wrap);
          var originalReady = false;
          var originalTask = null;
          function forget(task) { var index = viewer.tasks.indexOf(task); if (index >= 0) viewer.tasks.splice(index, 1); }
          function display(entry) {
            if (!valid() || entry.revoked) return;
            bindImage(image, entry, function () {
              if (!valid()) return;
              originalReady = false; save.disabled = true; retry.hidden = false;
              status.textContent = t('预览已释放，点击重新加载。');
            });
          }
          var thumb = cached('thumbnail', keyFor(holder.source, 'thumbnail'));
          if (thumb) display(thumb);
          function readOriginal() {
            if (!valid() || originalTask) return;
            retry.hidden = true; status.textContent = t('正在读取原图…'); save.disabled = true;
            var task = acquire(holder.source, 'original'); originalTask = task; viewer.tasks.push(task);
            task.promise.then(function (entry) {
              forget(task);
              if (!valid() || originalTask !== task) return;
              originalTask = null;
              if (entry.revoked) { status.textContent = errorMessage(null); retry.hidden = false; return; }
              image.onload = function () {
                if (!valid()) return;
                image.onload = image.onerror = null; originalReady = true; save.disabled = false; status.textContent = '';
              };
              image.onerror = function () {
                if (!valid()) return;
                unbindImage(image);
                removeCached('original', keyFor(holder.source, 'original'), entry);
                image.onload = image.onerror = null; image.removeAttribute('src'); originalReady = false;
                status.textContent = errorMessage(unsupported()); retry.hidden = false;
              };
              display(entry);
            }).catch(function (error) {
              forget(task);
              if (!valid() || error.name === 'AbortError') return;
              originalTask = null; status.textContent = errorMessage(error); retry.hidden = false;
            });
          }
          retry.addEventListener('click', readOriginal);
          save.addEventListener('click', function () {
            if (!valid() || !originalReady || originalTask) return;
            var task = acquire(holder.source, 'original'); originalTask = task; viewer.tasks.push(task); save.disabled = true;
            task.promise.then(function (entry) { forget(task); if (valid()) download(entry); }).catch(function (error) {
              forget(task);
              if (valid() && error.name !== 'AbortError') status.textContent = errorMessage(error);
            }).then(function () { if (originalTask === task) originalTask = null; if (valid()) save.disabled = false; });
          });
          viewer.clear = function () { unbindImage(image); image.onload = image.onerror = null; image.removeAttribute('src'); };
          readOriginal();
        });
        if (viewer.handle && typeof viewer.handle.onClose === 'function') viewer.handle.onClose(close);
      } catch (error) { close(); holder.status.textContent = errorMessage(error); }
    }
    function checkFallback() {
      fallbackFrame = null;
      syncContext();
      if (disposed || observer) return;
      var bounds = root.getBoundingClientRect();
      var end = Math.min(fallbackNodes.length, fallbackIndex + 100);
      for (; fallbackIndex < end; fallbackIndex++) {
        var holder = fallbackNodes[fallbackIndex];
        if (!live(holder)) continue;
        var rect = holder.figure.getBoundingClientRect();
        if (bounds.height && rect.height && rect.bottom >= bounds.top - 240 && rect.top <= bounds.bottom + 240) loadThumbnail(holder);
      }
      if (fallbackIndex < fallbackNodes.length) fallbackFrame = global.requestAnimationFrame(checkFallback);
    }
    function scheduleFallback() {
      if (disposed || observer) return;
      fallbackNodes = Array.from(figures); fallbackIndex = 0;
      if (fallbackFrame !== null) return;
      fallbackFrame = global.requestAnimationFrame(checkFallback);
    }
    function build(source) {
      syncContext();
      var invalid = false;
      try { source = sourceCopy(source); }
      catch (_) { invalid = true; source = { kind: 'path', path: '', name: safeName(source && source.name) }; }
      var figure = element('figure', 'dsh-image-figure');
      var preview = button('dsh-image-preview', undefined);
      preview.setAttribute('aria-label', t('查看图片') + ': ' + source.name);
      var image = element('img', 'dsh-image-thumbnail'); image.alt = source.name; image.decoding = 'async';
      preview.appendChild(image);
      var caption = element('figcaption', 'dsh-image-caption', source.name);
      var status = element('p', 'dsh-image-status', t('图片将在接近屏幕时加载。')); status.setAttribute('role', 'status');
      var retry = button('dsh-image-retry', t('重试图片')); retry.hidden = true;
      var save = button('dsh-image-save', t('下载原图'));
      figure.appendChild(preview); figure.appendChild(caption); figure.appendChild(status); figure.appendChild(retry); figure.appendChild(save);
      var holder = { source: source, figure: figure, preview: preview, image: image, status: status, retry: retry, save: save,
        epoch: epoch, context: context, attempts: 0, loading: false, ready: false, retired: false,
        task: null, saveTask: null, retryTimer: null, mounted: false };
      preview.addEventListener('click', function () { openViewer(holder); });
      save.addEventListener('click', function () { saveOriginal(holder); });
      retry.addEventListener('click', function () { holder.attempts = 0; loadThumbnail(holder); });
      figures.add(holder); targets.set(figure, holder);
      if (invalid || disposed || context === null) {
        retire(holder);
        if (invalid) status.textContent = t('图片格式或大小不受支持。');
      }
      else if (observer) observer.observe(figure);
      else scheduleFallback();
      return { figure: figure, save: save };
    }
    function clearState() {
      epoch++;
      queue = [];
      if (observer) observer.disconnect();
      figures.forEach(retire); figures.clear();
      viewers.forEach(function (viewer) {
        viewer.cancel();
        if (viewer.handle && typeof viewer.handle.close === 'function') viewer.handle.close();
      }); viewers.clear();
      jobs.forEach(function (job) { job.controller.abort(); finish(job, abortError()); }); jobs.clear(); active = 0;
      Object.keys(caches).forEach(function (variant) {
        caches[variant].entries.forEach(revoke); caches[variant].entries.clear(); caches[variant].bytes = 0;
      });
      fallbackNodes = []; fallbackIndex = 0;
      if (fallbackFrame !== null) global.cancelAnimationFrame(fallbackFrame);
      fallbackFrame = null;
    }
    function syncContext() {
      var next = disposed ? null : readContext();
      if (next !== context) { clearState(); context = next; }
      return context;
    }
    function reset() { clearState(); context = disposed ? null : readContext(); }
    function dispose() {
      if (disposed) return;
      disposed = true; reset();
      if (removals) removals.disconnect();
      root.removeEventListener('scroll', scheduleFallback);
      global.removeEventListener('resize', scheduleFallback);
    }
    if (typeof global.IntersectionObserver === 'function') {
      try {
        observer = new global.IntersectionObserver(function (entries) {
          syncContext();
          entries.forEach(function (entry) {
            var holder = targets.get(entry.target);
            if (holder && entry.isIntersecting && live(holder)) loadThumbnail(holder);
            else if (holder && holder.mounted && !holder.figure.isConnected) retire(holder);
          });
        }, { root: root, rootMargin: '240px' });
      } catch (_) { observer = null; }
    }
    root.addEventListener('scroll', scheduleFallback, { passive: true });
    global.addEventListener('resize', scheduleFallback, { passive: true });
    if (typeof global.MutationObserver === 'function') {
      removals = new global.MutationObserver(function (records) {
        records.forEach(function (record) {
          Array.from(record.removedNodes).forEach(function (node) {
            if (node.nodeType !== 1) return;
            var holder = targets.get(node);
            if (holder && !node.isConnected) retire(holder);
            Array.from(node.querySelectorAll('.dsh-image-figure')).forEach(function (figure) {
              var child = targets.get(figure); if (child && !figure.isConnected) retire(child);
            });
          });
        });
      });
      removals.observe(root, { childList: true, subtree: true });
    }
    return { build: build, reset: reset, dispose: dispose, syncContext: syncContext };
  }

  global.DshImageView = { create: create };
})(window);
