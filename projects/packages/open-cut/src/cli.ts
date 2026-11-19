#!/usr/bin/env node
/**
 * OpenCut CLI — compile a film script into an MP4.
 *
 * Usage:
 *   open-cut render <film.mjs|film.ts> [--out file.mp4] [--from s] [--to s] [--scene id] [--cancel-file path] [--audio-codec aac|flac] [--limiter-db n] [--burn] [--json]
 *   open-cut verify <film.mjs|film.ts> --out file.mp4 [--from s] [--to s] [--json]
 *   open-cut validate <film.mjs|film.ts> [--json]
 *   open-cut plan <film.mjs|film.ts> [--json]
 *   open-cut subtitles <film.mjs|film.ts> --out file.srt [--format srt|vtt] [--max-cps n] [--json]
 *   open-cut revise <film.mjs|film.ts> --cue id --text "..." [--json]
 *   open-cut chapters <film.mjs|film.ts> --out file.png [--json]
 *   open-cut compare <film.mjs|film.ts> --before <film.mjs|film.ts> --out file.png [--only p1,p2] [--json]
 *   open-cut inspect <file.mp4> [--probes n] [--expected seconds] [--expect-size WxH] [--strict] [--json]
 *   open-cut archive <film.mjs|film.ts> [--root dir] [--json]
 *   open-cut scenes <film.mjs|film.ts> --out file.png [--json]
 *   open-cut seams <film.mjs|film.ts> --out file.png [--json]
 *   open-cut at <film.mjs|film.ts> --frame N [--json]
 *   open-cut shots <film.mjs|film.ts> [--json]
 *   open-cut diff <film> --before <film> [--json]
 *   open-cut notes <film> [--file path] [--add --text "..." --shot id [--panel id] [--cue id] [--frame N]] [--resolve id] [--json]
 *   open-cut storyboard <film.mjs|film.ts> --out dir [--contact file.png] [--timeline file.png] [--motion file.mp4] [--covers n] [--only p1,p2] [--scale n] [--rows n] [--page 1600x1200] [--json]
 *   open-cut preview <film.mjs|film.ts> --frame N --out file.png [--json]
 *   open-cut preview <film.mjs|film.ts> --at seconds --out file.png [--json]
 *   open-cut preview <film.mjs|film.ts> --from s --to s --out dir [--json]
 *   open-cut gui <film.mjs|film.ts> [--content-dir dir] [--range from:to] [--scale n] [--title text]
 *   open-cut build [--json]
 *   open-cut version
 *
 * The film module must default-export a `Film` instance (or an object with a
 * `film` export). `--from`/`--to` export an interval in seconds (frames are
 * renumbered from zero). `--cancel-file` is polled between frames: creating
 * that file stops the run without touching the previous output.
 * Exit codes: 0 success, 1 runtime failure, 2 usage error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Film, toWire } from './dsl.js';
import { native } from './native.js';
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

/** Resolves the staged VMZ workbench directory.
 *
 * Explicit flag → `OPEN_CUT_GUI` → shipped `dist/gui` → sibling UI build. A
 * directory without `index.html` is rejected instead of opening a blank window. */
function resolveGuiContentDir(explicit: string | undefined): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        explicit === undefined ? undefined : path.resolve(explicit),
        process.env.OPEN_CUT_GUI,
        path.resolve(here, 'gui'),
        path.resolve(here, '../../open-cut-ui/dist/static'),
    ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
    const found = candidates.find((candidate) => existsSync(path.join(candidate, 'index.html')));
    if (found === undefined) {
        fail(
            `GUI content directory not found. Build it with \`pnpm build:ui\` or pass --content-dir.\nTried:\n${candidates
                .map((candidate) => `  - ${candidate}`)
                .join('\n')}`,
            2,
        );
    }
    return found;
}

/** Converts a non-negative seconds flag into a rounded frame index. */
function secondsToFrame(value: string, fps: number, name: string): number {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
        fail(`${name} must be a non-negative number of seconds, got ${value}`, 2);
    }
    return Math.round(seconds * fps);
}

/** One panel as the review surfaces see it: shot-local and absolute frames. */
interface PanelEntry {
    id: string;
    range: [number, number];
    absolute: [number, number] | null;
    purpose: string;
    composition: string;
    dialogue: string | null;
    camera: string | null;
    sound: string | null;
    /** Scene node ids this panel must show. */
    witness: string[];
    notes: string[];
}

/** One shot resolved against the compiled scene timeline. */
interface ShotEntry {
    id: string;
    scene: string;
    locked: boolean;
    /** Absolute half-open frames, or `null` when the referenced scene is missing. */
    range: [number, number] | null;
    panels: PanelEntry[];
}

interface CueEntry {
    id: string;
    shot: string;
    range: [number, number];
    absolute: [number, number] | null;
    text: string;
    speaker: string | null;
}

/** A review annotation kept beside the film, so a note never edits the source. */
interface ReviewNote {
    id: string;
    /** Absolute frame the note points at, or `null` when the anchor was lost. */
    frame: number | null;
    shot: string | null;
    panel: string | null;
    cue: string | null;
    text: string;
    status: 'open' | 'resolved';
}

/** Where notes for a film live by default: `<dir>/<name>.notes.json`. */
function notesPathFor(entry: string): string {
    const resolved = path.resolve(entry);
    return path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}.notes.json`);
}

/**
 * Resolves the production book against the compiled scenes.
 *
 * The book keeps ranges shot-local; every review surface shows absolute frames
 * so a picked block matches what a render reports. A shot whose scene is
 * missing is reported as `null`, never guessed.
 */
function shotIndex(film: Film): { shots: ShotEntry[]; cues: CueEntry[] } {
    const book = film.toProduction() as { shots?: unknown[]; cues?: unknown[] };
    const rawShots = Array.isArray(book.shots) ? book.shots : [];
    const rawCues = Array.isArray(book.cues) ? book.cues : [];
    const shots: ShotEntry[] = rawShots.map((entry) => {
        const shot = entry as { id: string; scene: string; locked?: boolean; panels?: unknown[] };
        const panelList = Array.isArray(shot.panels) ? shot.panels : [];
        let range: [number, number] | null = null;
        try {
            range = film.sceneRange(shot.scene);
        }
        catch {
            range = null;
        }
        return {
            id: shot.id,
            scene: shot.scene,
            locked: shot.locked === true,
            range,
            panels: panelList.map((value) => {
                const panel = value as {
                    id: string;
                    range: [number, number];
                    purpose?: string;
                    composition?: string;
                    dialogue?: string;
                    camera?: string;
                    sound?: string;
                    witness?: string[];
                    notes?: string[];
                };
                return {
                    id: panel.id,
                    range: panel.range,
                    absolute: range === null ? null : [range[0] + panel.range[0], range[0] + panel.range[1]],
                    purpose: panel.purpose ?? '',
                    composition: panel.composition ?? '',
                    dialogue: panel.dialogue ?? null,
                    camera: panel.camera ?? null,
                    sound: panel.sound ?? null,
                    witness: Array.isArray(panel.witness) ? panel.witness : [],
                    notes: Array.isArray(panel.notes) ? panel.notes : [],
                };
            }),
        };
    });
    const cues: CueEntry[] = rawCues.map((entry) => {
        const cue = entry as { id: string; shot: string; range: [number, number]; text: string; speaker?: string };
        const shot = shots.find((item) => item.id === cue.shot);
        const base = shot && shot.range ? shot.range[0] : null;
        return {
            id: cue.id,
            shot: cue.shot,
            range: cue.range,
            absolute: base === null ? null : [base + cue.range[0], base + cue.range[1]],
            text: cue.text,
            speaker: cue.speaker ?? null,
        };
    });
    return { shots, cues };
}

const args = process.argv.slice(2);
const command = args[0];

if (command === 'version' || command === undefined) {
    console.log(command === undefined ? 'usage: open-cut render <film> [--out file.mp4] | open-cut verify <film> --out file.mp4 | open-cut validate <film> | open-cut plan <film> | open-cut storyboard <film> --out dir | open-cut preview <film> --frame N --out file.png | open-cut build | open-cut version' : nativeVersion());
    process.exit(command === undefined ? 2 : 0);
}

if (command === 'gui') {
    const script = args[1];
    if (!script) {
        fail('gui requires a film script path', 2);
    }
    const entry = path.resolve(script);
    const contentDir = resolveGuiContentDir(flag(args, '--content-dir'));
    const scaleArg = flag(args, '--scale');
    const scale = scaleArg === undefined ? 0.5 : Number(scaleArg);
    if (!(scale >= 0.1 && scale <= 1)) {
        fail(`--scale must be between 0.1 and 1, got ${scaleArg}`, 2);
    }
    const module = await import(pathToFileURL(entry).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    const rangeArg = flag(args, '--range');
    let autoPreview: { startFrame: number; endFrame: number } | null = null;
    if (rangeArg !== undefined) {
        const match = /^(\d+):(\d+)$/.exec(rangeArg.trim());
        if (match === null) {
            fail(`--range takes <start>:<end> in frames, got ${rangeArg}`, 2);
        }
        const startFrame = Number(match[1]);
        const endFrame = Number(match[2]);
        if (!(startFrame < endFrame) || endFrame > film.durationFrames) {
            fail(`--range ${rangeArg} must satisfy 0 <= start < end <= ${film.durationFrames}`, 2);
        }
        autoPreview = { startFrame, endFrame };
    }
    const projectJson = JSON.stringify(toWire(film.toProject()));
    const revision = createHash('sha256').update(projectJson).digest('hex').slice(0, 12);
    const book = film.toProduction() as { shots?: unknown[]; cues?: unknown[]; assets?: unknown[] };
    const { shots: shotList, cues: cueList } = shotIndex(film);
    const session = {
        schema: 'open-cut.session/v0',
        name: path.basename(entry, path.extname(entry)),
        root: path.dirname(entry),
        entry: path.basename(entry),
        revision,
        build: nativeBuild(),
        project: {
            width: film.width,
            height: film.height,
            fps: film.fps,
            durationFrames: film.durationFrames,
            scenes: film.scenes,
        },
        production: {
            shots: shotList.length,
            panels: shotList.reduce<number>((sum, shot) => sum + shot.panels.length, 0),
            cues: cueList.length,
            assets: Array.isArray(book.assets) ? book.assets.length : 0,
            shotList,
            cueList,
        },
        preview: { scale, autoPreview },
    };
    const title = flag(args, '--title') ?? `OpenCut — ${session.name}`;
    try {
        const opened = native.openGui({
            contentDir,
            cacheDir: path.join(path.dirname(entry), '.cache', 'opencut'),
            title,
            project: projectJson,
            session: JSON.stringify(session),
        });
        if (!opened.opened) {
            fail(`GUI is already open (${opened.reason ?? 'unknown'})`, 1);
        }
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    console.log(`open-cut: gui ${session.name} [${revision}] ${film.width}x${film.height}@${film.fps} ${film.durationFrames}f`);
    console.log(`open-cut: review ${contentDir}`);
    // `pumpEvents` must run on this thread: it owns the window message loop.
    const timer = setInterval(() => {
        if (!native.pumpEvents()) {
            clearInterval(timer);
            process.exit(0);
        }
    }, 16);
    process.on('SIGINT', () => {
        native.closeGui();
        process.exit(0);
    });
    // Keep this module suspended: the pump timer owns the process lifetime and
    // the render command below must not run for `gui`.
    await new Promise<void>(() => {});
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
    // `--page 1920x1080` renders the same book onto a different sheet size, so
    // a wide or vertical deliverable is paginated instead of scaled down.
    const pageArg = flag(args, '--page');
    const page = pageArg === undefined ? undefined : /^(\d+)x(\d+)$/i.exec(pageArg.trim());
    if (pageArg !== undefined && page === null) {
        fail(`--page must be WIDTHxHEIGHT, got ${pageArg}`, 2);
    }
    const layoutOptions = {
        ...(rows === undefined ? {} : { rows }),
        ...(page === null || page === undefined ? {} : { width: Number(page[1]), height: Number(page[2]) }),
    };
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

if (command === 'at') {
    const script = args[1];
    if (!script) {
        fail('at requires a film script path', 2);
    }
    const frameArg = flag(args, '--frame');
    const frame = frameArg === undefined ? NaN : Number(frameArg);
    if (!Number.isInteger(frame) || frame < 0) {
        fail(`at requires --frame N, got ${frameArg}`, 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    try {
        const lookup = film.atFrame(frame);
        if (args.includes('--json')) {
            console.log(JSON.stringify(lookup, null, 2));
            process.exit(0);
        }
        console.log(`frame ${lookup.frame}: shots ${lookup.shots.join(', ') || '-'}, panels ${lookup.panels.join(', ') || '-'}, cues ${lookup.cues.join(', ') || '-'}`);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    process.exit(0);
}

if (command === 'shots') {
    const script = args[1];
    if (!script) {
        fail('shots requires a film script path', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    let report: ReturnType<Film['validateProduction']>;
    let index: ReturnType<typeof shotIndex>;
    try {
        report = film.validateProduction();
        index = shotIndex(film);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    // A panel without a purpose has no evidence to show, and a panel without a
    // witness never ties that evidence to a scene object. Either way the sheet
    // cannot claim the shot is reviewable. That is a review finding, not a
    // schema error.
    const findings: string[] = [];
    for (const shot of index.shots) {
        for (const panel of shot.panels) {
            if (panel.purpose.trim().length === 0) {
                findings.push(`panel ${panel.id} (shot ${shot.id}) has no purpose: nothing says what the audience must see`);
            }
            if (panel.absolute === null) {
                findings.push(`panel ${panel.id} (shot ${shot.id}) has no absolute range: scene \`${shot.scene}\` is missing`);
            }
            if (panel.witness.length === 0) {
                findings.push(`panel ${panel.id} (shot ${shot.id}) binds no witness: the evidence is not tied to any scene node`);
            }
        }
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify({ ok: report.ok && findings.length === 0, problems: report.problems, findings, ...index }, null, 2));
        process.exit(report.ok && findings.length === 0 ? 0 : 1);
    }
    for (const shot of index.shots) {
        const range = shot.range === null ? 'scene missing' : `${shot.range[0]}–${shot.range[1]}`;
        console.log(`shot ${shot.id} [${range}]${shot.locked ? ' locked' : ''} -> scene ${shot.scene}`);
        for (const panel of shot.panels) {
            const absolute = panel.absolute === null ? '—' : `${panel.absolute[0]}–${panel.absolute[1]}`;
            console.log(`  panel ${panel.id} [${absolute}] purpose: ${panel.purpose.trim() || '(not written)'}`);
            if (panel.composition.trim().length > 0) {
                console.log(`    composition: ${panel.composition}`);
            }
            if (panel.witness.length > 0) {
                console.log(`    sees: ${panel.witness.join(', ')}`);
            }
            const notes: string[] = [];
            if (panel.dialogue) notes.push(`dialogue: ${panel.dialogue}`);
            if (panel.camera) notes.push(`camera: ${panel.camera}`);
            if (panel.sound) notes.push(`sound: ${panel.sound}`);
            if (notes.length > 0) {
                console.log(`    ${notes.join(' · ')}`);
            }
        }
        for (const cue of index.cues.filter((item) => item.shot === shot.id)) {
            const absolute = cue.absolute === null ? '—' : `${cue.absolute[0]}–${cue.absolute[1]}`;
            console.log(`  cue ${cue.id} [${absolute}] ${cue.text}`);
        }
    }
    for (const problem of report.problems) {
        console.log(`FAIL ${problem}`);
    }
    for (const finding of findings) {
        console.log(`REVIEW ${finding}`);
    }
    console.log(`${report.ok && findings.length === 0 ? 'ok' : 'FAIL'}: ${index.shots.length} shots, ${index.shots.reduce((sum, shot) => sum + shot.panels.length, 0)} panels, ${index.cues.length} cues`);
    process.exit(report.ok && findings.length === 0 ? 0 : 1);
}

if (command === 'diff') {
    const script = args[1];
    if (!script) {
        fail('diff requires the newer film script path', 2);
    }
    const beforeArg = flag(args, '--before');
    if (beforeArg === undefined) {
        fail('diff requires --before <previous film>', 2);
    }
    const load = async (file: string): Promise<Film> => {
        const module = await import(pathToFileURL(path.resolve(file)).href);
        const loaded: unknown = module.default ?? module.film;
        if (!(loaded instanceof Film)) {
            fail(`the film module ${file} must default-export a Film instance`, 2);
        }
        return loaded;
    };
    const after = await load(script);
    const before = await load(beforeArg);
    let diff: ReturnType<Film['changesFrom']>;
    try {
        diff = after.changesFrom(before);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(diff, null, 2));
        process.exit(0);
    }
    for (const change of diff.changes) {
        const range = change.range === null ? '—' : `${change.range[0]}–${change.range[1]}`;
        console.log(`${change.kind} ${change.id} ${change.change} [${range}]`);
    }
    if (!diff.changed) {
        console.log('no changes');
        process.exit(0);
    }
    const seconds = (frame: number): string => (frame / after.fps).toFixed(3).replace(/\.?0+$/, '');
    for (const [start, end] of diff.rerender) {
        console.log(`re-render frames ${start}–${end} -> open-cut render ${path.basename(script)} --from ${seconds(start)} --to ${seconds(end)}`);
    }
    if (diff.reencode) {
        console.log(`re-encode the deliverable: the audio bed or delivery changed without moving a frame -> open-cut render ${path.basename(script)} --out <master>`);
    }
    const changedPanels = [...new Set(diff.changes
        .filter((change) => change.kind === 'panel' && change.change !== 'removed')
        .map((change) => change.id))];
    if (changedPanels.length > 0) {
        console.log(`compare the changed panels -> open-cut compare ${path.basename(script)} --before ${path.basename(beforeArg)} --only ${changedPanels.join(',')} --out review.png`);
    }
    process.exit(0);
}

if (command === 'notes') {
    const script = args[1];
    if (!script) {
        fail('notes requires a film script path', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    const fileArg = flag(args, '--file');
    const file = fileArg === undefined ? notesPathFor(script) : path.resolve(fileArg);
    const store: { schema: string; notes: ReviewNote[] } = { schema: 'open-cut.notes/v0', notes: [] };
    if (existsSync(file)) {
        try {
            const stored = JSON.parse(readFileSync(file, 'utf8')) as { notes?: ReviewNote[] };
            if (Array.isArray(stored.notes)) {
                store.notes = stored.notes;
            }
        }
        catch (error) {
            fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, 1);
        }
    }
    const index = shotIndex(film);
    const indexShot = (id: string | undefined) => (id === undefined ? undefined : index.shots.find((shot) => shot.id === id));
    const resolveId = flag(args, '--resolve');
    if (resolveId !== undefined) {
        const note = store.notes.find((entry) => entry.id === resolveId);
        if (!note) {
            fail(`no note ${resolveId} in ${file}`, 1);
        }
        note.status = 'resolved';
        writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
        console.log(`resolved ${note.id} (${file})`);
        process.exit(0);
    }
    if (args.includes('--add')) {
        const text = flag(args, '--text');
        const shotArg = flag(args, '--shot');
        const panelArg = flag(args, '--panel');
        const cueArg = flag(args, '--cue');
        if (text === undefined || text.trim().length === 0) {
            fail('notes --add requires --text "<note>"', 2);
        }
        if (shotArg === undefined && panelArg === undefined && cueArg === undefined) {
            fail('notes --add requires --shot, --panel or --cue', 2);
        }
        const shot = indexShot(shotArg);
        if (shotArg !== undefined && shot === undefined) {
            fail(`unknown shot ${shotArg}`, 1);
        }
        if (panelArg !== undefined && shot === undefined) {
            fail('--panel needs --shot', 2);
        }
        const panel = shot === undefined || panelArg === undefined
            ? undefined
            : shot.panels.find((entry) => entry.id === panelArg);
        if (panelArg !== undefined && panel === undefined) {
            fail(`shot ${String(shotArg)} has no panel ${panelArg}`, 1);
        }
        const cue = cueArg === undefined ? undefined : index.cues.find((entry) => entry.id === cueArg);
        if (cueArg !== undefined && cue === undefined) {
            fail(`unknown cue ${cueArg}`, 1);
        }
        const frameArg = flag(args, '--frame');
        const frame = frameArg === undefined ? undefined : Number(frameArg);
        if (frame !== undefined && (!Number.isInteger(frame) || frame < 0)) {
            fail(`notes --frame must be an integer frame, got ${frameArg}`, 2);
        }
        const id = `n${store.notes.reduce((max, note) => {
            const match = /^n(\d+)$/.exec(note.id);
            return match === null ? max : Math.max(max, Number(match[1]));
        }, 0) + 1}`;
        store.notes.push({
            id,
            frame: frame ?? panel?.absolute?.[0] ?? cue?.absolute?.[0] ?? shot?.range?.[0] ?? null,
            shot: shot?.id ?? null,
            panel: panel?.id ?? null,
            cue: cue?.id ?? null,
            text: text.trim(),
            status: 'open',
        });
        writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
        console.log(`added ${id} (${file})`);
        process.exit(0);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify({ file, notes: store.notes }, null, 2));
        process.exit(0);
    }
    const shotIds = new Set(index.shots.map((shot) => shot.id));
    const panelKeys = new Set(index.shots.flatMap((shot) => shot.panels.map((panel) => `${shot.id}/${panel.id}`)));
    const cueIds = new Set(index.cues.map((cue) => cue.id));
    for (const note of store.notes) {
        const anchor = note.panel !== null
            ? `panel ${String(note.shot)}/${note.panel}`
            : note.cue !== null
                ? `cue ${note.cue}`
                : note.shot !== null
                    ? `shot ${note.shot}`
                    : 'film';
        const stale = (note.shot !== null && !shotIds.has(note.shot))
            || (note.panel !== null && !panelKeys.has(`${String(note.shot)}/${note.panel}`))
            || (note.cue !== null && !cueIds.has(note.cue));
        const frame = note.frame === null ? '—' : String(note.frame);
        console.log(`${note.id} ${note.status} frame ${frame} ${anchor}${stale ? ' stale' : ''} "${note.text}"`);
    }
    if (store.notes.length === 0) {
        console.log(`no notes (${file})`);
    }
    process.exit(0);
}

if (command === 'scenes') {
    const script = args[1];
    if (!script) {
        fail('scenes requires a film script path', 2);
    }
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('scenes requires --out <file.png>', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    try {
        const page = film.sceneOverview(path.resolve(outArg));
        if (args.includes('--json')) {
            console.log(JSON.stringify(page, null, 2));
            process.exit(0);
        }
        console.log(`scenes: ${page.scenes} scene row(s) -> ${page.path}`);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    process.exit(0);
}

if (command === 'seams') {
    const script = args[1];
    if (!script) {
        fail('seams requires a film script path', 2);
    }
    const outArg = flag(args, '--out');
    if (outArg === undefined) {
        fail('seams requires --out <file.png>', 2);
    }
    const module = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = module.default ?? module.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    try {
        const page = film.seams(path.resolve(outArg));
        if (args.includes('--json')) {
            console.log(JSON.stringify(page, null, 2));
            process.exit(0);
        }
        console.log(`seams: ${page.cuts} cut(s) -> ${page.path}`);
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
    const expectedArg = flag(args, '--expected');
    const expected = expectedArg === undefined ? undefined : Number(expectedArg);
    if (expected !== undefined && (!Number.isFinite(expected) || expected <= 0)) {
        fail(`--expected must be a positive number of seconds, got ${expectedArg}`, 2);
    }
    const sizeArg = flag(args, '--expect-size');
    const size = sizeArg === undefined ? undefined : /^(\d+)x(\d+)$/i.exec(sizeArg.trim());
    if (sizeArg !== undefined && size === null) {
        fail(`--expect-size must be WIDTHxHEIGHT, got ${sizeArg}`, 2);
    }
    let report: ReturnType<typeof inspectDelivery>;
    try {
        report = inspectDelivery(
            path.resolve(file),
            probes,
            expected,
            0.5,
            size === null || size === undefined ? undefined : { width: Number(size[1]), height: Number(size[2]) },
        );
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
        console.log(`  f${sample.index} @${sample.seconds.toFixed(2)}s luma ${sample.mean_luma.toFixed(3)}${sample.frozen ? ' (identical to previous)' : ''}${sample.jump > 0 ? ` jump ${sample.jump.toFixed(2)}` : ''}`);
    }
    if (report.audio) {
        console.log(
            `  audio: ${report.audio.seconds.toFixed(2)}s @${report.audio.sample_rate}Hz, peak ${report.audio.peak_db.toFixed(1)} dBFS, rms ${report.audio.rms_db.toFixed(1)} dBFS, clipped ${report.audio.clipped}`,
        );
        console.log(
            `  loudness: ${report.audio.integrated_lufs.toFixed(1)} LUFS, true peak ${report.audio.true_peak_db.toFixed(1)} dBFS`,
        );
    }
    for (const suspect of report.suspects) {
        console.log(`  suspect: ${suspect}`);
    }
    process.exit(args.includes('--strict') && report.suspects.length > 0 ? 1 : 0);
}

if (command === 'archive') {
    const script = args[1];
    if (!script) {
        fail('archive requires a film script path', 2);
    }
    const current = await import(pathToFileURL(path.resolve(script)).href);
    const film: unknown = current.default ?? current.film;
    if (!(film instanceof Film)) {
        fail('the film module must default-export a Film instance', 2);
    }
    const rootArg = flag(args, '--root');
    const root = rootArg === undefined ? path.dirname(path.resolve(script)) : path.resolve(rootArg);
    let report: ReturnType<typeof import('./index.js').checkArchive>;
    try {
        report = film.archive(root);
    }
    catch (error) {
        fail(error instanceof Error ? error.message : String(error), 1);
    }
    if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.missing.length + report.mismatched.length > 0 ? 1 : 0);
    }
    console.log(`archive ${report.root}: ${report.ok.length} ok, ${report.missing.length} missing, ${report.mismatched.length} changed`);
    for (const asset of report.missing) {
        console.log(`  missing: ${asset.id} -> ${asset.path}`);
    }
    for (const asset of report.mismatched) {
        console.log(`  changed: ${asset.id} -> ${asset.path} (recorded ${asset.digest}, found ${asset.found})`);
    }
    process.exit(report.missing.length + report.mismatched.length > 0 ? 1 : 0);
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

const audioCodecArg = flag(args, '--audio-codec');
if (audioCodecArg !== undefined && audioCodecArg !== 'aac' && audioCodecArg !== 'flac') {
    fail(`--audio-codec must be aac or flac, got ${audioCodecArg}`, 2);
}
const audioCodec = audioCodecArg as 'aac' | 'flac' | undefined;

const limiterArg = flag(args, '--limiter-db');
const limiterCeilingDb = limiterArg === undefined ? undefined : Number(limiterArg);
if (limiterCeilingDb !== undefined && (!Number.isFinite(limiterCeilingDb) || limiterCeilingDb > 0)) {
    fail(`--limiter-db must be a non-positive dBFS ceiling, got ${limiterArg}`, 2);
}

const lufsArg = flag(args, '--lufs');
const loudnessTargetLufs = lufsArg === undefined ? undefined : Number(lufsArg);
if (loudnessTargetLufs !== undefined && (!Number.isFinite(loudnessTargetLufs) || loudnessTargetLufs > 0)) {
    fail(`--lufs must be a negative LUFS target, got ${lufsArg}`, 2);
}

const stats = (() => {
    try {
        if (args.includes('--burn')) {
            if (from !== undefined || sceneId !== undefined) {
                fail('--burn renders the whole film and cannot be combined with --from/--to/--scene', 2);
            }
            return film.renderWithSubtitles(out);
        }
        return film.render(out, { startFrame, endFrame, cancelFile: flag(args, '--cancel-file'), audioCodec, limiterCeilingDb, loudnessTargetLufs });
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
if (stats.limiter) {
    console.log(
        `limiter: peak ${stats.limiter.output_peak_db.toFixed(1)} dBFS, reduction ${stats.limiter.max_reduction_db.toFixed(1)} dB on ${stats.limiter.limited} sample(s)`,
    );
}
if (stats.loudness) {
    console.log(
        `loudness: ${stats.loudness.measured_lufs.toFixed(1)} -> ${stats.loudness.achieved_lufs.toFixed(1)} LUFS (target ${stats.loudness.target_lufs.toFixed(1)}, gain ${stats.loudness.gain_db.toFixed(1)} dB)`,
    );
}
for (const scene of stats.scenes) {
    console.log(`scene ${scene.id}: frames ${scene.range[0]}..${scene.range[1]}${scene.rendered ? '' : ' (not written)'}`);
}
if (stats.optionalMissing.length > 0) {
    console.log(`optional slots left empty: ${stats.optionalMissing.join(', ')}`);
}
