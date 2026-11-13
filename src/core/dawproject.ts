// DAWproject: the open exchange format that Bitwig Studio, Studio One, Cubase
// and others read (https://github.com/bitwig/dawproject). A .dawproject file is
// a zip holding project.xml, metadata.xml and the audio.
//
// Another program doesn't have Loopwell's instruments, so a beat goes over
// twice: every track's sound as audio, so it opens sounding as it did here,
// and every track's notes, so the parts can be given new instruments there.

import { barsUpTo, songEnd, stepToSeconds, tempoAt } from './arrange';
import { GM_NOTE, type Slot } from './kits';
import { NOTE_NAMES, SCALES } from './scales';
import { usesNotes, type Project, type Track } from './types';

/** A track's rendered sound, already written into the zip at `path`. */
export interface DawStem { track: number; path: string; seconds: number; sampleRate: number }

// the track colours as they are in the default theme; another program can't follow a theme
const COLORS = ['#ff4f1a', '#ff9a1f', '#f0c22b', '#35c47c', '#1fb7c6', '#3f7cff', '#8b5cf6', '#ee5aa6'];

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
  // XML has no way to write most control characters at all
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);
/** Steps are sixteenths; DAWproject counts in quarter notes. */
const beats = (steps: number) => num(steps / 4);

/** The key a drum track's hits are written on: the General MIDI drum for its sound. */
function drumKey(t: Track, index: number): number {
  return t.kind === 'dsyn' ? [36, 38, 42, 39][t.dsyn.model] : GM_NOTE[t.sample.split('/')[1] as Slot] ?? 60 + index;
}

interface Part { pattern: number; start: number; len: number; offset: number }

/** How many steps of the song a length of audio covers, tempo changes included. */
function stepsFor(p: Project, seconds: number, chain: boolean): number {
  if (chain || !p.arr.tempo.length) return (seconds * p.bpm) / 15;
  let step = 0;
  while (step < 100000 && stepToSeconds(p, step + 1) <= seconds) step++;
  const here = stepToSeconds(p, step);
  return step + ((seconds - here) * tempoAt(p, step)) / 15;
}

/**
 * The two XML files of a .dawproject. With `chain`, those patterns one after another; without, the song.
 * `stems` are the audio files that will sit beside them in the zip.
 */
export function dawproject(p: Project, chain: number[] | undefined, stems: DawStem[], appVersion: string): { project: string; metadata: string } {
  let ids = 0;
  const id = () => `id${ids++}`;
  const total = chain ? chain.length * p.steps : songEnd(p.arr) || p.steps;
  const partsOf = (ti: number): Part[] => (chain
    ? chain.map((pattern, bar) => ({ pattern, start: bar * p.steps, len: p.steps, offset: 0 }))
    : p.arr.clips.filter((c) => c.track === ti).sort((a, b) => a.start - b.start).map((c) => ({ pattern: c.pattern, start: c.start, len: c.len, offset: c.offset })));

  const tempoId = id(), sigId = id(), masterId = id(), masterChannel = id();
  const bars = chain ? null : barsUpTo(p, total);
  const firstBar = bars?.[0];

  const channel = (chId: string, vol: number, pan: number, mute: boolean, solo: boolean, role: string, dest?: string) =>
    `      <Channel audioChannels="2"${dest ? ` destination="${dest}"` : ''} role="${role}" solo="${solo}" id="${chId}">\n`
    + `        <Mute value="${mute}" id="${id()}" name="Mute"/>\n`
    + `        <Pan max="1" min="0" unit="normalized" value="${num(pan)}" id="${id()}" name="Pan"/>\n`
    + `        <Volume max="2" min="0" unit="linear" value="${num(vol)}" id="${id()}" name="Volume"/>\n`
    + '      </Channel>\n';

  let structure = '', lanes = '';
  const anySolo = p.tracks.some((t) => t.solo);

  // the sound of each track, as it was here
  for (const s of stems) {
    const t = p.tracks[s.track];
    if (!t) continue;
    const trackId = id();
    structure += `    <Track contentType="audio" loaded="true" id="${trackId}" name="${esc(t.name)}" color="${COLORS[t.color & 7]}">\n`
      // the file already has the track's level, pan and effects in it, so the fader starts flat
      + channel(id(), 1, 0.5, false, false, 'regular', masterChannel)
      + '    </Track>\n';
    const len = stepsFor(p, s.seconds, !!chain);
    lanes += `      <Lanes track="${trackId}" id="${id()}">\n        <Clips id="${id()}">\n`
      + `          <Clip time="0" duration="${beats(len)}" contentTimeUnit="seconds" playStart="0" name="${esc(t.name)}">\n`
      + `            <Audio algorithm="raw" channels="2" duration="${num(s.seconds)}" sampleRate="${s.sampleRate}" id="${id()}">\n`
      + `              <File path="${esc(s.path)}"/>\n            </Audio>\n          </Clip>\n        </Clips>\n      </Lanes>\n`;
  }

  // and the notes, for giving the parts new instruments. They have no sound of their own in another program,
  // so they sit muted beside the audio rather than doubling it once an instrument is put on them.
  p.tracks.forEach((t, ti) => {
    const drum = !usesNotes(t.kind);
    let clips = '';
    for (const part of partsOf(ti)) {
      const pat = p.patterns[part.pattern];
      if (!pat) continue;
      let notes = '';
      for (let k = 0; k < part.len; k++) {
        const local = (k + part.offset) % p.steps;
        if (drum) {
          const vel = pat.steps[ti]?.[local];
          if (vel) notes += `              <Note time="${beats(k)}" duration="0.125" channel="0" key="${drumKey(t, ti)}" vel="${num(vel / 127)}" rel="0.5"/>\n`;
        } else {
          for (const n of pat.notes[ti] ?? []) {
            if (n.s !== local) continue;
            const key = t.kind === 'slice' ? Math.min(127, 36 + n.p) : n.p;
            notes += `              <Note time="${beats(k)}" duration="${beats(Math.min(n.l, part.len - k))}" channel="0" key="${key}" vel="${num(n.v / 127)}" rel="0.5"/>\n`;
          }
        }
      }
      if (!notes) continue;
      clips += `          <Clip time="${beats(part.start)}" duration="${beats(part.len)}" playStart="0" name="${esc(`${t.name} ${String.fromCharCode(65 + part.pattern)}`)}">\n`
        + `            <Notes id="${id()}">\n${notes}            </Notes>\n          </Clip>\n`;
    }
    if (!clips) return;
    const trackId = id();
    const hasAudio = stems.some((s) => s.track === ti);
    structure += `    <Track contentType="notes" loaded="true" id="${trackId}" name="${esc(`${t.name} notes`)}" color="${COLORS[t.color & 7]}">\n`
      + channel(id(), (t.vol / 100) * (t.vol / 100), (t.pan + 64) / 127, hasAudio || t.mute || (anySolo && !t.solo), false, 'regular', masterChannel)
      + '    </Track>\n';
    lanes += `      <Lanes track="${trackId}" id="${id()}">\n        <Clips id="${id()}">\n${clips}        </Clips>\n      </Lanes>\n`;
  });

  structure += `    <Track contentType="audio notes" loaded="true" id="${masterId}" name="Master">\n`
    + channel(masterChannel, (p.master / 100) * (p.master / 100), 0.5, false, false, 'master')
    + '    </Track>\n';

  let extra = '';
  if (!chain) {
    if (p.arr.markers.length) {
      extra += `    <Markers id="${id()}">\n`
        + [...p.arr.markers].sort((a, b) => a.at - b.at).map((m) => `      <Marker time="${beats(m.at)}" name="${esc(m.name)}" color="${COLORS[m.color & 7]}"/>\n`).join('')
        + '    </Markers>\n';
    }
    if (p.arr.tempo.length) {
      extra += `    <TempoAutomation unit="bpm" id="${id()}">\n      <Target parameter="${tempoId}"/>\n`
        + `      <RealPoint time="0" value="${num(p.bpm)}" interpolation="hold"/>\n`
        + [...p.arr.tempo].sort((a, b) => a.at - b.at).filter((e) => e.at > 0 && e.at < total).map((e) => `      <RealPoint time="${beats(e.at)}" value="${num(e.bpm)}" interpolation="hold"/>\n`).join('')
        + '    </TempoAutomation>\n';
    }
    if (bars && p.arr.sigs.length) {
      let n = 0, d = 0, pts = '';
      for (const b of bars) if (b.num !== n || b.den !== d) { n = b.num; d = b.den; pts += `      <TimeSignaturePoint time="${beats(b.start)}" numerator="${n}" denominator="${d}"/>\n`; }
      extra += `    <TimeSignatureAutomation id="${id()}">\n      <Target parameter="${sigId}"/>\n${pts}    </TimeSignatureAutomation>\n`;
    }
  }

  const project = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<Project version="1.0">\n'
    + `  <Application name="Loopwell" version="${esc(appVersion)}"/>\n`
    + '  <Transport>\n'
    + `    <Tempo max="666" min="20" unit="bpm" value="${num(p.bpm)}" id="${tempoId}" name="Tempo"/>\n`
    + `    <TimeSignature denominator="${firstBar?.den ?? 4}" numerator="${firstBar?.num ?? 4}" id="${sigId}"/>\n`
    + '  </Transport>\n'
    + `  <Structure>\n${structure}  </Structure>\n`
    + `  <Arrangement id="${id()}">\n    <Lanes timeUnit="beats" id="${id()}">\n${lanes}    </Lanes>\n${extra}  </Arrangement>\n`
    + '  <Scenes/>\n</Project>\n';

  const pitched = p.tracks.some((t) => t.kind === 'synth' || t.kind === 'bass' || t.kind === 'plugin');
  const key = pitched ? ` Key: ${NOTE_NAMES[p.scaleRoot]} ${SCALES[p.scaleType]?.name.toLowerCase() ?? ''}.` : '';
  const metadata = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<MetaData>\n'
    + `  <Title>${esc(p.name && p.name !== 'untitled' ? p.name : 'Untitled beat')}</Title>\n`
    + `  <Comment>${esc(`Made with Loopwell. Tempo: ${p.bpm} BPM.${key} Each track is here twice: as audio, and as muted notes to put your own instruments on.`)}</Comment>\n`
    + '</MetaData>\n';
  return { project, metadata };
}
