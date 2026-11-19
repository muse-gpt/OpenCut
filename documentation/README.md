# OpenCut 开发者手册

## Layout

| Path | Contents |
|---|---|
| `crates/napi` | Node-API surface (`renderProject`, `previewFrame`, `build`) over the pinned media core |
| `packages/open-cut` | TypeScript DSL authoring surface and the `open-cut` CLI |
| `packages/open-cut-<platform>-<arch>` | Staged `.node` addon per host (win32/linux/darwin × x64/arm64) |
| `films` | Reference films written against the DSL |

The scene IR, motion evaluation, raster, text, audio synthesis, codecs and the encoder all live in the shared neutral media tree and are pinned by a full 40-character revision in `Cargo.toml`. This repository owns the authoring surface and the binding, not a second renderer.

## Authoring surface ownership

| Stage | Owner |
|---|---|
| Authoring | TypeScript DSL (`Film`, `text`, `code`, `counter`, `card`, `shape`, `footnote`, `image`, `video`, `progress`, `bands`, `glow`, `grain`, `path`, `chart`, `callout`, `layer`, `instance`); seconds in, frames out |
| IR | neutral `media.scene` — one serializable `Project`; no other input shape exists |
| Motion | neutral `media.motion` — `id`, `anim` keys, `follow`, time windows |
| Import | neutral `media.codec` — images through WIC, video frames and audio through a Media Foundation source reader, cached per path |
| Raster / text | neutral `media.raster` + `media.text` — real font rasterization, CJK/Latin wrapping, per-glyph fallback |
| Audio | neutral `media.audio` + `media.synthesis` + `media.voice` — synthesized BGM/effects/instruments/grooves/singing plus imported clips |
| Encode | neutral `media.codec` — H.264 video plus audio through the Windows Media Foundation sink writer |

Audio codec is negotiated: AAC is preferred and the encoder falls back to FLAC when the host image has no AAC encoder MFT registered.

## Design tokens

```ts
import { Film, colorToken, text } from '@wae/open-cut';

const ink = colorToken('ink');

const film = new Film({ width: 1280, height: 720 })
    .design({
        colors: [
            { role: 'ink', value: '#e9f0fb' },
            { role: 'accent', value: '#7aa2ff', locked: true },
        ],
    });

film.scene({
    duration: 3,
    design: { colors: [{ role: 'ink', value: '#ffd9a0' }] }, // scene override
    items: [text({ at: 0, dur: 3, content: 'theme tokens', color: ink })],
});
```

- Project and scene cards are the same shape; scene cards override project roles.
- A project role marked `locked` cannot be overridden by a scene card with a different value: that is an explicit `invalid_scene`, never a silent priority.
- Unknown roles, duplicate roles and non-color values fail with the structural path.
- `films/design-tokens.ts` is the reference film.

## Media import and explicit failure

```ts
film.scene({
    duration: 8,
    items: [
        image({ src: 'poster.png', x: 0.27, y: 0.44, w: 0.3, h: 0.46, fit: 'contain', radius: 16 }),
        video({ src: 'loop.mp4', srcIn: 45, x: 0.73, y: 0.44, w: 0.3, h: 0.46, fit: 'cover' }),
    ],
});
film.audio({ clips: [{ src: 'beat.wav', at: 21, volume: 0.9 }] });
```

- `fit` is `contain`, `cover` or `stretch`; `radius` clips to rounded corners.
- `srcIn` is the first source *frame* to show, so a clip can start mid-file.
- Required sources are preflighted before the encoder opens: a missing or undecodable asset aborts the run with a located error instead of producing a silently incomplete film. Declare `required: false` for an intentional empty slot.
- Relative paths are resolved against the process working directory; Media Foundation needs absolute paths and the core converts them.

## Narration is a slot, not a generator

The pipeline reserves a narration track and mixes a PCM16 WAV you supply at a given frame offset. Narration itself is never synthesized — but singing is.

```ts
film.audio({ bgm: { volume: 0.17 }, narration: { wav: 'voice.wav', delay: 0.5 }, sfx: [] });
```

## Synthesized sound

```ts
film.audio({
    patterns: [{ at: 0, preset: 'four-on-floor', bpm: 120, bars: 2, volume: 0.8 }],
    notes: [{ at: 0, instrument: 'bass', note: 36, duration: 0.6, velocity: 0.7 }],
    voice: [{ at: 2.6, song: { tempoBpm: 100, syllables: [{ onset: 'r', vowel: 'a', pitch: 392, beats: 1 }] } }],
});
```

- Instruments: `kick`, `snare`, `clap`, `hat-closed`, `hat-open`, `tom`, `rim`, `shaker`, `crash`, `bass`, `pluck`, `pad`, `lead`, `bell`, `marimba`, `keys`, `strings`. `note` is a MIDI number (A4 = 69).
- Grooves: `four-on-floor`, `breakbeat`, `trap`, `rock`, `half-time`, `bossa`, `lofi`, `dnb` — or `tracks` with 16 step velocities per bar.
- A song uses five vowels (`a e i o u`), onset classes (`s t n r w y f`), pitch in Hz and duration in beats; the same song and `seed` render byte-identically.
- `kind` and `preset` are mutually exclusive; unknown names and out-of-range parameters are explicit errors, never silent substitutions.

## Reproducible runs

- `open-cut build` prints the native version, the exact source revision and whether the tree was dirty, so a file can be traced back to its binary.
- `RenderStats` reports the frame range, fonts actually loaded, a project hash and optional slots left empty.
- `--from/--to` export an interval renumbered from zero; `--cancel-file` stops between frames and keeps the previous output.

## Quick start

```bash
pnpm install
pnpm run build                       # native binding + TypeScript
node --experimental-strip-types films/demo.ts out/demo.mp4
node --experimental-strip-types films/design-tokens.ts out/tokens.mp4

# CLI
node packages/open-cut/dist/cli.js render films/demo.ts --out out/demo.mp4
node packages/open-cut/dist/cli.js preview films/demo.ts --frame 90 --out out/frame.png
node packages/open-cut/dist/cli.js build
```

## Platform notes

Prebuilt natives resolve automatically for Windows x64, Linux x64/arm64 and macOS x64/arm64. MP4 encoding runs through Media Foundation (Windows only; N/KN editions need the Media Feature Pack).
