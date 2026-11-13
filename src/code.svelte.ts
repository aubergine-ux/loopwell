// Live code: turning what is on the grid into text and back.

import { checkpoint, toast } from './actions.svelte';
import { codeInfo, compileCode, gridAsCode } from './core/mini';
import { MAX_STEPS, usesNotes } from './core/types';
import { app } from './state.svelte';

/** Replace the code with the pattern on screen, written out. The grid is left alone, so the code is switched off to keep it from doubling. */
export function codeFromGrid(): void {
  const text = gridAsCode(app.project, app.pat);
  if (!text) { toast('This pattern is empty: there is nothing to write out yet.'); return; }
  checkpoint();
  app.project.code = text;
  app.project.codeOn = false;
  toast('The pattern is written out as code. It is switched off so it doesn\'t double the grid: clear the grid, or change the code, then switch it on.');
}

/** Write what the code plays in its first bar onto the grid, on the nearest steps, and switch the code off. */
export function codeToGrid(): void {
  const p = app.project;
  const lines = compileCode(p.code, codeInfo(p)).filter((l) => !l.error && l.cycles.length);
  if (!lines.length) { toast('There is no working line of code to write to the grid.'); return; }
  checkpoint();
  const pat = p.patterns[app.pat];
  const done = new Set<number>();
  let moved = 0;
  for (const ln of lines) {
    const t = ln.track, tr = p.tracks[t];
    if (!tr) continue;
    // the code takes the track over: what was on it in this pattern goes
    if (!done.has(t)) { pat.steps[t] = new Array<number>(MAX_STEPS).fill(0); pat.notes[t] = []; done.add(t); }
    const c = ln.cycles[0];
    for (let i = 0; i < c.t.length; i++) {
      const exact = c.t[i] * p.steps, s = Math.min(p.steps - 1, Math.round(exact));
      if (Math.abs(exact - s) > 0.01) moved++;
      if (usesNotes(tr.kind)) {
        const l = Math.max(1, Math.min(p.steps - s, Math.round(c.d[i] * p.steps)));
        if (!pat.notes[t].some((n) => n.s === s && n.p === c.p[i])) pat.notes[t].push({ s, l, p: c.p[i], v: c.v[i] });
      } else pat.steps[t][s] = Math.max(pat.steps[t][s], c.v[i]);
    }
    pat.notes[t].sort((a, b) => a.s - b.s || a.p - b.p);
  }
  p.codeOn = false;
  toast(moved ? `Written to the grid. ${moved} hit${moved === 1 ? ' was' : 's were'} between steps and moved to the nearest one. The code is switched off.` : 'Written to the grid, and the code is switched off.');
}

export const CODE_EXAMPLE = `// one line per track; each line fills a bar
kick:  x ~ ~ x  ~ ~ x ~
snare: ~ x
hat:   [x x x]*4
lead:  <c4 eb4 g4 bb4> ~ [c5 g4]/2`;
