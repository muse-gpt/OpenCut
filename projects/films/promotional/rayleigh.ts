/**
 * OpenCut sample - "Why the Sky Is Blue" (20 s, 1920x1080 @ 30 fps)
 *
 * A real-topic explainer built from three primitives that arrived together:
 * the `chart` item with bar value labels, and the `callout` item that links a
 * label to a measured point with a drawn leader. The curve is the Rayleigh
 * scattering law, intensity proportional to 1 / wavelength^4, normalized to
 * 550 nm. Both annotations cite the same curve the line is drawn from, so the
 * picture cannot contradict the numbers next to it.
 *
 * Run: node --experimental-strip-types films/rayleigh.ts rayleigh.mp4
 */
import { pathToFileURL } from 'node:url';
import { Film, anim, bands, callout, chart, footnote, glow, grain, text } from '../../packages/open-cut/dist/index.js';

const film = new Film({ width: 1920, height: 1080, fps: 30, supersample: 2 });

// A slow push keeps the frame alive without a cut.
film.camera([
    { at: 0, zoom: 1.0, focus: [0.5, 0.5], ease: 'in-out-sine' },
    { at: 20, zoom: 1.05, focus: [0.5, 0.5], ease: 'in-out-sine' },
]);

/** Sample wavelengths in nanometres, evenly spaced across the visible band. */
const WAVELENGTHS = ['400', '450', '500', '550', '600', '650', '700'];

/**
 * Relative Rayleigh scattering, `(550 / lambda)^4`, rounded to three decimals.
 * 400 nm scatters about 9.4 times as strongly as 700 nm.
 */
const SCATTERING = [3.576, 2.232, 1.464, 1.0, 0.706, 0.513, 0.381];

// Plot box: center (0.5, 0.52), size 0.72 x 0.42, so the box spans
// x 0.14..0.86 and y 0.31..0.73. Slot centres sit at the middle of each
// seventh; the two annotation anchors below are placed on that grid.
const CHART_X = 0.5;
const CHART_Y = 0.52;
const CHART_W = 0.72;
const CHART_H = 0.42;
const BOX_LEFT = CHART_X - CHART_W / 2;
const BOX_TOP = CHART_Y - CHART_H / 2;
const SLOT_W = CHART_W / WAVELENGTHS.length;
const slotX = (slot: number) => BOX_LEFT + SLOT_W * (slot + 0.5);
const slotY = (value: number) => BOX_TOP + CHART_H * (1 - value / 4);

film.scene({
    id: 'scattering',
    duration: 20,
    background: { kind: 'v-gradient', colors: ['#061024', '#0d1a36', '#04060f'] },
    items: [
        bands({ at: 0, dur: 20, count: 3, angle: -14, speed: 18, color: '#3f5c93', alpha: 0.12, thickness: 380 }),
        glow({ at: 0, dur: 20, x: 0.5, y: 0.42, radius: 0.42, color: '#1b3a72', intensity: 0.35, fadeIn: 1.2 }),

        text({
            at: 0.3,
            dur: 19.4,
            content: 'Why the Sky Is Blue',
            sub: 'Rayleigh scattering: intensity falls as 1 / wavelength^4',
            size: 54,
            bold: true,
            x: 0.5,
            y: 0.09,
            rise: 18,
            stagger: 2,
        }),

        chart({
            at: 2.0,
            dur: 17.6,
            x: CHART_X,
            y: CHART_Y,
            w: CHART_W,
            h: CHART_H,
            domain: [0, 4],
            lines: [{ points: SCATTERING, color: '#7aa2ff', stroke: 4 }],
            axis: '#5d6f8c',
            grid: '#1c2742',
            yTicks: [
                { value: 1, label: '1x' },
                { value: 2, label: '2x' },
                { value: 3, label: '3x' },
                { value: 4, label: '4x' },
            ],
            xLabels: WAVELENGTHS,
            labelSize: 22,
            anim: anim({
                progress: [
                    { at: 2.0, value: 0 },
                    { at: 6.4, value: 1, ease: 'in-out-cubic' },
                ],
            }),
        }),
        text({
            at: 2.6,
            dur: 17.0,
            content: 'wavelength (nm)   ·   relative scattering, 550 nm = 1x',
            size: 21,
            color: '#8fa3c8',
            align: 'center',
            x: CHART_X,
            y: 0.775,
        }),

        // Both anchors sit on the drawn curve. Each label sits in empty space,
        // above the plot for the blue end and inside its empty upper-right
        // corner for the red end, so no leader crosses a tick label.
        callout({
            at: 6.6,
            dur: 13.0,
            ax: slotX(0),
            ay: slotY(SCATTERING[0]),
            x: 0.285,
            y: 0.205,
            text: '3.6x at 400 nm',
            note: 'scatters hardest',
            size: 26,
            color: '#7aa2ff',
            panel: '#0f1c36',
            elbow: true,
        }),
        callout({
            at: 8.6,
            dur: 11.0,
            ax: slotX(6),
            ay: slotY(SCATTERING[6]),
            x: 0.735,
            y: 0.4,
            text: '1x at 700 nm',
            note: 'passes almost straight through',
            size: 26,
            color: '#e8b86d',
            panel: '#181428',
            elbow: true,
        }),

        text({
            at: 11.6,
            dur: 8.0,
            content: 'Blue light scatters ~9x more than red, so the sky glows from every direction.',
            size: 29,
            color: '#cfdcf2',
            x: 0.5,
            y: 0.875,
            maxWidth: 0.84,
        }),
        footnote({
            at: 12.4,
            dur: 7.2,
            text: 'Rayleigh, 1871 - intensity falls as 1 / wavelength^4 (for particles much smaller than the wavelength)',
            x: 0.5,
            y: 0.95,
            size: 22,
            align: 'center',
        }),
        grain({ at: 0, dur: 20, strength: 0.045, density: 14000 }),
    ],
});

film.audio({
    bgm: { volume: 0.055 },
    sfx: [
        { at: 0.2, kind: 'sub', volume: 0.34 },
        { at: 2.0, kind: 'riser', volume: 0.24 },
        { at: 6.4, kind: 'tick', volume: 0.28 },
        { at: 6.7, kind: 'sparkle', volume: 0.18 },
        { at: 8.7, kind: 'tick', volume: 0.22 },
        { at: 11.6, kind: 'whoosh', volume: 0.2 },
    ],
});

export default film;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const stats = film.render(process.argv[2] ?? 'rayleigh.mp4');
    console.log(`rendered ${stats.frames} frames (${stats.seconds.toFixed(1)}s) -> ${stats.out}`);
    console.log(`backend: ${stats.backend} · audio: ${stats.audio}`);
}
