# @wae/open-cut

Code-first video editing: write a film as TypeScript, render it to MP4.

```bash
npm install @wae/open-cut
```

```ts
import { Film, card, text } from '@wae/open-cut';

const film = new Film({ width: 1280, height: 720, fps: 30 })
    .scene(card({ title: 'Hello' }));

film.render('out/hello.mp4');
```

## CLI

```bash
open-cut render  <film.ts> --out out.mp4 [--from s] [--to s] [--scene id] [--json]
open-cut verify  <film.ts> --out out.mp4 [--from s] [--to s] [--json]
open-cut preview <film.ts> --frame N --out frame.png [--json]
open-cut preview <film.ts> --at s --out frame.png [--json]
open-cut preview <film.ts> --from s --to s --out dir/ [--json]
open-cut build   [--json]
open-cut version
```

- `render` writes an MP4 and prints the frame range, duration, audio level and
  scene spans as JSON with `--json`.
- `verify` renders to a file and fails when the delivery facts disagree with the
  film: frame count, duration, clipping, audio presence and scene spans. Use
  `--from`/`--to` to gate a single scene instead of the whole film.
- `preview` writes one PNG, or a zero-padded `frame-0000.png` sequence when given
  an interval and a directory.

A film module must default-export a `Film` instance. Exit codes: `0` success,
`1` runtime failure, `2` usage error.

## Delivery checks from code

`verifyRender(stats)` takes a render result and returns the same `RenderCheck[]`
the CLI gate prints, so a host can run the checks without the CLI:

```ts
import { verifyRender } from '@wae/open-cut';

const stats = film.render('out/film.mp4');
const failed = verifyRender(stats).filter((check) => !check.ok);
```

## Platform support

Native prebuilt addons are published for Windows x64, Linux x64/arm64 and
macOS x64/arm64. MP4 encoding and media import run through Windows Media
Foundation, so the full render path needs Windows; the codec-free review tools
(validate, plan, frame lookup, subtitle export and revision) run on every
published host. The TypeScript DSL and the film scripts are platform
independent.

## License

Apache-2.0.
