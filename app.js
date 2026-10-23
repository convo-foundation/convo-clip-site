import { createGifSink, createWebmSink, webmSupported } from './encoders.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tick = () => new Promise((r) => setTimeout(r, 0));
const abortError = () => new DOMException('Cancelled', 'AbortError');

const MIN_CLIP = 0.1;    // seconds
const MIN_CROP = 0.05;   // fraction of the frame
const LONG_CLIP = 15;    // seconds before we warn about size

const PRESETS = {
  'email-gif': { format: 'gif', fps: 10, width: 480, gifColors: 128 },
  'docs-gif': { format: 'gif', fps: 12, width: 640, gifColors: 256 },
  'web-webm': { format: 'webm', fps: 30, width: 720, webmQuality: 'medium' },
  'sign-webm': { format: 'webm', fps: 30, width: 640, webmQuality: 'high' },
};

const state = {
  name: 'clip',
  url: null,
  duration: 0,
  vw: 0,
  vh: 0,
  start: 0,
  end: 0,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  aspect: null,
  format: 'gif',
  fps: 12,
  width: 480,
  gifColors: 256,
  webmQuality: 'medium',
  busy: false,
};

const inViewer = 'claude' in window;
const video = $('video');
// A second, hidden element does all frame grabbing so the preview keeps playing.
const work = document.createElement('video');
work.muted = true;
work.playsInline = true;
work.preload = 'auto';

/* ---------- Loading ---------- */

function once(target, event) {
  return new Promise((resolve, reject) => {
    const ok = () => { target.removeEventListener('error', fail); resolve(); };
    const fail = () => { target.removeEventListener(event, ok); reject(new Error('unplayable')); };
    target.addEventListener(event, ok, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

// MediaRecorder WebM files report an infinite duration until the browser scans to the end.
async function ensureDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return;
  await new Promise((resolve) => {
    const check = () => {
      if (Number.isFinite(v.duration)) {
        v.removeEventListener('durationchange', check);
        resolve();
      }
    };
    v.addEventListener('durationchange', check);
    v.currentTime = 1e101;
    setTimeout(resolve, 4000);
  });
  v.currentTime = 0;
}

async function loadSource(blob, name) {
  hideError($('sourceError'));
  const url = URL.createObjectURL(blob);
  try {
    video.src = url;
    work.src = url;
    await Promise.all([once(video, 'loadedmetadata'), once(work, 'loadedmetadata')]);
    await Promise.all([ensureDuration(video), ensureDuration(work)]);
  } catch {
    URL.revokeObjectURL(url);
    showError($('sourceError'), 'This browser can’t play that file. Try MP4 (H.264) or WebM.');
    return;
  }
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = url;
  state.name = (name || 'clip').replace(/\.[^.]+$/, '') || 'clip';
  state.duration = video.duration;
  state.vw = video.videoWidth;
  state.vh = video.videoHeight;
  state.start = 0;
  state.end = state.duration <= 10 ? state.duration : 5;
  state.crop = { x: 0, y: 0, w: 1, h: 1 };
  setAspect(null);

  $('empty').hidden = true;
  $('recView').hidden = true;
  $('editor').hidden = false;
  $('exportBtn').disabled = false;
  $('result').hidden = true;
  video.currentTime = 0;
  renderTrim();
  renderCrop();
  renderSettings();
  scheduleEstimate();
}

$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadSource(file, file.name);
  e.target.value = '';
});
$('replaceBtn').addEventListener('click', () => $('fileInput').click());

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('video/')) || e.dataTransfer.files[0];
  if (file && !state.busy) loadSource(file, file.name);
});

/* ---------- Recording ---------- */

const COUNTDOWN = 3; // seconds before a self-recording starts
let recorder = null;
let recTimer = null;
let countdownCancel = null;

// In-page capture needs these APIs, and the hosted artifact viewer (window.claude) refuses it.
const canCapture = !inViewer && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;
// Phones and tablets can still film through the native camera via the file input's capture attribute.
const touchDevice = matchMedia('(pointer: coarse)').matches;

function showRecView(label) {
  $('empty').hidden = true;
  $('editor').hidden = true;
  $('recView').hidden = false;
  $('recLabel').innerHTML = label;
}

function backToEmpty() {
  $('recView').hidden = true;
  $('empty').hidden = !!state.duration;
  $('editor').hidden = !state.duration;
}

// Resolves true when the countdown finishes, false if the person cancels it.
function runCountdown(seconds) {
  const el = $('countdown');
  el.hidden = false;
  $('recDot').classList.add('idle');
  $('recStop').textContent = 'Cancel';
  return new Promise((resolve) => {
    let n = seconds;
    el.textContent = n;
    const timer = setInterval(() => {
      if (--n > 0) { el.textContent = n; return; }
      finish(true);
    }, 1000);
    const finish = (ok) => {
      clearInterval(timer);
      countdownCancel = null;
      el.hidden = true;
      $('recDot').classList.remove('idle');
      $('recStop').textContent = 'Stop and edit';
      resolve(ok);
    };
    countdownCancel = () => finish(false);
  });
}

async function startRecording(kind) {
  hideError($('sourceError'));
  let stream;
  try {
    stream = kind === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      : await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
  } catch (e) {
    showError($('sourceError'), e.name === 'NotAllowedError'
      ? `${kind === 'screen' ? 'Screen' : 'Camera'} access was blocked. Allow it in your browser, or choose a file instead.`
      : e.name === 'NotFoundError'
        ? 'No camera was found. Connect one, or choose a file instead.'
        : `Couldn’t start recording: ${e.message}`);
    return;
  }
  const stopStream = () => stream.getTracks().forEach((t) => t.stop());
  const live = $('liveVideo');
  live.srcObject = stream;
  live.classList.toggle('mirror', kind === 'camera');

  if (kind === 'camera') {
    showRecView('Get ready…');
    const ok = await runCountdown(COUNTDOWN);
    if (!ok) { stopStream(); live.srcObject = null; backToEmpty(); return; }
  }

  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    clearInterval(recTimer);
    stopStream();
    live.srcObject = null;
    const type = recorder.mimeType || 'video/webm';
    recorder = null;
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    if (blob.size) loadSource(blob, `${kind === 'camera' ? 'selfie' : 'screen'}-recording.${ext}`);
    else backToEmpty();
  };
  // The browser's own "Stop sharing" button ends the track; treat it like our Stop.
  stream.getVideoTracks()[0].addEventListener('ended', () => recorder?.state === 'recording' && recorder.stop());

  showRecView('Recording <strong id="recTime">0:00</strong>');
  const t0 = performance.now();
  recTimer = setInterval(() => { $('recTime').textContent = fmtTime((performance.now() - t0) / 1000, false); }, 250);
  recorder.start(250);
}

$('recScreen').addEventListener('click', () => startRecording('screen'));
$('recCamera').addEventListener('click', () => {
  if (canCapture) startRecording('camera');
  else $('captureInput').click();
});
$('refilmBtn').addEventListener('click', () => !state.busy && $('recCamera').click());
$('captureInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadSource(file, file.name || 'selfie.mp4');
  e.target.value = '';
});
$('recStop').addEventListener('click', () => {
  if (countdownCancel) countdownCancel();
  else if (recorder?.state === 'recording') recorder.stop();
});

if (!canCapture || !navigator.mediaDevices?.getDisplayMedia) $('recScreen').hidden = true;
if (!canCapture && !touchDevice) {
  $('recCamera').hidden = true;
  $('refilmBtn').hidden = true;
  $('camNote').hidden = false;
}

/* ---------- Trim and playback ---------- */

function fmtTime(s, tenths = true) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return tenths ? `${m}:${sec.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
}

function renderTrim() {
  const d = state.duration || 1;
  const a = (state.start / d) * 100;
  const b = (state.end / d) * 100;
  $('hStart').style.left = `${a}%`;
  $('hEnd').style.left = `${b}%`;
  $('range').style.left = `${a}%`;
  $('range').style.width = `${b - a}%`;
  $('timeDur').textContent = fmtTime(state.duration);
  if (document.activeElement !== $('startInput')) $('startInput').value = state.start.toFixed(1);
  if (document.activeElement !== $('endInput')) $('endInput').value = state.end.toFixed(1);
  $('startInput').max = $('endInput').max = state.duration.toFixed(1);
  $('clipLen').textContent = `Length ${(state.end - state.start).toFixed(1)} s`;
  renderSettings();
}

function setStart(t) { state.start = clamp(t, 0, state.end - MIN_CLIP); renderTrim(); }
function setEnd(t) { state.end = clamp(t, state.start + MIN_CLIP, state.duration); renderTrim(); }

function timeAt(clientX) {
  const r = $('timeline').getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * state.duration;
}

let trimDrag = null;
$('timeline').addEventListener('pointerdown', (e) => {
  if (state.busy) return;
  $('timeline').setPointerCapture(e.pointerId);
  if (e.target === $('hStart') || e.target === $('hEnd')) {
    trimDrag = e.target === $('hStart') ? 'start' : 'end';
    video.pause();
  } else {
    trimDrag = 'seek';
    video.currentTime = timeAt(e.clientX);
  }
});
$('timeline').addEventListener('pointermove', (e) => {
  if (!trimDrag) return;
  const t = timeAt(e.clientX);
  if (trimDrag === 'start') { setStart(t); video.currentTime = state.start; }
  else if (trimDrag === 'end') { setEnd(t); video.currentTime = state.end; }
  else video.currentTime = t;
});
$('timeline').addEventListener('pointerup', () => {
  if (trimDrag === 'start' || trimDrag === 'end') scheduleEstimate();
  trimDrag = null;
});

for (const [id, set] of [['hStart', setStart], ['hEnd', setEnd]]) {
  $(id).addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 1 : 0.1;
    const cur = id === 'hStart' ? state.start : state.end;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      set(cur + (e.key === 'ArrowRight' ? step : -step));
      scheduleEstimate();
    }
  });
}

$('startInput').addEventListener('change', (e) => { setStart(parseFloat(e.target.value) || 0); scheduleEstimate(); });
$('endInput').addEventListener('change', (e) => { setEnd(parseFloat(e.target.value) || 0); scheduleEstimate(); });
$('setStart').addEventListener('click', () => { setStart(video.currentTime); scheduleEstimate(); });
$('setEnd').addEventListener('click', () => { setEnd(video.currentTime); scheduleEstimate(); });

const PLAY = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
const PAUSE = '<path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
$('playBtn').addEventListener('click', togglePlay);
video.addEventListener('click', togglePlay);
function togglePlay() {
  if (video.paused) {
    if (video.currentTime < state.start || video.currentTime >= state.end - 0.05) video.currentTime = state.start;
    video.play();
  } else video.pause();
}
video.addEventListener('play', () => { $('playIcon').innerHTML = PAUSE; $('playBtn').ariaLabel = 'Pause'; });
video.addEventListener('pause', () => { $('playIcon').innerHTML = PLAY; $('playBtn').ariaLabel = 'Play'; });

// Keep the playhead in sync and loop playback inside the trim range.
(function frameLoop() {
  if (state.duration) {
    if (!video.paused && video.currentTime >= state.end) video.currentTime = state.start;
    $('playhead').style.left = `${(video.currentTime / state.duration) * 100}%`;
    $('timeNow').textContent = fmtTime(video.currentTime);
  }
  requestAnimationFrame(frameLoop);
})();

/* ---------- Crop ---------- */

function renderCrop() {
  const c = state.crop;
  const el = $('crop');
  el.style.left = `${c.x * 100}%`;
  el.style.top = `${c.y * 100}%`;
  el.style.width = `${c.w * 100}%`;
  el.style.height = `${c.h * 100}%`;
  el.classList.toggle('full', c.w > 0.999 && c.h > 0.999);
  $('cropSize').textContent = `${Math.round(c.w * state.vw)} × ${Math.round(c.h * state.vh)}`;
  renderSettings();
}

// Largest centred crop with the given width/height ratio, or the full frame for "Free".
function setAspect(aspect) {
  state.aspect = aspect;
  for (const b of $('aspectSeg').children) b.classList.toggle('on', (parseFloat(b.dataset.aspect) || null) === aspect);
  if (aspect) {
    const r = (aspect * state.vh) / state.vw; // width/height in normalised units
    let w = 1, h = 1 / r;
    if (h > 1) { h = 1; w = r; }
    state.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
}

$('aspectSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || state.busy) return;
  setAspect(parseFloat(b.dataset.aspect) || null);
  renderCrop();
  scheduleEstimate();
});
$('cropReset').addEventListener('click', () => {
  if (state.busy) return;
  state.crop = { x: 0, y: 0, w: 1, h: 1 };
  setAspect(null);
  renderCrop();
  scheduleEstimate();
});

function resizeCrop(handle, px, py, c) {
  const west = handle.includes('w');
  const north = handle.includes('n');
  const ax = west ? c.x + c.w : c.x; // opposite corner stays fixed
  const ay = north ? c.y + c.h : c.y;
  const maxW = west ? ax : 1 - ax;
  const maxH = north ? ay : 1 - ay;
  let w = clamp(west ? ax - px : px - ax, MIN_CROP, maxW);
  let h = clamp(north ? ay - py : py - ay, MIN_CROP, maxH);
  if (state.aspect) {
    const r = (state.aspect * state.vh) / state.vw;
    if (w / h > r) w = h * r; else h = w / r;
    if (w > maxW) { w = maxW; h = w / r; }
    if (h > maxH) { h = maxH; w = h * r; }
  }
  state.crop = { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

let cropDrag = null;
const overlay = $('overlay');
overlay.addEventListener('pointerdown', (e) => {
  if (state.busy) return;
  if (!$('crop').contains(e.target)) { togglePlay(); return; }
  e.preventDefault();
  overlay.setPointerCapture(e.pointerId);
  const r = $('frame').getBoundingClientRect();
  cropDrag = {
    mode: e.target.dataset.h || 'move',
    r,
    px: (e.clientX - r.left) / r.width,
    py: (e.clientY - r.top) / r.height,
    c: { ...state.crop },
  };
});
overlay.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const { r, c } = cropDrag;
  const px = clamp((e.clientX - r.left) / r.width, 0, 1);
  const py = clamp((e.clientY - r.top) / r.height, 0, 1);
  if (cropDrag.mode === 'move') {
    state.crop = { ...c, x: clamp(c.x + px - cropDrag.px, 0, 1 - c.w), y: clamp(c.y + py - cropDrag.py, 0, 1 - c.h) };
  } else {
    resizeCrop(cropDrag.mode, px, py, c);
  }
  renderCrop();
});
overlay.addEventListener('pointerup', () => {
  if (cropDrag) scheduleEstimate();
  cropDrag = null;
});

/* ---------- Settings ---------- */

function outputDims() {
  const sw = state.crop.w * state.vw;
  const sh = state.crop.h * state.vh;
  let w = state.width ? Math.min(state.width, sw) : sw;
  let h = (w * sh) / sw;
  // Even sizes keep VP8/VP9 happy and cost nothing for GIF.
  w = Math.max(2, Math.round(w / 2) * 2);
  h = Math.max(2, Math.round(h / 2) * 2);
  return { w, h, sx: state.crop.x * state.vw, sy: state.crop.y * state.vh, sw, sh };
}

const frameCount = () => Math.max(1, Math.floor((state.end - state.start) * state.fps));

function renderSettings() {
  for (const b of $('formatSeg').children) b.classList.toggle('on', b.dataset.format === state.format);
  $('fpsSel').value = String(state.fps);
  $('widthSel').value = String(state.width);
  $('colorsSel').value = String(state.gifColors);
  $('qualitySel').value = state.webmQuality;
  $('gifOpts').hidden = state.format !== 'gif';
  $('webmOpts').hidden = state.format !== 'webm';
  $('exportBtn').textContent = `Export ${state.format === 'gif' ? 'GIF' : 'WebM'}`;
  for (const row of document.querySelectorAll('.est-row')) row.classList.toggle('on', row.dataset.format === state.format);

  if (!state.duration) { $('outInfo').textContent = 'Load a video to get started.'; return; }
  const { w, h } = outputDims();
  $('outInfo').textContent = `Output ${w} × ${h} px · ${state.fps} fps · ${frameCount()} frames`;

  const warnings = [];
  if (state.format === 'gif' && state.fps > 30) warnings.push('Many viewers play GIFs above 30 fps unevenly. Pick 30 fps or less, or use WebM.');
  if (state.end - state.start > LONG_CLIP) warnings.push(`This clip is over ${LONG_CLIP} s. Expect a large file and a slower export.`);
  if (state.format === 'webm' && !webmSupported()) warnings.push('This browser can’t encode WebM. Use Chrome, Edge or Firefox.');
  $('warnInfo').hidden = !warnings.length;
  $('warnInfo').textContent = warnings.join(' ');
}

function onSettingChange(update) {
  Object.assign(state, update);
  $('presetSel').value = 'custom';
  renderSettings();
  scheduleEstimate();
}

$('formatSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || state.busy) return;
  state.format = b.dataset.format;
  renderSettings(); // format alone doesn't change either estimate
});
$('fpsSel').addEventListener('change', (e) => onSettingChange({ fps: +e.target.value }));
$('widthSel').addEventListener('change', (e) => onSettingChange({ width: +e.target.value }));
$('colorsSel').addEventListener('change', (e) => onSettingChange({ gifColors: +e.target.value }));
$('qualitySel').addEventListener('change', (e) => onSettingChange({ webmQuality: e.target.value }));
$('presetSel').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  Object.assign(state, p);
  renderSettings();
  $('presetSel').value = e.target.value;
  scheduleEstimate();
});

/* ---------- Frame grabbing ---------- */

// Jobs share the hidden video element, so they run one at a time.
let jobChain = Promise.resolve();
function runExclusive(fn) {
  const p = jobChain.then(fn);
  jobChain = p.catch(() => {});
  return p;
}

function seek(v, t) {
  return new Promise((resolve, reject) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return resolve();
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('Couldn’t read a frame from this video.')); };
    const cleanup = () => { v.removeEventListener('seeked', done); v.removeEventListener('error', fail); };
    v.addEventListener('seeked', done);
    v.addEventListener('error', fail);
    v.currentTime = t;
  });
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

async function renderFrames({ from, count, fps, dims, ctx, signal, onFrame }) {
  const last = Math.min(state.end, work.duration) - 0.001;
  for (let i = 0; i < count; i++) {
    if (signal.aborted) throw abortError();
    await seek(work, Math.min(from + i / fps, last));
    ctx.drawImage(work, dims.sx, dims.sy, dims.sw, dims.sh, 0, 0, dims.w, dims.h);
    await onFrame(i);
  }
}

/* ---------- Size estimate ---------- */

let estimateTimer = null;
let estimateAbort = null;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function scheduleEstimate() {
  clearTimeout(estimateTimer);
  estimateAbort?.abort();
  if (!state.duration) return;
  $('estStatus').textContent = 'Calculating…';
  estimateTimer = setTimeout(runEstimate, 450);
}

// Encodes a short window from the middle of the clip in both formats and scales up.
async function runEstimate() {
  if (state.busy || !state.duration) return;
  const ac = new AbortController();
  estimateAbort = ac;
  const dims = outputDims();
  const { fps } = state;
  const total = frameCount();
  const n = Math.min(total, Math.max(4, Math.round(fps * 2)));
  const mid = (state.start + state.end) / 2;
  const from = Math.max(state.start, mid - n / fps / 2);

  try {
    const est = await runExclusive(async () => {
      if (ac.signal.aborted) throw abortError();
      const { canvas, ctx } = makeCanvas(dims.w, dims.h);
      const gif = createGifSink({ width: dims.w, height: dims.h, fps, colors: state.gifColors });
      let webm = null;
      if (webmSupported()) {
        try { webm = await createWebmSink({ width: dims.w, height: dims.h, fps, quality: state.webmQuality }); } catch { webm = null; }
      }
      try {
        await renderFrames({
          from, count: n, fps, dims, ctx, signal: ac.signal,
          onFrame: async () => { gif.add(ctx); if (webm) await webm.add(canvas); },
        });
        const scale = total / n;
        return {
          gif: gif.finish().size * scale,
          webm: webm ? (await webm.finish()).size * scale : null,
        };
      } finally {
        webm?.close();
      }
    });
    if (ac.signal.aborted) return;
    renderEstimate(est);
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('estStatus').textContent = 'Couldn’t estimate';
  }
}

function renderEstimate({ gif, webm }) {
  const max = Math.max(gif, webm || 0);
  $('gifEst').textContent = `≈ ${fmtBytes(gif)}`;
  $('gifBar').style.width = `${(gif / max) * 100}%`;
  $('webmEst').textContent = webm ? `≈ ${fmtBytes(webm)}` : 'n/a';
  $('webmBar').style.width = webm ? `${(webm / max) * 100}%` : '0';
  $('estStatus').textContent = '';
  if (webm && gif > webm * 1.5) $('estNote').textContent = `WebM is about ${Math.round(gif / webm)}× smaller here, but GIF plays in more places (email, slides).`;
  else if (webm) $('estNote').textContent = 'Both formats come out at a similar size for this clip.';
  else $('estNote').textContent = 'WebM encoding isn’t available in this browser.';
}

/* ---------- Export ---------- */

let exportAbort = null;
let resultUrl = null;
let resultBlob = null;

function setBusy(busy) {
  state.busy = busy;
  $('exportBtn').disabled = busy;
  $('progress').hidden = !busy;
  for (const el of $('panel').querySelectorAll('select, .segmented button')) el.disabled = busy;
  for (const el of $('editor').querySelectorAll('input, .link-btn')) el.disabled = busy;
}

function progress(fraction, text) {
  $('progBar').style.width = `${Math.round(fraction * 100)}%`;
  $('progText').textContent = text;
}

async function exportClip() {
  hideError($('exportError'));
  clearTimeout(estimateTimer);
  estimateAbort?.abort();
  video.pause();

  const dims = outputDims();
  const { fps, format } = state;
  const count = frameCount();
  const ac = new AbortController();
  exportAbort = ac;
  setBusy(true);
  progress(0, 'Starting…');

  try {
    const blob = await runExclusive(async () => {
      const { canvas, ctx } = makeCanvas(dims.w, dims.h);
      const sink = format === 'gif'
        ? createGifSink({ width: dims.w, height: dims.h, fps, colors: state.gifColors })
        : await createWebmSink({ width: dims.w, height: dims.h, fps, quality: state.webmQuality });
      try {
        await renderFrames({
          from: state.start, count, fps, dims, ctx, signal: ac.signal,
          onFrame: async (i) => {
            if (format === 'gif') sink.add(ctx); else await sink.add(canvas);
            progress((i + 1) / count, `Frame ${i + 1} of ${count}`);
            if (i % 3 === 2) await tick();
          },
        });
        progress(1, 'Finishing…');
        return await sink.finish();
      } finally {
        sink.close?.();
      }
    });
    showResult(blob, format, dims, fps);
  } catch (e) {
    if (e.name !== 'AbortError') showError($('exportError'), e.message || 'Export failed.');
  } finally {
    exportAbort = null;
    setBusy(false);
  }
}

function showResult(blob, format, dims, fps) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  resultBlob = blob;
  hideError($('saveMsg'));
  const media = $('resultMedia');
  media.replaceChildren();
  if (format === 'gif') {
    const img = new Image();
    img.src = resultUrl;
    img.alt = 'Exported GIF preview';
    media.append(img);
  } else {
    const v = document.createElement('video');
    Object.assign(v, { src: resultUrl, autoplay: true, loop: true, muted: true, playsInline: true });
    media.append(v);
  }
  const ext = format === 'gif' ? 'gif' : 'webm';
  $('resultMeta').textContent = `${fmtBytes(blob.size)} · ${dims.w} × ${dims.h} · ${fps} fps · ${(state.end - state.start).toFixed(1)} s`;
  $('downloadLink').href = resultUrl;
  $('downloadLink').download = `${state.name}.${ext}`;
  $('downloadLink').textContent = `Download ${ext.toUpperCase()}`;
  $('result').hidden = false;
}

// In the artifact viewer, download links are inert; files go through the downloads capability.
$('downloadLink').addEventListener('click', async (e) => {
  if (!inViewer) return;
  e.preventDefault();
  const msg = $('saveMsg');
  hideError(msg);
  const downloads = await window.claude.use('downloads');
  if (!downloads) { showError(msg, 'Saving files isn’t available in this view.'); return; }
  try {
    await downloads.save({ filename: $('downloadLink').download, data: resultBlob });
  } catch (err) {
    if (err?.code === 'declined') return;
    showError(msg, err?.code === 'rate_limited'
      ? 'A save prompt is already open. Finish it, then try again.'
      : 'Couldn’t save the file here.');
  }
});

$('exportBtn').addEventListener('click', exportClip);
$('cancelBtn').addEventListener('click', () => exportAbort?.abort());

/* ---------- Errors ---------- */

function showError(el, msg) { el.textContent = msg; el.hidden = false; }
function hideError(el) { el.hidden = true; }

renderSettings();
