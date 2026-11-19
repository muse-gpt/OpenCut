/**
 * Code-first authoring surface. A film is a plain object graph: scenes carry
 * seconds, the compiler converts them to frames, and `render` hands the IR to
 * the Rust core through N-API. Timeline is data; the finished file is the
 * compiled artifact.
 */
import { native } from './native.js';
import type {
    ArchiveReport,
    CoverCandidate,
    CueRevision,
    FrameLookup,
    PreviewResult,
    ProductionReport,
    RenderOptions,
    RenderResult,
    StoryboardOptions,
    StoryboardPage,
    SubtitleExport,
    SubtitleFormat,
    SubtitleStyle,
    TaskPlan,
} from './native.js';
import type {
    Animated,
    AudioSpec,
    Background,
    BarSeries,
    CodeTheme,
    Component,
    DesignSpec,
    FontsSpec,
    Item,
    Keyframe,
    LineSeries,
    NoteInput,
    PatternInput,
    PostSpec,
    Project,
    SfxInput,
    Track,
    VoiceInput,
    YTick,
} from './types.js';

export type Ease =
    | 'linear'
    | 'in-out-cubic'
    | 'out-cubic'
    | 'out-quint'
    | 'in-out-sine'
    | 'out-expo'
    | 'in-expo'
    | 'in-out-quart'
    | 'out-back';

export interface FilmOptions {
    width?: number;
    height?: number;
    fps?: number;
    /** Visual controls. `vignette` is off unless declared here. */
    post?: PostSpec;
    /** Explicit font files; omit to let the host discover them and report them. */
    fonts?: FontsSpec;
    /** Project-level semantic color card. */
    design?: DesignSpec;
    /**
     * Extra raster resolution rendered before the frame is downsampled,
     * `1..=2`. Camera moves already supersample the world; this asks for the
     * same treatment in a film that does not move the camera.
     */
    supersample?: number;
}

interface TimedInput {
    at?: number;
    dur?: number;
    fadeIn?: number;
    fadeOut?: number;
}

export type SceneInput = {
    /** Stable identity for storyboard mapping, revision notes and locks. */
    id?: string;
    duration: number;
    background?: Background;
    items?: ItemInput[];
    /** Camera move applied to the whole scene. */
    camera?: CameraInput;
    /** Scene-level design overrides; locked project roles are rejected. */
    design?: DesignSpec;
};

/** Camera move in human units: zoom factors, normalized focus, degrees. */
export type CameraInput = {
    zoomFrom?: number;
    zoomTo?: number;
    focusFrom?: [number, number];
    focusTo?: [number, number];
    ease?: Ease;
    rotateTo?: number;
};

/** Item input: same fields as the IR but `at`/`dur`/fades in seconds. */
export type ItemInput = TimedInput & { kind: string } & Record<string, unknown>;

/** Fields every node accepts on top of its kind. */
export interface NodeOptions {
    /** Stable identity for revisions, locks and notes. */
    id?: string;
    /**
     * Which space the node is painted in. `world` (default) belongs to the
     * drawing and moves with the camera, so a push-in scales it. `screen` is
     * painted after the lens at the same scene clock, so an annotation keeps
     * its size and position and a push-in never crops it.
     */
    space?: 'world' | 'screen';
    /**
     * Motion with keys in seconds. By default keys run on the scene clock, the
     * same clock the renderer samples. Set `timeBase: 'local'` to author keys
     * relative to the item's own start; compiling adds that offset once, at
     * every nesting level, instead of leaving a manual fixup in the film.
     */
    anim?: AnimInput;
}

/** A reusable element declared on a film. */
export interface ComponentInput {
    id: string;
    items: ItemInput[];
}

const DEFAULT_FADE = 0.35;

function frames(seconds: number, fps: number): number {
    return Math.round(seconds * fps);
}

function compileItem(item: ItemInput, fps: number, sceneSeconds: number, depth = 0): Item {
    const out: Record<string, unknown> = { ...item };
    if (depth > 0 && item['space'] === 'screen') {
        throw new Error(`item \`${String(item.id ?? item.kind)}\`: screen space only applies to top-level scene nodes, because nested items paint into their parent's buffer`);
    }
    const atFrames = frames((item.at ?? 0) as number, fps);
    out['at'] = atFrames;
    out['dur'] = Math.max(1, frames((item.dur ?? sceneSeconds) as number, fps));
    // Zero is a real value: a fade of 0 means "no fade", so an author can cut
    // exactly on a frame instead of getting an implicit one-frame ramp.
    out['fadeIn'] = Math.max(0, frames((item.fadeIn ?? DEFAULT_FADE) as number, fps));
    out['fadeOut'] = Math.max(0, frames((item.fadeOut ?? DEFAULT_FADE) as number, fps));
    const motion = item['anim'] as AnimInput | undefined;
    const offset = motion?.timeBase === 'local' ? atFrames : 0;
    out['anim'] = compileAnim(motion, fps, offset);
    // A layer's children keep their own (layer-relative) timing, in seconds.
    if (item.kind === 'layer' && Array.isArray(item['items'])) {
        const children = item['items'] as ItemInput[];
        out['items'] = children.map((child) => compileItem(child, fps, sceneSeconds, depth + 1));
    }
    return out as unknown as Item;
}

/** Track keys authored in seconds; the core reads frames. */
type AnimInput = {
    /**
     * Which clock the keys are written on. `scene` (default) matches the
     * renderer's sampling clock; `local` is relative to the item's own start
     * and is offset by `at` at compile time.
     */
    timeBase?: 'scene' | 'local';
    x?: Array<{ at: number; value: number; ease?: Ease }>;
    y?: Array<{ at: number; value: number; ease?: Ease }>;
    opacity?: Array<{ at: number; value: number; ease?: Ease }>;
    progress?: Array<{ at: number; value: number; ease?: Ease }>;
    follow?: { points: Array<[number, number]>; smooth?: boolean; closed?: boolean };
};

function compileTrack<T>(keys: Array<Keyframe<T>> | undefined, fps: number, offsetFrames = 0): Track<T> | undefined {
    if (!keys) {
        return undefined;
    }
    return { keys: keys.map((key) => ({ ...key, at: frames(key.at, fps) + offsetFrames })) };
}

function compileAnim(input: AnimInput | Animated | undefined, fps: number, offsetFrames = 0): Animated | undefined {
    if (!input) {
        return undefined;
    }
    const anim: Animated = {};
    const x = compileTrack(input.x as Keyframe<number>[], fps, offsetFrames);
    const y = compileTrack(input.y as Keyframe<number>[], fps, offsetFrames);
    const opacity = compileTrack(input.opacity as Keyframe<number>[], fps, offsetFrames);
    const progress = compileTrack(input.progress as Keyframe<number>[], fps, offsetFrames);
    if (x) anim.x = x;
    if (y) anim.y = y;
    if (opacity) anim.opacity = opacity;
    if (progress) anim.progress = progress;
    if (input.follow) anim.follow = input.follow;
    return anim;
}

/**
 * Motion for one node, with every key authored in seconds. Keys run on the
 * scene clock by default, which is what the renderer samples; pass
 * `timeBase: 'local'` to write them relative to the item's own start. Position
 * is normalized frame coordinates; `progress` drives both "how much is drawn"
 * and travel along `follow`.
 */
export function anim(spec: AnimInput): AnimInput {
    return spec;
}

/** One difference between two builds of a film. */
export interface FilmChange {
    kind: 'scene' | 'shot' | 'panel' | 'cue' | 'audio' | 'delivery';
    id: string;
    change: 'added' | 'removed' | 'changed' | 'moved';
    /** Absolute half-open frames in the newer film, or `null` when the thing
     *  no longer exists there or is not tied to a frame range. */
    range: [number, number] | null;
}

/** What changed between two builds, and which blocks need a re-render. */
export interface FilmDiff {
    changes: FilmChange[];
    /** Merged absolute ranges of the newer film that changed, in frame order. */
    rerender: Array<[number, number]>;
    /** The audio bed or a delivery profile changed: no frame range moved, but
     *  the delivered file still has to be encoded again. */
    reencode: boolean;
    changed: boolean;
}

/** A film: scenes plus the audio bed, compiled to the core IR. */
export class Film {
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    private readonly post: PostSpec;
    private readonly fonts: FontsSpec | null;
    private designSpec: DesignSpec | null;
    private readonly supersample: number | undefined;
    private readonly sceneList: SceneInput[] = [];
    private readonly componentList: ComponentInput[] = [];
    private audioSpec: AudioSpec | null = null;
    private cameraKeys: Array<{ at: number; zoom: number; focus: [number, number]; rotate: number; ease: Ease }> = [];
    private productionSpec: ProductionInput = {};

    constructor(options: FilmOptions = {}) {
        this.width = options.width ?? 1920;
        this.height = options.height ?? 1080;
        this.fps = options.fps ?? 30;
        this.post = options.post ?? {};
        this.fonts = options.fonts ?? null;
        this.designSpec = options.design ?? null;
        this.supersample = options.supersample;
    }

    /** Declares semantic colors. Any color field may then use `$role`;
     *  resolution happens in the core before validation, so a locked role is
     *  a hard contract rather than a UI hint. */
    design(spec: DesignSpec): this {
        this.designSpec = spec;
        return this;
    }

    /** Appends a scene; scenes run back to back in call order. */
    scene(input: SceneInput): this {
        this.sceneList.push(input);
        return this;
    }

    /** Declares a reusable element. Instances reference it by `id`, so one
     *  edit updates every placement. */
    component(id: string, items: ItemInput[]): this {
        this.componentList.push({ id, items });
        return this;
    }

    /** Sets the audio bed. `sfx.at`, `voice.at`, `notes.at`, `patterns.at`,
     *  clip times and narration delay are in seconds here; the compiler
     *  converts them to frames for the IR. Effects, songs, instruments and
     *  grooves are synthesized by the core; audio files are only decoded. */
    audio(spec: {
        bgm?: { volume?: number; mood?: string } | null;
        narration?: { wav: string; delay?: number; volume?: number } | null;
        sfx?: SfxInput[];
        voice?: VoiceInput[];
        notes?: NoteInput[];
        patterns?: PatternInput[];
        clips?: Array<{ src: string; at?: number; dur?: number; offset?: number; volume?: number; required?: boolean }>;
    }): this {
        this.audioSpec = {
            bgm: spec.bgm,
            narration: spec.narration
                ? { wav: spec.narration.wav, delayFrames: frames(spec.narration.delay ?? 0, this.fps), volume: spec.narration.volume }
                : null,
            sfx: (spec.sfx ?? []).map((sfx) => ({ ...sfx, at: frames(sfx.at, this.fps) })),
            voice: (spec.voice ?? []).map((voice) => ({ ...voice, at: frames(voice.at, this.fps) })),
            notes: (spec.notes ?? []).map((note) => ({ ...note, at: frames(note.at, this.fps) })),
            patterns: (spec.patterns ?? []).map((pattern) => ({ ...pattern, at: frames(pattern.at, this.fps) })),
            clips: (spec.clips ?? []).map((clip) => ({
                src: clip.src,
                at: frames(clip.at ?? 0, this.fps),
                dur: clip.dur === undefined ? null : frames(clip.dur, this.fps),
                offsetFrames: frames(clip.offset ?? 0, this.fps),
                volume: clip.volume,
                required: clip.required,
            })),
        };
        return this;
    }

    /** Camera curve for the whole film. Keys are in seconds and are
     *  interpolated continuously, so the result plays as one take. */
    camera(keys: Array<{ at: number; zoom: number; focus?: [number, number]; rotate?: number; ease?: Ease }>): this {
        this.cameraKeys = keys.map((key) => ({
            at: frames(key.at, this.fps),
            zoom: key.zoom,
            focus: key.focus ?? [0.5, 0.5],
            rotate: key.rotate ?? 0,
            ease: key.ease ?? 'in-out-sine',
        }));
        return this;
    }

    /** Total duration in seconds. */
    get seconds(): number {
        return this.sceneList.reduce((sum, scene) => sum + scene.duration, 0);
    }

    /** Scene handles with their absolute half-open frame ranges.
     *
     * GUI hosts and range previews use this instead of recomputing scene
     * durations, so a picked block always matches what a render reports. */
    get scenes(): Array<{ id: string; range: [number, number] }> {
        let cursor = 0;
        return this.sceneList.map((scene, index) => {
            const duration = Math.max(1, frames(scene.duration, this.fps));
            const range: [number, number] = [cursor, cursor + duration];
            cursor = range[1];
            return { id: scene.id ?? `scene-${index}`, range };
        });
    }

    /** Total frames this film compiles to. */
    get durationFrames(): number {
        const scenes = this.scenes;
        const last = scenes[scenes.length - 1];
        return last === undefined ? 0 : last.range[1];
    }

    /** Half-open frame range of one named scene.
     *
     * The range matches the `scenes` report a render returns, so a review note
     * or a partial re-render can name a block instead of counting frames. An
     * unknown id is an explicit error, never a silent whole-film render.
     */
    sceneRange(id: string): [number, number] {
        let cursor = 0;
        for (const scene of this.sceneList) {
            const duration = Math.max(1, frames(scene.duration, this.fps));
            if (scene.id === id) {
                return [cursor, cursor + duration];
            }
            cursor += duration;
        }
        const known = this.sceneList.map((scene, index) => scene.id ?? `scene-${index}`).join(', ');
        throw new Error(`no scene with id \`${id}\`; scenes: ${known}`);
    }

    /** Compiles to the frame-based scene IR. */
    toProject(): Project {
        let cursor = 0;
        const scenes = this.sceneList.map((scene) => {
            const start = cursor;
            const duration = Math.max(1, frames(scene.duration, this.fps));
            cursor = start + duration;
            return {
                id: scene.id,
                start,
                duration,
                background: scene.background,
                items: (scene.items ?? []).map((item) => compileItem(item, this.fps, scene.duration)),
                design: scene.design,
                camera: scene.camera
                    ? {
                          zoomFrom: scene.camera.zoomFrom ?? 1,
                          zoomTo: scene.camera.zoomTo ?? 1,
                          focusFrom: scene.camera.focusFrom ?? [0.5, 0.5],
                          focusTo: scene.camera.focusTo ?? scene.camera.focusFrom ?? [0.5, 0.5],
                          ease: scene.camera.ease ?? 'in-out-cubic',
                          rotateTo: scene.camera.rotateTo ?? 0,
                      }
                    : null,
            };
        });
        return {
            width: this.width,
            height: this.height,
            fps: this.fps,
            durationFrames: cursor,
            scenes,
            components: this.componentList.map((component) => ({
                id: component.id,
                items: component.items.map((item) => compileItem(item, this.fps, this.seconds, 1)),
            })),
            audio: this.audioSpec,
            camera: this.cameraKeys,
            post: this.post,
            fonts: this.fonts,
            design: this.designSpec ?? undefined,
            supersample: this.supersample,
        };
    }

    /** Attaches the production book: shots, panels, cues, assets, tasks and
     *  delivery targets that reference this film's scenes.
     *
     *  This is not a second project file: the same `Film` still compiles the
     *  render project, and the book rides along with it. Merging only replaces
     *  the lists that are passed, so a film can declare shots and cues in
     *  separate calls. */
    production(input: ProductionInput): this {
        this.productionSpec = { ...this.productionSpec, ...input };
        return this;
    }

    /** The production book as wire data: the compiled project plus metadata. */
    toProduction(): Record<string, unknown> {
        return { project: this.toProject(), ...this.productionSpec };
    }

    /** Validates ids, references, frame ranges and task dependencies.
     *
     *  Rendering does not require this call; it is the review gate. Every
     *  problem is returned at once, each naming the handle the author wrote. */
    validateProduction(): ProductionReport {
        return native.validateProduction({ production: JSON.stringify(toWire(this.toProduction())) });
    }

    /** Re-reads every asset under `root` and compares it with the recorded digest.
     *
     *  `missing` and `mismatched` are reported separately, so an archive is
     *  never built over a hole or a silently replaced file. */
    archive(root: string): ArchiveReport {
        return native.checkArchive({ root, production: JSON.stringify(toWire(this.toProduction())) });
    }

    /** Which declared tasks still have to run, given their latest attempts.
     *
     *  `run` lists tasks whose fingerprints changed or that never succeeded,
     *  `fresh` lists tasks whose latest attempt is still current, and
     *  `problems` is the validation list so a host can refuse to start. */
    planTasks(): TaskPlan {
        return native.planTasks({ production: JSON.stringify(toWire(this.toProduction())) });
    }

    /** Writes storyboard pages into `outDir`, one page per `rows` panels.
     *
     *  Every thumbnail is a frame this film actually renders, and each row
     *  carries first/middle/last frames plus the shot, panel, range and
     *  dialogue. A book that fails validation throws before writing. `only`
     *  re-renders just the pages containing those panel handles, keeping the
     *  page numbers the full book would have given them. */
    storyboard(outDir: string, options: StoryboardOptions & { only?: string[] } = {}): StoryboardPage[] {
        const { only, ...layout } = options;
        return native.writeStoryboard({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outDir,
            ...layout,
            only: only === undefined ? undefined : only.join(','),
        }).pages;
    }

    /** Writes a chapter overview: one row per shot with its first and last
     *  frame, which doubles as the seam check between consecutive shots. */
    chapters(outPath: string, options: StoryboardOptions = {}): StoryboardPage {
        return native.writeChapters({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...options,
        });
    }

    /** Writes a before/after page: each panel's middle frame from two
     *  revisions, rendered with the same painter.
     *
     *  `before` is another compiled project (the previous revision). `only`
     *  limits the page to those panel handles. */
    comparison(before: Project, outPath: string, options: StoryboardOptions & { only?: string[] } = {}): { path: string; panels: string[] } {
        const { only, ...layout } = options;
        return native.writeComparison({
            before: JSON.stringify(toWire(before)),
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...layout,
            only: only === undefined ? undefined : only.join(','),
        });
    }

    /** Reports what changed since `before`, and which blocks need a re-render.
     *
     *  Scenes compare on their compiled IR with `start` removed, so a pure shift
     *  reads as `moved` instead of `changed`. Shots compare without their
     *  panels, and panels and cues compare on their own book entries. The audio
     *  bed and delivery profiles compare too: they change the delivered file
     *  without moving a frame, so they set `reencode` instead of `rerender`.
     *  Ranges are absolute frames in this film; removed entries carry `null`
     *  because they have no home here. */
    changesFrom(before: Film): FilmDiff {
        const changes: FilmChange[] = [];
        const afterProject = toWire(this.toProject()) as Record<string, unknown>;
        const beforeProject = toWire(before.toProject()) as Record<string, unknown>;
        const afterScenes = (afterProject['scenes'] as Array<Record<string, unknown>> | undefined) ?? [];
        const beforeScenes = (beforeProject['scenes'] as Array<Record<string, unknown>> | undefined) ?? [];
        const sceneKey = (scene: Record<string, unknown>, index: number): string => String(scene['id'] ?? `scene-${index}`);
        const afterSceneMap = new Map(afterScenes.map((scene, index) => [sceneKey(scene, index), scene]));
        const beforeSceneMap = new Map(beforeScenes.map((scene, index) => [sceneKey(scene, index), scene]));
        const afterRanges = new Map(this.scenes.map((scene) => [scene.id, scene.range]));
        const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
            const copy = { ...value };
            delete copy[key];
            return copy;
        };

        for (const id of new Set([...afterSceneMap.keys(), ...beforeSceneMap.keys()])) {
            const after = afterSceneMap.get(id);
            const previously = beforeSceneMap.get(id);
            const range = afterRanges.get(id) ?? null;
            if (!after) {
                changes.push({ kind: 'scene', id, change: 'removed', range: null });
            }
            else if (!previously) {
                changes.push({ kind: 'scene', id, change: 'added', range });
            }
            else if (stableJson(without(after, 'start')) !== stableJson(without(previously, 'start'))) {
                changes.push({ kind: 'scene', id, change: 'changed', range });
            }
            else if (after['start'] !== previously['start']) {
                changes.push({ kind: 'scene', id, change: 'moved', range });
            }
        }

        type RawShot = Record<string, unknown> & { id: string; scene: string; panels?: unknown[] };
        type RawPanel = Record<string, unknown> & { id: string; range: [number, number] };
        type RawCue = Record<string, unknown> & { id: string; shot: string; range: [number, number] };

        const shotsOf = (book: unknown): Map<string, RawShot> => {
            const shots = (book as { shots?: unknown[] }).shots;
            return new Map((Array.isArray(shots) ? shots : []).map((entry) => {
                const shot = entry as RawShot;
                return [shot.id, shot];
            }));
        };
        const panelsOf = (shots: Map<string, RawShot>): Map<string, { shot: string; panel: RawPanel }> => {
            const out = new Map<string, { shot: string; panel: RawPanel }>();
            for (const shot of shots.values()) {
                for (const entry of Array.isArray(shot.panels) ? shot.panels : []) {
                    const panel = entry as RawPanel;
                    out.set(`${shot.id}/${panel.id}`, { shot: shot.id, panel });
                }
            }
            return out;
        };
        const sceneRangeOf = (scene: string): [number, number] | null => {
            try {
                return this.sceneRange(scene);
            }
            catch {
                return null;
            }
        };

        const afterShots = shotsOf(this.toProduction());
        const beforeShots = shotsOf(before.toProduction());
        for (const id of new Set([...afterShots.keys(), ...beforeShots.keys()])) {
            const after = afterShots.get(id);
            const previously = beforeShots.get(id);
            const range = after ? sceneRangeOf(after.scene) : null;
            if (!after) {
                changes.push({ kind: 'shot', id, change: 'removed', range: null });
            }
            else if (!previously) {
                changes.push({ kind: 'shot', id, change: 'added', range });
            }
            else if (stableJson(without(after, 'panels')) !== stableJson(without(previously, 'panels'))) {
                changes.push({ kind: 'shot', id, change: 'changed', range });
            }
        }

        const afterPanels = panelsOf(afterShots);
        const beforePanels = panelsOf(beforeShots);
        for (const key of new Set([...afterPanels.keys(), ...beforePanels.keys()])) {
            const after = afterPanels.get(key);
            const previously = beforePanels.get(key);
            const panelId = key.slice(key.indexOf('/') + 1);
            const range = after === undefined
                ? null
                : ((): [number, number] | null => {
                    const shot = afterShots.get(after.shot);
                    const scene = shot === undefined ? null : sceneRangeOf(shot.scene);
                    return scene === null ? null : [scene[0] + after.panel.range[0], scene[0] + after.panel.range[1]];
                })();
            if (!after) {
                changes.push({ kind: 'panel', id: panelId, change: 'removed', range: null });
            }
            else if (!previously) {
                changes.push({ kind: 'panel', id: panelId, change: 'added', range });
            }
            else if (stableJson(after.panel) !== stableJson(previously.panel)) {
                changes.push({ kind: 'panel', id: panelId, change: 'changed', range });
            }
        }

        const cuesOf = (book: unknown): Map<string, RawCue> => {
            const cues = (book as { cues?: unknown[] }).cues;
            return new Map((Array.isArray(cues) ? cues : []).map((entry) => {
                const cue = entry as RawCue;
                return [cue.id, cue];
            }));
        };
        const cueRange = (cue: RawCue): [number, number] | null => {
            const shot = afterShots.get(cue.shot);
            const scene = shot ? sceneRangeOf(shot.scene) : null;
            return scene === null ? null : [scene[0] + cue.range[0], scene[0] + cue.range[1]];
        };
        const afterCues = cuesOf(this.toProduction());
        const beforeCues = cuesOf(before.toProduction());
        for (const id of new Set([...afterCues.keys(), ...beforeCues.keys()])) {
            const after = afterCues.get(id);
            const previously = beforeCues.get(id);
            if (!after) {
                changes.push({ kind: 'cue', id, change: 'removed', range: null });
            }
            else if (!previously) {
                changes.push({ kind: 'cue', id, change: 'added', range: cueRange(after) });
            }
            else if (stableJson(after) !== stableJson(previously)) {
                changes.push({ kind: 'cue', id, change: 'changed', range: cueRange(after) });
            }
        }

        // The audio bed and the delivery profiles change the file without moving
        // a picture frame, so they report themselves but ask for a re-encode.
        const bedOf = (project: Record<string, unknown>): Record<string, unknown> => {
            const audio = project['audio'];
            return audio === null || typeof audio !== 'object' ? {} : audio as Record<string, unknown>;
        };
        const afterBed = bedOf(afterProject);
        const beforeBed = bedOf(beforeProject);
        let reencode = false;
        for (const key of new Set([...Object.keys(afterBed), ...Object.keys(beforeBed)])) {
            const after = afterBed[key] ?? null;
            const previously = beforeBed[key] ?? null;
            if (stableJson(after) === stableJson(previously)) {
                continue;
            }
            reencode = true;
            changes.push({ kind: 'audio', id: key, change: previously === null ? 'added' : after === null ? 'removed' : 'changed', range: null });
        }

        const deliveryOf = (book: unknown): Map<string, unknown> => {
            const delivery = (book as { delivery?: unknown[] }).delivery;
            return new Map((Array.isArray(delivery) ? delivery : []).map((entry, index) => {
                const profile = entry as Record<string, unknown>;
                return [String(profile['name'] ?? `delivery-${index}`), profile];
            }));
        };
        const afterDelivery = deliveryOf(this.toProduction());
        const beforeDelivery = deliveryOf(before.toProduction());
        for (const id of new Set([...afterDelivery.keys(), ...beforeDelivery.keys()])) {
            const after = afterDelivery.get(id);
            const previously = beforeDelivery.get(id);
            if (after !== undefined && previously !== undefined && stableJson(after) === stableJson(previously)) {
                continue;
            }
            reencode = true;
            changes.push({ kind: 'delivery', id, change: after === undefined ? 'removed' : previously === undefined ? 'added' : 'changed', range: null });
        }

        const blocks = changes
            .filter((change): change is FilmChange & { range: [number, number] } => change.range !== null)
            .map((change) => change.range)
            .sort((left, right) => left[0] - right[0]);
        const rerender: Array<[number, number]> = [];
        for (const block of blocks) {
            const last = rerender[rerender.length - 1];
            if (last !== undefined && block[0] <= last[1]) {
                last[1] = Math.max(last[1], block[1]);
            }
            else {
                rerender.push([block[0], block[1]]);
            }
        }
        return { changes, rerender, reencode, changed: changes.length > 0 };
    }

    /** Writes one contact sheet: the middle frame of every panel in a grid. */
    contactSheet(outPath: string, options: StoryboardOptions = {}): StoryboardPage {
        return native.writeContactSheet({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...options,
        });
    }

    /** Writes a timeline overview: one row per shot, panel ticks, cue strip. */
    timeline(outPath: string, options: StoryboardOptions = {}): StoryboardPage {
        return native.writeTimeline({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...options,
        });
    }

    /** Writes a scene overview: one establishing frame per scene.
     *
     *  Each row names the scene, its absolute frame span, its duration and the
     *  shots that use it, so the space view is separate from the film view. */
    sceneOverview(outPath: string, options: StoryboardOptions = {}): { path: string; scenes: number } {
        return native.writeSceneOverview({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...options,
        });
    }

    /** Looks up the shot, panel and cue covering one absolute frame.
     *
     *  Ranges are shot-local in the book and resolved to absolute frames here,
     *  so the answer matches the timeline the renderer uses. A frame in a gap
     *  returns empty lists instead of throwing. */
    atFrame(frame: number): FrameLookup {
        return native.lookupFrame({ production: JSON.stringify(toWire(this.toProduction())), frame });
    }

    /** Writes a seam page: every cut as its last and first drawn frames.
     *
     *  Needs at least two shots; the frames come from the panels' own ranges. */
    seams(outPath: string, options: StoryboardOptions = {}): { path: string; cuts: number } {
        return native.writeSeams({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...options,
        });
    }

    /** Renders the whole film at reduced resolution for motion review.
     *
     *  Timing and audio are unchanged; only the raster scales. `scale` defaults
     *  to `0.5` and is clamped by the core. */
    motionPreview(outPath: string, options: { scale?: number } = {}): RenderResult {
        return native.writeMotionPreview({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            scale: options.scale,
        });
    }

    /** Shortlists cover candidates from frames the film shows.
     *
     *  Candidates are scored by mean luminance plus contrast and returned
     *  strongest first; the final pick stays with a human. */
    coverCandidates(outDir: string, count = 4): CoverCandidate[] {
        return native.writeCoverCandidates({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outDir,
            count,
        }).candidates;
    }

    /** Exports the declared cues as a subtitle file body.
     *
     *  Cues are resolved from shot-local to project frames once; a cue that is
     *  too fast to read or needs more lines than the style allows throws with
     *  the cue's handle. */
    subtitles(format: SubtitleFormat = 'srt', style: SubtitleStyle = {}): SubtitleExport {
        return native.exportSubtitles({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            format,
            ...style,
        });
    }

    /** Recompute one cue after its text changes, without applying the edit.
     *
     *  Returns the new lines (or why they do not fit) and the shots and panels
     *  the cue overlaps, so only those storyboard rows need re-rendering. */
    reviseCue(cue: string, text: string, style: SubtitleStyle = {}): CueRevision {
        return native.reviseCue({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            cue,
            text,
            ...style,
        });
    }

    /** Renders the film with its cues burned into the picture.
     *
     *  The lines come from the same resolver and wrapper the subtitle exporter
     *  uses, so the burned words and the SRT/VTT cannot drift. An unreadable
     *  cue throws before any frame is written. */
    renderWithSubtitles(outPath: string, style: SubtitleStyle = {}): RenderResult {
        return native.renderWithSubtitles({
            project: JSON.stringify(toWire(this.toProject())),
            production: JSON.stringify(toWire(this.toProduction())),
            out: outPath,
            ...style,
        });
    }

    /** Renders one frame into a PNG.
     *
     * The preview runs the same contract checks and painter as an export, so a
     * reviewed frame is the frame the encoder receives. `frame` is an absolute
     * project frame index. */
    preview(frame: number, outPath: string): PreviewResult {
        return native.previewFrame({ project: JSON.stringify(toWire(this.toProject())), frame, out: outPath });
    }

    /** Renders one absolute interval into an MP4 for review.
     *
     * The range is half-open and renumbered from zero, and `scale` shrinks the
     * raster without changing timing, so a review copy costs less than an
     * export. This is the same native path the GUI workbench calls. */
    previewRange(startFrame: number, endFrame: number, outPath: string, options: { scale?: number; cacheDir?: string } = {}): RenderResult {
        return native.previewRange({
            project: JSON.stringify(toWire(this.toProject())),
            out: outPath,
            startFrame,
            endFrame,
            scale: options.scale,
            cacheDir: options.cacheDir,
        });
    }

    /** Renders the compiled project into `outPath` (MP4).
     *
     * `startFrame`/`endFrame` export a half-open interval (renumbered from
     * zero); `cancelFile` is polled between frames so another process can stop
     * the run, which then publishes nothing and keeps the previous file. */
    render(outPath: string, options: RenderOptions = {}): RenderResult {
        return native.renderProject({
            project: JSON.stringify(toWire(this.toProject())),
            out: outPath,
            startFrame: options.startFrame,
            endFrame: options.endFrame,
            cancelFile: options.cancelFile,
            audioCodec: options.audioCodec,
            limiterCeilingDb: options.limiterCeilingDb,
            loudnessTargetLufs: options.loudnessTargetLufs,
        });
    }
}

/** Reference a declared design role, e.g. `colorToken('accent') === '$accent'`. */
export function colorToken(role: string): string {
    return role.startsWith('$') ? role : `$${role}`;
}

/**
 * Converts the JS authoring shape into the domain wire shape.
 *
 * `media.rs` keeps Rust-native snake_case field names — JS style is this
 * binding's concern only. All keys are converted here, at the single boundary
 * where the project crosses into the native module, so the TypeScript API can
 * stay camelCase without pushing that spelling into the domain.
 */
export function toWire(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toWire);
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            out[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = toWire(inner);
        }
        return out;
    }
    return value;
}

/** JSON with sorted keys, so two builds compare structurally rather than by
 *  declaration order. `undefined` members are dropped the way JSON does. */
function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Item constructors (all times in seconds, positions normalized 0..1)
// ---------------------------------------------------------------------------

export interface TextOptions extends NodeOptions {
    at?: number;
    dur?: number;
    content: string;
    sub?: string;
    size: number;
    bold?: boolean;
    color?: string;
    subColor?: string;
    subSize?: number;
    x?: number;
    y: number;
    align?: 'left' | 'center' | 'right';
    fadeIn?: number;
    fadeOut?: number;
    driftY?: number;
    maxWidth?: number;
    lineHeight?: number;
    /** Characters revealed per frame (typewriter effect). */
    typing?: number;
    glow?: string;
    /** Pixels each glyph rises from as it appears. 0 disables the stagger. */
    rise?: number;
    /** Frames between two glyphs entering. */
    stagger?: number;
    /** Reveal rectangle [x, y, w, h] in normalized coords; glyphs paint only inside. */
    clip?: [number, number, number, number];
}

export function text(options: TextOptions): ItemInput {
    return { kind: 'text', color: '#e6eefa', x: 0.5, align: 'center', dur: options.dur ?? 4, ...options } as ItemInput;
}

export interface CodeOptions extends NodeOptions {
    at?: number;
    dur?: number;
    lines: string[];
    x?: number;
    y: number;
    size?: number;
    theme?: Partial<CodeTheme>;
    fadeIn?: number;
    fadeOut?: number;
    typing?: number;
    lineHeight?: number;
}

export function code(options: CodeOptions): ItemInput {
    return { kind: 'code', x: 0.18, size: 34, dur: options.dur ?? 5, ...options } as ItemInput;
}

export interface CounterOptions extends NodeOptions {
    at?: number;
    dur?: number;
    from: number;
    to: number;
    y: number;
    x?: number;
    size?: number;
    color?: string;
    prefix?: string;
    suffix?: string;
    decimals?: number;
    ease?: 'linear' | 'in-out-cubic' | 'out-cubic' | 'out-quint' | 'in-out-sine';
    fadeIn?: number;
    fadeOut?: number;
}

export function counter(options: CounterOptions): ItemInput {
    return { kind: 'counter', x: 0.5, size: 150, color: '#f0f6ff', ease: 'out-quint', dur: options.dur ?? 4, ...options } as ItemInput;
}

export interface CardOptions extends NodeOptions {
    at?: number;
    dur?: number;
    x: number;
    y: number;
    w?: number;
    h?: number;
    title: string;
    body?: string;
    accent?: string;
    panel?: string;
    fadeIn?: number;
    fadeOut?: number;
    driftY?: number;
}

export function card(options: CardOptions): ItemInput {
    return { kind: 'card', w: 0.2, h: 0.16, accent: '#6ea0ff', dur: options.dur ?? 4, ...options } as ItemInput;
}

export interface ShapeOptions extends NodeOptions {
    at?: number;
    dur?: number;
    /**
     * Every shape anchors at its centre in `(x, y)`, like the other items.
     * `rect`, `circle` and `ring` fill a centred `w` × `h` box, so a radial
     * shape with `w != h` is an ellipse. A line runs from `(x, y)` along `(w, h)`.
     */
    shape: 'rect' | 'circle' | 'ring' | 'line';
    x: number;
    y: number;
    w?: number;
    h?: number;
    color?: string;
    radius?: number;
    stroke?: number;
    /** Fraction drawn, for a line that draws itself in. */
    progress?: number;
    blend?: 'normal' | 'add';
    fadeIn?: number;
    fadeOut?: number;
}

export function shape(options: ShapeOptions): ItemInput {
    // Radial shapes fill their `w` × `h` box, so an omitted height must mirror
    // the width instead of inheriting the line's hairline default and collapsing
    // the ellipse to a sliver.
    const radial = options.shape === 'circle' || options.shape === 'ring';
    const w = options.w ?? 0.1;
    const h = options.h ?? (radial ? w : 0.01);
    return { kind: 'shape', color: '#6ea0ff', dur: options.dur ?? 3, ...options, w, h } as ItemInput;
}

/** What a referenced file is. */
export type AssetKind = 'image' | 'video' | 'audio' | 'font' | 'model' | 'document';

/** Where a referenced file came from. */
export type AssetSource =
    | { kind: 'file' }
    | { kind: 'recorded' }
    | { kind: 'generated'; engine: string }
    | { kind: 'remote'; service: string };

/** One file the work references; `path` must stay inside the production root. */
export interface AssetInput {
    id: string;
    /** Relative path; absolute paths and `..` escapes are rejected. */
    path: string;
    kind: AssetKind;
    /** Content digest recorded when the asset entered the work. */
    digest: string;
    source: AssetSource;
}

/** How a cue's frame range was obtained. */
export type CueTiming = { kind: 'estimated' } | { kind: 'measured'; source: string } | { kind: 'manual'; basis: string };

/** One storyboard panel. `range` is a half-open frame range inside the shot. */
export interface PanelInput {
    id: string;
    range: [number, number];
    /** What the audience must see here: the evidence this panel carries. */
    purpose: string;
    composition: string;
    dialogue?: string;
    /** Camera note for this panel, e.g. a move or a focal change. */
    camera?: string;
    /** What has to be heard at this moment. */
    sound?: string;
    /** Safe area in normalized panel coordinates `[x0, y0, x1, y1]`. */
    safeArea?: [number, number, number, number];
    /**
     * Scene node ids this panel must show: the evidence is bound to the same
     * objects the picture is built from, so validation catches a renamed node
     * or a node that is off screen for the whole panel.
     */
    witness?: string[];
    notes?: string[];
}

/** One shot: a scene plus its panels. `scene` must match a `SceneInput.id`. */
export interface ShotInput {
    id: string;
    scene: string;
    /** A locked shot keeps its content across local revisions. */
    locked?: boolean;
    panels?: PanelInput[];
}

/** One subtitle cue. `range` is a half-open frame range inside the shot. */
export interface CueInput {
    id: string;
    shot: string;
    range: [number, number];
    text: string;
    speaker?: string;
    timing: CueTiming;
}

/** One resumable task. Cache validity compares the fingerprints, not files. */
export interface TaskInput {
    id: string;
    /** Capability it exercises, e.g. `media.render`. */
    capability: string;
    /** Fingerprint of the exact inputs; empty is rejected. */
    input: string;
    /** Fingerprint of the processing configuration. */
    config: string;
    deps?: string[];
    outputs?: string[];
}

/** One delivery target. An encoder that cannot produce `video`/`audio` must fail. */
export interface DeliveryInput {
    name: string;
    container: string;
    video?: string;
    audio?: string;
    subtitle?: string;
}

/** How one task attempt ended. */
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * One recorded task attempt.
 *
 * `outputs` belongs to a `succeeded` run only: a cancelled or failed attempt
 * published nothing, so it cannot claim artifacts.
 */
export interface TaskRunInput {
    task: string;
    status: TaskStatus;
    input: string;
    config: string;
    outputs?: string[];
    failure?: { code: string; message: string };
}

/** The production book attached to a film. */
export interface ProductionInput {
    assets?: AssetInput[];
    shots?: ShotInput[];
    cues?: CueInput[];
    tasks?: TaskInput[];
    runs?: TaskRunInput[];
    delivery?: DeliveryInput[];
}

/** Soft diagonal light bands; `alpha` is the peak opacity of each band. */
export function bands(options: {
    at?: number;
    dur?: number;
    count?: number;
    angle?: number;
    speed?: number;
    color?: string;
    alpha?: number;
    thickness?: number;
    fadeIn?: number;
    fadeOut?: number;
}): ItemInput {
    return { kind: 'bands', color: '#8fb4ff', alpha: 0.08, count: 3, angle: -18, speed: 26, thickness: 90, dur: options.dur ?? 4, ...options } as ItemInput;
}

/** Deterministic film grain, refreshed every frame. */
export function grain(options: { at?: number; dur?: number; strength?: number; density?: number; fadeIn?: number; fadeOut?: number } = {}): ItemInput {
    return { kind: 'grain', strength: 0.05, density: 9000, dur: options.dur ?? 4, ...options } as ItemInput;
}

export interface PathOptions extends NodeOptions {
    at?: number;
    dur?: number;
    /** Control points in normalized frame coordinates. */
    points: Array<[number, number]>;
    /** Treat the points as a smooth curve instead of a polyline. */
    smooth?: boolean;
    closed?: boolean;
    fill?: string;
    /** Stroke color. */
    color?: string;
    stroke?: number;
    /** Fraction of the outline drawn. */
    progress?: number;
    /** Degrees, around the path centroid. */
    rotate?: number;
    scale?: number;
    blend?: 'normal' | 'add';
    fadeIn?: number;
    fadeOut?: number;
}

/**
 * A free path: fill it for shapes and silhouettes, stroke it for lines and
 * charts, and animate `progress` to make it draw itself.
 */
export function path(options: PathOptions): ItemInput {
    return { kind: 'path', color: '#7aa2ff', stroke: 3, progress: 1, scale: 1, rotate: 0, dur: options.dur ?? 4, ...options } as ItemInput;
}

/**
 * A group whose opacity follows the camera zoom. Two layers with overlapping
 * zoom windows cross-fade instead of cutting, which is what lets a single
 * continuous camera move carry the film from one idea to the next.
 */
export interface LayerOptions extends NodeOptions {
    at?: number;
    dur?: number;
    zoomFrom: number;
    zoomTo: number;
    edge?: number;
    items: ItemInput[];
}

export function layer(options: LayerOptions): ItemInput {
    return { kind: 'layer', edge: 0.12, dur: options.dur ?? 999, ...options } as ItemInput;
}

/** Soft additive light. A disc with a hard edge reads as a sticker, this reads
 *  as light; `radius` is a fraction of the frame width. */
export interface GlowOptions extends NodeOptions {
    at?: number;
    dur?: number;
    x: number;
    y: number;
    radius: number;
    color?: string;
    intensity?: number;
    fadeIn?: number;
    fadeOut?: number;
}

export function glow(options: GlowOptions): ItemInput {
    return { kind: 'glow', color: '#f2c98a', intensity: 1, dur: options.dur ?? 6, ...options } as ItemInput;
}

export interface FootnoteOptions extends NodeOptions {
    at?: number;
    dur?: number;
    text: string;
    x?: number;
    y?: number;
    size?: number;
    align?: 'left' | 'center' | 'right';
    color?: string;
    fadeIn?: number;
    fadeOut?: number;
}

/** Source line, bottom-left by default — every claim keeps its citation. */
export function footnote(options: FootnoteOptions): ItemInput {
    return { kind: 'footnote', x: 0.06, y: 0.9, size: 26, align: 'left', color: '#5d6f8c', dur: options.dur ?? 4, ...options } as ItemInput;
}

/** A still image decoded from disk. Position is the box center. */
export function image(options: {
    at?: number;
    dur?: number;
    src: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    fit?: 'contain' | 'cover' | 'stretch';
    opacity?: number;
    radius?: number;
    fadeIn?: number;
    fadeOut?: number;
    /** `false` marks a documented empty slot; the default must decode. */
    required?: boolean;
}): ItemInput {
    return { kind: 'image', x: 0.5, y: 0.5, w: 0.4, h: 0.4, fit: 'contain', opacity: 1, dur: options.dur ?? 4, ...options } as ItemInput;
}

/** A video clip; `srcIn` is the first source frame to show. */
export function video(options: {
    at?: number;
    dur?: number;
    src: string;
    srcIn?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    fit?: 'contain' | 'cover' | 'stretch';
    opacity?: number;
    radius?: number;
    fadeIn?: number;
    fadeOut?: number;
    required?: boolean;
}): ItemInput {
    return { kind: 'video', x: 0.5, y: 0.5, w: 0.4, h: 0.4, fit: 'contain', opacity: 1, dur: options.dur ?? 4, ...options } as ItemInput;
}

/** One placement of a declared component. The definition is painted once and
 *  this box controls where it lands, so reuse never copies the content. */
export function instance(options: {
    at?: number;
    dur?: number;
    component: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
    fit?: 'contain' | 'cover' | 'stretch';
    opacity?: number;
    fadeIn?: number;
    fadeOut?: number;
    required?: boolean;
} & NodeOptions): ItemInput {
    return { kind: 'instance', w: 0.4, h: 0.4, fit: 'contain', opacity: 1, dur: options.dur ?? 4, ...options } as ItemInput;
}

/** The only "timeline" a code-first film shows: a global progress bar. */
export function progress(options: { at?: number; dur?: number; track?: string; fill?: string; y?: number } = {}): ItemInput {
    return { kind: 'progress', at: options.at ?? 0, track: '#28344e', fill: '#6ea0ff', ...options } as ItemInput;
}

export interface ChartOptions extends NodeOptions {
    at?: number;
    dur?: number;
    /** Plot box center; `(w, h)` is the box size, all normalized. */
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    /** Value range mapped onto the box height. */
    domain?: [number, number];
    bars?: BarSeries[];
    lines?: LineSeries[];
    axis?: string;
    grid?: string;
    yTicks?: YTick[];
    xLabels?: string[];
    labelSize?: number;
    /** Paint each bar's value above it. */
    valueLabels?: boolean;
    /** Fixed decimals for value labels; omit to trim trailing zeros. */
    valueDecimals?: number;
    /** Reveal fraction along the category axis, 0..=1. */
    progress?: number;
    fadeIn?: number;
    fadeOut?: number;
}

/**
 * A data chart: bar and polyline series inside one plot box. Animate
 * `progress` through `anim` to reveal the categories left to right.
 */
export function chart(options: ChartOptions): ItemInput {
    return {
        kind: 'chart',
        x: 0.5,
        y: 0.5,
        w: 0.62,
        h: 0.5,
        domain: [0, 1],
        axis: '#5d6f8c',
        grid: '#22304c',
        labelSize: 22,
        progress: 1,
        dur: options.dur ?? 6,
        ...options,
    } as ItemInput;
}

export interface CalloutOptions extends NodeOptions {
    at?: number;
    dur?: number;
    /** Anchor point the leader starts from, normalized. */
    ax: number;
    ay: number;
    /** Label box center, normalized. */
    x: number;
    y: number;
    /** Primary label line. */
    text: string;
    /** Secondary line painted under `text`. */
    note?: string;
    size?: number;
    /** Leader, dot and default text color. */
    color?: string;
    /** Label text color; defaults to `color`, then a neutral ink. */
    textColor?: string;
    /** Label background panel; omit to paint bare text. */
    panel?: string;
    /** `true` bends the leader with an elbow, `false` draws it straight. */
    elbow?: boolean;
    /** Reveal fraction; the leader draws first, then the label fades in. */
    progress?: number;
    fadeIn?: number;
    fadeOut?: number;
}

/**
 * An annotation: a leader line from an anchor point to a label box. Animate
 * `progress` to draw the leader and its dot first, then fade the label in.
 */
export function callout(options: CalloutOptions): ItemInput {
    return { kind: 'callout', size: 26, elbow: true, progress: 1, dur: options.dur ?? 4, ...options } as ItemInput;
}
