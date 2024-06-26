#!/usr/bin/env node
/**
 * OpenCut CLI — compile a film script into an MP4.
 *
 * Usage:
 *   open-cut render <film.mjs|film.ts> [--out file.mp4] [--from s] [--to s] [--scene id] [--cancel-file path] [--json]
 *   open-cut verify <film.mjs|film.ts> --out file.mp4 [--from s] [--to s] [--json]
 *   open-cut validate <film.mjs|film.ts> [--json]
 *   open-cut plan <film.mjs|film.ts> [--json]
 *   open-cut subtitles <film.mjs|film.ts> --out file.srt [--format srt|vtt] [--max-cps n] [--json]
 *   open-cut revise <film.mjs|film.ts> --cue id --text "..." [--json]
 *   open-cut chapters <film.mjs|film.ts> --out file.png [--json]
 *   open-cut compare <film.mjs|film.ts> --before <film.mjs|film.ts> --out file.png [--only p1,p2] [--json]
 *   open-cut inspect <file.mp4> [--probes n] [--strict] [--json]
 *   open-cut storyboard <film.mjs|film.ts> --out dir [--contact file.png] [--timeline file.png] [--motion file.mp4] [--covers n] [--only p1,p2] [--scale n] [--rows n] [--json]
 *   open-cut preview <film.mjs|film.ts> --frame N --out file.png [--json]
 *   open-cut preview <film.mjs|film.ts> --at seconds --out file.png [--json]
 *   open-cut preview <film.mjs|film.ts> --from s --to s --out dir [--json]
 *   open-cut build [--json]
 *   open-cut version
 *
 * The film module must default-export a `Film` instance (or an object with a
 * `film` export). `--from`/`--to` export an interval in seconds (frames are
 * renumbered from zero). `--cancel-file` is polled between frames: creating
 * that file stops the run without touching the previous output.
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Film } from './dsl.js';
import { nativeBuild, nativeVersion, inspectDelivery, verifyRender } from './index.js';

function fail(message: string, code: number): never {
    console.error(`open-cut: ${message}`);
    process.exit(code);
}

function flag(args: string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    const value = args[index + 1];
    if (value === undefined) {
        fail(`${name} requires a value`, 2);
    }
    return value;
}

/** Converts a non-negative seconds flag into a rounded frame index. */
function secondsToFrame(value: string, fps: number, name: string): number {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
        fail(`${name} must be a non-negative number of seconds, got ${value}`, 2);
    }
    return Math.round(seconds * fps);
}

const args = process.argv.slice(2);
const command = args[0];

if (command === 'version' || command === undefined) {
    console.log(command === undefined ? 'usage: open-cut render <film> [--out file.mp4] | open-cut verify <film> --out file.mp4 | open-cut validate <film> | open-cut plan <film> | open-cut storyboard <film> --out dir | open-cut preview <film> --frame N --out file.png | open-cut build | open-cut version' : nativeVersion());
    process.exit(command === undefined ? 2 : 0);
}

if (command === 'build') {
    const build = nativeBuild();
    if (args.includes('--json')) {
        console.log(JSON.stringify(build, null, 2));
    }
    else {
        console.log(`${build.version} ${build.sourceRev}${build.dirty ? ' (dirty)' : ''} [${build.profile}]`);
    }
    process.exit(0);
}

if (command === 'preview') {
    const script = args[1];
    if (!script) {
        fail('preview requires a film script path', 2);
    }
    const frameArg = flag(args, '--frame');
    const atArg = flag(args, '--at');
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('preview requires --out <file.png> and either --frame <index>, --at <seconds> or --from/--to', 2);
    }
    const fromArg = flag(args, '--from');
    const toArg = flag(args, '--to');
    if ((fromArg === undefined) !== (toArg === undefined)) {
        fail('--from and --to must be given together', 2);
    }
    if (fromArg !== undefined && (frameArg !== undefined || atArg !== undefined)) {
        fail('preview takes either --frame/--at or --from/--to, not both', 2);
    }
    if (fromArg === undefined && (frameArg === undefined) === (atArg === undefined)) {
        fail('preview takes exactly one of --frame <index> or --at <seconds>', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    if (fromArg !== undefined && toArg !== undefined) {
        // An interval preview is a frame sequence: `--out` is the directory and
        // frames are numbered from zero like `render --from/--to`.
        const start = secondsToFrame(fromArg, film.fps, '--from');
        const end = secondsToFrame(toArg, film.fps, '--to');
        if (end <= start) {
            fail(`preview --from ${fromArg} must be earlier than --to ${toArg}`, 2);
        }
        const dir = path.resolve(outArg);
        mkdirSync(dir, { recursive: true });
        const frames: unknown[] = [];
        try {
            for (let frame = start; frame < end; frame += 1) {
                const name = `frame-${String(frame - start).padStart(4, '0')}.png`;
                frames.push(film.preview(frame, path.join(dir, name)));
            }
        }
        catch (error) {
            fail(error instanceof Error ? error.message : String(error), 1);
        }
        if (args.includes('--json')) {
            console.log(JSON.stringify({ dir, startFrame: start, endFrame: end, frames }, null, 2));
            process.exit(0);
        }
        console.log(`frames ${start}..${end} (${frames.length} files) -> ${outArg}`);
        process.exit(0);
    }
    const frame = atArg !== undefined ? secondsToFrame(atArg, film.fps, '--at') : Math.round(Number(frameArg));
    try {
        const stats = film.preview(frame, path.resolve(outArg));
        if (args.includes('--json')) {
            console.log(JSON.stringify(stats, null, 2));
            process.exit(0);
        }
        console.log(`frame ${stats.frame} -> ${outArg} [${stats.width}x${stats.height}, project ${stats.projectHash}]`);
        console.log(`fonts: ${stats.fonts.join(', ')}`);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    process.exit(0);
}

if (command === 'validate') {
    const script = args[1];
    if (!script) {
        fail('validate requires a film script path', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    let report: ReturnType<Film['validateProduction']>;
    try {
        report = film.validateProduction();
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
    }
    else {
        for (const problem of report.problems) {
            console.log(`FAIL ${problem}`);
        }
        const { shots, panels, cues, assets, tasks, delivery } = report.counts;
        console.log(`${report.ok ? 'ok' : 'FAIL'}: ${shots} shots, ${panels} panels, ${cues} cues, ${assets} assets, ${tasks} tasks, ${delivery} delivery`);
    }
    process.exit(report.ok ? 0 : 1);
}

if (command === 'plan') {
    const script = args[1];
    if (!script) {
        fail('plan requires a film script path', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    let plan: ReturnType<Film['planTasks']>;
    try {
        plan = film.planTasks();
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(plan, null, 2));
    }
    else {
        for (const problem of plan.problems) {
            console.log(`FAIL ${problem}`);
        }
        console.log(`run: ${plan.run.length > 0 ? plan.run.join(', ') : '(none)'}`);
        console.log(`fresh: ${plan.fresh.length > 0 ? plan.fresh.join(', ') : '(none)'}`);
    }
    // A broken book cannot be planned; a plan of nothing is still a success.
    process.exit(plan.problems.length === 0 ? 0 : 1);
}

if (command === 'storyboard') {
    const script = args[1];
    if (!script) {
        fail('storyboard requires a film script path', 2);
    }
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('storyboard requires --out <dir>', 2);
    }
    const rowsArg = flag(args, '--rows');
    const rows = rowsArg === undefined ? undefined : Number(rowsArg);
    if (rows !== undefined && (!Number.isInteger(rows) || rows < 1)) {
        fail(`--rows must be a positive integer, got ${rowsArg}`, 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    const out = path.resolve(outArg);
    const onlyArg = flag(args, '--only');
    const only = onlyArg === undefined ? undefined : onlyArg.split(',').map((panel) => panel.trim()).filter((panel) => panel.length > 0);
    const layoutOptions = rows === undefined ? {} : { rows };
    const options = { ...layoutOptions, ...(only === undefined ? {} : { only }) };
    try {
        const pages = film.storyboard(out, options);
        const contact = flag(args, '--contact');
        const sheet = contact === undefined ? null : film.contactSheet(path.resolve(contact), layoutOptions);
        const timelineArg = flag(args, '--timeline');
        const timeline = timelineArg === undefined ? null : film.timeline(path.resolve(timelineArg), layoutOptions);
        const motionArg = flag(args, '--motion');
        const scaleArg = flag(args, '--scale');
        const scale = scaleArg === undefined ? undefined : Number(scaleArg);
        if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0 || scale > 1)) {
            fail(`--scale must be a number in (0, 1], got ${scaleArg}`, 2);
        }
        const motion = motionArg === undefined ? null : film.motionPreview(path.resolve(motionArg), { scale });
        const coversArg = flag(args, '--covers');
        const coversCount = coversArg === undefined ? 0 : Number(coversArg);
        if (coversArg !== undefined && (!Number.isInteger(coversCount) || coversCount < 1)) {
            fail(`--covers must be a positive integer, got ${coversArg}`, 2);
        }
        const covers = coversCount === 0 ? null : film.coverCandidates(path.join(out, 'covers'), coversCount);
        const cells = pages.reduce((sum, page) => sum + page.cells.length, 0);
        if (args.includes('--json')) {
            console.log(JSON.stringify({ pages, sheet, timeline, motion, covers }, null, 2));
            process.exit(0);
        }
        console.log(`storyboard: ${pages.length} page(s), ${cells} panel row(s) -> ${out}`);
        for (const page of pages) {
            console.log(`  ${page.path}: ${page.cells.map((cell) => `${cell.shot}/${cell.panel}`).join(', ')}`);
        }
        if (sheet) {
            console.log(`contact sheet: ${sheet.path}`);
        }
        if (timeline) {
            console.log(`timeline: ${timeline.path} (${timeline.cells.length} shot rows)`);
        }
        if (motion) {
            console.log(`motion preview: ${motion.out} [${motion.width}x${motion.height}, ${motion.frames} frames]`);
        }
        if (covers) {
            console.log(`cover candidates: ${covers.length} in ${path.join(out, 'covers')}`);
        }
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    process.exit(0);
}

if (command === 'subtitles') {
    const script = args[1];
    if (!script) {
        fail('subtitles requires a film script path', 2);
    }
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('subtitles requires --out <file.srt|file.vtt>', 2);
    }
    const formatArg = flag(args, '--format') ?? 'srt';
    if (formatArg !== 'srt' && formatArg !== 'vtt') {
        fail(`--format must be srt or vtt, got ${formatArg}`, 2);
    }
    const maxCpsArg = flag(args, '--max-cps');
    const maxCps = maxCpsArg === undefined ? undefined : Number(maxCpsArg);
    if (maxCps !== undefined && (!Number.isFinite(maxCps) || maxCps <= 0)) {
        fail(`--max-cps must be a positive number, got ${maxCpsArg}`, 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    let result: ReturnType<Film['subtitles']>;
    try {
        result = film.subtitles(formatArg, maxCps === undefined ? {} : { maxCps });
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    const out = path.resolve(outArg);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, result.text, 'utf8');
    if (args.includes('--json')) {
        console.log(JSON.stringify({ ...result, out }, null, 2));
        process.exit(0);
    }
    console.log(`subtitles: ${result.cues} cue(s), ${result.format} -> ${out}`);
    process.exit(0);
}

if (command === 'revise') {
    const script = args[1];
    if (!script) {
        fail('revise requires a film script path', 2);
    }
    const cue = flag(args, '--cue');
    const text = flag(args, '--text');
    if (cue === undefined || text === undefined) {
        fail('revise requires --cue <id> and --text "<new line>"', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    let revision: ReturnType<Film['reviseCue']>;
    try {
        revision = film.reviseCue(cue, text);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(revision, null, 2));
        process.exit(revision.lines.ok && revision.reading === null ? 0 : 1);
    }
    if (revision.lines.ok) {
        for (const line of revision.lines.lines) {
            console.log(`  ${line}`);
        }
    }
    else {
        console.log(`FAIL ${revision.lines.error}`);
    }
    if (revision.reading) {
        console.log(`FAIL ${revision.reading}`);
    }
    console.log(`cue ${revision.cue} frames ${revision.range[0]}..${revision.range[1]}`);
    console.log(`affected: shots ${revision.shots.join(', ') || '(none)'} panels ${revision.panels.join(', ') || '(none)'}`);
    process.exit(revision.lines.ok && revision.reading === null ? 0 : 1);
}

if (command === 'chapters') {
    const script = args[1];
    if (!script) {
        fail('chapters requires a film script path', 2);
    }
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('chapters requires --out <file.png>', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    try {
        const page = film.chapters(path.resolve(outArg));
        if (args.includes('--json')) {
            console.log(JSON.stringify(page, null, 2));
            process.exit(0);
        }
        console.log(`chapters: ${page.cells.length} shot row(s) -> ${page.path}`);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    process.exit(0);
}

if (command === 'compare') {
    const script = args[1];
    if (!script) {
        fail('compare requires the current film script path', 2);
    }
    const beforeArg = flag(args, '--before');
    const outArg = flag(args, '--out');
    if (beforeArg === undefined || outArg === undefined) {
        fail('compare requires --before <film> and --out <file.png>', 2);
    }
    const current = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = current.default ?? current.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    const previous = await import(pathToFileURL(path.resolve(beforeArg)).href);
    const before: unknown = previous.default ?? previous.film;
    if (!(before instanceof Film)) {
        fail('the --before module must default-export a Film instance', 2);
    }
    const onlyArg = flag(args, '--only');
    const only = onlyArg === undefined ? undefined : onlyArg.split(',').map((panel) => panel.trim()).filter((panel) => panel.length > 0);
    try {
        const page = film.comparison(before.toProject(), path.resolve(outArg), only === undefined ? {} : { only });
        if (args.includes('--json')) {
            console.log(JSON.stringify(page, null, 2));
            process.exit(0);
        }
        console.log(`comparison: ${page.panels.join(', ')} -> ${page.path}`);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    process.exit(0);
}

if (command === 'inspect') {
    const file = args[1];
    if (!file) {
        fail('inspect requires a delivered file path', 2);
    }
    const probesArg = flag(args, '--probes');
    const probes = probesArg === undefined ? 8 : Number(probesArg);
    if (!Number.isInteger(probes) || probes < 2) {
        fail(`--probes must be an integer of at least 2, got ${probesArg}`, 2);
    }
    let report: ReturnType<typeof inspectDelivery>;
    try {
        report = inspectDelivery(path.resolve(file), probes);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
        process.exit(args.includes('--strict') && report.suspects.length > 0 ? 1 : 0);
    }
    console.log(`inspected ${report.path} [${report.width}x${report.height}]`);
    for (const sample of report.samples) {
        console.log(`  f${sample.index} @${sample.seconds.toFixed(2)}s luma ${sample.mean_luma.toFixed(3)}${sample.frozen ? ' (identical to previous)' : ''}`);
    }
    if (report.audio) {
        console.log(
            `  audio: ${report.audio.seconds.toFixed(2)}s @${report.audio.sample_rate}Hz, peak ${report.audio.peak_db.toFixed(1)} dBFS, rms ${report.audio.rms_db.toFixed(1)} dBFS, clipped ${report.audio.clipped}`,
        );
    }
    for (const suspect of report.suspects) {
        console.log(`  suspect: ${suspect}`);
    }
    process.exit(args.includes('--strict') && report.suspects.length > 0 ? 1 : 0);
}

if (command === 'verify') {
    const script = args[1];
    if (!script) {
        fail('verify requires a film script path', 2);
    }
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('verify requires --out <file.mp4>', 2);
    }
    const fromArg = flag(args, '--from');
    const toArg = flag(args, '--to');
    if ((fromArg === undefined) !== (toArg === undefined)) {
        fail('--from and --to must be given together', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    const range =
        fromArg !== undefined && toArg !== undefined
            ? { startFrame: secondsToFrame(fromArg, film.fps, '--from'), endFrame: secondsToFrame(toArg, film.fps, '--to') }
            : undefined;
    const stats = (() => {
        try {
            return film.render(path.resolve(outArg), range);
        }
        catch (error) {
            fail(error instanceof Error ? error.message : String(error), 1);
        }
    })();
    const checks = verifyRender(stats);
    const ok = checks.every((check) => check.ok);
    if (args.includes('--json')) {
        console.log(JSON.stringify({ ok, checks, stats }, null, 2));
    }
    else {
        for (const check of checks) {
            console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
        }
    }
    process.exit(ok ? 0 : 1);
}

if (command !== 'render') {
    fail(`unknown command ${command}`, 2);
}

const script = args[1];
if (!script) {
    fail('render requires a film script path', 2);
}
const out = path.resolve(flag(args, '--out') ?? path.join(path.dirname(path.resolve(script)), 'film.mp4'));

const module = await import(pathToFileURL(path.resolve(script)).href);
const film: unknown = module.default ?? module.film;
if (!(film instanceof Film)) {
    fail('the film module must default-export a Film instance', 2);
}

const from = flag(args, '--from');
const to = flag(args, '--to');
if ((from === undefined) !== (to === undefined)) {
    fail('--from and --to must be given together', 2);
}
const sceneId = flag(args, '--scene');
if (sceneId !== undefined && from !== undefined) {
    fail('--scene cannot be combined with --from/--to', 2);
}
let startFrame = from === undefined ? undefined : Math.round(Number(from) * film.fps);
let endFrame = to === undefined ? undefined : Math.round(Number(to) * film.fps);
if (sceneId !== undefined) {
    try {
        ([startFrame, endFrame] = film.sceneRange(sceneId));
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 2);
    }
}

const stats = (() => {
    try {
        return film.render(out, { startFrame, endFrame, cancelFile: flag(args, '--cancel-file') });
    }
    catch (error) {
        // The core reports stable codes (`cancelled`, `media`, `invalid_scene`, …);
        // surface the message instead of a bare stack trace.
        fail(error instanceof Error ? error.message : String(error), 1);
    }
})();
if (args.includes('--json')) {
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
}
console.log(
    `rendered frames ${stats.range[0]}..${stats.range[1]} (${stats.frames} frames, ${(stats.frames / stats.fps).toFixed(1)}s) -> ${stats.out} ` +
        `[${stats.backend}, ${Math.round(stats.bytes / 1024)} KiB, project ${stats.projectHash}]`,
);
console.log(`fonts: ${stats.fonts.join(', ')}`);
console.log(`assets: ${stats.assets.length} fingerprinted`);
if (stats.audioLevel) {
    console.log(
        `audio level: peak ${stats.audioLevel.peakDbfs.toFixed(1)} dBFS, rms ${stats.audioLevel.rmsDbfs.toFixed(1)} dBFS` +
            (stats.audioLevel.clipped > 0 ? `, clipped ${stats.audioLevel.clipped}` : ''),
    );
}
for (const scene of stats.scenes) {
    console.log(`scene ${scene.id}: frames ${scene.range[0]}..${scene.range[1]}${scene.rendered ? '' : ' (not written)'}`);
}
if (stats.optionalMissing.length > 0) {
    console.log(`optional slots left empty: ${stats.optionalMissing.join(', ')}`);
}
