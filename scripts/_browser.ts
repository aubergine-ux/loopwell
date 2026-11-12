// Shared helper for the browser-driven scripts: serves the production build
// and opens it in headless Chromium.

import { chromium, type Browser, type Page } from 'playwright-core';
import { preview } from 'vite';

export async function launch(opts: { width?: number; height?: number; touch?: boolean; video?: string; scale?: number; autoplay?: boolean } = {}): Promise<{
  page: Page; browser: Browser; url: string; errors: string[]; close: () => Promise<void>;
}> {
  const server = await preview({ preview: { port: 4179, strictPort: false }, logLevel: 'error' });
  const url = server.resolvedUrls!.local[0];
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    // pass autoplay: false to get the real-world policy, where sound needs a click first
    // a made-up microphone, so recording can be tested without hardware or a permission prompt
    args: [opts.autoplay === false ? '--autoplay-policy=document-user-activation-required' : '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const size = { width: opts.width ?? 1440, height: opts.height ?? 900 };
  const ctx = await browser.newContext({
    viewport: size, deviceScaleFactor: opts.scale ?? 1, hasTouch: !!opts.touch,
    recordVideo: opts.video ? { dir: opts.video, size } : undefined,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  return {
    page, browser, url, errors,
    close: async () => { await ctx.close(); await browser.close(); await new Promise<void>((r) => server.httpServer.close(() => r())); },
  };
}
