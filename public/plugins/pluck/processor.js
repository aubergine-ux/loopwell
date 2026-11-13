// The sound of Pluck, which runs on the audio thread.
//
// The host turns this whole function into text and runs it inside the
// AudioWorklet, so it must not use anything from outside itself: no imports,
// no variables from the file around it. What it needs from the SDK it takes
// from the "module scope" the SDK keeps on the audio thread.
//
// The synthesis is Karplus-Strong: a burst of noise is put in a short delay
// line and goes round and round through a gentle filter. The length of the
// line is the pitch; the filter makes the high end die away first, as it does
// on a real string.

const getPluckProcessor = (moduleId) => {
  const { WamProcessor, WamParameterInfo } = globalThis.webAudioModules.getModuleScope(moduleId);
  const VOICES = 10;
  const SIZE = 4096; // long enough for the lowest note, and a power of two so wrapping is a mask
  const MASK = SIZE - 1;

  class Voice {
    constructor() {
      this.buf = new Float32Array(SIZE);
      this.active = false;
      this.held = false;
      this.pitch = -1;
      this.w = 0;
      this.len = 100;
      this.lp = 0;
      this.gain = 0;
      this.peak = 0;
      this.pan = 0;
      this.age = 0;
    }

    start(pitch, vel, bright, pick, age) {
      const hz = 440 * Math.pow(2, (pitch - 69) / 12);
      this.len = Math.max(8, Math.min(SIZE - 4, sampleRate / hz - 0.5));
      this.pitch = pitch;
      this.held = true;
      this.active = true;
      this.age = age;
      this.gain = (vel / 127) * (vel / 127);
      this.lp = 0;
      this.peak = 1;
      // The pluck itself: noise, duller for a soft touch, with the notch a string has where it is picked.
      const n = Math.ceil(this.len) + 2;
      const cut = 0.08 + 0.9 * bright * (0.4 + 0.6 * vel / 127);
      const gap = Math.max(1, Math.round(this.len * (0.08 + 0.42 * pick)));
      const burst = new Float32Array(n);
      let low = 0, mean = 0;
      for (let i = 0; i < n; i++) {
        low += cut * (Math.random() * 2 - 1 - low);
        burst[i] = low;
      }
      for (let i = n - 1; i >= gap; i--) burst[i] -= burst[i - gap];
      for (let i = 0; i < n; i++) mean += burst[i];
      mean /= n;
      let top = 1e-6;
      for (let i = 0; i < n; i++) { burst[i] -= mean; top = Math.max(top, Math.abs(burst[i])); }
      for (let i = 0; i < n; i++) this.buf[(this.w - n + i) & MASK] = burst[i] / top;
    }

    /** Add this voice to `l` and `r` between two frames of the block. */
    render(l, r, from, to, bright, seconds) {
      const hz = sampleRate / (this.len + 0.5);
      // how much is lost on each trip round the string, so that it takes `seconds` to fall silent
      const loss = Math.pow(10, -3 / ((this.held ? seconds : 0.12) * hz));
      const smooth = 0.25 + 0.74 * bright;
      const gl = this.gain * Math.cos((this.pan + 1) * Math.PI / 4), gr = this.gain * Math.sin((this.pan + 1) * Math.PI / 4);
      const buf = this.buf;
      let { w, lp, peak } = this;
      for (let i = from; i < to; i++) {
        // the note's pitch rarely falls on a whole number of samples: read between two
        const at = w - this.len, k = Math.floor(at), f = at - k;
        const x = buf[k & MASK] * (1 - f) + buf[(k + 1) & MASK] * f;
        lp += smooth * (x - lp);
        buf[w & MASK] = lp * loss;
        w++;
        l[i] += x * gl;
        r[i] += x * gr;
        const a = x < 0 ? -x : x;
        peak = a > peak ? a : peak * 0.9995;
      }
      this.w = w & MASK; this.lp = lp; this.peak = peak;
      if (peak < 2e-4) { this.active = false; this.pitch = -1; }
    }
  }

  class PluckProcessor extends WamProcessor {
    constructor(options) {
      super(options);
      this.voices = [];
      for (let i = 0; i < VOICES; i++) this.voices.push(new Voice());
      this.age = 0;
    }

    /** The knobs. The host shows them, saves them with the song, and can automate them. */
    _generateWamParameterInfo() {
      return {
        brightness: new WamParameterInfo('brightness', { type: 'float', label: 'Brightness', defaultValue: 0.6, minValue: 0, maxValue: 1 }),
        decay: new WamParameterInfo('decay', { type: 'float', label: 'Decay', defaultValue: 2.5, minValue: 0.2, maxValue: 8, units: 's' }),
        pick: new WamParameterInfo('pick', { type: 'float', label: 'Pick position', defaultValue: 0.3, minValue: 0, maxValue: 1 }),
        width: new WamParameterInfo('width', { type: 'float', label: 'Width', defaultValue: 0.5, minValue: 0, maxValue: 1 }),
        level: new WamParameterInfo('level', { type: 'float', label: 'Level', defaultValue: 0.7, minValue: 0, maxValue: 1 }),
      };
    }

    value(id) {
      return this._parameterInterpolators[id].values[0];
    }

    /** Notes arrive as plain MIDI, each on the exact frame it is meant for. */
    _onMidi(data) {
      const [status, a, b] = data.bytes;
      const kind = status & 0xf0;
      if (kind === 0x90 && b > 0) this.noteOn(a, b);
      else if (kind === 0x80 || kind === 0x90) this.noteOff(a);
      else if (kind === 0xb0 && (a === 123 || a === 120)) for (const v of this.voices) v.held = false;
    }

    noteOn(pitch, vel) {
      // the string already playing this note, else a silent one, else the one that has faded furthest
      let same = null, free = null, faint = this.voices[0];
      for (const v of this.voices) {
        if (v.pitch === pitch) { same = v; break; }
        if (!v.active) { if (!free) free = v; continue; }
        if (v.peak < faint.peak) faint = v;
      }
      const pickV = same || free || faint;
      const width = this.value('width');
      pickV.pan = width * (((this.age * 0.618) % 1) * 2 - 1) * 0.8;
      pickV.start(pitch, vel, this.value('brightness'), this.value('pick'), this.age++);
    }

    noteOff(pitch) {
      for (const v of this.voices) if (v.pitch === pitch) v.held = false;
    }

    _process(from, to, inputs, outputs) {
      const out = outputs[0];
      if (!out || !out[0]) return;
      const l = out[0], r = out[1] || out[0];
      const bright = this.value('brightness'), seconds = this.value('decay'), level = this.value('level');
      for (const v of this.voices) if (v.active) v.render(l, r, from, to, bright, seconds);
      for (let i = from; i < to; i++) { l[i] *= level; if (r !== l) r[i] *= level; }
    }
  }

  // one registration for each audio context; a second instance of the plugin finds it already there
  try { registerProcessor(moduleId, PluckProcessor); } catch (e) { /* registered */ }
  return PluckProcessor;
};

export default getPluckProcessor;
