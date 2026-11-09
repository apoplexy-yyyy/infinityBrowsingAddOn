// すべてのページを同じ階層の iframe(カード)として並べ、カメラ操作で入れ子に見せる。
// 実際に iframe を入れ子にしないのは、深い階層でも座標変換と操作を親子間で中継せずに済むため。
const OPEN_W = 220; // 画面上のリンク幅がこの値を超えたらリンク先を開く
const OPEN_MIN_SCALE = 1.5; // 長いリンクが等倍のまま開いてページを覆わないようにする
const OPEN_DELAY = 150; // 拡大の途中で通過するだけのリンクを読み込まないための待ち時間
const MAX_LIVE_FRAMES = 12; // カードは閉じないので、読み込んだままにする iframe の数だけ制限する
const UNLOAD_SCALE = 300; // 十分に拡大され隠れた祖先はメモリ節約のため破棄する
const RELOAD_SCALE = 100;
const MIN_LOAD_W = 60; // これより小さく映るカードは読み直さない
const MIN_CARD_RATIO = 0.5; // カードは親の半分より小さくしない。リンク幅だけで決めると階層ごとに極端に縮む
const CLOSE_SIZE = window.zbSite && matchMedia('(any-pointer: coarse)').matches ? 36 : 24; // ×ボタンの画面上の大きさ
const TAP_MOVE = 8; // これ以上動いたらタップではなくドラッグとして扱う
const TAP_TIME = 500;
const ZOOM_OUT_HOLD = 300; // ピンチで縮小している間は新しいリンクを開かない
const CLOSE_INSET = 4;
const CLOSE_MIN_CARD_W = 48; // これより小さく映るカードには×ボタンを出さない
const LINK_GAP = 0.5; // リンクとカードの間隔(リンクの高さに対する比率)
const CARD_GAP = 48; // カード同士の間隔(カード内の座標)
const PAGE_GAP = 24; // 親ページとカードの間隔(親ページの座標)
const ALLOW_OVERLAP_KEY = 'allowOverlap';
const PUSH_PASSES = 20;
const PUSH_EASE = 0.25;
const MIN_ROOT_SCALE = 0.1;
// 最初のページの初期倍率。レイアウトの幅は画面と同じままで、空いた右側と下側にリンク先が開ける
const INITIAL_SCALE = 0.67;
const MAX_SCALE = 40;
const PAGE_H_STEP = 20000; // ページ自身の無限スクロールが一気に走らないよう、末尾に近づいた分だけ上限を広げる
const MAX_PAGE_H = 500000;
const READY_TIMEOUT = 10000;
const ZOOM_SPEED = 0.002;
const FLY_EASE = 0.15; // 開いているページへ移動するときのカメラの追従率

const demoSite = window.zbSite; // index.html のデモで実サイトの代わりに表示するサイト
// デモのページは同じオリジンなので、タッチ端末では操作をすべてビューアで受け、タップだけページへ渡す。
// 指が複数の iframe にまたがっても、ピンチを1つの操作として扱える
const touchMode = Boolean(demoSite) && matchMedia('(any-pointer: coarse)').matches;
const stage = document.getElementById('stage');
const hud = {
  depth: document.getElementById('hud-depth'),
  title: document.getElementById('hud-title'),
  zoom: document.getElementById('hud-zoom'),
};

const cards = new Set(); // 追加順は重なり順(後のものほど手前)と一致する
let root = null;
let anchor = null; // カメラの基準カード。座標はここから相対的に求め、深い階層でも精度を保つ
let zoomPending = 0;
let zoomPivot = { x: 0, y: 0 };
let frameQueued = false;
let lastZoomOutAt = -Infinity;
let allowOverlap = false;
let pendingLink = null; // 開く直前のリンク { card, href, since }
let flight = null; // 開いているページへの移動中 { card }

const isHttpUrl = (url) => {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};

function queueFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(tick);
}

// --- カードの生成と破棄 ---
function createCard(url, parent, link) {
  const card = {
    url,
    title: '',
    parent,
    children: new Map(),
    dismissed: new Set(), // ×で閉じたリンク。拡大しただけでは開き直さない
    w: innerWidth,
    viewH: innerHeight, // ページの1画面分。リンクへの配置やレイアウト調整の基準
    h: innerHeight, // スクロール先まで含めたカードの高さ
    frameH: innerHeight,
    maxH: PAGE_H_STEP,
    docHeight: 0,
    frozen: false,
    k: 1,
    ox: 0,
    oy: 0,
    x: 0,
    y: 0,
    s: 1,
    links: [],
    frame: null,
    readyAt: 0,
    scroll: null,
    restore: null,
    lastView: '',
    lastTransform: '',
    el: document.createElement('div'),
    placeholder: document.createElement('div'),
  };
  card.el.className = 'card';
  card.el.style.width = `${card.w}px`;
  card.el.style.height = `${card.h}px`;
  card.placeholder.className = 'placeholder';
  card.placeholder.style.height = `${card.viewH}px`;
  card.placeholder.textContent = `読み込み中… ${new URL(url).host}`;
  card.el.append(card.placeholder);
  stage.append(card.el);
  cards.add(card);
  if (parent) {
    card.closeButton = createCloseButton(card);
    parent.children.set(url, card);
    positionChild(card, link);
    requestAnimationFrame(() => queueFrame());
  }
  loadFrame(card);
  return card;
}

function createCloseButton(card) {
  const button = document.createElement('button');
  button.className = 'card-close';
  button.type = 'button';
  button.textContent = '×';
  button.title = 'このリンク先を閉じる';
  button.setAttribute('aria-label', 'このリンク先を閉じる');
  // ステージのドラッグ移動を始めさせない
  button.addEventListener('pointerdown', (e) => e.stopPropagation());
  button.addEventListener('click', () => {
    card.parent.dismissed.add(card.url);
    closeCard(card);
    queueFrame();
  });
  stage.append(button);
  return button;
}

// カードが画面より大きくても押せるよう、見えている範囲の右上に置く
function placeCloseButton(card, visible) {
  const button = card.closeButton;
  if (!button) return;
  const width = card.w * card.s;
  const right = Math.min(card.x + width, innerWidth);
  const top = Math.max(card.y, 0);
  const show = visible && width >= CLOSE_MIN_CARD_W && right - CLOSE_SIZE - CLOSE_INSET >= card.x;
  button.style.display = show ? 'block' : 'none';
  if (show) button.style.transform = `translate(${right - CLOSE_SIZE - CLOSE_INSET}px, ${top + CLOSE_INSET}px)`;
}

function loadFrame(card) {
  const frame = document.createElement('iframe');
  // allow-top-navigation を与えず、フレーム脱出スクリプトでビューアが置き換わるのを防ぐ
  frame.sandbox =
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
  if (demoSite) frame.srcdoc = demoSite.render(card.url);
  else frame.src = card.url;
  card.frame = frame;
  setFrameHeight(card, card.viewH);
  card.el.classList.remove('ready');
  card.el.append(frame);
  clearTimeout(card.readyTimer);
  card.readyTimer = setTimeout(() => {
    card.placeholder.textContent = '';
    const message = document.createElement('div');
    message.textContent = 'このページは埋め込み表示できませんでした';
    const detail = document.createElement('small');
    detail.textContent = `${card.url}(↗ で新しいタブに開けます)`;
    card.placeholder.append(message, detail);
  }, READY_TIMEOUT);
}

function setFrameHeight(card, h) {
  card.frameH = h;
  if (card.frame) card.frame.style.height = `${h}px`;
}

function unloadFrame(card) {
  card.frame.remove();
  card.frame = null;
  card.readyAt = 0;
  card.restore = card.scroll;
  card.lastView = '';
  clearTimeout(card.readyTimer);
  card.el.classList.remove('ready');
}

function closeCard(card) {
  for (const child of [...card.children.values()]) closeCard(child);
  if (anchor === card) anchor = card.parent;
  if (pendingLink?.card === card) pendingLink = null;
  card.parent?.children.delete(card.url);
  clearTimeout(card.readyTimer);
  card.el.remove();
  card.closeButton?.remove();
  cards.delete(card);
}

function positionChild(card, link) {
  card.k = Math.max(link.w / card.w, link.h / card.viewH, MIN_CARD_RATIO);
  card.link = link;
  queueFrame();
}

// 重なりを許可するとリンクの右横、許可しないと親ページの外側の右横が基準の位置になる
function basePosition(card) {
  const { link, parent } = card;
  return {
    x: allowOverlap ? link.x + link.w + link.h * LINK_GAP : parent.w + PAGE_GAP,
    y: link.y,
  };
}

// 兄弟カードを押し合わせ、重ならない位置を決める。戻り値は自分と子孫が占める範囲(自分の座標系)
function layoutChildren(card) {
  const items = [...card.children.values()].map((child) => {
    const box = layoutChildren(child);
    const base = basePosition(child);
    return {
      child,
      baseX: base.x,
      x: base.x,
      y: base.y,
      l: box.l * child.k,
      t: box.t * child.k,
      r: box.r * child.k,
      b: box.b * child.k,
      gap: CARD_GAP * child.k,
    };
  });

  for (let pass = 0; pass < PUSH_PASSES; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        // 左のカードは動かさない。左へ押すとリンクの文字に被ってしまう
        const [left, right] =
          items[i].baseX <= items[j].baseX ? [items[i], items[j]] : [items[j], items[i]];
        const [top, bottom] = items[i].y <= items[j].y ? [items[i], items[j]] : [items[j], items[i]];
        const gap = Math.min(left.gap, right.gap);
        const overlapX = left.x + left.r + gap - (right.x + right.l);
        const overlapY = top.y + top.b + gap - (bottom.y + bottom.t);
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        if (overlapX <= overlapY) {
          right.x += overlapX;
        } else {
          top.y -= overlapY / 2;
          bottom.y += overlapY / 2;
        }
      }
    }
    if (!moved) break;
  }

  const box = { l: 0, t: 0, r: card.w, b: card.h };
  for (const item of items) {
    moveToward(item.child, item.x, item.y, card.s);
    box.l = Math.min(box.l, item.x + item.l);
    box.t = Math.min(box.t, item.y + item.t);
    box.r = Math.max(box.r, item.x + item.r);
    box.b = Math.max(box.b, item.y + item.b);
  }
  return box;
}

// 押された動きが見えるよう、少しずつ目標位置へ近づける。開いた直後のカードだけは最初から目標に置く
function moveToward(card, x, y, parentScale) {
  if (!card.placed) {
    card.placed = true;
    card.ox = x;
    card.oy = y;
    return;
  }
  const dx = x - card.ox;
  const dy = y - card.oy;
  if (Math.hypot(dx, dy) * parentScale < 0.5) {
    card.ox = x;
    card.oy = y;
    return;
  }
  card.ox += dx * PUSH_EASE;
  card.oy += dy * PUSH_EASE;
  queueFrame();
}

// スクロール先まで見えるよう、ページの全長までカードを伸ばす
function growToDocument(card) {
  if (card.frozen || card.docHeight <= card.h) return;
  card.h = Math.min(card.docHeight, card.maxH);
  setFrameHeight(card, card.h);
}

function extendHeightLimit(card) {
  const gap = card.y + card.h * card.s - innerHeight;
  if (card.h < card.maxH || card.maxH >= MAX_PAGE_H || gap >= innerHeight) return;
  card.maxH = Math.min(card.maxH + PAGE_H_STEP, MAX_PAGE_H);
  growToDocument(card);
}

// --- 座標の伝播 ---
function propagate(card, from) {
  for (const child of card.children.values()) {
    if (child === from) continue;
    child.s = card.s * child.k;
    child.x = card.x + child.ox * card.s;
    child.y = card.y + child.oy * card.s;
    propagate(child, card);
  }
  const p = card.parent;
  if (p && p !== from) {
    p.s = card.s / card.k;
    p.x = card.x - card.ox * p.s;
    p.y = card.y - card.oy * p.s;
    propagate(p, card);
  }
}

const contains = (c, x, y) => x >= c.x && y >= c.y && x <= c.x + c.w * c.s && y <= c.y + c.h * c.s;

const coversViewport = (c) =>
  c.readyAt > 0 && c.x <= 0 && c.y <= 0 && c.x + c.w * c.s >= innerWidth && c.y + c.h * c.s >= innerHeight;

const isCovered = (card) =>
  [...card.children.values()].some((child) => coversViewport(child) || isCovered(child));

const isOnScreen = (c) =>
  c.x < innerWidth && c.y < innerHeight && c.x + c.w * c.s > 0 && c.y + c.h * c.s > 0;

const isAncestorOfAnchor = (card) => {
  for (let c = anchor; c; c = c.parent) if (c === card) return true;
  return false;
};

// --- 毎フレームの処理 ---
const minRootScale = () => Math.min(MIN_ROOT_SCALE, (0.9 * innerHeight) / root.h);

function applyZoom() {
  if (zoomPending === 0) return;
  let step = Math.abs(zoomPending) < 0.002 ? zoomPending : zoomPending * 0.3;
  // 親カードは常に子より大きいので、画面内で最も奥のカードの倍率で上限を判定する
  const deepest = Math.min(...[...cards].filter(isOnScreen).map((c) => c.s));
  if ((step > 0 && deepest >= MAX_SCALE) || (step < 0 && root.s <= minRootScale())) {
    zoomPending = 0;
    return;
  }
  zoomPending -= step;
  if (Math.abs(zoomPending) < 1e-5) zoomPending = 0;
  scaleCamera(step, zoomPivot.x, zoomPivot.y);
}

function scaleCamera(step, x, y) {
  const f = Math.exp(step);
  anchor.x = x - (x - anchor.x) * f;
  anchor.y = y - (y - anchor.y) * f;
  anchor.s *= f;
}

// ピンチは指に追従させるので、ホイールと違いなめらかにせずそのまま反映する
function pinchZoom(step, x, y) {
  const deepest = Math.min(...[...cards].filter(isOnScreen).map((c) => c.s));
  if ((step > 0 && deepest >= MAX_SCALE) || (step < 0 && root.s <= minRootScale())) return;
  if (step < 0) lastZoomOutAt = performance.now();
  flight = null;
  scaleCamera(step, x, y);
  queueFrame();
}

const withoutHash = (url) => url.split('#')[0];

// 同じページを開いたカードを探す。クリックしたページの子を優先する
function findOpenCard(card, href) {
  const url = withoutHash(href);
  const matches = (c) => withoutHash(c.currentUrl || c.url) === url;
  return [...card.children.values()].find(matches) || [...cards].find(matches);
}

// 倍率は変えずに、移動先のページ1画面分が画面中央に来るようカメラを少しずつ動かす。
// 画面より大きいときは左上を画面の左上に合わせる
function applyFlight() {
  if (!flight) return;
  const card = flight.card;
  if (!cards.has(card)) {
    flight = null;
    return;
  }
  anchor = card;
  const x = Math.max(0, (innerWidth - card.w * card.s) / 2);
  const y = Math.max(0, (innerHeight - card.viewH * card.s) / 2);
  const done = Math.hypot(x - card.x, y - card.y) < 0.5;
  card.x = done ? x : card.x + (x - card.x) * FLY_EASE;
  card.y = done ? y : card.y + (y - card.y) * FLY_EASE;
  if (done) flight = null;
  else queueFrame();
}

function chooseAnchor() {
  let best = anchor;
  let bestScore = Infinity;
  for (const c of cards) {
    const score = Math.abs(Math.log(c.s));
    if (score < bestScore && isOnScreen(c)) {
      best = c;
      bestScore = score;
    }
  }
  anchor = best;
}

// 画面中央に見えているカードから、中央に最も近いリンクを探す
function findNearestLink() {
  const cx = innerWidth / 2;
  const cy = innerHeight / 2;
  const card = [...cards].reverse().find((c) => contains(c, cx, cy));
  if (!card?.readyAt || card.s < OPEN_MIN_SCALE) return null;

  const openChildren = [...card.children.values()];
  let nearest = null;
  let nearestDist = Infinity;
  for (const link of card.links) {
    const left = card.x + link.x * card.s;
    const top = card.y + link.y * card.s;
    const width = link.w * card.s;
    const height = link.h * card.s;
    if (width < OPEN_W) continue;
    if (left >= innerWidth || top >= innerHeight || left + width <= 0 || top + height <= 0) continue;
    const isOpen = card.children.has(link.href);
    // 既に開いたカードの下に隠れているリンクは、見えないので対象にしない
    const hidden = !isOpen && openChildren.some((c) => contains(c, left + width / 2, top + height / 2));
    if (hidden) continue;
    const dx = Math.max(left - cx, 0, cx - left - width);
    const dy = Math.max(top - cy, 0, cy - top - height);
    const dist = Math.hypot(dx, dy);
    if (dist < nearestDist) {
      nearest = link;
      nearestDist = dist;
    }
  }
  if (!nearest || card.children.has(nearest.href) || card.dismissed.has(nearest.href)) return null;
  return { card, link: nearest };
}

// 縮小してから拡大し直したときは、改めて開く操作と見なす
function forgetDismissedLinks() {
  for (const card of cards) {
    for (const href of card.dismissed) {
      const link = card.links.find((l) => l.href === href);
      if (!link || link.w * card.s < OPEN_W) card.dismissed.delete(href);
    }
  }
}

function openNearestLink(now) {
  forgetDismissedLinks();
  const zoomingOut = zoomPending < 0 || now - lastZoomOutAt < ZOOM_OUT_HOLD;
  if (zoomingOut) setTimeout(queueFrame, ZOOM_OUT_HOLD + 10);
  const found = zoomingOut ? null : findNearestLink();
  if (!found) {
    pendingLink = null;
    return;
  }
  if (pendingLink?.card !== found.card || pendingLink.href !== found.link.href) {
    pendingLink = { card: found.card, href: found.link.href, since: now };
    setTimeout(queueFrame, OPEN_DELAY + 10);
    return;
  }
  if (now - pendingLink.since < OPEN_DELAY) return;
  if (!makeRoomForFrame()) return;
  pendingLink = null;
  createCard(found.link.href, found.card, found.link);
  queueFrame();
}

const framePriority = (c) => (isOnScreen(c) ? c.s * c.w : 0);

function makeRoomForFrame(forCard) {
  const live = [...cards].filter((c) => c.frame);
  if (live.length < MAX_LIVE_FRAMES) return true;
  const needed = forCard ? framePriority(forCard) : Infinity;
  const victims = live
    .filter((c) => !isAncestorOfAnchor(c) && framePriority(c) < needed)
    .sort((a, b) => framePriority(a) - framePriority(b));
  if (!victims.length) return false;
  unloadFrame(victims[0]);
  return true;
}

function manageFrames() {
  for (const card of cards) if (card.frame && card.s > UNLOAD_SCALE) unloadFrame(card);
  const wanted = [...cards]
    .filter((c) => !c.frame && c.s < RELOAD_SCALE && isOnScreen(c) && c.s * c.w >= MIN_LOAD_W)
    .sort((a, b) => framePriority(b) - framePriority(a));
  for (const card of wanted) {
    if (!makeRoomForFrame(card)) break;
    loadFrame(card);
  }
}

function render() {
  manageFrames();
  for (const card of cards) {
    // 画面外でも正しい幅でレイアウトさせる。狭いままだと折り返しで高さを過大に報告してしまう
    card.el.style.width = `${card.w}px`;
    card.el.style.height = `${card.h}px`;
    const visible = isOnScreen(card) && card.s <= UNLOAD_SCALE && !isCovered(card);
    card.el.style.visibility = visible ? 'visible' : 'hidden';
    placeCloseButton(card, visible);
    if (!visible) continue;

    const transform = `translate(${card.x}px, ${card.y}px) scale(${card.s})`;
    if (transform !== card.lastTransform) {
      card.el.style.transform = transform;
      card.lastTransform = transform;
    }
    card.el.style.opacity = 1;
    extendHeightLimit(card);
    sendView(card);
  }
}

function sendView(card) {
  if (!card.frame?.contentWindow || !card.readyAt) return;
  const left = Math.max(0, card.x);
  const top = Math.max(0, card.y);
  const right = Math.min(innerWidth, card.x + card.w * card.s);
  const bottom = Math.min(innerHeight, card.y + card.h * card.s);
  const view = {
    s: card.s,
    x: (left - card.x) / card.s,
    y: (top - card.y) / card.s,
    w: (right - left) / card.s,
    h: (bottom - top) / card.s,
    screenH: innerHeight,
    open: [...card.children.keys()],
  };
  const key = JSON.stringify(view);
  if (key === card.lastView) return;
  card.lastView = key;
  card.frame.contentWindow.postMessage({ zb: true, type: 'view', view }, '*');
}

function updateHud() {
  let depth = 0;
  for (let c = anchor.parent; c; c = c.parent) depth++;
  hud.depth.textContent = `階層 ${depth}`;
  hud.title.textContent = anchor.title || anchor.url;
  hud.title.title = anchor.url;
  hud.zoom.textContent = `${Math.round(anchor.s * 100)}%`;
}

function tick(now) {
  frameQueued = false;
  applyFlight();
  applyZoom();
  layoutChildren(root);
  propagate(anchor, null);
  chooseAnchor();
  render();
  if (!flight) openNearestLink(now);
  updateHud();
  if (zoomPending !== 0) queueFrame();
}

// --- 入力 ---
function addZoom(dy, x, y) {
  flight = null;
  zoomPending -= dy * ZOOM_SPEED;
  zoomPivot = { x, y };
  queueFrame();
}

function pan(dx, dy) {
  if (dx || dy) flight = null;
  anchor.x += dx;
  anchor.y += dy;
  queueFrame();
}

window.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? innerHeight : 1;
    addZoom(e.deltaY * unit, e.clientX, e.clientY);
  },
  { passive: false }
);

// 読み込み中のカードや余白の上ではカード内スクリプトが動かないので、ビューアが直接パンする
const pointers = new Map();
let pinchDistance = 0;
let tap = null;

const pinchState = () => {
  const [a, b] = [...pointers.values()];
  return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tap = pointers.size === 1 ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
  if (pointers.size === 2) pinchDistance = pinchState().distance;
});
stage.addEventListener('pointermove', (e) => {
  const pointer = pointers.get(e.pointerId);
  if (!pointer) return;
  if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= TAP_MOVE) tap = null;

  if (pointers.size !== 2) {
    if (!tap && pointers.size === 1) pan(e.clientX - pointer.x, e.clientY - pointer.y);
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    return;
  }
  const before = pinchState();
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  const after = pinchState();
  pan(after.x - before.x, after.y - before.y);
  if (pinchDistance > 0 && after.distance > 0) pinchZoom(Math.log(after.distance / pinchDistance), after.x, after.y);
  pinchDistance = after.distance;
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size === 2) pinchDistance = pinchState().distance;
  if (pointers.size > 0) return;
  stage.classList.remove('dragging');
  if (e.type === 'pointerup' && touchMode && tap && e.timeStamp - tap.at < TAP_TIME) tapAt(tap.x, tap.y);
  tap = null;
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

function elementAt(x, y) {
  const card = [...cards].reverse().find((c) => contains(c, x, y) && c.el.style.visibility !== 'hidden');
  if (!card?.readyAt || !card.frame) return null;
  return card.frame.contentDocument?.elementFromPoint((x - card.x) / card.s, (y - card.y) / card.s) || null;
}

// 指の下にある要素へクリックを渡す。リンクなら content.js がカードとして開く
function tapAt(x, y) {
  const el = elementAt(x, y);
  if (!el) return;
  if (el.matches('input,textarea,select,[contenteditable]')) el.focus();
  el.click();
}

// タッチ画面付きの PC でもマウスは使えるが、iframe がマウスを受けないのでリンク上のカーソルをここで出す
stage.addEventListener('pointermove', (e) => {
  if (!touchMode || e.pointerType !== 'mouse') return;
  stage.classList.toggle('over-link', !pointers.size && Boolean(elementAt(e.clientX, e.clientY)?.closest('a[href]')));
});

if (touchMode) {
  document.body.classList.add('touch-mode');
  // iOS の Safari はページ全体の拡大を viewport の指定だけでは止めない
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

const finite = (...values) => values.every(Number.isFinite);

window.addEventListener('message', (e) => {
  const data = e.data;
  if (!data?.zb) return;
  const card = [...cards].find((c) => c.frame && c.frame.contentWindow === e.source);
  if (!card) return;

  if (data.type === 'hello') {
    const navigated = card.currentUrl && card.currentUrl !== data.url;
    card.currentUrl = data.url;
    if (navigated) {
      for (const child of [...card.children.values()]) closeCard(child);
      card.links = [];
      card.dismissed.clear();
      card.restore = null;
      card.h = card.viewH;
      card.maxH = PAGE_H_STEP;
      card.docHeight = 0;
      card.frozen = false;
      setFrameHeight(card, card.viewH);
    }
    card.frame.contentWindow.postMessage({ zb: true, type: 'welcome', scroll: card.restore }, '*');
    card.restore = null;
    card.readyAt = performance.now();
    card.lastView = '';
    clearTimeout(card.readyTimer);
    card.el.classList.add('ready');
    queueFrame();
  } else if (data.type === 'wheel' && finite(data.dy, data.x, data.y)) {
    addZoom(data.dy, card.x + data.x * card.s, card.y + data.y * card.s);
  } else if (data.type === 'pan' && finite(data.dx, data.dy)) {
    pan(data.dx, data.dy);
  } else if (data.type === 'openLink') {
    const link = data.link;
    if (!link || !isHttpUrl(link.href) || !finite(link.x, link.y, link.w, link.h) || link.w <= 0) return;
    card.dismissed.delete(link.href);
    const opened = findOpenCard(card, link.href);
    if (opened) {
      flight = { card: opened };
      zoomPending = 0;
      queueFrame();
      return;
    }
    if (!makeRoomForFrame()) return;
    createCard(link.href, card, link);
  } else if (data.type === 'probe' && finite(data.h)) {
    setFrameHeight(card, Math.min(Math.max(data.h, card.viewH), card.maxH));
  } else if (data.type === 'probeDone') {
    setFrameHeight(card, card.h);
  } else if (data.type === 'freeze') {
    // 上限で止めたカードは文書の方が長くて当然なので、高さの連動とは見なさない
    if (card.h < card.maxH) card.frozen = true;
  } else if (data.type === 'appended') {
    card.frozen = false;
  } else if (data.type === 'unfreeze') {
    card.frozen = false;
    growToDocument(card);
  } else if (data.type === 'links' && Array.isArray(data.links)) {
    card.links = data.links.filter(
      (l) => l && isHttpUrl(l.href) && finite(l.x, l.y, l.w, l.h) && l.w > 0
    );
    for (const link of card.links) {
      const child = card.children.get(link.href);
      if (child) positionChild(child, link);
    }
    card.title = String(data.title || '');
    if (isHttpUrl(data.url)) {
      // 再読み込みせずに URL だけ切り替えるサイトでは、hello が来ないのでここで遷移に気づく
      if (card.currentUrl && withoutHash(card.currentUrl) !== withoutHash(data.url)) {
        for (const child of [...card.children.values()]) closeCard(child);
        card.dismissed.clear();
      }
      card.currentUrl = data.url;
    }
    if (finite(data.scrollX, data.scrollY)) card.scroll = { x: data.scrollX, y: data.scrollY };
    if (finite(data.docHeight)) {
      card.docHeight = data.docHeight;
      growToDocument(card);
    }
    queueFrame();
  }
});

function fitRootToWindow() {
  root.w = innerWidth;
  root.viewH = innerHeight;
  root.placeholder.style.height = `${root.viewH}px`;
  root.h = Math.max(root.h, root.viewH);
  setFrameHeight(root, root.h);
}

window.addEventListener('resize', () => {
  fitRootToWindow();
  queueFrame();
});

document.getElementById('hud-reset').addEventListener('click', () => {
  for (const child of [...root.children.values()]) closeCard(child);
  anchor = root;
  root.x = 0;
  root.y = 0;
  root.s = INITIAL_SCALE;
  zoomPending = 0;
  flight = null;
  queueFrame();
});
const overlapButton = document.getElementById('hud-overlap');
function showOverlapSetting() {
  overlapButton.setAttribute('aria-pressed', String(allowOverlap));
}
try {
  allowOverlap = localStorage.getItem(ALLOW_OVERLAP_KEY) === 'true';
} catch {
  // 保存先が使えなくても、初期設定のまま動かす
}
showOverlapSetting();
overlapButton.addEventListener('click', () => {
  allowOverlap = !allowOverlap;
  showOverlapSetting();
  try {
    localStorage.setItem(ALLOW_OVERLAP_KEY, String(allowOverlap));
  } catch {
    // 保存できなくても、このタブの間は設定が効く
  }
  queueFrame();
});
document.getElementById('hud-open').addEventListener('click', () => {
  window.open(anchor.currentUrl || anchor.url, '_blank', 'noopener');
});
document.getElementById('hud-exit').addEventListener('click', () => {
  location.href = anchor.currentUrl || anchor.url;
});

// --- 起動 ---
async function allowFramingInThisTab() {
  // X-Frame-Options / CSP を外すのはこのタブのサブフレームだけに限定する
  const { id } = await chrome.tabs.getCurrent();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { tabIds: [id], resourceTypes: ['sub_frame'] },
      },
    ],
  });
}

(async () => {
  const url = demoSite ? demoSite.startUrl : new URLSearchParams(location.search).get('url');
  if (!isHttpUrl(url)) {
    hud.title.textContent = 'http / https のページで拡張アイコンを押してください';
    return;
  }
  if (!demoSite) await allowFramingInThisTab();
  root = createCard(url, null, null);
  root.s = INITIAL_SCALE;
  fitRootToWindow();
  anchor = root;
  queueFrame();
})();
