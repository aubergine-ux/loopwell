// Shared helper for the browser-driven scripts: serves the production build
// and opens it in headless Chromium.

import { chromium, firefox, type Browser, type Page } from 'playwright-core';
import { preview } from 'vite';

export async function launch(opts: { width?: number; height?: number; touch?: boolean; video?: string; scale?: number; autoplay?: boolean; microphone?: string } = {}): Promise<{
  page: Page; browser: Browser; url: string; errors: string[]; close: () => Promise<void>;
}> {
  const server = await preview({ preview: { port: 4179, strictPort: false }, logLevel: 'error' });
  const url = server.resolvedUrls!.local[0];
  // BROWSER=firefox runs the same checks in Firefox (npx playwright-core install firefox first). Sound may start
  // without a click and a made-up microphone stands in for a real one, as in Chromium below.
  const browser = process.env.BROWSER === 'firefox' ? await firefox.launch({
    firefoxUserPrefs: {
      'media.autoplay.default': opts.autoplay === false ? 1 : 0, 'media.autoplay.blocking_policy': 0,
      'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true,
    },
  }) : await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    // pass autoplay: false to get the real-world policy, where sound needs a click first
    // a made-up microphone, so recording can be tested without hardware or a permission prompt
    args: [opts.autoplay === false ? '--autoplay-policy=document-user-activation-required' : '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      // `microphone` is a WAV file the made-up microphone plays, for testing things that listen (%noloop: once, then silence)
      ...(opts.microphone ? [`--use-file-for-fake-audio-capture=${opts.microphone}%noloop`] : [])],
  });
  const size = { width: opts.width ?? 1440, height: opts.height ?? 900 };
  const ctx = await browser.newContext({
    viewport: size, deviceScaleFactor: opts.scale ?? 1, hasTouch: !!opts.touch,
    recordVideo: opts.video ? { dir: opts.video, size } : undefined,
  });
  // SLOW=300 holds every script back by that many milliseconds, as a slow connection or a busy machine would: the
  // way to find a test (or a part of the app) that assumes something loaded on demand is there at once
  const slow = Number(process.env.SLOW) || 0;
  if (slow) await ctx.route(/\/assets\/.*\.js$/, async (route) => { await new Promise((r) => setTimeout(r, slow)); await route.continue(); });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // Firefox remarks on every audio context made before a click; the app expects that and shows its tap-to-play prompt
  // and, when a page is left while it is playing, on cutting its audio script off mid-block; and it doesn't know the
  // "autoplay" permission that an embedded player's frame asks for
  const expected = /AudioContext was prevented from starting automatically|Script terminated by timeout at:[\s\S]*worklet-|Permissions Policy: Skipping unsupported feature name .autoplay/;
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !expected.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
  return {
    page, browser, url, errors,
    close: async () => { await ctx.close(); await browser.close(); await new Promise<void>((r) => server.httpServer.close(() => r())); },
  };
}
