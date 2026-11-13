# Architecture

How Loopwell is put together, for anyone who wants to change it. The README says what it does; this says where things live and why.

## The shape of it

```text
                 main thread                                   audio thread
┌──────────────────────────────────────────┐        ┌──────────────────────────────┐
│  ui/*.svelte      what is on screen      │        │  audio/worklet.ts            │
│        │                                 │        │    └─ core/engine.ts         │
│  state.svelte.ts  the beat + view state  │ ─────► │        clock, sequencer,     │
│        │                                 │ project│        voices, mixer, effects│
│  actions.svelte.ts  everything a person  │  edits │                              │
│        │            can do to a beat     │ ◄───── │  steps and meters, for the   │
│  audio/host.ts    owns the AudioContext  │ lights │  lights only                 │
└──────────────────────────────────────────┘        └──────────────────────────────┘
        │ the same Engine class, run faster than real time
        ▼
  core/render.ts  →  WAV, MP3/OGG, stems, video, DAW project, the embedded player
```

Three rules hold the design together:

1. **The engine is one plain class with no DOM in it** (`src/core/engine.ts`). The AudioWorklet runs it in real time; `renderProject` runs the very same code offline. An export is therefore exactly what was heard, and every engine feature is testable in Node.
2. **All timing happens on the audio thread, counted in frames.** The main thread only sends edits and receives notifications to light things up. A frozen page cannot make a hit late (`npm run test:realtime` freezes it on purpose and checks).
3. **A beat is one plain object** (`Project` in `src/core/types.ts`), made of small integers. Whatever arrives from a file, a link or another person goes through `sanitize()` first, so the rest of the code never has to doubt it.

## Where things are

| Path | What is there |
| :-- | :-- |
| `src/core/` | Everything that is pure logic and runs anywhere: the engine, the step clock, the song timeline, DSP (`dsp/`), formats (share links, project files, MIDI, WAV, DAWproject), analysis (tempo, key, loudness), the mini-notation compiler, templates and lessons' data |
| `src/audio/` | The AudioWorklet wrapper, the main-thread host that owns the `AudioContext`, recording, Web MIDI input |
| `src/*.svelte.ts` | State and actions, one file per area: `actions` (the core verbs, undo, export), `sound`, `song`, `creative`, `mix`, `perform`, `ideas`, `stems`, `video`, `plugins`, `code`, `learn`, `projects`, `library`, `commands`, `prefs`, `tour` |
| `src/ui/` | Svelte components. They read state and call actions; they hold no logic of their own worth testing |
| `src/live/` | Live sessions: `session` is the light half the app talks to, `engine` and `ydoc` the half that mirrors a beat into a Yjs document |
| `src/stems/`, `src/video/`, `src/plugins/`, `src/embed/` | The heavy or separate parts, each loaded only when used (see below) |
| `public/plugins/` | The example plugins and a copy of the WAM SDK, unbundled |
| `server/` | The optional community server and live-session relay |
| `src-tauri/` | The desktop shell |
| `tests/` | Unit tests (`*.test.ts`), browser tests (`e2e/`), the real-time check (`realtime/`), fixtures |
| `scripts/` | Kit synthesis, benchmarks, the budget check, README assets |

## The engine

`Engine.process()` fills blocks of 128 frames. For each block:

1. The `StepClock` reports which steps land inside it and on which frame.
2. For each step the sequencer starts voices, either at once or through a small queue of pending hits (`at()` / `runTo()`), which is how rolls, groove delays, arpeggios and live-code hits between steps land on exact frames.
3. Voices render in segments split at every event, so a hit that starts mid-block starts mid-block.
4. Each track goes through its strip: inserts, filter, level and pan, sends; then groups, the reverb and delay returns, the master filter and compressor, performance effects and the mastering chain.

Nothing on that path allocates. Things that would (parsing live code, building wavetables) happen in `setProject`, only when what they depend on changes.

Three things enter the engine from outside it:

- **Samples**, decoded on the main thread and posted over once.
- **Plugin audio.** A Web Audio Module is its own node in the audio graph. The engine sends it notes on the audio thread and its output is wired into an input of the engine's node, where it joins the track before the track's effects (`engine.ext`). Offline, plugins are rendered first in an `OfflineAudioContext` and handed to `renderProject` as buffers. See [docs/plugins.md](docs/plugins.md).
- **Live code.** The text is compiled by `core/mini.ts` into sorted lists of hits per bar; the engine only walks the lists.

## Formats

- **Share links** (`core/share.ts`): the beat packed into tagged binary chunks, deflated, base64url. Readers skip chunks they don't know, so new features add a chunk and old links never break. The order of effect types and parameters is part of the format: append, never reorder. `tests/fixtures/links-2.0.txt` pins links made by 2.0.
- **Project files** (`core/projectfile.ts`): a zip of `project.json` and any samples the person brought. `FILE_VERSION` is 3.
- **Storage**: the open beat and preferences in `localStorage`; the library of beats, snapshots and imported samples in IndexedDB (`storage.ts`).

Changing the `Project` type means: a default in `emptyProject`/`newTrack`, a line in `sanitize`, a chunk (or a field in one) in `share.ts`, the mapping in `live/ydoc.ts`, and a test in `tests/formats.test.ts`.

## What loads when

The page starts with the sequencer, the engine and the panels under the grid. Everything else is a dynamic `import()` at the point of use:

| Loaded when | What |
| :-- | :-- |
| A dialog is opened | That dialog (`ui/*Modal.svelte`) |
| Song view, Pads view, Live view | `Timeline`, `PerformView`, `StageView` |
| A live session starts | `live/engine` and Yjs |
| MP3/OGG export | The WebAssembly encoders |
| Video export | `video/render` and Mediabunny |
| Stems are split | A worker with ONNX Runtime Web; then the 180 MB model, fetched once and kept in Cache Storage |
| A track uses a plugin | `plugins/host`, the WAM SDK, and the plugin's own code (after the person agrees to it) |
| MIDI import/export, DAW project export | `core/midi`, `core/dawproject` |

`npm run budget` (run in CI) fails if the startup scripts pass the sizes in `perf-budget.json`, or if any of those libraries turns up in a startup file.

The service worker precaches the app and its kits, so all of this works offline once visited; the stem model and its runtime are cached on first use instead.

## Tests

| Kind | Where | What it protects |
| :-- | :-- | :-- |
| Unit | `tests/*.test.ts` | Timing to the frame, every engine feature, formats and migrations, the compilers and analysers |
| Browser | `tests/e2e/*.ts` | Each area used the way a person uses it, against the production build in headless Chromium |
| Real time | `tests/realtime/` | The audio thread keeping exact time while the page is frozen |
| Benchmark | `scripts/bench.ts` | Headroom of the engine on a worst-case song |
| Budget | `scripts/budget.ts` | Startup size |

The browser tests are plain scripts (`npx tsx tests/e2e/mix.ts`); set `SHOTS=dir` to keep screenshots, `CHROMIUM=path` to pick the browser.
