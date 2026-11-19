/**
 * OpenCut sample - "Feature Atlas" (34 s, 1920x1080 @ 30 fps)
 *
 * A tour of the authoring surface across five scenes instead of one long shot:
 * semantic color roles, bands / glow / grain atmosphere, staggered and typing
 * text, a chart with bar value labels, two callouts, a counter, the global
 * progress bar, code with a custom theme, cards, a self-drawing shape, zoom
 * layers that cross-fade on the camera curve, reusable components placed as
 * instances, and a synthesized audio bed with effects, notes and a groove.
 *
 * Run: node --experimental-strip-types films/atlas.ts atlas.mp4
 */
import { pathToFileURL } from 'node:url';
import {
    Film,
    anim,
    bands,
    callout,
    card,
    chart,
    code,
    colorToken,
    counter,
    footnote,
    glow,
    grain,
    instance,
    layer,
    path,
    progress,
    shape,
    text,
} from '../../packages/open-cut/dist/index.js';

const film = new Film({ width: 1920, height: 1080, fps: 30, supersample: 1.5 });

// One continuous push for the whole film. Scene four keys its layers to this
// curve, so the cross-fade there is driven by the same zoom the viewer sees.
film.camera([
    { at: 0, zoom: 1.0, focus: [0.5, 0.5], ease: 'in-out-sine' },
    { at: 34, zoom: 1.18, focus: [0.5, 0.5], ease: 'in-out-sine' },
]);

film.design({
    colors: [
        { role: 'ink', value: '#e6eefa', locked: true },
        { role: 'muted', value: '#8fa3c8' },
        { role: 'accent', value: '#7aa2ff' },
        { role: 'warm', value: '#e8b86d' },
        { role: 'panel', value: '#101a34' },
    ],
});

// A reusable tile. Components paint on their own buffer in frame coordinates
// and the instance places that buffer into a box, so the definition lives in a
// centred square that survives any placement.
film.component('tile', [
    shape({ at: 0, dur: 5.5, shape: 'ring', x: 0.5, y: 0.5, w: 0.18, h: 0.18, color: colorToken('warm'), stroke: 8, fadeIn: 0.5 }),
    shape({ at: 0, dur: 5.5, shape: 'circle', x: 0.5, y: 0.5, w: 0.08, h: 0.08, color: colorToken('warm'), fadeIn: 0.5 }),
    // Every shape anchors at its centre, so the bar and the ring line up.
    shape({ at: 0, dur: 5.5, shape: 'rect', x: 0.5, y: 0.34, w: 0.22, h: 0.012, color: colorToken('accent'), fadeIn: 0.4 }),
    text({ at: 0.2, dur: 5.3, content: 'tile', size: 130, color: colorToken('ink'), x: 0.5, y: 0.63, rise: 24, stagger: 2 }),
]);

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

film.scene({
    id: 'open',
    duration: 4.5,
    background: { kind: 'v-gradient', colors: ['#08111f', '#122240', '#04060f'] },
    items: [
        bands({ at: 0, dur: 4.5, count: 3, angle: -16, speed: 26, color: colorToken('accent'), alpha: 0.09, thickness: 380 }),
        glow({ at: 0, dur: 4.5, x: 0.5, y: 0.46, radius: 0.2, color: colorToken('warm'), intensity: 0.2, fadeIn: 0.8 }),
        text({
            at: 0.2,
            dur: 4.1,
            content: 'Feature Atlas',
            sub: 'five scenes - one authoring surface',
            size: 64,
            bold: true,
            color: colorToken('ink'),
            subColor: colorToken('muted'),
            x: 0.5,
            y: 0.42,
            rise: 22,
            stagger: 3,
        }),
        footnote({ at: 0.8, dur: 3.5, text: 'every primitive here is a scene node - no post compositing', x: 0.5, y: 0.9, size: 22, align: 'center' }),
        grain({ at: 0, dur: 4.5, strength: 0.05, density: 14000 }),
    ],
});

film.scene({
    id: 'data',
    duration: 9.5,
    background: { kind: 'v-gradient', colors: ['#071022', '#0e1b36', '#04060f'] },
    items: [
        bands({ at: 0, dur: 9.5, count: 2, angle: -12, speed: 18, color: colorToken('accent'), alpha: 0.1, thickness: 420 }),
        text({
            at: 0.3,
            dur: 9.0,
            content: 'Frames per scene, one week',
            sub: 'two runs side by side, every bar labelled',
            size: 40,
            bold: true,
            color: colorToken('ink'),
            subColor: colorToken('muted'),
            x: 0.44,
            y: 0.13,
            rise: 14,
            stagger: 2,
        }),
        chart({
            at: 0.8,
            dur: 8.4,
            x: 0.42,
            y: 0.54,
            w: 0.56,
            h: 0.44,
            domain: [0, 400],
            bars: [
                { values: [120, 180, 230, 270, 310, 350, 300], color: colorToken('accent') },
                { values: [160, 220, 260, 320, 360, 390, 340], color: '#3f5c93' },
            ],
            lines: [],
            axis: '#5d6f8c',
            grid: '#1a2540',
            yTicks: [
                { value: 100, label: '100' },
                { value: 200, label: '200' },
                { value: 300, label: '300' },
                { value: 400, label: '400' },
            ],
            xLabels: DAYS,
            labelSize: 20,
            valueLabels: true,
            anim: anim({
                progress: [
                    { at: 0.8, value: 0 },
                    { at: 4.2, value: 1, ease: 'in-out-cubic' },
                ],
            }),
        }),
        callout({
            at: 4.6,
            dur: 5.4,
            ax: 0.58,
            ay: 0.331,
            x: 0.83,
            y: 0.22,
            text: '390 frames',
            note: 'busiest run',
            size: 24,
            color: colorToken('warm'),
            panel: colorToken('panel'),
            elbow: true,
        }),
        counter({
            at: 5.2,
            dur: 4.6,
            from: 0,
            to: 2470,
            suffix: ' frames',
            size: 44,
            color: colorToken('warm'),
            x: 0.85,
            y: 0.5,
            decimals: 0,
        }),
        text({ at: 5.4, dur: 4.4, content: 'rendered this week', size: 22, color: colorToken('muted'), x: 0.85, y: 0.57 }),
        progress({ at: 0.4, dur: 9.0, track: '#1b2947', fill: colorToken('accent'), y: 0.885 }),
        footnote({ at: 1.2, dur: 8.2, text: 'sample data - the chart, counter and bar share one scene clock', x: 0.5, y: 0.945, size: 21, align: 'center' }),
        grain({ at: 0, dur: 9.5, strength: 0.045, density: 14000 }),
    ],
});

film.scene({
    id: 'code',
    duration: 7.5,
    background: { kind: 'v-gradient', colors: ['#06101e', '#0b1830', '#03050c'] },
    items: [
        text({
            at: 0.3,
            dur: 7.0,
            content: 'The film is a program',
            size: 38,
            bold: true,
            color: colorToken('ink'),
            align: 'left',
            x: 0.08,
            y: 0.12,
            rise: 12,
            stagger: 2,
        }),
        card({
            at: 0.8,
            dur: 6.4,
            x: 0.17,
            y: 0.34,
            w: 0.2,
            h: 0.13,
            title: 'Stable ids',
            body: 'a node keeps its identity across edits',
            accent: colorToken('accent'),
            panel: colorToken('panel'),
        }),
        card({
            at: 1.4,
            dur: 5.8,
            x: 0.17,
            y: 0.56,
            w: 0.2,
            h: 0.13,
            title: 'One clock',
            body: 'seconds in, frames out, no second timeline',
            accent: colorToken('warm'),
            panel: colorToken('panel'),
        }),
        shape({ at: 1.0, dur: 6.2, shape: 'line', x: 0.31, y: 0.16, w: 0.56, h: 0, color: colorToken('warm'), stroke: 2, progress: 1 }),
        code({
            at: 1.1,
            dur: 6.2,
            x: 0.33,
            y: 0.26,
            size: 40,
            typing: 0.45,
            theme: { panel: null, plain: '#cfdcf2', keyword: '#7aa2ff', fn: '#e8b86d', string: '#6fd6a4' },
            lines: ['const film = new Film({ width: 1920, fps: 30 })', '', 'film.scene({ id: "data", duration: 9.5 })', 'film.audio({ bgm: { volume: 0.05 } })', '', 'film.render("atlas.mp4")'],
        }),
        callout({
            at: 4.4,
            dur: 3.0,
            ax: 0.52,
            ay: 0.45,
            x: 0.68,
            y: 0.58,
            text: 'the same call, every time',
            note: 'authoring and export share one IR',
            size: 22,
            color: colorToken('accent'),
            panel: colorToken('panel'),
            elbow: true,
        }),
        grain({ at: 0, dur: 7.5, strength: 0.05, density: 15000 }),
    ],
});

film.scene({
    id: 'camera',
    duration: 7.0,
    background: { kind: 'v-gradient', colors: ['#0a1024', '#16203d', '#05070f'] },
    items: [
        // Two layers keyed to the film camera: the wide one fades out as the
        // frame pushes past 1.13, the close one fades in over the same window.
        layer({
            at: 0,
            dur: 7.0,
            zoomFrom: 0.9,
            zoomTo: 1.1,
            edge: 0.05,
            items: [
                path({
                    at: 0,
                    dur: 7.0,
                    points: [[0.0, 0.74], [0.16, 0.62], [0.32, 0.68], [0.5, 0.56], [0.68, 0.64], [0.84, 0.58], [1.0, 0.66]],
                    smooth: true,
                    stroke: 3,
                    color: colorToken('accent'),
                    progress: 1,
                    blend: 'add',
                }),
                path({
                    at: 0,
                    dur: 7.0,
                    points: [[0.0, 0.74], [0.16, 0.62], [0.32, 0.68], [0.5, 0.56], [0.68, 0.64], [0.84, 0.58], [1.0, 0.66], [1.0, 1.0], [0.0, 1.0]],
                    smooth: true,
                    closed: true,
                    fill: '#0c1528',
                }),
                path({
                    at: 0,
                    dur: 7.0,
                    points: [[0.0, 0.82], [0.2, 0.76], [0.4, 0.8], [0.6, 0.72], [0.8, 0.78], [1.0, 0.74], [1.0, 1.0], [0.0, 1.0]],
                    smooth: true,
                    closed: true,
                    fill: '#070d1c',
                }),
                glow({ at: 0, dur: 7.0, x: 0.6, y: 0.44, radius: 0.18, color: colorToken('warm'), intensity: 0.35 }),
                text({ at: 0.3, dur: 6.5, content: 'A wide layer holds the landscape', size: 34, color: colorToken('ink'), align: 'left', x: 0.07, y: 0.26 }),
                text({ at: 0.4, dur: 6.4, content: 'zoom layer: wide', size: 22, color: colorToken('muted'), align: 'left', x: 0.07, y: 0.86 }),
            ],
        }),
        layer({
            at: 0,
            dur: 7.0,
            zoomFrom: 1.14,
            zoomTo: 1.6,
            edge: 0.05,
            items: [
                // The close scale keeps its own composition: a shelf, two
                // measured lines and the point where they meet.
                path({
                    at: 0,
                    dur: 7.0,
                    points: [[0.0, 0.8], [0.28, 0.77], [0.6, 0.81], [1.0, 0.78], [1.0, 1.0], [0.0, 1.0]],
                    smooth: true,
                    closed: true,
                    fill: '#0a1224',
                }),
                path({
                    at: 0,
                    dur: 7.0,
                    points: [[0.16, 0.62], [0.36, 0.56], [0.5, 0.58], [0.66, 0.5], [0.84, 0.54]],
                    smooth: true,
                    stroke: 4,
                    color: colorToken('warm'),
                    progress: 1,
                }),
                path({
                    at: 0.5,
                    dur: 6.5,
                    points: [[0.2, 0.7], [0.34, 0.62], [0.5, 0.58], [0.7, 0.6], [0.86, 0.66]],
                    smooth: true,
                    stroke: 3,
                    color: colorToken('accent'),
                    progress: 1,
                }),
                shape({ at: 0, dur: 7.0, shape: 'ring', x: 0.5, y: 0.58, w: 0.08, h: 0.08, color: colorToken('accent'), stroke: 3 }),
                glow({ at: 0, dur: 7.0, x: 0.72, y: 0.48, radius: 0.1, color: colorToken('warm'), intensity: 0.45 }),
                text({ at: 0.3, dur: 6.5, content: 'A close layer holds the detail', size: 38, color: colorToken('ink'), align: 'left', x: 0.07, y: 0.18 }),
                text({ at: 0.4, dur: 6.4, content: 'zoom layer: close', size: 22, color: colorToken('muted'), align: 'left', x: 0.07, y: 0.86 }),
            ],
        }),
        grain({ at: 0, dur: 7.0, strength: 0.06, density: 15000 }),
    ],
});

film.scene({
    id: 'close',
    duration: 5.5,
    background: { kind: 'v-gradient', colors: ['#060a18', '#101a34', '#03050a'] },
    items: [
        text({
            at: 0.2,
            dur: 5.1,
            content: 'One definition, many placements',
            sub: 'components compile once and paint through instances',
            size: 44,
            bold: true,
            color: colorToken('ink'),
            subColor: colorToken('muted'),
            x: 0.5,
            y: 0.16,
            rise: 16,
            stagger: 2,
        }),
        instance({ at: 0.6, dur: 4.7, component: 'tile', x: 0.26, y: 0.46, w: 0.3, h: 0.3, opacity: 1 }),
        instance({ at: 0.9, dur: 4.4, component: 'tile', x: 0.5, y: 0.46, w: 0.3, h: 0.3, opacity: 0.88 }),
        instance({ at: 1.2, dur: 4.1, component: 'tile', x: 0.74, y: 0.46, w: 0.3, h: 0.3, opacity: 0.72 }),
        text({ at: 1.6, dur: 3.7, content: 'same definition', size: 22, color: colorToken('muted'), x: 0.26, y: 0.72 }),
        text({ at: 1.8, dur: 3.5, content: 'same definition', size: 22, color: colorToken('muted'), x: 0.5, y: 0.72 }),
        text({ at: 2.0, dur: 3.3, content: 'same definition', size: 22, color: colorToken('muted'), x: 0.74, y: 0.72 }),
        footnote({ at: 1.0, dur: 4.3, text: 'edit the component, every placement follows - no copies', x: 0.5, y: 0.9, size: 22, align: 'center' }),
        grain({ at: 0, dur: 5.5, strength: 0.05, density: 13000 }),
    ],
});

film.audio({
    bgm: { volume: 0.05 },
    sfx: [
        { at: 0.1, kind: 'sub', volume: 0.34 },
        { at: 4.5, kind: 'whoosh', volume: 0.26 },
        { at: 13.6, kind: 'riser', volume: 0.22 },
        { at: 21.5, kind: 'impact', volume: 0.34 },
        { at: 28.5, kind: 'sparkle', volume: 0.2 },
    ],
    notes: [
        { at: 0.4, instrument: 'pad', note: 52, duration: 4.0, velocity: 0.5 },
        { at: 5.0, instrument: 'pad', note: 55, duration: 4.0, velocity: 0.45 },
        { at: 14.2, instrument: 'keys', note: 60, duration: 1.6, velocity: 0.5 },
        { at: 21.8, instrument: 'strings', note: 48, duration: 3.0, velocity: 0.4 },
        { at: 28.8, instrument: 'bell', note: 64, duration: 2.2, velocity: 0.35 },
    ],
    patterns: [{ at: 21.5, preset: 'half-time', bpm: 96, bars: 2, volume: 0.28 }],
});

export default film;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const stats = film.render(process.argv[2] ?? 'atlas.mp4');
    console.log(`rendered ${stats.frames} frames (${stats.seconds.toFixed(1)}s) -> ${stats.out}`);
    console.log(`backend: ${stats.backend} · audio: ${stats.audio}`);
}
