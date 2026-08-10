// WALL TOUCH — Electron main process.
// Same shape as Door Portals' main.js (proven on the show machine): owns the OSC
// receiver and the NDI module, hands config.json to the renderer. The renderer is
// plain WebGL2 here — no three.js — so the `three/examples` asar trap cannot bite.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ndi = require('./ndi/sender');
const osc = require('./osc/receiver');

// Squeeze the most out of the GPU (target machine: RTX 5080).
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');

let win = null;
let config = null;
let userCfgPath = null;   // where calibration is written — NEVER inside the asar

// Anything the app writes MUST go to userData, not next to the source. In a packaged
// build config.json lives inside app.asar — a read-only archive — so writing there fails
// with ENOENT and a calibration done on site is lost the moment the app closes. The
// bundled file stays the defaults; the user file is an overlay on top of it.
function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  try {
    config = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('[config] failed to read config.json:', err.message);
    config = {};
  }

  userCfgPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(userCfgPath)) {
      const over = JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
      applyOverlay(config, over);
      console.log('[config] overlay loaded from', userCfgPath);
    } else {
      console.log('[config] no overlay yet; will save calibration to', userCfgPath);
    }
  } catch (err) {
    console.error('[config] overlay unreadable, ignoring:', err.message);
  }
  // Dev override: RENDER_SCALE=0.4 npm start → preview at 40% resolution. It scales
  // the SIM grids too (src/app.js), so a Mac preview is cheap end to end.
  if (process.env.RENDER_SCALE && config.output) {
    config.output.renderScale = parseFloat(process.env.RENDER_SCALE);
  }
  if (process.env.NDI_RGBA === '1') config.ndi = { ...(config.ndi || {}), bgra: false };
  if (process.env.NDI_OFF === '1') config.ndi = { ...(config.ndi || {}), enabled: false };
  if (process.env.NDI_PBO) {
    const n = parseInt(process.env.NDI_PBO, 10);
    if (n >= 1 && n <= 8) config.ndi = { ...(config.ndi || {}), pbo: n };
  }
  return config;
}

// Shallow per-section merge, plus per-index merge for walls. Deliberately not a deep
// generic merge: the only things written back are small named fields, and a clever merge
// would silently resurrect stale settings after a config change.
function applyOverlay(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (k === 'walls' && Array.isArray(v) && Array.isArray(base.walls)) {
      v.forEach((w, i) => { if (base.walls[i] && w) Object.assign(base.walls[i], w); });
    } else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      Object.assign(base[k], v);
    } else {
      base[k] = v;
    }
  }
}

function createWindow() {
  const kiosk = process.env.KIOSK === '1' || !!(config.output && config.output.kiosk);
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    backgroundColor: '#000000',
    title: 'WALL TOUCH',
    fullscreen: kiosk,
    frame: !kiosk,
    kiosk,
    autoHideMenuBar: kiosk,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // NDI runs INSIDE the renderer (see preload.js) — measured on Door Portals:
      // handing 45 MB/frame to the main process cost 36.6 of 46 ms. NDI_IPC=1 restores
      // the old path for A/B on a new machine.
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  win.loadFile('index.html');

  // On the show machine the app lives on a projector with no DevTools — this is the
  // only place the [perf] line and renderer errors ever surface.
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[watchdog] renderer gone:', details.reason, '— reloading in 1s');
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
  win.webContents.on('unresponsive', () => {
    console.error('[watchdog] renderer unresponsive — reloading');
    if (win && !win.isDestroyed()) win.reload();
  });

  // Dev aid: SNAP_DIR=/path → in-app frame grabs (no paid screenshot needed).
  // The directory must already exist; the app does not create it.
  const snapDir = process.env.SNAP_DIR;
  if (snapDir) {
    const at = (process.env.SNAP_AT || '8000,11000,15000').split(',').map(Number);
    at.forEach((t, i) => setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(snapDir, `snap${i + 1}.png`), img.toPNG());
        console.log(`[snap] saved snap${i + 1}.png`);
      } catch (e) { console.error('[snap] failed:', e.message); }
    }, t));
  }
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();

  // The bridge in fusion mode sends every surface's bundle to ONE port (osc.port,
  // 7000). Legacy per-wall ports stay listened to so an old bridge config still works.
  const wallPorts = Array.isArray(config.walls) ? config.walls.map(w => w.oscPort) : [];
  const ports = [...new Set([config.osc?.port, ...wallPorts].filter(Boolean))];
  if (!ports.length) ports.push(7000);
  osc.start(ports, (msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('osc:message', msg);
  });
});

ipcMain.handle('config:get', () => config);

// Persist calibration (and anything else the app edits) back to config.json. Without
// this a calibration done on site would be lost the next time the app starts, which is
// exactly when you least want to redo it.
ipcMain.handle('config:save', (_e, partial) => {
  try {
    let disk = {};
    if (fs.existsSync(userCfgPath)) {
      try { disk = JSON.parse(fs.readFileSync(userCfgPath, 'utf8')); } catch (_) { disk = {}; }
    }
    if (partial.walls) {
      disk.walls = disk.walls || [];
      partial.walls.forEach((pw, i) => { disk.walls[i] = { ...(disk.walls[i] || {}), ...pw }; });
    }
    for (const [k, v] of Object.entries(partial)) if (k !== 'walls') disk[k] = v;

    fs.mkdirSync(path.dirname(userCfgPath), { recursive: true });
    fs.writeFileSync(userCfgPath, JSON.stringify(disk, null, 2));
    applyOverlay(config, partial);
    console.log('[config] saved →', userCfgPath);
    return { ok: true, path: userCfgPath };
  } catch (err) {
    console.error('[config] save failed:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ndi:available', () => ndi.isAvailable());

ipcMain.handle('ndi:start', async (_e, cfg) => {
  try {
    await ndi.startSender(cfg); // { name, width, height, fps }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('ndi:stop', (_e, name) => { ndi.stopSender(name); return { ok: true }; });
ipcMain.handle('ndi:status', () => ndi.status());

ipcMain.on('ndi:frame', (_e, meta, data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data);
  ndi.sendFrame(meta, buf);
});

app.on('window-all-closed', () => { ndi.stopAll(); osc.stop(); app.quit(); });
app.on('before-quit', () => { ndi.stopAll(); osc.stop(); });
