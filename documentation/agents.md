# OpenCut Agent 参考

## CLI 命令

```sh
open-cut render films/demo.ts -o out/demo.mp4
open-cut preview films/demo.ts --frame 90 -o frame.png
open-cut build                              # 看 native 版本和 source revision
```

## Exit codes

标准 wae exit codes：
- `0` — success
- `1` — failure
- `2` — usage
- `3` — capability unavailable
- `4` — canceled

## DSL 快速引用

### 核心对象

```ts
new Film({ width: 1280, height: 720 })
  .design({ colors: [{ role: 'ink', value: '#e9f0fb' }] })
  .scene({
      duration: 3,
      items: [text({ at: 0, dur: 3, content: 'Hello' })],
  });
```

### Item 类型

| Item | 参数 | 说明 |
|------|------|------|
| `text({ at, dur, content, color, size, weight, ... })` | 秒级时间 | CJK/Latin 自动换行 |
| `code({ at, dur, lang, code })` | 秒级时间 | 代码着色显示 |
| `counter({ at, dur, from, to, decimals })` | 数值动画 | 数字滚动 |
| `card({ at, dur, title, subtitle })` | 卡片 | |
| `shape({ at, dur, kind, width, height })` | 矩形/圆形/箭头 | |
| `footnote({ at, dur, note })` | 脚注 | |
| `progress({ at, dur, from, to, trackColor, fillColor })` | 进度条 | |
| `bands({ at, dur, bands })` | 音频频谱 | |
| `glow({ at, dur, intensity })` | 辉光效果 | |
| `grain({ at, dur, intensity })` | 颗粒效果 | |
| `path({ at, dur, d })` | SVG path | |
| `chart({ at, dur, data, kind, ... })` | 图表 | |
| `callout({ at, dur, text, from, to })` | 标注 | |
| `layer({ items })` | 分组 | |
| `instance({ template, ... })` | 复用组件实例 | |

### 音频

```ts
film.audio({
    bgm: { volume: 0.17 },
    narration: { wav: 'voice.wav', delay: 0.5 },   // slot，不生成
    clips: [{ src: 'beat.wav', at: 21, volume: 0.9 }],
    patterns: [{ at: 0, preset: 'four-on-floor', bpm: 120, bars: 2 }],
    notes: [{ at: 0, instrument: 'bass', note: 36, duration: 0.6 }],
    voice: [{ at: 2.6, song: { tempoBpm: 100, syllables: [...] } }],
});
```

### 歌曲 syllable 合同

```ts
{ onset: 'r', vowel: 'a', pitch: 392, beats: 1 }
// onset class: s t n r w y f
// vowel: a e i o u
// pitch: Hz
// beats: float
```

## 参考示例

`films/demo.ts` — 基础渲染
`films/design-tokens.ts` — 语义颜色 token + locked
`films/voice-sfx.ts` — 歌声 + effect
`films/groove.ts` — 鼓 groove
