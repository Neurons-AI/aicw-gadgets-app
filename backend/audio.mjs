// Small audio helpers, no dependencies: WAV <-> PCM16, mono, resample.
export const RATE = 16000;

export function pcmToWav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Parse a WAV file (PCM 8/16/24/32-bit int or 32-bit float, any channels) -> { rate, samples: Float32Array mono } */
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { data = buf.subarray(body, Math.min(body + size, buf.length)); }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data');
  if (fmt.format === 0xfffe) fmt.format = fmt.bits === 32 && data.length % 4 === 0 ? 1 : 1; // extensible: treat as PCM
  const bps = fmt.bits / 8, frames = Math.floor(data.length / (bps * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const p = (i * fmt.channels + c) * bps;
      let v;
      if (fmt.format === 3) v = data.readFloatLE(p);
      else if (fmt.bits === 16) v = data.readInt16LE(p) / 32768;
      else if (fmt.bits === 24) v = data.readIntLE(p, 3) / 8388608;
      else if (fmt.bits === 32) v = data.readInt32LE(p) / 2147483648;
      else v = (data[p] - 128) / 128;
      acc += v;
    }
    out[i] = acc / fmt.channels;
  }
  return { rate: fmt.rate, samples: out };
}

export function resample(samples, from, to = RATE) {
  if (from === to) return samples;
  const n = Math.floor(samples.length * to / from), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * r, i0 = Math.floor(x), f = x - i0;
    const a = samples[i0] ?? 0, b = samples[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}

export function toPcm16(samples) {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  return b;
}

/** Any WAV -> PCM16 mono at `rate` */
export function wavToPcm16(buf, rate = RATE) {
  const { rate: r, samples } = parseWav(buf);
  return toPcm16(resample(samples, r, rate));
}

/** Strip markdown, links and emoji so the reply reads well aloud. */
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`#>|[\]]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
