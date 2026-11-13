// The player that can be put on other websites: what its address means and
// the snippets people paste. The player itself is in src/embed.

import { HASH_KEY, decodeBeat } from './share';
import type { Project } from './types';

export const EMBED_PAGE = 'embed.html';
export const EMBED_SCRIPT = 'player.js';
export const EMBED_THEMES = ['cream', 'night', 'slate', 'arcade', 'contrast'] as const;
/** Tall enough for the title, the waveform and the buttons. */
export const EMBED_HEIGHT = 152;

export interface EmbedOptions {
  /** null when the address holds no beat, or one that can't be read. */
  project: Project | null;
  code: string;
  /** '' follows the visitor's light or dark setting. */
  theme: string;
  /** The pattern played when the beat has no song arranged. */
  pattern: number;
}

/** Read a player address: everything is after the #, as `b=<beat>&theme=night&p=2`. */
export function embedOptions(hash: string): EmbedOptions {
  const get = (key: string) => new RegExp(`[#&]${key}=([^&]*)`).exec(hash)?.[1] ?? '';
  const code = get(HASH_KEY);
  const project = decodeBeat(code);
  const theme = get('theme');
  const p = parseInt(get('p'), 10);
  return {
    project, code,
    theme: (EMBED_THEMES as readonly string[]).includes(theme) ? theme : '',
    pattern: project && p >= 0 && p < project.patterns.length ? p : 0,
  };
}

/** The folder the app is served from, with a slash on the end. */
export function appBase(href: string): string {
  return href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');
}

export function embedUrl(base: string, code: string, opts: { theme?: string; pattern?: number } = {}): string {
  return `${base}${EMBED_PAGE}#${HASH_KEY}=${code}${opts.theme ? `&theme=${opts.theme}` : ''}${opts.pattern ? `&p=${opts.pattern}` : ''}`;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** An iframe: works anywhere HTML can be pasted. */
export function iframeSnippet(base: string, code: string, title: string, opts: { theme?: string; pattern?: number } = {}): string {
  return `<iframe src="${attr(embedUrl(base, code, opts))}" title="${attr(title || 'A beat')} on Loopwell" width="100%" height="${EMBED_HEIGHT}" style="border:0;border-radius:14px;max-width:560px" loading="lazy" allow="autoplay"></iframe>`;
}

/** The custom element: one script on the page, then a tag per beat. */
export function elementSnippet(base: string, code: string, opts: { theme?: string; pattern?: number } = {}): string {
  return `<script src="${attr(base + EMBED_SCRIPT)}" async></script>\n<loopwell-player beat="${attr(code)}"${opts.theme ? ` theme="${opts.theme}"` : ''}${opts.pattern ? ` pattern="${opts.pattern}"` : ''}></loopwell-player>`;
}
