// Encodes a beat video: frames drawn on a canvas and the rendered audio, put
// together as an MP4 in the browser. The encoding is the browser's own
// (WebCodecs); the file is assembled by Mediabunny. All of this is loaded only
// when a video is actually made.

import {
  AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeAudio, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { FPS, VIDEO_SIZES, drawFrame, type Scene, type VideoSize } from './draw';

export class VideoUnsupported extends Error {
  // a name that survives minifying, for telling it apart from other failures
  override name = 'VideoUnsupported';
}

/**
 * Make the MP4. `onProgress` is called with 0..1 as frames are encoded; throw from it (or pass an aborted
 * signal) to stop.
 */
export async function encodeVideo(scene: Scene, size: VideoSize, onProgress?: (done: number) => void | Promise<void>, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const { w, h } = VIDEO_SIZES[size];
  if (typeof VideoEncoder === 'undefined') throw new VideoUnsupported('This browser can\'t encode video. Chrome, Edge and Safari can.');
  const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
  // H.264 first: it is what phones and the sites videos are posted to expect
  const wanted = format.getSupportedVideoCodecs();
  const order = [...wanted.filter((c) => c === 'avc'), ...wanted.filter((c) => c !== 'avc')];
  const videoCodec = await getFirstEncodableVideoCodec(order, { width: w, height: h });
  if (!videoCodec) throw new VideoUnsupported('This browser has no video encoder that can make an MP4 at this size.');
  let audioCodec: 'aac' | 'mp3' = 'aac';
  if (!(await canEncodeAudio('aac'))) {
    // some browsers (Chrome on Linux, Firefox) can't make AAC; MP3 sound in an MP4 plays everywhere that matters
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();
    audioCodec = 'mp3';
  }

  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
  const output = new Output({ format, target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  const audio = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
  output.addVideoTrack(video, { frameRate: FPS });
  output.addAudioTrack(audio);
  await output.start();
  try {
    const buf = new AudioBuffer({ length: scene.l.length, numberOfChannels: 2, sampleRate: scene.sampleRate });
    buf.copyToChannel(scene.l as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(scene.r as Float32Array<ArrayBuffer>, 1);
    await audio.add(buf);
    audio.close();
    const frames = Math.max(1, Math.ceil(scene.seconds * FPS));
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      drawFrame(ctx, w, h, f / FPS, scene);
      await video.add(f / FPS, 1 / FPS);
      if (f % 10 === 0) await onProgress?.(f / frames);
    }
    video.close();
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
  return new Uint8Array(output.target.buffer!);
}
