# Plugins

Loopwell hosts [Web Audio Modules](https://www.webaudiomodules.com/) (WAM 2.0): instruments and effects that anyone can write, publish at an address, and load into a track. This page explains how they fit into Loopwell and how to build one. The two plugins that come with the app are the worked examples:

| Plugin | What it is | Source |
| --- | --- | --- |
| **Pluck** | An instrument: a plucked string (Karplus-Strong) with its own window | [`public/plugins/pluck`](../public/plugins/pluck) |
| **Wobble** | An effect: a slow chorus, with no window of its own | [`public/plugins/wobble`](../public/plugins/wobble) |

Neither is built or bundled. The files in those folders are exactly what the browser runs, so they are the quickest way to see how a plugin is put together.

## Using one

1. Select a track, open **Sound**, and choose **Plugin** (or press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> and type "plugins").
2. Pick from what comes with Loopwell, from the WAM community's list, or paste the address of a plugin's `index.js`.
3. **Open** shows the plugin's own controls. **Add an effect plugin** puts another plugin after it; up to four on a track.

The first plugin on a track is its instrument: it is sent the track's notes, from the piano roll, the pads, the arpeggiator or a MIDI keyboard. Whatever follows it is an effect on its sound. The result then goes through the track's mixer strip like any other track: its effect rack, filter, level, pan, sends, group and the master chain all apply, and it is in every export (WAV, MP3, stems, video).

A plugin's settings are saved in the beat, so they come back with a project file, a share link, an undo, and in a live session.

### Trust

A plugin is a program. Once it is loaded it runs inside the page, with the same access Loopwell has. So:

- Choosing a plugin in the browser is your yes to it, and is remembered for that address.
- A beat that arrives by link or file with a plugin you have not said yes to **loads nothing** until you press *Load it* on that track. Until then the track is silent and no request is made to the plugin's address.
- The plugins in `public/plugins` are part of Loopwell and need no asking.
- The embedded player never loads plugins: a plugin track is silent there.

## How a plugin is put together

A WAM is an ES module whose default export is a class with a static `createInstance(groupId, audioContext, initialState)`. The [SDK](https://github.com/webaudiomodules/sdk) gives you base classes that do nearly all of it. A copy sits at [`public/plugins/sdk/index.js`](../public/plugins/sdk/index.js) so the examples work offline; your own plugin can import the SDK from wherever you like.

A typical plugin is three or four files:

```
my-plugin/
  index.js         the module: the class a host loads
  processor.js     the sound, which runs on the audio thread
  gui.js           optional: the plugin's own window
  descriptor.json  its name, who made it, what it takes and gives
```

### `descriptor.json`

```json
{
  "identifier": "org.example.my-plugin",
  "name": "My Plugin",
  "vendor": "You",
  "isInstrument": true,
  "hasAudioInput": false,
  "hasAudioOutput": true,
  "hasMidiInput": true
}
```

`isInstrument` is what Loopwell's browser shows as *Instrument* or *Effect*. See Pluck's for the full set of fields.

### `index.js`

```js
import { WebAudioModule, WamNode, addFunctionModule } from '../sdk/index.js';
import getProcessor from './processor.js';

const here = new URL('.', import.meta.url).href;

class MyNode extends WamNode {
  static async addModules(audioContext, moduleId) {
    await super.addModules(audioContext, moduleId);                      // the SDK's base classes
    await addFunctionModule(audioContext.audioWorklet, getProcessor, moduleId); // then yours
  }
  constructor(module, options) {
    // an instrument has no input; an effect has numberOfInputs: 1
    super(module, { ...options, numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  }
}

export default class MyPlugin extends WebAudioModule {
  _descriptorUrl = `${here}descriptor.json`;
  _guiModuleUrl = `${here}gui.js`;          // leave out if there is no gui.js

  async initialize(state) {
    await this._loadDescriptor();
    return super.initialize(state);
  }

  async createAudioNode(initialState) {
    await MyNode.addModules(this.audioContext, this.moduleId);
    const node = new MyNode(this, {});
    await node._initialize();
    if (initialState) await node.setState(initialState);
    return node;
  }
}
```

### `processor.js`

The processor is one function that the host turns into text and runs inside the AudioWorklet. That is the one rule that trips people up: **it cannot use anything from outside itself.** No imports, no variables from the surrounding file. What it needs from the SDK it takes from the module scope:

```js
const getProcessor = (moduleId) => {
  const { WamProcessor, WamParameterInfo } = globalThis.webAudioModules.getModuleScope(moduleId);

  class MyProcessor extends WamProcessor {
    // The knobs. The host shows them, saves them with the song and can automate them.
    _generateWamParameterInfo() {
      return {
        tone: new WamParameterInfo('tone', { type: 'float', label: 'Tone', defaultValue: 0.5, minValue: 0, maxValue: 1 }),
      };
    }

    // Notes arrive as plain MIDI, each on the exact frame it is meant for.
    _onMidi({ bytes: [status, pitch, velocity] }) {
      if ((status & 0xf0) === 0x90 && velocity > 0) { /* note on */ }
      else if ((status & 0xf0) === 0x80 || (status & 0xf0) === 0x90) { /* note off */ }
      else if ((status & 0xf0) === 0xb0 && pitch === 123) { /* all notes off */ }
    }

    // Fill outputs[0] between two frames of the block. It is called once per stretch between events,
    // so a note that starts in the middle of a block starts in the middle of the block.
    _process(from, to, inputs, outputs) {
      const [l, r] = outputs[0];
      const tone = this._parameterInterpolators.tone.values[0];
      for (let i = from; i < to; i++) { l[i] = 0; r[i] = 0; }
    }
  }

  try { registerProcessor(moduleId, MyProcessor); } catch (e) { /* already registered in this context */ }
  return MyProcessor;
};

export default getProcessor;
```

### `gui.js`

```js
export async function createElement(plugin) {
  const el = document.createElement('div');
  // plugin.audioNode.getParameterInfo(), getParameterValues(), setParameterValues({ id: { id, value, normalized: false } })
  return el;
}
```

Return any element you like. If a plugin has no `gui.js`, Loopwell draws a slider for each parameter itself, which is how Wobble is shown.

## What Loopwell does with it

Worth knowing while you build:

- **Notes** are sent as `wam-midi` events: note on (`0x90`), note off (`0x80`), and `CC 123` when the transport stops. Loopwell also ends every held note by name when it stops, so a plugin that ignores CC 123 doesn't hang.
- **Timing.** Events are handed over on the audio thread, on their exact frame. A plugin's sound reaches the mix one block (128 frames, about 3 ms) after the rest: always exactly that, so it never drifts.
- **State.** `getState()` is read while the plugin's window is open and when it closes, and stored in the beat as JSON; `setState()` gets it back on load and on undo. Up to 32 kB is kept in a project file. A share link carries up to 1.5 kB per plugin; settings bigger than that stay out of the link and the plugin starts as it comes.
- **Exports** are rendered faster than real time: the plugin is created again in an `OfflineAudioContext`, sent the same notes, and its output mixed into the track. So a plugin must work in an `OfflineAudioContext` and must not depend on wall-clock time.
- **Sample rate** is whatever the device runs at (usually 44.1 or 48 kHz). Read `sampleRate` on the audio thread; don't assume.

## Trying your plugin

Serve the folder from your machine and paste its address:

```sh
npx serve --cors my-plugin        # prints something like http://localhost:3000
```

In Loopwell: **Sound → Plugin → From an address**, and enter `http://localhost:3000/index.js`. Plain `http` is accepted for `localhost` only; anything published needs `https`, and the server must allow other sites to fetch it (`Access-Control-Allow-Origin`).

To offer it to everyone, add it to the [community list](https://github.com/boourns/wam-community). Anything on that list shows up in Loopwell's browser.

## Limits

- A plugin track holds one instrument and up to three effects. Plugin effects can follow a plugin instrument; they can't yet be put on a sample or built-in synth track (use the track's effect rack there).
- Plugin parameters can't be drawn as automation curves in the song view yet.
- The desktop app offers only the plugins that come with it.
