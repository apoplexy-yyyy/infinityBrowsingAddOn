// ビューアの直接の子フレームでだけ動く。通常のブラウジングには一切影響しない。
// index.html のデモでは zbDemo を定義した iframe に読み込まれる(拡張の実行環境からは zbDemo は見えない)。
(() => {
  const demo = window.zbDemo;
  const viewerOrigin = demo ? '*' : chrome.runtime.getURL('').slice(0, -1);
  if (!demo && (window.parent === window || location.ancestorOrigins?.[0] !== viewerOrigin)) return;
  const currentHref = () => (demo ? demo.url : location.href);

  const REPORT_W = 150; // 画面上でこの幅以上のリンクをビューアへ報告する
  const REPORT_MIN_SCALE = 1.25; // この倍率未満では新しく開くリンクを報告しない
  const MAX_LINKS = 100;
  const DRAG_START = 4;
  const FEEDBACK_RATIO = 0.25;
  const PROBE_RATIO = 1.5;
  const PROBE_TIMEOUT = 500;
  const PROBE_MAX_PASSES = 10;
  const PROBE_AFTER_DOM_READY = 1500; // load を待ちきれないページでの調整開始までの時間

  const send = (msg) => window.parent.postMessage({ zb: true, ...msg }, viewerOrigin);

  let view = { s: 1, x: 0, y: 0, w: innerWidth, h: innerHeight, open: [] };
  let lastReport = '';
  let scanQueued = false;
  let probed = false;
  let lastInnerHeight = innerHeight;
  const openPositions = new Map(); // 開いたリンクの現在位置。同じ URL のリンクが複数あるときの取り違えを防ぐ

  function pageUrl(url) {
    return url.split('#')[0];
  }

  const docHeight = () =>
    Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  function scan() {
    scanQueued = false;
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const here = pageUrl(currentHref());
    const open = new Set(view.open);
    const nearest = new Map();
    for (const a of document.links) {
      const href = a.href;
      if (!/^https?:/.test(href) || pageUrl(href) === here) continue;
      const r = a.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const isOpen = open.has(href);
      if (!isOpen) {
        if (view.s < REPORT_MIN_SCALE || r.width * view.s < REPORT_W) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      }
      const from = isOpen ? openPositions.get(href) : null;
      const dist = from
        ? Math.hypot(r.left - from.x, r.top - from.y)
        : Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
      const prev = nearest.get(href);
      if (!prev || dist < prev.dist) {
        nearest.set(href, { href, x: r.left, y: r.top, w: r.width, h: r.height, dist, isOpen });
      }
    }
    // 開いたリンクは個数制限で落とさない
    const links = [...nearest.values()]
      .sort((a, b) => b.isOpen - a.isOpen || a.dist - b.dist)
      .slice(0, Math.max(MAX_LINKS, open.size));
    openPositions.clear();
    for (const link of links) openPositions.set(link.href, { x: link.x, y: link.y });
    const report = JSON.stringify({
      type: 'links',
      url: currentHref(),
      title: document.title,
      scrollX,
      scrollY,
      docHeight: probed === true ? docHeight() : 0,
      links: links.map(({ dist, isOpen, ...link }) => link),
    });
    if (report !== lastReport) {
      lastReport = report;
      send(JSON.parse(report));
    }
    checkAutoPage();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data?.zb) return;
    if (e.data.type === 'view') {
      view = e.data.view;
      queueScan();
    } else if (e.data.type === 'welcome' && e.data.scroll) {
      const restore = () => scrollTo(e.data.scroll.x, e.data.scroll.y);
      restore();
      addEventListener('load', restore, { once: true });
    }
  });

  addEventListener('scroll', queueScan, { capture: true, passive: true });
  addEventListener('resize', () => {
    // 伸ばした直後に文書が伸び幅に比例して長いままなら、高さがフレームに連動している。伸ばし続けないよう止める
    const grown = innerHeight - lastInnerHeight;
    lastInnerHeight = innerHeight;
    if (probed === true && grown > 1 && docHeight() - innerHeight > grown * FEEDBACK_RATIO) send({ type: 'freeze' });
    queueScan();
  });
  addEventListener('load', queueScan);

  // --- 縦長表示の準備 ---
  // フレームを文書の全長まで伸ばすと 100vh の要素まで一緒に伸びるため、先にフレームを少し伸ばして
  // 高さが連動する要素を見つけ、1画面分の高さに固定しておく。
  function waitForResize() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        removeEventListener('resize', done);
        resolve();
      };
      const timer = setTimeout(done, PROBE_TIMEOUT);
      addEventListener('resize', done);
    });
  }

  function resizeFrame(h) {
    const resized = waitForResize();
    send({ type: 'probe', h });
    return resized;
  }

  async function pinViewportHeights() {
    if (probed || !document.body) return;
    probed = 'running';
    const baseH = innerHeight;
    const probeH = Math.round(baseH * PROBE_RATIO);
    const heights = new Map();
    const hasChanged = (el) => Math.abs(el.getBoundingClientRect().height - heights.get(el)) > 0.5;
    for (const el of document.body.querySelectorAll('*')) heights.set(el, el.getBoundingClientRect().height);

    await resizeFrame(probeH);
    const grown = [...heights.keys()].filter(hasChanged);
    // 読み込みや無限スクロールでも要素は伸びる。フレームを戻すと縮むものだけが連動している
    await resizeFrame(baseH);
    const linked = grown.filter((el) => !hasChanged(el));
    await resizeFrame(probeH);

    // 内側から順に固定する。外側の要素は中身が固定されれば元の高さに戻るので、固定せずに済む
    for (let pass = 0; pass < PROBE_MAX_PASSES; pass++) {
      const changed = linked.filter(hasChanged);
      if (!changed.length) break;
      const deepest = changed.filter((el) => !changed.some((other) => other !== el && el.contains(other)));
      for (const el of deepest) {
        el.style.setProperty('height', `${heights.get(el)}px`, 'important');
        el.style.setProperty('min-height', '0', 'important');
      }
    }
    // 先に元の高さへ戻す。伸ばしたままだとフレームの高さを文書の高さとして報告してしまう
    await resizeFrame(baseH);
    probed = true;
    send({ type: 'probeDone' });
    queueScan();
  }

  let probeTimer = 0;
  addEventListener('load', () => {
    clearTimeout(probeTimer);
    pinViewportHeights();
  });

  // --- オートページャ ---
  const MAX_AUTO_PAGES = 100;
  const AUTOPAGE_QUIET = 1200; // ページ自身の無限スクロールと二重に読み込まないよう、伸びが止まるのを待つ
  const AUTOPAGE_TRIGGER = 0.1; // 末尾がほぼ見えてから動く(ページ自身の無限スクロールに先を譲るため)
  const AUTOPAGE_MIN_CARD_W = 100; // 小さく映っているだけのカードでは継ぎ足さない
  const DOMINANT_RATIO = 0.7;
  const NEXT_TEXT =
    /^[\s«‹<]*(次へ|次のページ|次ページ|次|次の\d+件|next|next page|older|older posts|›|»|→|>)[\s>›»→]*$/i;
  const NON_CONTENT = 'script,style,noscript,template,link,meta,iframe';
  const PAGER = 'nav,[class*="pagination" i],[class*="pager" i],[role="navigation"]';
  const NO_SEPARATOR_IN = 'ul,ol,table,thead,tbody,tr,dl,select';

  const autoPage = {
    visited: new Set([pageUrl(currentHref())]),
    nextUrl: undefined, // undefined は未検出、null はこれ以上ページがないことを表す
    container: null,
    prevDoc: null,
    pages: 1,
    busy: false,
    quietTimer: 0,
    quietHeight: 0,
  };

  function findNextUrl(doc, base) {
    const anchors = [...doc.querySelectorAll('a[href]')];
    const candidates = [
      ...doc.querySelectorAll('link[rel~="next" i][href],a[rel~="next" i][href]'),
      ...anchors.filter((a) => NEXT_TEXT.test(a.getAttribute('aria-label') || a.textContent)),
      ...doc.querySelectorAll(
        '[class*="pagination" i] a[class*="next" i],[class*="pager" i] a[class*="next" i],' +
          '[class*="pagination" i] [class*="next" i] a,[class*="pager" i] [class*="next" i] a'
      ),
    ];
    for (const el of candidates) {
      try {
        const url = new URL(el.getAttribute('href'), base);
        if (url.origin === new URL(currentHref()).origin && !autoPage.visited.has(pageUrl(url.href))) return url.href;
      } catch {
        // 不正な href は候補から外す
      }
    }
    return null;
  }

  // 比較用の内容。画像だけのページも見分けられるよう、画像とリンクの URL も含める
  function contentKey(el) {
    let key = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    // nextNode は起点を返さないので、el 自身も含むよう currentNode から始める
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.parentElement.closest(NON_CONTENT)) key += node.data;
      } else if (node.tagName === 'IMG') {
        key += node.getAttribute('data-src') || node.getAttribute('src') || '';
      } else if (node.tagName === 'A') {
        key += node.getAttribute('href') || '';
      }
    }
    return key.replace(/\s+/g, '');
  }

  const signature = (el) => `${el.tagName}#${el.id}.${el.classList[0] || ''}`;

  // 2つのページを上から比べ、内容の違いの大半が1つの子要素に収まる間だけ潜って本文の入れ物を探す
  function findContent(current, next) {
    let a = current;
    let b = next;
    for (;;) {
      const unused = [...a.children].filter((el) => !el.matches(NON_CONTENT));
      const diffs = [];
      for (const child of b.children) {
        if (child.matches(NON_CONTENT)) continue;
        const i = unused.findIndex((el) => signature(el) === signature(child));
        const partner = i < 0 ? null : unused.splice(i, 1)[0];
        const key = contentKey(child);
        if (!partner || contentKey(partner) !== key) diffs.push({ a: partner, b: child, size: key.length });
      }
      const total = diffs.reduce((sum, d) => sum + d.size, 0);
      const best = diffs.reduce((top, d) => (!top || d.size > top.size ? d : top), null);
      if (best?.a && best.size >= total * DOMINANT_RATIO && best.b.children.length) {
        a = best.a;
        b = best.b;
        continue;
      }
      const nodes = diffs.map((d) => d.b).filter((el) => !el.matches(`${PAGER},header,footer,aside`));
      return nodes.length ? { container: a, nodes } : null;
    }
  }

  // 読み込み元のページ基準で書かれた URL を解決し、スクリプトなしでは表示されない遅延画像を救う
  function prepareForInsert(el, base) {
    for (const node of [el, ...el.querySelectorAll('*')]) {
      for (const attr of ['href', 'src']) {
        if (node.hasAttribute(attr)) {
          try {
            node.setAttribute(attr, new URL(node.getAttribute(attr), base).href);
          } catch {
            // 解決できない値はそのまま残す
          }
        }
      }
      if (node.tagName === 'IMG') {
        const lazy = ['data-src', 'data-lazy-src', 'data-original'].map((n) => node.getAttribute(n)).find(Boolean);
        if (lazy) node.src = new URL(lazy, base).href;
      }
    }
    el.querySelectorAll('script').forEach((script) => script.remove());
    return document.importNode(el, true);
  }

  function insertPage(nodes, url) {
    const container = autoPage.container;
    const pagers = [...container.children].filter((el) => el.matches(PAGER) || el.querySelector(PAGER));
    const before = pagers.at(-1) || null;
    autoPage.pages++;
    if (!container.matches(NO_SEPARATOR_IN)) {
      const separator = document.createElement('div');
      separator.dataset.zbPage = autoPage.pages;
      separator.style.cssText =
        'clear:both;margin:24px 0;padding:6px;text-align:center;font:13px sans-serif;color:#667;border-top:1px dashed #99a';
      separator.textContent = `ページ ${autoPage.pages}`;
      container.insertBefore(separator, before);
    }
    for (const node of nodes) container.insertBefore(prepareForInsert(node, url), before);
  }

  async function fetchPage(url) {
    if (demo) return { url, html: demo.fetchPage(url) };
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) throw new Error(res.status);
    // res.text() は UTF-8 固定なので、Shift_JIS などのサイトでは文字化けする
    return { url: res.url, html: new TextDecoder(document.characterSet).decode(await res.arrayBuffer()) };
  }

  async function loadNextPage() {
    const url = autoPage.nextUrl;
    autoPage.busy = true;
    try {
      const res = await fetchPage(url);
      autoPage.visited.add(pageUrl(url));
      autoPage.visited.add(pageUrl(res.url));
      const doc = new DOMParser().parseFromString(res.html, 'text/html');
      const found = findContent(autoPage.prevDoc?.body || document.body, doc.body);
      if (!found) throw new Error('no content');
      autoPage.container ||= found.container;
      autoPage.nextUrl = findNextUrl(doc, res.url);
      insertPage(found.nodes, res.url);
      autoPage.prevDoc = doc;
      send({ type: 'appended' });
    } catch {
      autoPage.nextUrl = null;
    }
    autoPage.busy = false;
    queueScan();
  }

  function checkAutoPage() {
    if (probed !== true || !view.screenH || autoPage.busy || autoPage.nextUrl === null) return;
    if (autoPage.pages >= MAX_AUTO_PAGES || innerWidth * view.s < AUTOPAGE_MIN_CARD_W) return;
    const height = docHeight();
    const gap = (height - (view.y + view.h)) * view.s;
    if (gap >= view.screenH * AUTOPAGE_TRIGGER) {
      clearTimeout(autoPage.quietTimer);
      autoPage.quietTimer = 0;
      return;
    }
    if (autoPage.nextUrl === undefined) {
      autoPage.nextUrl = findNextUrl(document, currentHref());
      if (autoPage.nextUrl === null) return;
    }
    if (autoPage.quietTimer && autoPage.quietHeight === height) return;
    clearTimeout(autoPage.quietTimer);
    autoPage.quietHeight = height;
    autoPage.quietTimer = setTimeout(() => {
      autoPage.quietTimer = 0;
      if (docHeight() === autoPage.quietHeight) loadNextPage();
      else queueScan();
    }, AUTOPAGE_QUIET);
  }

  // --- ズーム ---
  addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1;
      send({ type: 'wheel', dy: e.deltaY * unit, x: e.clientX, y: e.clientY });
    },
    { capture: true, passive: false }
  );

  // --- ドラッグ移動 ---
  const isEditable = (el) =>
    el instanceof Element && !!el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]');

  let drag = null;
  let suppressClick = false;

  function scrollableChain(target) {
    const chain = [];
    for (let el = target; el instanceof Element; el = el.parentElement) {
      if (el === document.documentElement || el === document.body) break;
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) chain.push(el);
    }
    if (document.scrollingElement) chain.push(document.scrollingElement);
    return chain;
  }

  // 指定軸をスクロールし、使い切れなかった量を返す。d は scroll 量(ページ座標)
  function scrollAxis(chain, axis, d) {
    const prop = axis === 'x' ? 'scrollLeft' : 'scrollTop';
    const max = axis === 'x' ? (el) => el.scrollWidth - el.clientWidth : (el) => el.scrollHeight - el.clientHeight;
    for (const el of chain) {
      if (d === 0) break;
      const cur = el[prop];
      const next = Math.min(max(el), Math.max(0, cur + d));
      if (next === cur) continue;
      el[prop] = next;
      d -= next - cur;
    }
    return d;
  }

  // 1軸分の移動を「ビューアのパン → ページのスクロール → 残りをパン」の順に割り振る。
  // 拡大中はカードの端が画面に来るまで滑らかにパンし、端に達してから中身がスクロールする。
  function moveAxis(axis, screenDelta) {
    const s = view.s;
    const hiddenBefore = axis === 'x' ? view.x : view.y;
    const hiddenAfter = axis === 'x' ? innerWidth - view.x - view.w : innerHeight - view.y - view.h;
    const budget = Math.max(0, (screenDelta > 0 ? hiddenBefore : hiddenAfter) * s);
    const pan = Math.sign(screenDelta) * Math.min(Math.abs(screenDelta), budget);
    let rest = screenDelta - pan;

    // scrollTop は整数に丸められるため、端数は次回へ持ち越す
    drag.carry[axis] -= rest / s;
    const whole = Math.trunc(drag.carry[axis]);
    drag.carry[axis] -= whole;
    const unused = whole === 0 ? 0 : scrollAxis(drag.chain, axis, whole);
    rest = -unused * s;
    return pan + rest;
  }

  addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || isEditable(e.target)) return;
      drag = {
        sx: e.screenX,
        sy: e.screenY,
        moved: false,
        chain: scrollableChain(e.target),
        carry: { x: 0, y: 0 },
      };
    },
    true
  );

  addEventListener(
    'mousemove',
    (e) => {
      if (!drag) return;
      if (e.buttons === 0) {
        drag = null;
        return;
      }
      const dx = e.screenX - drag.sx;
      const dy = e.screenY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_START) return;
      drag.moved = true;
      drag.sx = e.screenX;
      drag.sy = e.screenY;
      e.preventDefault();
      e.stopImmediatePropagation();
      const panX = moveAxis('x', dx);
      const panY = moveAxis('y', dy);
      if (panX || panY) send({ type: 'pan', dx: panX, dy: panY });
    },
    true
  );

  addEventListener(
    'mouseup',
    (e) => {
      if (drag?.moved) {
        suppressClick = true;
        setTimeout(() => (suppressClick = false));
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      drag = null;
    },
    true
  );

  addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // 修飾キー付きのクリックは「新しいタブで開く」などブラウザの動作に任せる
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href],area[href]') : null;
      if (!a || typeof a.href !== 'string' || a.hasAttribute('download')) return;
      // 同じページ内のリンクなどは通常どおり動かす
      if (!/^https?:/.test(a.href) || pageUrl(a.href) === pageUrl(currentHref())) return;
      const r = a.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openPositions.set(a.href, { x: r.left, y: r.top });
      send({ type: 'openLink', link: { href: a.href, x: r.left, y: r.top, w: r.width, h: r.height } });
    },
    true
  );

  addEventListener('dragstart', (e) => e.preventDefault(), true);
  addEventListener(
    'selectstart',
    (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    },
    true
  );

  // ページ内の iframe がホイールやドラッグを横取りしないようにする
  const style = document.createElement('style');
  // スクロールバーの有無で横幅が変わると、高さの連動を正しく検出できないので常に隠す
  style.textContent =
    'iframe,embed,object{pointer-events:none!important}html{cursor:grab;scrollbar-width:none}html:active{cursor:grabbing}';
  document.documentElement.append(style);

  addEventListener('DOMContentLoaded', () => {
    new MutationObserver(queueScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'style', 'class'],
    });
    new ResizeObserver(queueScan).observe(document.documentElement);
    if (document.body) new ResizeObserver(queueScan).observe(document.body);
    probeTimer = setTimeout(pinViewportHeights, PROBE_AFTER_DOM_READY);
    queueScan();
  });

  send({ type: 'hello', url: currentHref() });
})();
