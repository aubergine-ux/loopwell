// Every knob that an automation lane can move. The order is part of the
// share-link format, so new entries go at the end of their group's list.

import type { Project, Track, TrackKind } from './types';

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  scope: 'track' | 'master';
  /** Only offered for this kind of track. */
  kind?: TrackKind;
  get: (o: any) => number;
  set: (o: any, v: number) => void;
}

const track = (id: string, label: string, min: number, max: number, def: number, key: keyof Track, kind?: TrackKind): ParamDef => ({
  id, label, min, max, def, scope: 'track', kind,
  get: (t: Track) => t[key] as number,
  set: (t: Track, v) => { (t[key] as number) = v; },
});
type SynthKnob = { [K in keyof Track['synth']]: Track['synth'][K] extends number ? K : never }[keyof Track['synth']];
const synth = (id: string, label: string, def: number, key: SynthKnob, min = 0, max = 127): ParamDef => ({
  id, label, min, max, def, scope: 'track', kind: 'synth',
  get: (t: Track) => t.synth[key],
  set: (t: Track, v) => { t.synth[key] = v; },
});
type BassKnob = { [K in keyof Track['bass']]: Track['bass'][K] extends number ? K : never }[keyof Track['bass']];
const bass = (id: string, label: string, def: number, key: BassKnob): ParamDef => ({
  id, label, min: 0, max: 127, def, scope: 'track', kind: 'bass',
  get: (t: Track) => t.bass[key],
  set: (t: Track, v) => { t.bass[key] = v; },
});
const dsyn = (id: string, label: string, def: number, key: Exclude<keyof Track['dsyn'], 'model'>, min = 0, max = 127): ParamDef => ({
  id, label, min, max, def, scope: 'track', kind: 'dsyn',
  get: (t: Track) => t.dsyn[key],
  set: (t: Track, v) => { t.dsyn[key] = v; },
});
const fx = (id: string, label: string, min: number, max: number, def: number, key: keyof Project['fx']): ParamDef => ({
  id, label, min, max, def, scope: 'master',
  get: (p: Project) => p.fx[key] as number,
  set: (p: Project, v) => { (p.fx[key] as number) = v; },
});

export const PARAMS: ParamDef[] = [
  track('vol', 'Level', 0, 127, 100, 'vol'),
  track('pan', 'Pan', -64, 63, 0, 'pan'),
  track('filter', 'Filter', -64, 63, 0, 'filter'),
  track('rev', 'Reverb send', 0, 127, 0, 'rev'),
  track('dly', 'Delay send', 0, 127, 0, 'dly'),
  track('tune', 'Tune', -24, 24, 0, 'tune', 'drum'),
  track('decay', 'Decay', 0, 127, 127, 'decay', 'drum'),
  synth('cutoff', 'Cutoff', 70, 'cutoff'),
  synth('reso', 'Resonance', 30, 'reso'),
  synth('env', 'Filter env', 60, 'env'),
  {
    id: 'master', label: 'Volume', min: 0, max: 127, def: 100, scope: 'master',
    get: (p: Project) => p.master, set: (p: Project, v) => { p.master = v; },
  },
  fx('mfilter', 'Filter', -64, 63, 0, 'filter'),
  fx('mres', 'Filter reso', 0, 127, 30, 'filterRes'),
  fx('revlvl', 'Reverb level', 0, 127, 90, 'revLevel'),
  fx('revsize', 'Reverb size', 0, 127, 70, 'revSize'),
  fx('dlylvl', 'Delay level', 0, 127, 90, 'dlyLevel'),
  fx('dlyfb', 'Delay feedback', 0, 127, 50, 'dlyFb'),
  synth('pos', 'Osc 1 shape', 0, 'pos'),
  synth('pos2', 'Osc 2 shape', 0, 'pos2'),
  synth('mix', 'Osc mix', 0, 'mix'),
  synth('noise', 'Noise', 0, 'noise'),
  synth('detune', 'Detune', 9, 'detune'),
  synth('spread', 'Width', 0, 'spread'),
  synth('lforate', 'LFO rate', 64, 'lfoRate'),
  synth('lfoamt', 'LFO amount', 0, 'lfoAmt', -64, 63),
  synth('menvamt', 'Mod env amount', 0, 'menvAmt', -64, 63),
  track('stretch', 'Stretch', 0, 127, 64, 'stretch', 'slice'),
  bass('bdrive', 'Drive', 45, 'drive'),
  bass('bdecay', 'Decay', 90, 'decay'),
  bass('btone', 'Tone', 50, 'tone'),
  bass('bglide', 'Glide', 40, 'glide'),
  dsyn('dtune', 'Tune', 0, 'tune', -24, 24),
  dsyn('ddecay', 'Decay', 50, 'decay'),
  dsyn('dtone', 'Tone', 50, 'tone'),
  dsyn('dsnap', 'Snap', 50, 'snap'),
];

export const paramIndex = (id: string) => PARAMS.findIndex((d) => d.id === id);
export const paramDef = (id: string) => PARAMS.find((d) => d.id === id);

/** The parameters a lane on this track (or the master, track -1) can target. */
export function paramsFor(p: Project, trackIdx: number): ParamDef[] {
  if (trackIdx < 0) return PARAMS.filter((d) => d.scope === 'master');
  const kind = p.tracks[trackIdx]?.kind;
  // a sliced sample has the drum knobs too
  return PARAMS.filter((d) => d.scope === 'track' && (!d.kind || d.kind === kind || (d.kind === 'drum' && kind === 'slice')));
}
