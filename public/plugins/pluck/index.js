// Pluck: the example instrument plugin that comes with Loopwell.
//
// A Web Audio Module is an ES module whose default export is a class with a
// static createInstance(). This file is that class; the sound is made in
// processor.js, on the audio thread, and gui.js draws the knobs. Nothing here
// is built or bundled: what you read is what runs. docs/plugins.md walks
// through it.

import { WebAudioModule, WamNode, addFunctionModule } from '../sdk/index.js';
import getPluckProcessor from './processor.js';

const here = new URL('.', import.meta.url).href;

class PluckNode extends WamNode {
  /** Put the SDK's base classes on the audio thread, then our processor on top of them. */
  static async addModules(audioContext, moduleId) {
    await super.addModules(audioContext, moduleId);
    await addFunctionModule(audioContext.audioWorklet, getPluckProcessor, moduleId);
  }

  constructor(module, options) {
    // an instrument: no sound comes in, a stereo pair goes out
    super(module, { ...options, numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  }
}

export default class Pluck extends WebAudioModule {
  _descriptorUrl = `${here}descriptor.json`;
  _guiModuleUrl = `${here}gui.js`;

  async initialize(state) {
    await this._loadDescriptor();
    return super.initialize(state);
  }

  async createAudioNode(initialState) {
    await PluckNode.addModules(this.audioContext, this.moduleId);
    const node = new PluckNode(this, {});
    await node._initialize();
    if (initialState) await node.setState(initialState);
    return node;
  }
}
