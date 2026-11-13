// What a beat really plays, note by note: found by running it through the
// engine and writing down every hit it starts. Rolls, steps that play by
// chance or only on some repeats, grooves and swing, arpeggios and live code
// are all in it, exactly as they are in the sound. The MIDI and DAW-project
// exports and the video's pads are made from this, so they match what is heard.

import { songEnd } from './arrange';
import { renderProject } from './render';
import type { Project } from './types';

export interface Played {
  track: number;
  /** Where it starts, in steps from the beginning; rarely a whole number. */
  step: number;
  /** How long it is held, in steps. 0 for a drum hit, which has no length. */
  len: number;
  pitch: number;
  vel: number;
  /** The same start, in seconds. */
  time: number;
}

/** A moment in seconds as a place in the song in steps, tempo changes included. */
function secondsToStep(p: Project, seconds: number, steady: boolean): number {
  if (steady || !p.arr.tempo.length) return (seconds * p.bpm) / 15;
  // find the tempo stretch the moment falls in
  let at = 0, t = 0, bpm = p.bpm;
  for (const e of [...p.arr.tempo].sort((a, b) => a.at - b.at)) {
    const reached = t + ((e.at - at) * 15) / bpm;
    if (reached > seconds) break;
    t = reached; at = e.at; bpm = e.bpm;
  }
  return at + ((seconds - t) * bpm) / 15;
}

/** Every hit and note, in order. With `chain`, those patterns one after another; without, the song. */
export async function playedNotes(p: Project, chain?: number[]): Promise<Played[]> {
  const sr = 48000;
  const out: Played[] = [];
  const total = chain ? chain.length * p.steps : songEnd(p.arr) || p.steps;
  // no samples are needed to hear what the sequencer does, so this is quick
  await renderProject(p, {}, {
    sampleRate: sr, chain, maxTail: 0,
    onEmit: (track, pitch, vel, gate, frame) => {
      const time = frame / sr;
      const step = secondsToStep(p, time, !!chain);
      if (step >= total) return;
      const len = gate === Infinity ? 0 : secondsToStep(p, time + gate / sr, !!chain) - step;
      out.push({ track, step, len, pitch, vel, time });
    },
  });
  return out.sort((a, b) => a.step - b.step || a.track - b.track || a.pitch - b.pitch);
}
