# @wae/open-cut-win32-x64

Prebuilt native artifact for Windows x64. **Not a public import target.**

Pulled automatically when installing `@wae/open-cut` on matching hosts. MP4
encoding runs through Media Foundation, so this is the only platform sidecar
the package ships today.

## Example

```ts
import { renderFile } from '@wae/open-cut';

const stats = renderFile('films/my-film.ts', { out: 'out/my-film.mp4' });
console.log(stats.out, stats.bytes);
```
