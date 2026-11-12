import { emptyProject } from '../../src/core/types';

/** Every step on, on every track, six-note chords on both synths, all effects up. */
export function stressProject() {
  const p = emptyProject();
  p.bpm = 200;
  p.steps = 32;
  p.swing = 55;
  p.fx.filter = -20;
  p.tracks.forEach((t, i) => {
    t.rev = 100; t.dly = 100; t.filter = i % 2 ? 30 : -30; t.pan = i * 16 - 60;
    t.synth.release = 90; t.synth.sustain = 100;
  });
  for (const pat of p.patterns) {
    p.tracks.forEach((t, i) => {
      for (let s = 0; s < 32; s++) {
        if (t.kind === 'drum') pat.steps[i][s] = 60 + ((s * 7) % 60);
        else for (const off of [0, 4, 7, 11, 14, 19]) pat.notes[i].push({ s, l: 4, p: 40 + off + (s % 5), v: 100 });
      }
    });
  }
  return p;
}
