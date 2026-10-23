// Frame sinks: feed them one rendered canvas frame at a time, then call finish() for a Blob.
import { GIFEncoder, quantize, applyPalette } from 'https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js';
import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs';

/* ---------- GIF ---------- */

export function createGifSink({ width, height, fps, colors }) {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  return {
    add(ctx) {
      const { data } = ctx.getImageData(0, 0, width, height);
      // A palette per frame keeps colours accurate when the scene changes.
      const palette = quantize(data, colors, { format: 'rgb565' });
      const index = applyPalette(data, palette, 'rgb565');
      gif.writeFrame(index, width, height, { palette, delay });
    },
    finish() {
      gif.finish();
      return new Blob([gif.bytes()], { type: 'image/gif' });
    },
  };
}

/* ---------- WebM (WebCodecs + webm-muxer) ---------- */

// Bits per pixel per frame for each quality level.
const BPP = { low: 0.05, medium: 0.1, high: 0.2 };
const CODECS = [
  { codec: 'vp09.00.10.08', mux: 'V_VP9' },
  { codec: 'vp8', mux: 'V_VP8' },
];

export const webmSupported = () => 'VideoEncoder' in window && 'VideoFrame' in window;

async function pickCodec(config) {
  for (const c of CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ ...config, codec: c.codec });
      if (supported) return c;
    } catch {
      // try the next codec
    }
  }
  return null;
}

export async function createWebmSink({ width, height, fps, quality }) {
  if (!webmSupported()) throw new Error('This browser can’t encode WebM. Use Chrome, Edge or Firefox.');
  const bitrate = Math.max(150_000, Math.round(width * height * fps * BPP[quality]));
  const config = { width, height, bitrate, framerate: fps };
  const picked = await pickCodec(config);
  if (!picked) throw new Error('This browser can’t encode VP9 or VP8 at this size.');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: picked.mux, width, height, frameRate: fps },
    firstTimestampBehavior: 'offset',
  });
  let error = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { error = e; },
  });
  encoder.configure({ ...config, codec: picked.codec });

  const frameUs = 1e6 / fps;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  let i = 0;

  return {
    async add(canvas) {
      if (error) throw error;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      i++;
      // Back-pressure so long clips don't queue hundreds of frames in memory.
      while (encoder.encodeQueueSize > 8) {
        await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
      }
    },
    async finish() {
      await encoder.flush();
      if (error) throw error;
      encoder.close();
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/webm' });
    },
    close() {
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}
