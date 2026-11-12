// Checks that an uploaded sample really is audio. The format is decided by
// magic bytes, never by filename. WAV, AIFF and FLAC headers are parsed far
// enough to know duration, channel count and sample rate; compressed formats
// are only identified.

import { HttpError } from './util.ts';

export type AudioFormat = 'wav' | 'aiff' | 'mp3' | 'ogg' | 'flac' | 'm4a';

export interface AudioInfo {
  format: AudioFormat;
  durationMs: number | null;
  channels: number | null;
  sampleRate: number | null;
}

export const AUDIO_MIME: Record<AudioFormat, string> = {
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
};

export const MAX_CHANNELS = 8;
export const MIN_SAMPLE_RATE = 4000;
export const MAX_SAMPLE_RATE = 192_000;

const unsupported = () => new HttpError(415, 'unsupported_audio', 'Not a recognised audio file. Accepted formats: WAV, AIFF, MP3, OGG, FLAC, M4A.');
const invalid = (why: string) => new HttpError(422, 'invalid_audio', `The audio file is damaged or unusual: ${why}.`);

const tag = (b: Buffer, at: number): string => b.toString('latin1', at, at + 4);

const M4A_BRANDS = ['M4A ', 'M4B ', 'mp41', 'mp42', 'isom', 'iso2'];

/** An MPEG audio frame header: 11 sync bits, then a valid layer, bitrate and rate. */
function mp3Frame(b: Buffer, at: number): boolean {
  if (at + 4 > b.length) return false;
  return b[at] === 0xff && (b[at + 1] & 0xe0) === 0xe0
    && (b[at + 1] & 0x18) !== 0x08 // reserved version
    && (b[at + 1] & 0x06) !== 0 // reserved layer
    && (b[at + 2] & 0xf0) !== 0xf0 // bad bitrate
    && (b[at + 2] & 0x0c) !== 0x0c; // reserved sample rate
}

export function sniff(b: Buffer): AudioFormat | null {
  if (b.length < 12) return null;
  if (tag(b, 0) === 'RIFF' && tag(b, 8) === 'WAVE') return 'wav';
  if (tag(b, 0) === 'FORM' && (tag(b, 8) === 'AIFF' || tag(b, 8) === 'AIFC')) return 'aiff';
  if (tag(b, 0) === 'OggS') return 'ogg';
  if (tag(b, 0) === 'fLaC') return 'flac';
  if (tag(b, 4) === 'ftyp' && M4A_BRANDS.includes(tag(b, 8))) return 'm4a';
  if (tag(b, 0).startsWith('ID3')) {
    // an ID3v2 tag: the first audio frame must follow it
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return mp3Frame(b, 10 + size) ? 'mp3' : null;
  }
  if (mp3Frame(b, 0)) return 'mp3';
  return null;
}

function checkShape(channels: number, sampleRate: number): void {
  if (channels < 1 || channels > MAX_CHANNELS) throw invalid(`${channels} channels (1 to ${MAX_CHANNELS} are accepted)`);
  if (!(sampleRate >= MIN_SAMPLE_RATE && sampleRate <= MAX_SAMPLE_RATE)) {
    throw invalid(`a sample rate of ${Math.round(sampleRate)} Hz (${MIN_SAMPLE_RATE} to ${MAX_SAMPLE_RATE} are accepted)`);
  }
}

function wav(b: Buffer): AudioInfo {
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let dataBytes = -1;
  let at = 12;
  while (at + 8 <= b.length) {
    const id = tag(b, at);
    const size = b.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > b.length) throw invalid('the format chunk is cut short');
      channels = b.readUInt16LE(body + 2);
      sampleRate = b.readUInt32LE(body + 4);
      blockAlign = b.readUInt16LE(body + 12);
    } else if (id === 'data') {
      // streamed files leave the size at 0 or 0xffffffff; trust the bytes present
      dataBytes = Math.min(size, b.length - body);
      break;
    }
    at = body + size + (size & 1);
  }
  if (!channels && !sampleRate) throw invalid('it has no format chunk');
  checkShape(channels, sampleRate);
  if (dataBytes < 0) throw invalid('it has no audio data');
  if (blockAlign < channels) throw invalid('the frame size does not fit the channel count');
  return { format: 'wav', channels, sampleRate, durationMs: Math.round((dataBytes / blockAlign / sampleRate) * 1000) };
}

/** The 80-bit extended float AIFF uses for its sample rate. */
function extended(b: Buffer, at: number): number {
  const exponent = ((b[at] & 0x7f) << 8) | b[at + 1];
  const mantissa = b.readUInt32BE(at + 2) * 2 ** 32 + b.readUInt32BE(at + 6);
  if (exponent === 0 && mantissa === 0) return 0;
  if (exponent === 0x7fff) return Infinity;
  return mantissa * 2 ** (exponent - 16383 - 63);
}

function aiff(b: Buffer): AudioInfo {
  let at = 12;
  while (at + 8 <= b.length) {
    const id = tag(b, at);
    const size = b.readUInt32BE(at + 4);
    const body = at + 8;
    if (id === 'COMM') {
      if (size < 18 || body + 18 > b.length) throw invalid('the format chunk is cut short');
      const channels = b.readInt16BE(body);
      const frames = b.readUInt32BE(body + 2);
      const sampleRate = extended(b, body + 8);
      checkShape(channels, sampleRate);
      return { format: 'aiff', channels, sampleRate: Math.round(sampleRate), durationMs: Math.round((frames / sampleRate) * 1000) };
    }
    at = body + size + (size & 1);
  }
  throw invalid('it has no format chunk');
}

function flac(b: Buffer): AudioInfo {
  // the STREAMINFO block always comes first: a 4-byte block header, then 34 bytes
  if (b.length < 42 || (b[4] & 0x7f) !== 0) throw invalid('the stream header is missing');
  const sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const channels = ((b[20] >> 1) & 7) + 1;
  const samples = (b[21] & 0x0f) * 2 ** 32 + b.readUInt32BE(22);
  checkShape(channels, sampleRate);
  // zero means the encoder did not know the length
  return { format: 'flac', channels, sampleRate, durationMs: samples ? Math.round((samples / sampleRate) * 1000) : null };
}

/** Identifies the file and enforces the duration limit where it can be known. */
export function scanAudio(b: Buffer, maxSeconds: number): AudioInfo {
  const format = sniff(b);
  if (!format) throw unsupported();
  const info: AudioInfo = format === 'wav' ? wav(b) : format === 'aiff' ? aiff(b) : format === 'flac' ? flac(b) : { format, durationMs: null, channels: null, sampleRate: null };
  if (info.durationMs !== null && info.durationMs > maxSeconds * 1000) {
    throw new HttpError(422, 'audio_too_long', `Samples can be at most ${maxSeconds} seconds long; this one is ${(info.durationMs / 1000).toFixed(1)} s.`);
  }
  return info;
}
