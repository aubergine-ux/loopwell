// Wobble: the example effect plugin that comes with Loopwell. An effect is
// the same thing as an instrument (see ../pluck) except that sound comes in
// as well as going out. It has no gui.js, to show what a host does then:
// Loopwell draws a slider for each parameter itself.

import { WebAudioModule, WamNode, addFunctionModule } from '../sdk/index.js';

const here = new URL('.', import.meta.url).href;

// Runs on the audio thread: see ../pluck/processor.js for the rules it lives by.
const getWobbleProcessor = (moduleId) => {
  const { WamProcessor, WamParameterInfo } = globalThis.webAudioModules.getModuleScope(moduleId);
  const SIZE = 4096, MASK = SIZE - 1;

  class WobbleProcessor extends WamProcessor {
    constructor(options) {
      super(options);
      this.l = new Float32Array(SIZE);
      this.r = new Float32Array(SIZE);
      this.w = 0;
      this.phase = 0;
    }

    _generateWamParameterInfo() {
      return {
        rate: new WamParameterInfo('rate', { type: 'float', label: 'Rate', defaultValue: 0.6, minValue: 0.05, maxValue: 6, units: 'Hz' }),
        depth: new WamParameterInfo('depth', { type: 'float', label: 'Depth', defaultValue: 0.5, minValue: 0, maxValue: 1 }),
        mix: new WamParameterInfo('mix', { type: 'float', label: 'Mix', defaultValue: 0.5, minValue: 0, maxValue: 1 }),
      };
    }

    _onMidi() {}

    _process(from, to, inputs, outputs) {
      const out = outputs[0], inp = inputs[0];
      if (!out || !out[0]) return;
      const il = inp && inp[0], ir = inp && (inp[1] || inp[0]);
      const ol = out[0], or = out[1] || out[0];
      const rate = this._parameterInterpolators.rate.values[0];
      const depth = this._parameterInterpolators.depth.values[0];
      const mix = this._parameterInterpolators.mix.values[0];
      const step = rate / sampleRate, base = 0.012 * sampleRate, swing = 0.006 * sampleRate * depth;
      let { w, phase } = this;
      const tap = (buf, d) => { const at = w - d, k = Math.floor(at), f = at - k; return buf[k & MASK] * (1 - f) + buf[(k + 1) & MASK] * f; };
      for (let i = from; i < to; i++) {
        const xl = il ? il[i] : 0, xr = ir ? ir[i] : 0;
        this.l[w & MASK] = xl;
        this.r[w & MASK] = xr;
        // the two sides wobble a quarter turn apart, which is what makes it wide
        const dl = base + swing * Math.sin(2 * Math.PI * phase), dr = base + swing * Math.sin(2 * Math.PI * (phase + 0.25));
        ol[i] = xl * (1 - mix * 0.5) + tap(this.l, dl) * mix;
        if (or !== ol) or[i] = xr * (1 - mix * 0.5) + tap(this.r, dr) * mix;
        w++;
        phase += step;
        if (phase >= 1) phase -= 1;
      }
      this.w = w & MASK; this.phase = phase;
    }
  }

  try { registerProcessor(moduleId, WobbleProcessor); } catch (e) { /* registered */ }
  return WobbleProcessor;
};

class WobbleNode extends WamNode {
  static async addModules(audioContext, moduleId) {
    await super.addModules(audioContext, moduleId);
    await addFunctionModule(audioContext.audioWorklet, getWobbleProcessor, moduleId);
  }

  constructor(module, options) {
    super(module, { ...options, numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  }
}

export default class Wobble extends WebAudioModule {
  _descriptorUrl = `${here}descriptor.json`;

  async initialize(state) {
    await this._loadDescriptor();
    return super.initialize(state);
  }

  async createAudioNode(initialState) {
    await WobbleNode.addModules(this.audioContext, this.moduleId);
    const node = new WobbleNode(this, {});
    await node._initialize();
    if (initialState) await node.setState(initialState);
    return node;
  }
}
