/**
 * OpenCut sample - "Two Years of Frames" (10 s, 1920x1080 @ 30 fps)
 *
 * A first look at the `chart` item: two bar series and a trend line inside one
 * plot box, revealed category by category by animating `progress`. The title,
 * the sweep and the footnote share a single scene, so the whole film is one
 * uninterrupted move.
 *
 * Run: node --experimental-strip-types films/chart-demo.ts chart-demo.mp4
 */
import { pathToFileURL } from 'node:url';
import { Film, anim, chart, footnote, grain, text } from '../packages/open-cut/dist/index.js';

const film = new Film({ width: 1920, height: 1080, fps: 30 });

// Category axis shared by both bar series and the trend line.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'];

film.scene({
    duration: 10,
    background: { kind: 'v-gradient', colors: ['#0a1024', '#101a34', '#05070f'] },
    items: [
        text({
            at: 0.4,
            dur: 9.2,
            content: 'Two Years of Frames',
            sub: 'rendered minutes per month, 2024 vs 2025',
            size: 54,
            bold: true,
            x: 0.5,
            y: 0.12,
            rise: 18,
            stagger: 2,
        }),
        chart({
            at: 1.2,
            dur: 8.4,
            x: 0.5,
            y: 0.55,
            w: 0.74,
            h: 0.52,
            domain: [0, 1],
            bars: [
                { values: [0.12, 0.2, 0.28, 0.36, 0.44, 0.5, 0.58, 0.66], color: '#3f5c93' },
                { values: [0.22, 0.34, 0.46, 0.55, 0.7, 0.82, 0.9, 1.0], color: '#7aa2ff' },
            ],
            lines: [{ points: [0.17, 0.27, 0.37, 0.46, 0.57, 0.66, 0.74, 0.83], color: '#e8b86d', stroke: 3 }],
            axis: '#5d6f8c',
            grid: '#1c2742',
            yTicks: [
                { value: 0.25, label: '25' },
                { value: 0.5, label: '50' },
                { value: 0.75, label: '75' },
                { value: 1.0, label: '100' },
            ],
            xLabels: MONTHS,
            labelSize: 22,
            // `anim` keys run on the scene clock, so the sweep starts exactly
            // when the chart appears and lands well before it fades out.
            anim: anim({
                progress: [
                    { at: 1.2, value: 0 },
                    { at: 4.8, value: 1, ease: 'in-out-cubic' },
                ],
            }),
        }),
        footnote({
            at: 5.4,
            dur: 4.2,
            text: 'synthetic sample data - the chart item paints bars, lines, grid and labels from one IR node',
            x: 0.5,
            y: 0.93,
            align: 'center',
        }),
        grain({ at: 0, dur: 10, strength: 0.05, density: 12000 }),
    ],
});

film.audio({
    bgm: { volume: 0.05 },
    sfx: [
        { at: 1.2, kind: 'riser', volume: 0.25 },
        { at: 4.8, kind: 'tick', volume: 0.3 },
        { at: 5.4, kind: 'sparkle', volume: 0.22 },
    ],
});

export default film;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const stats = film.render(process.argv[2] ?? 'chart-demo.mp4');
    console.log(`rendered ${stats.frames} frames (${stats.seconds.toFixed(1)}s) -> ${stats.out}`);
    console.log(`backend: ${stats.backend} · audio: ${stats.audio}`);
}
