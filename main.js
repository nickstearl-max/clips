const { app, BrowserWindow, ipcMain, protocol, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { Readable } = require('stream');

// First folder that exists: NVIDIA ShadowPlay, Xbox Game Bar, AMD ReLive, then plain Videos.
const VIDEOS = path.join(os.homedir(), 'Videos');
const DEFAULT_FOLDER = [
  path.join(VIDEOS, 'NVIDIA'),
  path.join(VIDEOS, 'Captures'),
  path.join(VIDEOS, 'Radeon ReLive'),
].find((p) => fs.existsSync(p)) || VIDEOS;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

let win;
let items = new Map(); // id -> item (with absolute path)
let settings = { folder: DEFAULT_FOLDER, favorites: [] };
let meta = {}; // thumb key -> { d, w, h }
let dataDir, thumbDir, settingsFile, metaFile;

// ---------- persistence ----------

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(settingsFile, JSON.stringify(settings), () => {});
    fs.writeFile(metaFile, JSON.stringify(meta), () => {});
  }, 500);
}

// ---------- ffmpeg ----------

function findFfmpeg() {
  const candidates = [
    path.join(process.resourcesPath || '', 'ffmpeg', 'ffmpeg.exe'),
    path.join(os.homedir(), 'Downloads', 'ffmpeg', 'ffmpeg.exe'),
    path.join(os.homedir(), 'Downloads', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    // winget install Gyan.FFmpeg (PATH may not be refreshed for apps started before re-login)
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
  ];
  if (process.env.CLIPS_NO_FFMPEG) return null; // dev: test the no-ffmpeg fallback
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const found = execFileSync('where', ['ffmpeg'], { windowsHide: true }).toString().split(/\r?\n/)[0].trim();
    if (found) return found;
  } catch {}
  return null;
}
const FFMPEG = findFfmpeg();

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
    p.on('error', (e) => resolve({ code: -1, err: String(e) }));
  });
}

function parseProbe(text) {
  const out = {};
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) out.d = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const r = /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(text);
  if (r) { out.w = +r[1]; out.h = +r[2]; }
  return out;
}

// ---------- thumbnail queue (newest request first, so what's on screen wins) ----------

const stack = [];
const waiting = new Map(); // id -> [resolve]
let active = 0;
const MAX_JOBS = Math.max(2, Math.min(4, os.cpus().length - 2));

function thumbInfo(item) {
  const m = meta[item.key] || {};
  const file = path.join(thumbDir, item.key + '.jpg');
  return { thumb: fs.existsSync(file) ? `media://t/${item.id}?k=${item.key}` : null, duration: m.d, w: m.w, h: m.h };
}

function requestThumb(id) {
  const item = items.get(id);
  if (!item) return Promise.resolve(null);
  const info = thumbInfo(item);
  if (info.thumb || !FFMPEG) return Promise.resolve(info);
  return new Promise((resolve) => {
    if (waiting.has(id)) waiting.get(id).push(resolve);
    else waiting.set(id, [resolve]);
    stack.push(id);
    pump();
  });
}

function pump() {
  while (active < MAX_JOBS && stack.length) {
    const id = stack.pop();
    if (!waiting.has(id)) continue;
    const resolvers = waiting.get(id);
    waiting.delete(id);
    active++;
    makeThumb(items.get(id))
      .catch(() => null)
      .then((info) => {
        active--;
        resolvers.forEach((r) => r(info));
        pump();
      });
  }
}

async function makeThumb(item) {
  if (!item) return null;
  const out = path.join(thumbDir, item.key + '.jpg');
  const scale = ['-vf', "scale='if(gt(iw,ih),-2,480)':'if(gt(iw,ih),480,-2)'", '-q:v', '4', '-y', out];
  let res;
  if (item.type === 'video') {
    res = await runFfmpeg(['-hide_banner', '-ss', '1.5', '-i', item.path, '-frames:v', '1', ...scale]);
    if (!fs.existsSync(out)) res = await runFfmpeg(['-hide_banner', '-i', item.path, '-frames:v', '1', ...scale]);
  } else {
    res = await runFfmpeg(['-hide_banner', '-i', item.path, '-frames:v', '1', ...scale]);
  }
  meta[item.key] = parseProbe(res.err);
  saveSoon();
  return thumbInfo(item);
}

// ---------- library scan ----------

function parseDate(name) {
  const m = /(\d{4})[.\-_](\d{2})[.\-_](\d{2})[ \-_]+(\d{2})[.\-_:](\d{2})[.\-_:](\d{2})/.exec(name);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isNaN(t) ? null : t;
}

async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await walk(p, out); continue; }
    const ext = path.extname(e.name).toLowerCase();
    const type = VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : null;
    if (!type) continue;
    try {
      const st = await fsp.stat(p);
      out.push({ path: p, name: e.name, ext, type, size: st.size, mtime: st.mtimeMs, time: parseDate(e.name) ?? st.mtimeMs });
    } catch {}
  }
}

async function scan() {
  const found = [];
  await walk(settings.folder, found);
  found.sort((a, b) => a.time - b.time);
  items = new Map();
  const favs = new Set(settings.favorites);
  const list = found.map((f) => {
    const id = crypto.createHash('sha1').update(f.path.toLowerCase()).digest('hex').slice(0, 16);
    const key = crypto.createHash('sha1').update(`${f.path}|${f.size}|${f.mtime}`).digest('hex').slice(0, 20);
    const item = { ...f, id, key };
    items.set(id, item);
    const rel = path.relative(settings.folder, path.dirname(f.path));
    return {
      id, name: f.name, type: f.type, size: f.size, time: f.time, album: rel || null,
      fav: favs.has(f.path), ...thumbInfo(item),
    };
  });
  watchFolder();
  return { folder: settings.folder, ffmpeg: !!FFMPEG, items: list };
}

let watcher, watchTimer;
function watchFolder() {
  if (watcher && watcher.folder === settings.folder) return;
  try { watcher?.close(); } catch {}
  try {
    watcher = fs.watch(settings.folder, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => win?.webContents.send('library-changed'), 1500);
    });
    watcher.folder = settings.folder;
  } catch { watcher = null; }
}

// ---------- media:// protocol (with range support so videos can seek) ----------

async function serveFile(file, request) {
  const stat = await fsp.stat(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'max-age=3600' };
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : stat.size - parseInt(m[2], 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200, headers: { ...headers, 'Content-Length': String(stat.size) },
  });
}

function registerProtocol() {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.replace(/^\//, '');
      const item = items.get(id);
      if (!item) return new Response('not found', { status: 404 });
      if (url.host === 't') return await serveFile(path.join(thumbDir, item.key + '.jpg'), request);
      return await serveFile(item.path, request);
    } catch {
      return new Response('error', { status: 500 });
    }
  });
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('scan', () => scan());
  ipcMain.handle('thumb', (_e, id) => requestThumb(id));
  ipcMain.handle('reveal', (_e, id) => { const it = items.get(id); if (it) shell.showItemInFolder(it.path); });
  ipcMain.handle('open-external', (_e, id) => { const it = items.get(id); if (it) shell.openPath(it.path); });
  ipcMain.handle('trash', async (_e, id) => {
    const it = items.get(id);
    if (!it) return false;
    await shell.trashItem(it.path);
    items.delete(id);
    return true;
  });
  ipcMain.handle('favorite', (_e, id, on) => {
    const it = items.get(id);
    if (!it) return;
    const set = new Set(settings.favorites);
    if (on) set.add(it.path); else set.delete(it.path);
    settings.favorites = [...set];
    saveSoon();
  });
  ipcMain.handle('choose-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.folder });
    if (r.canceled || !r.filePaths[0]) return false;
    settings.folder = r.filePaths[0];
    saveSoon();
    return true;
  });
  ipcMain.handle('fullscreen', (_e, on) => {
    win.setFullScreen(on === undefined ? !win.isFullScreen() : on);
    return win.isFullScreen();
  });
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#000000',
    title: 'Clips',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 44 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Dev helper: CLIPS_SHOT=out.png [CLIPS_JS=code] captures the window for visual checks.
  if (process.env.CLIPS_SHOT) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 5000));
      if (process.env.CLIPS_JS) {
        await win.webContents.executeJavaScript(process.env.CLIPS_JS).catch((e) => console.error(e));
        await new Promise((r) => setTimeout(r, +(process.env.CLIPS_WAIT || 2500)));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CLIPS_SHOT, img.toPNG());
      app.quit();
    });
  }
}

// dev/test only: separate profile (must happen before the single-instance lock)
if (process.env.CLIPS_DATA) app.setPath('userData', process.env.CLIPS_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.clips.album');
    dataDir = app.getPath('userData');
    thumbDir = path.join(dataDir, 'thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });
    settingsFile = path.join(dataDir, 'settings.json');
    metaFile = path.join(dataDir, 'meta.json');
    settings = { ...settings, ...loadJson(settingsFile, {}) };
    meta = loadJson(metaFile, {});
    registerProtocol();
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
