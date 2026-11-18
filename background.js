// Chrome allows about 2 captureVisibleTab calls per second.
const CAPTURE_INTERVAL_MS = 550;
// Chrome's canvas limits; taller pages are split into several images.
const MAX_CANVAS_DIM = 32767;
const MAX_CANVAS_AREA = 268435456;
// A4 portrait, in PDF points.
const PDF_PAGE_W = 595.28;
const PDF_PAGE_H = 841.89;
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
      const makeSink = (width) => (mode === 'pdf' ? new PdfSink(base, width) : new PngSink(base));
      await captureFullPage(tab, makeSink);
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

async function captureFullPage(tab, makeSink) {
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
      stitcher ??= new Stitcher(bitmap.width, bitmap.width / info.viewWidth, info, makeSink(bitmap.width));
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
  constructor(width, scale, info, sink) {
    this.width = width;
    this.scale = scale;
    this.sink = sink;
    this.totalHeight = Math.round(info.fullHeight * scale);
    this.frameHeight = Math.round(info.viewHeight * scale);
    // Chunks are a whole number of sink pages tall, so no page straddles two chunks.
    const maxHeight = Math.min(MAX_CANVAS_DIM, Math.floor(MAX_CANVAS_AREA / width));
    this.chunkHeight = Math.floor(maxHeight / sink.align) * sink.align;
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

  async finish() {
    await this.flush();
    await this.sink.finish();
  }

  flush() {
    return this.sink.add(this.canvas, this.index, this.parts);
  }
}

// Saves each stitched chunk as its own PNG.
class PngSink {
  constructor(base) {
    this.base = base;
    this.align = 1;
  }

  async add(canvas, index, parts) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const name = parts > 1 ? `${this.base}-part${index + 1}.png` : `${this.base}.png`;
    await save(await blobToDataUrl(blob), name);
  }

  async finish() {}
}

// Slices stitched chunks into A4 pages and saves them as one PDF.
class PdfSink {
  constructor(base, width) {
    this.base = base;
    this.width = width;
    this.align = Math.round((width * PDF_PAGE_H) / PDF_PAGE_W);
    this.pages = [];
  }

  async add(canvas) {
    for (let y = 0; y < canvas.height; y += this.align) {
      const h = Math.min(this.align, canvas.height - y);
      const page = new OffscreenCanvas(this.width, h);
      const ctx = page.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, this.width, h);
      ctx.drawImage(canvas, 0, y, this.width, h, 0, 0, this.width, h);
      const blob = await page.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      this.pages.push({ width: this.width, height: h, bytes: new Uint8Array(await blob.arrayBuffer()) });
    }
  }

  async finish() {
    await save(await blobToDataUrl(buildPdf(this.pages)), `${this.base}.pdf`);
  }
}

// Minimal PDF 1.4: one JPEG image per A4 page, anchored at the top.
function buildPdf(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const begin = (id) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
  };
  const num = (n) => +n.toFixed(2);

  push('%PDF-1.4\n');
  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((p, i) => {
    const [pageId, contentId, imageId] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
    const drawH = (p.height * PDF_PAGE_W) / p.width;
    const content = `q ${num(PDF_PAGE_W)} 0 0 ${num(drawH)} 0 ${num(PDF_PAGE_H - drawH)} cm /Im0 Do Q`;
    begin(pageId);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_W} ${PDF_PAGE_H}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`
    );
    begin(contentId);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(imageId);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`
    );
    push(p.bytes);
    push('\nendstream\nendobj\n');
  });

  const xref = length;
  const count = 3 + pages.length * 3;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
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
