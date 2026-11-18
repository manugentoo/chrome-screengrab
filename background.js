// Chrome allows about 2 captureVisibleTab calls per second.
const CAPTURE_INTERVAL_MS = 550;
// Chrome's canvas limits; taller pages are split into several images.
const MAX_CANVAS_DIM = 32767;
const MAX_CANVAS_AREA = 268435456;
// Pages Chrome never lets extensions capture or script.
const RESTRICTED_URLS = [
  /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search):/i,
  /^https:\/\/chromewebstore\.google\.com/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
];

let busy = false;
let lastCaptureAt = 0;
let status = { text: '', state: 'idle' };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse(status);
  } else if (msg.type === 'capture') {
    if (!busy) run(msg.mode, msg.tabId);
    sendResponse(status);
  }
});

async function run(mode, tabId) {
  busy = true;
  report('Starting…');
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || RESTRICTED_URLS.some((re) => re.test(tab.url))) {
      throw new Error("Chrome doesn't allow capturing this page.");
    }
    const base = baseName(tab.url);
    if (mode === 'visible') {
      await save(await capture(tab), `${base}.png`);
    } else {
      await captureFullPage(tab, base);
    }
    report('Saved!', 'done');
  } catch (err) {
    const text = /cancel/i.test(err.message) ? 'Save canceled.' : err.message;
    report(text, 'error');
  } finally {
    busy = false;
    chrome.action.setBadgeText({ text: '' });
  }
}

async function captureFullPage(tab, base) {
  const target = { tabId: tab.id };
  const info = await exec(target, pagePrepare);
  try {
    const positions = [];
    for (let y = 0; y < info.fullHeight; y += info.viewHeight) positions.push(y);

    let stitcher = null;
    for (let i = 0; i < positions.length; i++) {
      const pct = Math.round((i / positions.length) * 100);
      report(`Capturing… ${pct}%`);
      chrome.action.setBadgeText({ text: `${pct}%` });

      // Fixed headers/banners only belong in the first frame.
      if (i === 1) await exec(target, pageHideFixed);
      const actualY = await exec(target, pageScrollTo, [positions[i]]);
      const bitmap = await createImageBitmap(await (await fetch(await capture(tab))).blob());
      stitcher ??= new Stitcher(bitmap.width, bitmap.width / info.viewWidth, info, base);
      await stitcher.draw(bitmap, actualY);
      bitmap.close();
    }
    report('Saving…');
    await stitcher.finish();
  } finally {
    await exec(target, pageRestore).catch(() => {});
  }
}

class Stitcher {
  constructor(width, scale, info, base) {
    this.width = width;
    this.scale = scale;
    this.base = base;
    this.totalHeight = Math.round(info.fullHeight * scale);
    this.frameHeight = Math.round(info.viewHeight * scale);
    this.chunkHeight = Math.min(MAX_CANVAS_DIM, Math.floor(MAX_CANVAS_AREA / width));
    this.parts = Math.ceil(this.totalHeight / this.chunkHeight);
    this.open(0);
  }

  open(index) {
    this.index = index;
    this.top = index * this.chunkHeight;
    const height = Math.min(this.chunkHeight, this.totalHeight - this.top);
    this.canvas = new OffscreenCanvas(this.width, height);
    this.ctx = this.canvas.getContext('2d');
  }

  async draw(bitmap, cssY) {
    const y = Math.round(cssY * this.scale);
    const h = Math.min(this.frameHeight, bitmap.height, this.totalHeight - y);
    if (h <= 0) return;
    this.ctx.drawImage(bitmap, 0, 0, this.width, h, 0, y - this.top, this.width, h);
    // Frame spills over into the next chunk: save this one and continue there.
    if (y + h > this.top + this.canvas.height && this.index < this.parts - 1) {
      await this.flush();
      this.open(this.index + 1);
      this.ctx.drawImage(bitmap, 0, 0, this.width, h, 0, y - this.top, this.width, h);
    }
  }

  finish() {
    return this.flush();
  }

  async flush() {
    const blob = await this.canvas.convertToBlob({ type: 'image/png' });
    const name = this.parts > 1 ? `${this.base}-part${this.index + 1}.png` : `${this.base}.png`;
    await save(await blobToDataUrl(blob), name);
  }
}

async function capture(tab) {
  const current = await chrome.tabs.get(tab.id);
  if (!current.active) throw new Error('Capture stopped: the tab was switched.');
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

// saveAs: true opens the native "Save As" dialog on Windows, macOS, Linux and ChromeOS.
function save(url, filename) {
  return chrome.downloads.download({ url, filename, saveAs: true });
}

async function exec(target, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target, func, args });
  return res.result;
}

function report(text, state = 'working') {
  status = { text, state };
  chrome.runtime.sendMessage({ type: 'status', ...status }).catch(() => {});
}

function baseName(url) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_') || 'page';
  } catch {}
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `screengrab-${host}-${stamp}`;
}

// Service workers have no URL.createObjectURL, so downloads get a data URL.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// ---- Functions below run inside the page (must be self-contained). ----

function pagePrepare() {
  const root = document.documentElement;
  window.__screengrab = { x: window.scrollX, y: window.scrollY, hidden: [] };
  return {
    fullHeight: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0),
    viewWidth: window.innerWidth,
    // clientHeight excludes a horizontal scrollbar; quirks mode reports the document height instead.
    viewHeight: root.clientHeight && root.clientHeight <= window.innerHeight ? root.clientHeight : window.innerHeight,
  };
}

function pageScrollTo(y) {
  window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.scrollY)))
  );
}

function pageHideFixed() {
  const state = window.__screengrab;
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= 0 || r.top >= window.innerHeight) continue;
    state.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
    el.style.setProperty('visibility', 'hidden', 'important');
  }
}

function pageRestore() {
  const state = window.__screengrab;
  if (!state) return;
  for (const [el, value, priority] of state.hidden) {
    if (value) el.style.setProperty('visibility', value, priority);
    else el.style.removeProperty('visibility');
  }
  window.scrollTo({ top: state.y, left: state.x, behavior: 'instant' });
  delete window.__screengrab;
}
