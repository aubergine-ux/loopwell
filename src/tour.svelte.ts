// The first-run walkthrough: seven small things to do that add up to a beat.
// Each step points at part of the screen and moves on by itself when the thing
// has been done, so it teaches by doing rather than by reading.

import { emptyProject } from './core/types';
import { setPref } from './prefs.svelte';
import { openAsNew } from './projects.svelte';
import { app } from './state.svelte';

export interface TourStep {
  title: string;
  text: string;
  /** CSS selector of what to point at. */
  target: string;
  /** Has the person done it? */
  done: () => boolean;
  /** Set the screen up for this step. */
  enter?: () => void;
}

const row = (t: number) => app.project.patterns[app.pat]?.steps[t] ?? [];
const count = (t: number) => row(t).filter((v) => v > 0).length;
const bass = () => app.project.tracks.findIndex((t) => t.kind === 'synth' || t.kind === 'bass');

export const TOUR: TourStep[] = [
  {
    title: 'Start with a kick',
    text: 'Click steps 1, 5, 9 and 13 in the KICK row. That is a kick drum on every beat: the pulse of most dance music.',
    target: '.row[data-row="0"] .cells',
    done: () => [0, 4, 8, 12].every((s) => row(0)[s] > 0),
    enter: () => { app.perform = app.stage = false; app.project.songMode = false; app.sel = 0; },
  },
  {
    title: 'Hear it',
    text: 'Press play, or the space bar. The pattern loops round and round while you build on it.',
    target: '.tbtn.play',
    done: () => app.playing,
  },
  {
    title: 'Add a backbeat',
    text: 'Put a CLAP on steps 5 and 13. Now it has somewhere to land.',
    target: '.row[data-row="2"] .cells',
    done: () => row(2)[4] > 0 && row(2)[12] > 0,
  },
  {
    title: 'Paint some hi-hats',
    text: 'Press on a step in the HAT row and drag sideways to paint a run of them. Drag a step up or down to make it louder or softer.',
    target: '.row[data-row="3"] .cells',
    done: () => count(3) >= 4,
  },
  {
    title: 'Pick the bass',
    text: 'Click BASS to select it. Its notes are drawn in the Keys panel below, which opens for you.',
    target: `.row[data-row="6"] .head`,
    done: () => app.sel === bass(),
  },
  {
    title: 'Draw a bassline',
    text: 'Click in the grid to add three or more notes; drag one to move it or make it longer. Only notes in the key are shown, so none of them can be wrong.',
    target: '.roll .scroller',
    done: () => (app.project.patterns[app.pat]?.notes[bass()]?.length ?? 0) >= 3,
    enter: () => { app.tab = 'keys'; },
  },
  {
    title: 'Give it some swing',
    text: 'Drag the Swing knob upwards and listen to the beat loosen up.',
    target: '.deck .knobs .knob',
    done: () => app.project.swing >= 12,
  },
];

export const tour = $state({
  /** A step was just done; the tick is showing before the next one. */
  ticked: false,
  /** What is being walked through: the first-run walkthrough, or a lesson from Learn. */
  steps: TOUR,
  /** The lesson's id; '' for the walkthrough. */
  lesson: '',
  /** What to call it on the cards. */
  name: 'Walkthrough',
  /** Said when the last step is done. */
  end: { title: '', text: '' },
  /** Called when a lesson is finished to the end. */
  finished: null as null | (() => void),
});

/** Walk through a lesson's steps on the beat that is open. */
export function runSteps(lesson: string, name: string, steps: TourStep[], end: { title: string; text: string }, finished: () => void): void {
  tour.ticked = false;
  tour.steps = steps;
  tour.lesson = lesson;
  tour.name = name;
  tour.end = end;
  tour.finished = finished;
  app.modal = null;
  app.tour = 0;
  steps[0].enter?.();
}

/** Begin on a clean beat, so that everything heard at the end was made in the tour. */
export async function startTour(): Promise<void> {
  const p = emptyProject();
  p.name = 'My first beat';
  await openAsNew(p, 'Started the walkthrough');
  tour.steps = TOUR;
  tour.lesson = '';
  tour.name = 'Walkthrough';
  tour.finished = null;
  app.modal = null;
  app.tour = 0;
  TOUR[0].enter?.();
}

export function tourNext(): void {
  tour.ticked = false;
  if (app.tour < 0) return;
  app.tour++;
  // the last card is the finish, not a step
  if (app.tour >= tour.steps.length) { if (tour.lesson) tour.finished?.(); else setPref('toured', true); }
  else tour.steps[app.tour].enter?.();
}

export function endTour(): void {
  tour.ticked = false;
  app.tour = -1;
  if (!tour.lesson) setPref('toured', true);
}
