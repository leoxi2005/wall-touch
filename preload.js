// Preload runs IN the renderer process, so anything it requires stays on this side
// of the process boundary. That matters for NDI: handing 45 MB of pixels per frame
// to the main process over IPC measured 36.6 ms/frame — 86% of the whole frame,
// dwarfing the GPU readback (1.7 ms) and the 5-wall packing (4.4 ms).
//
// But it is a real trade, not a free win: in-process, NDI's encoder competes with
// the render loop for CPU instead of running parallel in the main process. On a
// MacBook M4 Max the old path actually delivered MORE NDI frames (21.6/s vs 17.9/s)
// even while the renderer crawled at half the framerate. Which side wins depends on
// how expensive IPC is on the machine — so both paths ship, and you measure.
//   default   → NDI in this process, no IPC hop
//   NDI_IPC=1 → NDI in the main process (pre-v1.0.7 behaviour)
const { ipcRenderer } = require('electron');
const ndi = require('./ndi/sender');

const useIpc = process.env.NDI_IPC === '1';

window.api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (partial) => ipcRenderer.invoke('config:save', partial),

  ndi: useIpc ? {
    available: () => ipcRenderer.invoke('ndi:available'),
    start: (cfg) => ipcRenderer.invoke('ndi:start', cfg),
    stop: (name) => ipcRenderer.invoke('ndi:stop', name),
    status: () => ipcRenderer.invoke('ndi:status'),
    frame: (meta, data) => ipcRenderer.send('ndi:frame', meta, data)
  } : {
    available: () => ndi.isAvailable(),
    start: (cfg) => ndi.startSender(cfg).then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: String(err.message || err) })),
    stop: (name) => { ndi.stopSender(name); return { ok: true }; },
    status: () => ndi.status(),
    // Hot path: 5 calls per captured frame. Straight call, zero serialisation.
    frame: (meta, data) => ndi.sendFrame(meta, data)
  },

  onOsc: (cb) => {
    ipcRenderer.on('osc:message', (_e, msg) => cb(msg));
  }
};

// In-process senders live and die with THIS process, so close them here — the
// main process's before-quit hook holds a different (empty) copy of the module.
if (!useIpc) {
  window.addEventListener('beforeunload', () => { try { ndi.stopAll(); } catch (_) {} });
}
