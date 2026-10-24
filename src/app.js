'use strict';

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

const ZOOMS = [2, 3, 4, 5, 6, 8, 10, 13];
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const SPEEDS = [1, 1.5, 2, 0.5, 0.25];
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  all: [],
  list: [],
  filter: store.get('filter', 'all'),
  zoom: store.get('zoom', null),
  idx: -1,
  muted: store.get('muted', false),
  volume: store.get('volume', 1),
  loop: store.get('loop', false),
  speed: 1,
  pendingReload: false,
};
const byId = new Map();

const scroller = $('#scroller');
const sections = $('#sections');

// ---------------- formatting ----------------

const pad = (n) => String(n).padStart(2, '0');
function fmtDur(s, round = true) {
  if (!Number.isFinite(s)) return '';
  s = Math.max(0, round ? Math.round(s) : Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtSize(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}
function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  const opts = { month: 'long', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
const timeLabel = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const monthName = (d) => d.toLocaleDateString(undefined, { month: 'long' });
const mediaUrl = (it) => `media://v/${it.id}`;
function plural(n, word) { return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`; }
function countsLabel(list) {
  const v = list.filter((x) => x.type === 'video').length;
  const p = list.length - v;
  return [v && plural(v, 'Video'), p && plural(p, 'Photo')].filter(Boolean).join(', ') || 'No items';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

// ---------------- library ----------------

async function load(keepScroll) {
  const res = await api.scan();
  S.folder = res.folder;
  S.ffmpeg = res.ffmpeg;
  S.all = res.items;
  byId.clear();
  S.all.forEach((it) => byId.set(it.id, it));
  applyFilter(keepScroll);
}

function applyFilter(keepScroll) {
  const f = S.filter;
  S.list = S.all.filter((it) => f === 'all' || (f === 'fav' ? it.fav : it.type === f));
  renderGrid(keepScroll);
  updateSeg();
}

const thumbIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbIO.unobserve(e.target);
    paintTile(e.target);
  }
}, { root: scroller, rootMargin: '700px 0px' });

async function ensureThumb(it) {
  if (it.thumb || it.noThumb) return it;
  if (!it.thumbPromise) {
    it.thumbPromise = api.thumb(it.id).then((info) => {
      if (info) {
        for (const k of ['thumb', 'duration', 'w', 'h']) if (info[k] != null) it[k] = info[k];
      }
      if (!it.thumb) it.noThumb = true;
      return it;
    });
  }
  return it.thumbPromise;
}

async function paintTile(tile) {
  const it = byId.get(tile.dataset.id);
  if (!it) return;
  await ensureThumb(it);
  if (it.thumb) {
    const img = $('img', tile);
    img.onload = () => img.classList.add('loaded');
    img.src = it.thumb;
  } else if (!$('video.fallback', tile)) {
    // No ffmpeg: let Chromium render a frame from the file itself.
    const v = el('video', 'fallback');
    v.muted = true;
    v.preload = 'metadata';
    v.src = it.type === 'video' ? mediaUrl(it) + '#t=1.5' : '';
    if (it.type === 'image') { $('img', tile).src = mediaUrl(it); $('img', tile).classList.add('loaded'); }
    else {
      v.addEventListener('loadeddata', () => { v.classList.add('loaded'); it.duration = v.duration; decorateTile(tile, it); }, { once: true });
      tile.prepend(v);
    }
  }
  decorateTile(tile, it);
}

function decorateTile(tile, it) {
  const badge = $('.badge', tile);
  if (badge) badge.textContent = fmtDur(it.duration);
  const heart = $('.heart', tile);
  if (it.fav && !heart) { const h = el('span', 'heart'); h.innerHTML = HEART; tile.append(h); }
  else if (!it.fav && heart) heart.remove();
  const needShade = it.type === 'video' || it.fav;
  const shade = $('.shade', tile);
  if (needShade && !shade) tile.append(el('div', 'shade'));
  else if (!needShade && shade) shade.remove();
}

function makeTile(it) {
  const b = el('button', 'tile');
  b.dataset.id = it.id;
  b.title = it.name;
  const img = el('img');
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  b.append(img);
  if (it.type === 'video') b.append(el('span', 'badge'));
  decorateTile(b, it);
  thumbIO.observe(b);
  return b;
}

function renderGrid(keepScroll) {
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const prevTop = scroller.scrollTop;
  thumbIO.disconnect();
  stopPreview();
  sections.textContent = '';

  const groups = [];
  let cur = null;
  for (const it of S.list) {
    const d = new Date(it.time);
    const key = d.getFullYear() * 12 + d.getMonth();
    if (!cur || cur.key !== key) { cur = { key, date: d, items: [] }; groups.push(cur); }
    cur.items.push(it);
  }

  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const sec = el('section', 'month');
    sec.dataset.label = `${monthName(g.date)} ${g.date.getFullYear()}`;
    const h = el('div', 'month-h');
    h.innerHTML = `<h2>${monthName(g.date)} <span>${g.date.getFullYear()}</span></h2><span class="count"></span>`;
    $('.count', h).textContent = countsLabel(g.items);
    const grid = el('div', 'grid');
    for (const it of g.items) grid.append(makeTile(it));
    sec.append(h, grid);
    frag.append(sec);
  }
  sections.append(frag);

  $('#footer-count').textContent = S.list.length ? countsLabel(S.list) : '';
  $('#subtitle').textContent = countsLabel(S.all);

  const empty = !S.list.length;
  $('#empty').hidden = !empty;
  $('#empty-folder').hidden = !!S.all.length;
  if (empty) {
    $('#empty-msg').textContent = !S.all.length
      ? `Nothing found in ${S.folder}`
      : S.filter === 'fav' ? 'Tap the heart on a clip to add it here.' : 'Nothing matches this filter.';
  }

  if (!keepScroll || nearBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = prevTop;
  updateTitle();
}

function tileFor(id) { return sections.querySelector(`.tile[data-id="${id}"]`); }

// header title follows the month you're looking at
let titleRaf = 0;
function updateTitle() {
  titleRaf = 0;
  const secs = sections.children;
  let label = 'Library';
  for (const s of secs) {
    if (s.getBoundingClientRect().bottom > 110) { label = s.dataset.label; break; }
  }
  const t = $('#big-title');
  if (t.textContent !== label) t.textContent = label;
}
scroller.addEventListener('scroll', () => { if (!titleRaf) titleRaf = requestAnimationFrame(updateTitle); }, { passive: true });

// ---------------- grid zoom ----------------

function defaultZoom() {
  const want = Math.round(innerWidth / 215);
  let best = 0;
  ZOOMS.forEach((z, i) => { if (Math.abs(z - want) < Math.abs(ZOOMS[best] - want)) best = i; });
  return best;
}
function setZoom(i) {
  i = Math.max(0, Math.min(ZOOMS.length - 1, i));
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  S.zoom = i;
  store.set('zoom', i);
  document.documentElement.style.setProperty('--cols', ZOOMS[i]);
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.scrollTop = nearBottom ? max : ratio * max;
  updateTitle();
}
$('#zoom-in').onclick = () => setZoom(S.zoom - 1);
$('#zoom-out').onclick = () => setZoom(S.zoom + 1);
let wheelZoomAt = 0;
scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (performance.now() - wheelZoomAt < 160) return;
  wheelZoomAt = performance.now();
  setZoom(S.zoom + (e.deltaY > 0 ? 1 : -1));
}, { passive: false });

// ---------------- filters ----------------

function updateSeg() {
  const seg = $('#filters');
  let on;
  seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.filter === S.filter); if (b.dataset.filter === S.filter) on = b; });
  const pill = $('.seg-pill', seg);
  if (on) { pill.style.width = on.offsetWidth + 'px'; pill.style.transform = `translateX(${on.offsetLeft}px)`; }
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.filter === S.filter) return;
  S.filter = b.dataset.filter;
  store.set('filter', S.filter);
  applyFilter(false);
});

$('#btn-refresh').onclick = async () => { await load(true); toast('Library refreshed'); };
$('#btn-folder').onclick = async () => { if (await api.chooseFolder()) load(false); };
$('#empty-folder').onclick = () => $('#btn-folder').click();

api.onLibraryChanged(() => {
  if (!$('#viewer').hidden) { S.pendingReload = true; return; }
  load(true);
});

// ---------------- hover preview ----------------

let hoverTile = null, hoverTimer = 0;
sections.addEventListener('pointerover', (e) => {
  const t = e.target.closest('.tile');
  if (t === hoverTile) return;
  stopPreview();
  hoverTile = t;
  if (!t) return;
  const it = byId.get(t.dataset.id);
  if (!it || it.type !== 'video') return;
  hoverTimer = setTimeout(() => {
    const v = el('video', 'preview');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.src = mediaUrl(it) + '#t=1.5';
    v.addEventListener('playing', () => v.classList.add('loaded'), { once: true });
    t.append(v);
    v.play().catch(() => {});
  }, 550);
});
scroller.addEventListener('pointerleave', stopPreview);
function stopPreview() {
  clearTimeout(hoverTimer);
  const v = hoverTile && $('.preview', hoverTile);
  if (v) killVideo(v);
  hoverTile = null;
}
function killVideo(v) {
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.remove();
}

sections.addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (t) openViewer(t.dataset.id);
});

// =====================================================================
// VIEWER
// =====================================================================

const viewer = $('#viewer');
const stage = $('#stage');
const strip = $('#strip');
const V = { slide: null, media: null, item: null, z: { s: 1, x: 0, y: 0 }, closing: false };

function fitRect(it) {
  const w = it.w || 16, h = it.h || 9;
  const s = Math.min(innerWidth / w, innerHeight / h);
  return { left: (innerWidth - w * s) / 2, top: (innerHeight - h * s) / 2, width: w * s, height: h * s };
}
function layoutMedia() {
  if (!V.media) return;
  const r = fitRect(V.item);
  Object.assign(V.media.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  applyZoom(false);
}

// Animates a cropped thumbnail between two rects (the iOS "hero" zoom).
function fly(from, to, source) {
  const box = el('div', 'fly');
  let inner;
  if (source instanceof HTMLCanvasElement) { inner = source; Object.assign(inner.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }); }
  else { inner = el('img'); inner.src = source; }
  box.append(inner);
  document.body.append(box);
  const frame = (r) => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  Object.assign(box.style, frame(from));
  const anim = box.animate([frame(from), frame(to)], { duration: 420, easing: EASE, fill: 'forwards' });
  return anim.finished.then(() => { requestAnimationFrame(() => box.remove()); });
}

function snapshot(media) {
  if (media.tagName !== 'VIDEO' || media.readyState < 2 || !media.videoWidth) return null;
  const c = el('canvas');
  c.width = 640;
  c.height = Math.round(640 * media.videoHeight / media.videoWidth);
  c.getContext('2d').drawImage(media, 0, 0, c.width, c.height);
  return c;
}

function openViewer(id) {
  const i = S.list.findIndex((x) => x.id === id);
  if (i < 0 || V.closing) return;
  stopPreview();
  S.idx = i;
  const it = S.list[i];
  viewer.hidden = false;
  buildStrip();
  showSlide(it, 0);
  const tile = tileFor(it.id);
  if (tile && it.thumb) {
    tile.classList.add('hidden-by-viewer');
    V.slide.style.visibility = 'hidden';
    const slide = V.slide;
    fly(tile.getBoundingClientRect(), fitRect(it), it.thumb).then(() => {
      slide.style.visibility = '';
      tile.classList.remove('hidden-by-viewer');
    });
  }
  requestAnimationFrame(() => viewer.classList.add('open'));
  pokeChrome();
  tick();
}

function ensureTileVisible(tile) {
  const r = tile.getBoundingClientRect();
  if (r.top < 100 || r.bottom > innerHeight - 90) {
    scroller.scrollTop += r.top - (innerHeight - r.height) / 2;
    updateTitle();
  }
}

function closeViewer() {
  if (V.closing || viewer.hidden) return;
  V.closing = true;
  hideInfo();
  const it = V.item, media = V.media, slide = V.slide;
  if (media.tagName === 'VIDEO') media.pause();
  const tile = tileFor(it.id);
  if (tile) ensureTileVisible(tile);
  const from = media.getBoundingClientRect();
  viewer.classList.remove('open', 'hide-chrome', 'idle');
  const finish = () => {
    stage.querySelectorAll('video').forEach(killVideo);
    stage.textContent = '';
    strip.textContent = '';
    if (tile) tile.classList.remove('hidden-by-viewer');
    viewer.hidden = true;
    V.slide = V.media = V.item = null;
    V.closing = false;
    S.idx = -1;
    if (S.pendingReload) { S.pendingReload = false; load(true); }
    else if (S.filter === 'fav') applyFilter(true);
  };
  if (tile && it.thumb) {
    tile.classList.add('hidden-by-viewer');
    const src = snapshot(media) || it.thumb;
    slide.style.visibility = 'hidden';
    fly(from, tile.getBoundingClientRect(), src).then(finish);
  } else {
    slide.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).finished.then(finish);
  }
}

function showSlide(it, dir) {
  const old = V.slide;
  const s = el('div', 'slide');
  let m;
  if (it.type === 'video') {
    m = el('video');
    m.preload = 'auto';
    m.playsInline = true;
    m.muted = S.muted;
    m.volume = S.volume;
    m.loop = S.loop;
    if (it.thumb) m.poster = it.thumb;
    m.src = mediaUrl(it);
    m.addEventListener('loadedmetadata', () => {
      m.playbackRate = S.speed;
      if (!it.duration) it.duration = m.duration;
      if (!it.w && m.videoWidth) { it.w = m.videoWidth; it.h = m.videoHeight; if (m === V.media) layoutMedia(); }
    });
    m.addEventListener('play', () => { if (m === V.media) { viewer.classList.add('playing'); bigPlay(false); pokeChrome(); } });
    m.addEventListener('pause', () => { if (m === V.media) { viewer.classList.remove('playing'); if (!scrubbing) bigPlay(true); pokeChrome(); } });
    m.addEventListener('ended', () => { if (m === V.media) { viewer.classList.remove('playing'); bigPlay(true); pokeChrome(); } });
    m.addEventListener('click', togglePlay);
    m.addEventListener('dblclick', () => toggleFullscreen());
    m.play().catch(() => {});
  } else {
    m = el('img');
    m.draggable = false;
    m.decoding = 'async';
    const onSize = (img) => { if (!it.w && img.naturalWidth) { it.w = img.naturalWidth; it.h = img.naturalHeight; if (m === V.media) layoutMedia(); } };
    if (it.thumb) {
      m.src = it.thumb;
      const full = new Image();
      full.src = mediaUrl(it);
      full.decode().then(() => { onSize(full); m.src = full.src; }).catch(() => {});
    } else {
      m.src = mediaUrl(it);
      m.onload = () => onSize(m);
    }
    m.addEventListener('dblclick', (e) => {
      if (V.z.s > 1) setZoomState(1, 0, 0, true);
      else zoomAt(e.clientX, e.clientY, 2.5, true);
    });
    m.addEventListener('pointerdown', startPan);
  }
  m.className = 'media';
  s.append(m);
  stage.append(s);

  V.slide = s;
  V.media = m;
  V.item = it;
  V.z = { s: 1, x: 0, y: 0 };
  layoutMedia();
  viewer.classList.toggle('playing', it.type === 'video' && !m.paused);
  bigPlay(false);

  if (old) {
    const ov = old.querySelector('video');
    if (ov) ov.pause();
    old.style.pointerEvents = 'none';
    const anim = dir
      ? old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${-dir * 7}%) scale(0.96)`, opacity: 0 }], { duration: 280, easing: EASE, fill: 'forwards' })
      : old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
    anim.finished.then(() => { if (ov) killVideo(ov); old.remove(); });
  }
  if (dir) s.animate([{ transform: `translateX(${dir * 7}%) scale(0.96)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 340, easing: EASE });

  preloadNeighbours();
  updateViewerUI();
}

function preloadNeighbours() {
  for (const d of [1, -1]) {
    const n = S.list[S.idx + d];
    if (n && n.type === 'image') { const im = new Image(); im.src = mediaUrl(n); }
    if (n) ensureThumb(n);
  }
}

function go(d) {
  const n = S.idx + d;
  if (n < 0 || n >= S.list.length) {
    V.slide.animate([{ transform: 'none' }, { transform: `translateX(${-d * 2.5}%)` }, { transform: 'none' }], { duration: 380, easing: EASE });
    return;
  }
  goTo(n);
}
function goTo(n) {
  if (n === S.idx || n < 0 || n >= S.list.length) return;
  const dir = Math.sign(n - S.idx);
  S.idx = n;
  hideInfo();
  showSlide(S.list[n], dir);
}

function updateViewerUI() {
  const it = V.item;
  $('#v-date').textContent = dayLabel(it.time);
  $('#v-time').textContent = timeLabel(it.time);
  $('#v-fav').classList.toggle('on', !!it.fav);
  $('#controls').classList.toggle('no-video', it.type !== 'video');
  $('#v-prev').disabled = S.idx <= 0;
  $('#v-next').disabled = S.idx >= S.list.length - 1;
  viewer.classList.toggle('muted', S.muted);
  $('#c-loop').classList.toggle('on', S.loop);
  $('#c-speed').textContent = S.speed + '×';
  $('#c-speed').classList.toggle('on', S.speed !== 1);
  $('#c-vol').value = S.volume;
  $('#c-vol').style.setProperty('--v', (S.muted ? 0 : S.volume) * 100 + '%');
  updateStrip();
  if (!$('#info-card').hidden) showInfo();
}

// ---------------- playback controls ----------------

const isVideo = () => V.media && V.media.tagName === 'VIDEO';
const isPlaying = () => isVideo() && !V.media.paused && !V.media.ended;

function togglePlay() {
  if (!isVideo()) return;
  if (V.media.paused || V.media.ended) V.media.play().catch(() => {});
  else V.media.pause();
}
function bigPlay(show) { $('#big-play').classList.toggle('show', !!show && isVideo()); }
function seekBy(sec) {
  if (!isVideo()) return;
  V.media.currentTime = Math.max(0, Math.min(V.media.duration || 0, V.media.currentTime + sec));
  pokeChrome();
}
function setMuted(m) {
  S.muted = m;
  store.set('muted', m);
  if (isVideo()) V.media.muted = m;
  updateViewerUI();
}

$('#c-play').onclick = togglePlay;
$('#c-mute').onclick = () => setMuted(!S.muted);
$('#c-vol').addEventListener('input', (e) => {
  S.volume = +e.target.value;
  store.set('volume', S.volume);
  if (isVideo()) V.media.volume = S.volume;
  if (S.muted && S.volume > 0) setMuted(false); else updateViewerUI();
});
$('#c-loop').onclick = () => {
  S.loop = !S.loop;
  store.set('loop', S.loop);
  if (isVideo()) V.media.loop = S.loop;
  updateViewerUI();
  toast(S.loop ? 'Loop on' : 'Loop off');
};
$('#c-speed').onclick = () => {
  S.speed = SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
  if (isVideo()) V.media.playbackRate = S.speed;
  updateViewerUI();
};
$('#c-full').onclick = () => toggleFullscreen();
function toggleFullscreen(on) { api.fullscreen(on); }
api.onFullscreen((v) => {
  document.body.classList.toggle('fs', v);
  setTimeout(() => { layoutMedia(); updateStrip(); updateSeg(); }, 50);
});

// scrubber
const scrub = $('#scrub');
let scrubbing = false, scrubWasPlaying = false;
function scrubFrac(e) {
  const r = scrub.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}
function scrubTip(e) {
  if (!isVideo()) return;
  const f = scrubFrac(e);
  const tip = $('#scrub-tip');
  tip.textContent = fmtDur(f * (V.media.duration || 0), false);
  tip.style.left = f * 100 + '%';
}
scrub.addEventListener('pointermove', (e) => {
  scrubTip(e);
  if (scrubbing) { const f = scrubFrac(e); V.media.currentTime = f * (V.media.duration || 0); paintScrub(f); }
});
scrub.addEventListener('pointerdown', (e) => {
  if (!isVideo()) return;
  scrubbing = true;
  scrub.classList.add('drag');
  scrub.setPointerCapture(e.pointerId);
  scrubWasPlaying = !V.media.paused;
  V.media.pause();
  const f = scrubFrac(e);
  V.media.currentTime = f * (V.media.duration || 0);
  paintScrub(f);
});
const endScrub = () => {
  if (!scrubbing) return;
  scrubbing = false;
  scrub.classList.remove('drag');
  if (scrubWasPlaying) V.media.play().catch(() => {});
  else bigPlay(true);
};
scrub.addEventListener('pointerup', endScrub);
scrub.addEventListener('pointercancel', endScrub);

function paintScrub(f) {
  $('#scrub-fill').style.width = f * 100 + '%';
  $('#scrub-knob').style.left = f * 100 + '%';
}

// one rAF loop while the viewer is open keeps the time + bar smooth
function tick() {
  if (viewer.hidden) return;
  if (isVideo()) {
    const m = V.media, d = m.duration || V.item.duration || 0;
    if (!scrubbing) paintScrub(d ? m.currentTime / d : 0);
    $('#c-cur').textContent = fmtDur(m.currentTime, false);
    $('#c-left').textContent = '-' + fmtDur(Math.max(0, d - m.currentTime), false);
    const b = m.buffered;
    $('#scrub-buf').style.width = (d && b.length ? b.end(b.length - 1) / d : 0) * 100 + '%';
  }
  requestAnimationFrame(tick);
}

// ---------------- chrome auto-hide ----------------

let idleTimer = 0, overChrome = false;
function pokeChrome() {
  viewer.classList.remove('hide-chrome', 'idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (isPlaying() && !overChrome && !scrubbing && $('#info-card').hidden) viewer.classList.add('hide-chrome', 'idle');
  }, 2600);
}
viewer.addEventListener('pointermove', pokeChrome);
viewer.querySelectorAll('.v-top, .v-bottom').forEach((c) => {
  c.addEventListener('pointerenter', () => { overChrome = true; });
  c.addEventListener('pointerleave', () => { overChrome = false; pokeChrome(); });
});

// ---------------- filmstrip ----------------

const stripIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    stripIO.unobserve(e.target);
    const it = byId.get(e.target.dataset.id);
    if (it) ensureThumb(it).then(() => { if (it.thumb) $('img', e.target).src = it.thumb; });
  }
}, { root: strip, rootMargin: '0px 500px' });

function buildStrip() {
  stripIO.disconnect();
  strip.textContent = '';
  strip.hidden = S.list.length < 2;
  const frag = document.createDocumentFragment();
  S.list.forEach((it, i) => {
    const b = el('button', 'strip-item');
    b.dataset.id = it.id;
    b.dataset.i = i;
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    b.append(img);
    frag.append(b);
    stripIO.observe(b);
  });
  strip.append(frag);
}
let stripCur = null;
function updateStrip() {
  if (strip.hidden || S.idx < 0) return;
  const cur = strip.children[S.idx];
  if (stripCur && stripCur !== cur) stripCur.classList.remove('cur');
  if (cur) cur.classList.add('cur');
  stripCur = cur;
  // compute target from fixed sizes so the in-flight width transition doesn't skew it
  const padL = parseFloat(getComputedStyle(strip).paddingLeft) || 0;
  const center = padL + S.idx * 32 + 6 + 37;
  strip.scrollTo({ left: center - strip.clientWidth / 2 });
}
strip.addEventListener('click', (e) => {
  const b = e.target.closest('.strip-item');
  if (b) goTo(+b.dataset.i);
});

// ---------------- photo zoom / pan ----------------

function applyZoom(animate) {
  const m = V.media;
  if (!m) return;
  m.classList.toggle('anim-zoom', !!animate);
  m.classList.toggle('zoomed', V.z.s > 1);
  m.style.transform = V.z.s === 1 ? '' : `translate(${V.z.x}px, ${V.z.y}px) scale(${V.z.s})`;
}
function setZoomState(s, x, y, animate) {
  const r = fitRect(V.item);
  s = Math.max(1, Math.min(8, s));
  if (s < 1.02) { s = 1; x = 0; y = 0; }
  const mx = Math.max(0, (r.width * s - innerWidth) / 2);
  const my = Math.max(0, (r.height * s - innerHeight) / 2);
  V.z = { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  applyZoom(animate);
}
function zoomAt(px, py, s, animate) {
  const cx = innerWidth / 2, cy = innerHeight / 2;
  const k = s / V.z.s;
  setZoomState(s, (px - cx) - (px - cx - V.z.x) * k, (py - cy) - (py - cy - V.z.y) * k, animate);
}
function startPan(e) {
  if (V.z.s <= 1 || e.button !== 0) return;
  const m = V.media, sx = e.clientX, sy = e.clientY, ox = V.z.x, oy = V.z.y;
  m.setPointerCapture(e.pointerId);
  m.classList.add('dragging');
  const move = (ev) => setZoomState(V.z.s, ox + ev.clientX - sx, oy + ev.clientY - sy, false);
  const up = () => { m.classList.remove('dragging'); m.removeEventListener('pointermove', move); m.removeEventListener('pointerup', up); };
  m.addEventListener('pointermove', move);
  m.addEventListener('pointerup', up);
}

// ---------------- wheel: scroll through clips ----------------

let wheelAcc = 0, wheelLock = false, wheelLockTimer = 0, wheelAccTimer = 0;
viewer.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (V.closing || !V.item) return;
  if (e.target.closest('.strip')) { strip.scrollLeft += e.deltaY + e.deltaX; return; }
  if (V.item.type === 'image' && (e.ctrlKey || V.z.s > 1)) {
    zoomAt(e.clientX, e.clientY, V.z.s * Math.exp(-e.deltaY * 0.0022), false);
    return;
  }
  // one gesture (a flick or a burst of wheel notches) = one step
  clearTimeout(wheelLockTimer);
  wheelLockTimer = setTimeout(() => { wheelLock = false; }, 200);
  if (wheelLock) return;
  wheelAcc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  clearTimeout(wheelAccTimer);
  wheelAccTimer = setTimeout(() => { wheelAcc = 0; }, 200);
  if (Math.abs(wheelAcc) >= 40) {
    go(Math.sign(wheelAcc));
    wheelAcc = 0;
    wheelLock = true;
  }
}, { passive: false });

// ---------------- top bar actions ----------------

$('#v-back').onclick = closeViewer;
$('#v-prev').onclick = () => go(-1);
$('#v-next').onclick = () => go(1);
$('#v-reveal').onclick = () => api.reveal(V.item.id);
$('#v-fav').onclick = toggleFav;
$('#v-info').onclick = () => ($('#info-card').hidden ? showInfo() : hideInfo());
$('#v-trash').onclick = askTrash;

function toggleFav() {
  const it = V.item;
  it.fav = !it.fav;
  api.favorite(it.id, it.fav);
  const tile = tileFor(it.id);
  if (tile) decorateTile(tile, it);
  const btn = $('#v-fav');
  btn.classList.toggle('on', it.fav);
  btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 300, easing: EASE });
}

function showInfo() {
  const it = V.item, card = $('#info-card');
  const d = new Date(it.time);
  const rows = [
    ['Type', it.type === 'video' ? 'Video' : 'Photo'],
    it.w && ['Resolution', `${it.w} × ${it.h}`],
    it.type === 'video' && it.duration && ['Length', fmtDur(it.duration)],
    ['Size', fmtSize(it.size)],
    it.album && ['Folder', it.album],
  ].filter(Boolean);
  card.innerHTML = '';
  const h = el('h3'); h.textContent = it.name;
  const sub = el('div', 'sub');
  sub.textContent = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ' · ' + timeLabel(it.time);
  card.append(h, sub);
  for (const [k, v] of rows) {
    const r = el('div', 'row');
    const a = el('span'); a.textContent = k;
    const b = el('span'); b.textContent = v;
    r.append(a, b);
    card.append(r);
  }
  const open = el('button', 'link');
  open.textContent = 'Open in default app';
  open.onclick = () => { V.media.pause?.(); api.openExternal(it.id); };
  card.append(open);
  card.hidden = false;
  $('#v-info').classList.add('active');
}
function hideInfo() { $('#info-card').hidden = true; $('#v-info').classList.remove('active'); }

// ---------------- delete (to Recycle Bin) ----------------

function askTrash() {
  if (!V.item) return;
  const vid = V.item.type === 'video';
  $('#sheet-msg').textContent = `This ${vid ? 'video' : 'photo'} will be moved to the Recycle Bin.`;
  $('#sheet-ok').textContent = vid ? 'Delete Video' : 'Delete Photo';
  $('#sheet').hidden = false;
  if (isVideo()) V.media.pause();
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet-cancel').onclick = closeSheet;
$('.sheet-bg').onclick = closeSheet;
$('#sheet-ok').onclick = async () => {
  closeSheet();
  const it = V.item;
  try { await api.trash(it.id); } catch { toast('Could not delete'); return; }
  S.all = S.all.filter((x) => x !== it);
  byId.delete(it.id);
  const i = S.list.indexOf(it);
  S.list.splice(i, 1);
  tileFor(it.id)?.remove();
  toast('Moved to Recycle Bin');
  if (!S.list.length) { V.item = null; viewer.hidden = true; stage.textContent = ''; renderGrid(true); return; }
  S.idx = Math.min(i, S.list.length - 1);
  buildStrip();
  showSlide(S.list[S.idx], i < S.list.length ? 1 : -1);
  S.pendingReload = true;
};

// ---------------- keyboard ----------------

document.addEventListener('keydown', (e) => {
  if (!$('#sheet').hidden) {
    if (e.key === 'Escape') closeSheet();
    if (e.key === 'Enter') $('#sheet-ok').click();
    return;
  }
  if (!viewer.hidden) {
    if (e.target.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case 'Escape':
        if (!$('#info-card').hidden) hideInfo();
        else if (document.body.classList.contains('fs')) toggleFullscreen(false);
        else closeViewer();
        break;
      case 'ArrowRight': case 'ArrowDown': case 'PageDown':
        if (e.shiftKey && isVideo()) seekBy(5); else go(1); break;
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        if (e.shiftKey && isVideo()) seekBy(-5); else go(-1); break;
      case 'Home': goTo(0); break;
      case 'End': goTo(S.list.length - 1); break;
      case ' ': case 'k': togglePlay(); break;
      case 'j': seekBy(-10); break;
      case ',': if (isVideo()) { V.media.pause(); seekBy(-1 / 60); } break;
      case '.': if (isVideo()) { V.media.pause(); seekBy(1 / 60); } break;
      case 'm': setMuted(!S.muted); break;
      case 'l': $('#c-loop').click(); break;
      case 's': $('#c-speed').click(); break;
      case 'f': toggleFav(); break;
      case 'i': $('#v-info').click(); break;
      case 'Enter': toggleFullscreen(); break;
      case 'Delete': askTrash(); break;
      default:
        if (/^[0-9]$/.test(k) && isVideo()) V.media.currentTime = (+k / 10) * (V.media.duration || 0);
        else return;
    }
    e.preventDefault();
    pokeChrome();
    return;
  }
  if (e.ctrlKey && (e.key === '=' || e.key === '+')) { setZoom(S.zoom - 1); e.preventDefault(); }
  else if (e.ctrlKey && e.key === '-') { setZoom(S.zoom + 1); e.preventDefault(); }
  else if (e.key === 'End') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  else if (e.key === 'Home') scroller.scrollTo({ top: 0, behavior: 'smooth' });
  else if (e.key === 'F11') toggleFullscreen();
});

addEventListener('resize', () => { layoutMedia(); updateStrip(); updateSeg(); });

// ---------------- boot ----------------

if (S.zoom == null || S.zoom >= ZOOMS.length) S.zoom = defaultZoom();
document.documentElement.style.setProperty('--cols', ZOOMS[S.zoom]);
load(false);
