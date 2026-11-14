# Changelog

All notable changes to Loopwell. Versions follow [semantic versioning](https://semver.org); the project file and share-link formats are versioned separately and every earlier version of both still opens.

## 3.0.0 — 2026-11-13

The biggest release so far: Loopwell grows from a beat sketchpad into a place to finish a track, while the first minute stays as simple as it was.

### Making patterns

- **Euclidean rhythms**: spread any number of hits evenly over a pattern, and rotate them.
- **Step chance, conditions and rolls**: a step can play some of the time, only on certain repeats (1 of 2, fills…), or as a roll of two, three or four hits.
- **Grooves**: swing templates per track or for the whole beat, with an amount.
- **Chords and an arpeggiator** on any pitched track.
- **Dice**: randomise a pattern, a track or a sound, with locks on the tracks you want kept.
- **Live coding**: a Code tab that plays TidalCycles/Strudel-style mini-notation in time with the grid, edited while it plays. It converts to and from the grid.

### Sounds

- **808 bass** with glide, drive and key-following, and a **drum synth** (kick, snare, hat, clap from knobs).
- **Sample browser** with preview, waveforms, detected tempo and key, favourites and tags.
- **Stem separation**: split a song into drums, bass, vocals and the rest, on your own device (HT-Demucs through ONNX Runtime Web, WebGPU with a WebAssembly fallback). Nothing is uploaded.
- **Vocal tools**: pitch correction that knows the song's key, a harmoniser, doubler and formant shift, a compressor and de-esser, and four ready-made vocal chains.
- **Plugins**: a Web Audio Modules (WAM 2.0) host with a plugin browser, two example plugins and [a guide to building one](docs/plugins.md).
- **Ideas to notes**: hum a melody, tap a rhythm, open a MIDI file, or fit a loop to the song's tempo and slice it.

### Mixing and finishing

- **Groups and sends**, peak and LUFS meters on every channel, a spectrum and waveform view, and a reference track to switch to and compare against.
- **Mastering**: EQ, multiband glue, stereo width and a limiter, genre presets, a loudness target, and before/after at the same volume.
- **MP3 and OGG** export with loudness normalisation, alongside WAV.
- **Video export**: an MP4 with a waveform, spectrum, pads or cover-art visualiser, sized for TikTok/Reels, YouTube or a square post.
- **DAW project export** (`.dawproject`, for Bitwig Studio, Studio One, Cubase) and **MIDI plus stems** in one zip.
- MIDI and DAW-project exports are written from what the engine actually plays, so rolls, steps that play by chance, grooves and swing, arpeggios and live code are all in them, each note where it sounds.
- **Lyrics pad** that scrolls with the song.

### Playing live

- **Launchpad view**: launch clips per track, quantised to the bar.
- **Performance effects pad**, **MIDI learn** with saved mappings, and **recording a performance** onto the timeline.

### Getting around

- **Command palette** (<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd>), a history panel, customisable shortcuts and a cheat sheet.
- **Project browser** with autosave, duplicates, renaming and snapshots.
- Tap tempo, a metronome with count-in, and a loop region.
- **Embeddable player**: an iframe or a `<loopwell-player>` element with the waveform, play controls and an "Open in Loopwell" button.

### Learning

- A first-run walkthrough, genre templates (trap, house, boom bap, lo-fi, drill) with matching kits, and tooltips that can be switched off.
- **Learn mode**: lessons on trap hi-hats, sidechaining a bass and chopping a sample, and "recreate this beat" challenges that score how close you are.

### Polish

- Every browser test can run in Firefox (`BROWSER=firefox`) and WebKit (`BROWSER=webkit`, or `scripts/webkit-docker.sh`) as well as Chromium.
- If sound fails to start (when a share link is opened, say), the app offers the tap-to-play button and tries again, instead of staying silent until it is reloaded.
- A high-contrast theme, beat-synced animation that respects reduced-motion settings, keyboard access throughout, and a phone layout.
- Startup stays close to 2.0 despite all of the above (158 kB needed to start against 146 kB, and the same time to the first usable screen on a throttled phone profile): dialogs, the timeline, live sessions, encoders, the stem model and the plugin host load only when used, and the panels behind the other tabs are fetched in the background once the app is up. A size budget is checked on every commit.

### Formats

- Project files are format 3. Share links gained chunks for the new features; readers skip chunks they don't know, so 2.0 links open unchanged and 3.0 links degrade gracefully in older builds.

### Fixed

- In Firefox, tooltips showed for the first control reached with Tab and then stopped.
- Automation is applied before the hits of its own step, not after.

## 2.0.0

Song timeline with clips and automation, a slicing sampler, a two-oscillator wavetable synth, effect racks, recording, live sessions, the optional community server and the desktop app.

## 1.0.0

The step sequencer, four drum kits, a synth, share links and WAV export.
