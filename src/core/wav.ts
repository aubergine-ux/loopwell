/** Encode stereo (or mono) float audio as a PCM WAV file. */
export function encodeWav(channels: Float32Array[], sampleRate: number, bits: 16 | 24 = 24): Uint8Array<ArrayBuffer> {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const dataLen = frames * nch * bytes;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nch, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nch * bytes, true);
  dv.setUint16(32, nch * bytes, true); dv.setUint16(34, bits, true);
  str(36, 'data'); dv.setUint32(40, dataLen, true);
  const max = bits === 16 ? 32767 : 8388607;
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      let x = channels[c][i];
      x = x > 1 ? 1 : x < -1 ? -1 : x;
      const v = Math.round(x * max);
      if (bits === 16) { dv.setInt16(o, v, true); o += 2; }
      else { out[o++] = v & 255; out[o++] = (v >> 8) & 255; out[o++] = (v >> 16) & 255; }
    }
  }
  return out;
}

/** Minimal PCM WAV reader (8/16/24/32-bit int, 32-bit float). Used by tooling and tests. */
export function decodeWav(buf: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = 1, nch = 1, sr = 44100, bits = 16, o = 12;
  while (o + 8 <= buf.length) {
    const id = tag(o), len = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = dv.getUint16(o + 8, true); nch = dv.getUint16(o + 10, true);
      sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true);
    } else if (id === 'data') {
      const bytes = bits / 8;
      const frames = Math.floor(Math.min(len, buf.length - o - 8) / (bytes * nch));
      const channels = Array.from({ length: nch }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += bytes) {
        channels[c][i] = fmt === 3 ? dv.getFloat32(p, true)
          : bits === 8 ? (buf[p] - 128) / 128
          : bits === 16 ? dv.getInt16(p, true) / 32768
          : bits === 24 ? ((dv.getInt8(p + 2) << 16) | (buf[p + 1] << 8) | buf[p]) / 8388608
          : dv.getInt32(p, true) / 2147483648;
      }
      return { channels, sampleRate: sr };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error('WAV has no data chunk');
}
