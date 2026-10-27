// Frame sinks: feed them one rendered canvas frame at a time, then call finish() for a Blob.
import { GIFEncoder, quantize, applyPalette, nearestColorIndex } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
import {
  Output, WebMOutputFormat, BufferTarget, CanvasSource, canEncodeVideo,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.58.0/dist/bundles/mediabunny.min.mjs';

/* ---------- GIF ---------- */

// GIF transparency is all or nothing per pixel; anything less than half opaque becomes see-through.
const ALPHA_CUTOFF = 128;
// How much of each pixel's colour error is passed to its neighbours. Below 1 keeps the fine
// dither pattern from shimmering between frames while still removing the banding.
const DITHER_STRENGTH = 0.8;

// Maps each pixel to its nearest palette colour, spreading the leftover error to the pixels
// right and below (Floyd–Steinberg). Smooth gradients then read as gradients instead of bands.
function ditherToPalette(data, width, height, palette, transparentIndex) {
  const n = width * height;
  const index = new Uint8Array(n);
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = data[i * 4];
    rgb[i * 3 + 1] = data[i * 4 + 1];
    rgb[i * 3 + 2] = data[i * 4 + 2];
  }
  // Nearest-colour lookups, cached by RGB565 so each distinct colour is searched once.
  const cache = new Int16Array(65536).fill(-1);
  const spread = (i, er, eg, eb, f) => {
    rgb[i * 3] += er * f;
    rgb[i * 3 + 1] += eg * f;
    rgb[i * 3 + 2] += eb * f;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (transparentIndex >= 0 && data[i * 4 + 3] < ALPHA_CUTOFF) { index[i] = transparentIndex; continue; }
      const r = Math.min(255, Math.max(0, rgb[i * 3]));
      const g = Math.min(255, Math.max(0, rgb[i * 3 + 1]));
      const b = Math.min(255, Math.max(0, rgb[i * 3 + 2]));
      const key = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
      let k = cache[key];
      if (k < 0) { k = nearestColorIndex(palette, [r, g, b]); cache[key] = k; }
      index[i] = k;
      const p = palette[k];
      const er = (r - p[0]) * DITHER_STRENGTH;
      const eg = (g - p[1]) * DITHER_STRENGTH;
      const eb = (b - p[2]) * DITHER_STRENGTH;
      if (x + 1 < width) spread(i + 1, er, eg, eb, 7 / 16);
      if (y + 1 < height) {
        if (x > 0) spread(i + width - 1, er, eg, eb, 3 / 16);
        spread(i + width, er, eg, eb, 5 / 16);
        if (x + 1 < width) spread(i + width + 1, er, eg, eb, 1 / 16);
      }
    }
  }
  return index;
}

export function createGifSink({ width, height, fps, colors, transparent = false, dither = true }) {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  return {
    add(ctx) {
      const { data } = ctx.getImageData(0, 0, width, height);
      // A palette per frame keeps colours accurate when the scene changes. With transparency,
      // the last palette slot is kept for "see-through".
      const palette = quantize(data, transparent ? Math.max(2, colors - 1) : colors, { format: 'rgb565' });
      const transparentIndex = transparent ? palette.length : -1;
      let index;
      if (dither) {
        index = ditherToPalette(data, width, height, palette, transparentIndex);
      } else {
        index = applyPalette(data, palette, 'rgb565');
        if (transparent) {
          for (let i = 0, a = 3; i < index.length; i++, a += 4) {
            if (data[a] < ALPHA_CUTOFF) index[i] = transparentIndex;
          }
        }
      }
      gif.writeFrame(index, width, height, transparent
        ? { palette: [...palette, [0, 0, 0]], delay, transparent: true, transparentIndex }
        : { palette, delay });
    },
    finish() {
      gif.finish();
      return new Blob([gif.bytes()], { type: 'image/gif' });
    },
  };
}

/* ---------- WebM (Mediabunny over WebCodecs) ---------- */

// Bits per pixel per frame for each quality level.
const BPP = { low: 0.05, medium: 0.1, high: 0.2 };

export const webmSupported = () => 'VideoEncoder' in window && 'VideoFrame' in window;

// Reads each frame from `canvas` when add() is called. With `alpha`, transparent pixels stay
// transparent (VP8/VP9 carry a separate alpha layer that Chrome, Edge and Firefox play).
export async function createWebmSink({ width, height, fps, quality, canvas, alpha = false }) {
  if (!webmSupported()) throw new Error('This browser can’t encode WebM. Use Chrome, Edge or Firefox.');
  const bitrate = Math.max(150_000, Math.round(width * height * fps * BPP[quality]));
  let codec = null;
  for (const c of ['vp9', 'vp8']) {
    if (await canEncodeVideo(c, { width, height, bitrate })) { codec = c; break; }
  }
  if (!codec) throw new Error('This browser can’t encode VP9 or VP8 at this size.');

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec,
    bitrate,
    alpha: alpha ? 'keep' : 'discard',
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  let i = 0;
  return {
    async add() {
      // The frame is captured from the canvas synchronously; awaiting applies back-pressure.
      await source.add(i / fps, 1 / fps);
      i++;
    },
    async finish() {
      source.close();
      await output.finalize();
      return new Blob([output.target.buffer], { type: 'video/webm' });
    },
    close() {
      if (output.state === 'started' || output.state === 'pending') output.cancel().catch(() => {});
    },
  };
}
