import { describe, expect, it } from 'vitest';
import { EMBED_HEIGHT, appBase, elementSnippet, embedOptions, embedUrl, iframeSnippet } from '../src/core/embed';
import { encodeBeat } from '../src/core/share';
import { TEMPLATES } from '../src/core/templates';

const beat = TEMPLATES[0].make();
const code = encodeBeat(beat);

describe('player address', () => {
  it('carries the beat, the theme and the pattern after the #', () => {
    const url = embedUrl('https://example.org/loopwell/', code, { theme: 'night', pattern: 2 });
    expect(url.startsWith('https://example.org/loopwell/embed.html#b=')).toBe(true);
    const o = embedOptions(new URL(url).hash);
    expect(o.project?.name).toBe(beat.name);
    expect(o.project?.bpm).toBe(beat.bpm);
    expect(o.theme).toBe('night');
    expect(o.pattern).toBe(2);
    expect(o.code).toBe(code);
  });

  it('reads a plain share link the same way', () => {
    const o = embedOptions(`#b=${code}`);
    expect(o.project).not.toBeNull();
    expect(o.theme).toBe('');
    expect(o.pattern).toBe(0);
  });

  it('survives rubbish', () => {
    expect(embedOptions('').project).toBeNull();
    expect(embedOptions('#b=').project).toBeNull();
    expect(embedOptions('#b=not-a-beat&theme=<script>&p=99').project).toBeNull();
    const o = embedOptions(`#b=${code}&theme=javascript:alert(1)&p=999`);
    expect(o.theme).toBe('');
    expect(o.pattern).toBe(0);
    expect(embedOptions(`#b=${code.slice(0, 40)}`).project).toBeNull();
  });

  it('finds the folder the app is served from', () => {
    expect(appBase('https://a.b/loopwell/#b=xyz')).toBe('https://a.b/loopwell/');
    expect(appBase('https://a.b/loopwell/index.html?x=1#b=xyz')).toBe('https://a.b/loopwell/');
    expect(appBase('http://localhost:5173/')).toBe('http://localhost:5173/');
  });
});

describe('embed code', () => {
  it('makes an iframe that names the beat and cannot be broken out of', () => {
    const html = iframeSnippet('https://a.b/', code, 'My "best" <beat>');
    expect(html).toContain(`src="https://a.b/embed.html#b=${code}"`);
    expect(html).toContain(`height="${EMBED_HEIGHT}"`);
    expect(html).toContain('title="My &quot;best&quot; &lt;beat> on Loopwell"');
    expect(html.match(/"/g)!.length % 2).toBe(0);
    expect(iframeSnippet('https://a.b/', code, '')).toContain('title="A beat on Loopwell"');
  });

  it('makes a script and a tag for the web component', () => {
    const html = elementSnippet('https://a.b/', code, { pattern: 3 });
    expect(html).toContain('<script src="https://a.b/player.js" async></script>');
    expect(html).toContain(`<loopwell-player beat="${code}" pattern="3"></loopwell-player>`);
  });
});
