// Beat videos: the song as an MP4 with a picture that moves to it. The encoder
// is only loaded when a video is made.

import { renderMix, saveAs, toast } from './actions.svelte';
import { hitTimeline } from './core/hits';
import { app } from './state.svelte';
import { loadText, saveText } from './storage';
import { envelopes, type Palette, type Scene, type VideoSize, type VideoStyle } from './video/draw';

const TAG = 'loopwell:producer-tag';

export const video = $state({
  size: 'vertical' as VideoSize,
  style: 'wave' as VideoStyle,
  /** Shown at the top. Starts as the beat's name. */
  title: '',
  /** A line at the bottom, such as "prod. you". Remembered between beats. */
  tag: loadText(TAG) ?? '',
  showTitle: true,
  coverName: '',
  stage: 'idle' as 'idle' | 'audio' | 'frames',
  progress: 0,
  error: '',
});

let cover: ImageBitmap | null = null;
let stop: AbortController | null = null;

export const coverImage = () => cover;

export async function chooseCover(file: File): Promise<void> {
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error('big');
    const next = await createImageBitmap(file);
    cover?.close();
    cover = next;
    video.coverName = file.name;
    video.style = 'cover';
    video.error = '';
  } catch (e) {
    video.error = e instanceof Error && e.message === 'big' ? `${file.name} is too big for a cover (30 MB at most).` : `${file.name} couldn't be read as a picture.`;
  }
}

export function clearCover(): void {
  cover?.close();
  cover = null;
  video.coverName = '';
}

/** The colours of the theme on screen, which the video is drawn in. */
export function palette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#111'), panel: v('--panel', '#222'), ink: v('--ink', '#fff'), dim: v('--dim', '#999'), accent: v('--accent', '#f50'),
    tracks: Array.from({ length: 8 }, (_, i) => v(`--t${i}`, '#888')),
  };
}

/** Everything a frame is drawn from, for the audio given. */
export function sceneFor(mix: Awaited<ReturnType<typeof renderMix>>): Scene {
  const p = mix.project;
  const { level, bass } = envelopes(mix.l, mix.r, mix.sampleRate);
  return {
    l: mix.l, r: mix.r, sampleRate: mix.sampleRate, seconds: mix.l.length / mix.sampleRate,
    hits: hitTimeline(p, mix.chain), trackNames: p.tracks.map((t) => t.name), trackColors: p.tracks.map((t) => t.color),
    palette: palette(), style: video.style, title: video.showTitle ? video.title.trim() : '', tag: video.tag.trim(), cover, level, bass,
  };
}

export const videoBusy = () => video.stage !== 'idle';

/** Render the song and encode it as an MP4, then save it. */
export async function exportVideo(): Promise<boolean> {
  if (videoBusy()) return false;
  video.error = '';
  video.progress = 0;
  video.stage = 'audio';
  saveText(TAG, video.tag.trim());
  stop = new AbortController();
  try {
    const mix = await renderMix((d) => { video.progress = d * 0.15; return new Promise<void>((r) => setTimeout(r)); });
    if (!mix.l.some((x) => x !== 0)) throw new Error('empty');
    video.stage = 'frames';
    const { encodeVideo } = await import('./video/render');
    const bytes = await encodeVideo(sceneFor(mix), video.size, (d) => { video.progress = 0.15 + d * 0.85; return new Promise<void>((r) => setTimeout(r)); }, stop.signal);
    saveAs(bytes, 'mp4', 'video/mp4');
    toast(`Video saved: ${(bytes.length / 1048576).toFixed(1)} MB`);
    return true;
  } catch (e) {
    const err = e instanceof Error ? e : new Error('something went wrong');
    const name = err.name;
    if (name !== 'AbortError') {
      video.error = err.message === 'empty' ? `There is nothing to film yet: the ${app.project.songMode ? 'song' : 'pattern'} is silent.`
        : name === 'VideoUnsupported' ? err.message
        : `The video could not be made: ${err.message}`;
    }
    return false;
  } finally {
    video.stage = 'idle';
    stop = null;
  }
}

export function cancelVideo(): void {
  stop?.abort();
}
