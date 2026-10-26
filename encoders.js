// Frame sinks: feed them one rendered canvas frame at a time, then call finish() for a Blob.
import { GIFEncoder, quantize, applyPalette } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
import {
  Output, WebMOutputFormat, BufferTarget, CanvasSource, canEncodeVideo,
} from 'https://cdn.jsdelivr.net/npm/mediabunny@1.58.0/dist/bundles/mediabunny.min.mjs';

/* ---------- GIF ---------- */

// GIF transparency is all or nothing per pixel; anything less than half opaque becomes see-through.
const ALPHA_CUTOFF = 128;

export function createGifSink({ width, height, fps, colors, transparent = false }) {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  return {
    add(ctx) {
      const { data } = ctx.getImageData(0, 0, width, height);
      if (!transparent) {
        // A palette per frame keeps colours accurate when the scene changes.
        const palette = quantize(data, colors, { format: 'rgb565' });
        gif.writeFrame(applyPalette(data, palette, 'rgb565'), width, height, { palette, delay });
        return;
      }
      // Keep the last palette slot for "see-through", and map the transparent pixels to it.
      const opaque = quantize(data, Math.max(2, colors - 1), { format: 'rgb565' });
      const index = applyPalette(data, opaque, 'rgb565');
      const transparentIndex = opaque.length;
      for (let i = 0, a = 3; i < index.length; i++, a += 4) {
        if (data[a] < ALPHA_CUTOFF) index[i] = transparentIndex;
      }
      gif.writeFrame(index, width, height, {
        palette: [...opaque, [0, 0, 0]], delay, transparent: true, transparentIndex,
      });
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
