/**
 * Native binding loader for `@wae/open-cut`.
 *
 * The N-API module is the only implementation path: CLI and authoring
 * surface both call these functions. Platform packages are optional
 * dependencies; a missing binary produces an actionable error instead of a
 * silent fallback.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export interface RenderResult {
    frames: number;
    width: number;
    height: number;
    fps: number;
    seconds: number;
    out: string;
    bytes: number;
    backend: string;
    audio: boolean;
    /** Half-open frame range written, in project frames. */
    range: [number, number];
    /** Font files the render loaded, in role order. */
    fonts: string[];
    /** FNV-1a hash of each loaded font file's bytes, in the same order. */
    fontHashes: string[];
    /** FNV-1a hash of the project JSON that produced the file. */
    projectHash: string;
    /** External files the render loaded, with byte length and hash. */
    assets: AssetFingerprint[];
    /** Every scene with its frame range and whether it was written. */
    scenes: SceneSpan[];
    /** Level of the mixed audio bed; `null` when the film has no audio. */
    audioLevel: AudioLevel | null;
    /** What the delivery limiter did; `null` when none was requested. */
    limiter: LimiterStats | null;
    /** What loudness normalization did; `null` when no target was requested. */
    loudness: LoudnessStats | null;
    /** Declared optional resources that stayed empty. */
    optionalMissing: string[];
}

/** Report of one loudness normalization pass. */
export interface LoudnessStats {
    /** Requested integrated loudness in LUFS. */
    target_lufs: number;
    /** Loudness measured before any gain. */
    measured_lufs: number;
    /** Loudness measured after the gain was applied. */
    achieved_lufs: number;
    /** Gain that was applied, in dB. */
    gain_db: number;
}

/** Report of one delivery limiter pass. */
export interface LimiterStats {
    /** Deepest gain reduction applied, in dB (negative or zero). */
    max_reduction_db: number;
    /** Peak of the limited output, in dBFS. */
    output_peak_db: number;
    /** Samples that pulled the gain down. */
    limited: number;
}

/** Peak, RMS and clipping facts for one mixed audio bed. */
export interface AudioLevel {
    /** Peak level in dBFS. */
    peakDbfs: number;
    /** RMS level in dBFS. */
    rmsDbfs: number;
    /** Samples at or beyond full scale. */
    clipped: number;
    /** Measured interleaved samples. */
    samples: number;
}

/** One project scene mapped into frames. */
export interface SceneSpan {
    /** Declared scene id, or `scene-{index}` when the scene was not named. */
    id: string;
    /** Half-open project frame range of the scene. */
    range: [number, number];
    /** Whether this scene intersects the frame range that was written. */
    rendered: boolean;
}

/** One external file a render loaded, fingerprinted from its bytes. */
export interface AssetFingerprint {
    /** How the project uses the file: `image`, `video`, `audio` or `narration`. */
    kind: string;
    /** The path as declared in the project. */
    path: string;
    /** Byte length of the loaded file. */
    bytes: number;
    /** FNV-1a hash of the loaded bytes. */
    hash: string;
}

export interface RenderOptions {
    /** First project frame to write; frames are renumbered from zero. */
    startFrame?: number;
    /** Exclusive end frame. Required when `startFrame` is set. */
    endFrame?: number;
    /** Path polled between frames: creating it cancels the run. */
    cancelFile?: string;
    /** Required audio codec. A machine that cannot provide it fails instead
     *  of substituting another codec. */
    audioCodec?: 'aac' | 'flac';
    /** Peak ceiling in dBFS applied to the mixed bed before encoding. */
    limiterCeilingDb?: number;
    /** Integrated loudness target in LUFS for the mixed bed. */
    loudnessTargetLufs?: number;
}

export interface BuildInfo {
    version: string;
    sourceRev: string;
    dirty: boolean;
    profile: string;
}

/** Options for a review-range preview: half-open frames, optional smaller raster. */
export interface PreviewRangeOptions {
    /** First project frame of the interval. */
    startFrame: number;
    /** Exclusive end frame. */
    endFrame: number;
    /** Raster scale in `0.1..=1.0`; timing and scenes stay unchanged. */
    scale?: number;
    /** Project-local cache root; repeats of the same inputs reuse the MP4. */
    cacheDir?: string;
}

/** What the GUI host shows on mount. Owned by the Node side, opaque to native. */
export interface GuiOpenOptions {
    /** Staged VMZ static directory mapped to `https://app.local/`. */
    contentDir: string;
    /** Project-local cache root for interval previews. */
    cacheDir?: string;
    /** Window title. */
    title?: string;
    /** Compiled project JSON used for preview renders. */
    project: string;
    /** Session snapshot JSON the page reads on mount. */
    session: string;
}

export interface PreviewResult {
    frame: number;
    width: number;
    height: number;
    /** Font files the preview loaded, in role order. */
    fonts: string[];
    projectHash: string;
}

/** Entity counts in a production book, as the core sees them. */
export interface ProductionCounts {
    shots: number;
    /** Panels summed across every shot. */
    panels: number;
    cues: number;
    assets: number;
    tasks: number;
    delivery: number;
}

/**
 * Result of validating a production book.
 *
 * `problems` is empty exactly when `ok` is true. Each entry names the handle
 * the author wrote, so a review page can point at the broken shot or cue
 * rather than showing one joined message.
 */
export interface ProductionReport {
    ok: boolean;
    problems: string[];
    counts: ProductionCounts;
}

/**
 * Which tasks still have to run.
 *
 * `run` lists tasks whose latest attempt does not match the declared input and
 * config fingerprints, in declaration order. `fresh` lists tasks whose latest
 * attempt is a current success. `problems` is the same list validation
 * reports, so a host can refuse to start a plan on a broken book.
 */
export interface TaskPlan {
    run: string[];
    fresh: string[];
    problems: string[];
}

/** Digest of one file, computed with the function render reports quote. */
export interface AssetDigest {
    digest: string;
    bytes: number;
}

/** One panel placed on a storyboard page. */
export interface StoryboardCell {
    shot: string;
    panel: string;
    /** Absolute project frames drawn for this panel. */
    frames: number[];
    dialogue: string | null;
}

/** One written storyboard page or contact sheet. */
export interface StoryboardPage {
    index: number;
    path: string;
    cells: StoryboardCell[];
}

/** Page geometry for storyboard output. */
export interface StoryboardOptions {
    width?: number;
    height?: number;
    /** Panel rows per page; each row is one panel. */
    rows?: number;
    /** Contact-sheet columns. */
    columns?: number;
    margin?: number;
    gap?: number;
    titleSize?: number;
    labelSize?: number;
}

/** One cover shortlist entry. */
export interface CoverCandidate {
    /** Project frame the candidate was taken from. */
    frame: number;
    /** Written PNG path. */
    path: string;
    /** Shortlist score: mean luminance plus contrast, not an aesthetic rank. */
    score: number;
}

/** Subtitle export formats. */
export type SubtitleFormat = 'srt' | 'vtt';

/** Line-breaking and reading-speed limits for subtitle export. */
export interface SubtitleStyle {
    maxChars?: number;
    maxLines?: number;
    minFrames?: number;
    maxCps?: number;
}

/** One exported subtitle file body. */
export interface SubtitleExport {
    format: SubtitleFormat;
    /** File contents, ready to write. */
    text: string;
    /** Number of cues the book declared. */
    cues: number;
}

/** What a cue edit affects, before it is applied. */
export interface CueRevision {
    cue: string;
    /** Absolute project frame range after the edit. */
    range: [number, number];
    /** Shots overlapping the cue. */
    shots: string[];
    /** Storyboard panels overlapping the cue. */
    panels: string[];
    /** Reading-speed problem, when the text is too fast for the range. */
    reading: string | null;
    /** New lines, or the reason they do not fit. */
    lines: { ok: true; lines: string[] } | { ok: false; error: string };
}

/** One sampled frame read back from a delivered file. */
export interface SampleReport {
    index: number;
    seconds: number;
    /** Mean luminance in `0..=1`. */
    mean_luma: number;
    /** Absolute luminance change from the previous sample; `0` for the first. */
    jump: number;
    /** Whether the bytes are identical to the previous sample. */
    frozen: boolean;
}

/** Audio facts measured from the delivered file. */
export interface DeliveryAudio {
    sample_rate: number;
    frames: number;
    seconds: number;
    peak_db: number;
    rms_db: number;
    clipped: number;
    /** Gated integrated loudness in LUFS. */
    integrated_lufs: number;
    /** Interpolated true peak in dBFS. */
    true_peak_db: number;
}

/** What the decoder sees when a delivered file is reopened. */
export interface DeliveryReport {
    path: string;
    width: number;
    height: number;
    samples: SampleReport[];
    audio: DeliveryAudio | null;
    /** Duration the samples covered; `null` when a video-only file has no known duration. */
    span_seconds: number | null;
    /** Advisory findings; empty means nothing looked wrong. */
    suspects: string[];
}

/** One asset as found relative to the archive root. */
export interface AssetCheck {
    id: string;
    path: string;
    /** Digest recorded in the production. */
    digest: string;
    /** Digest read from disk; `null` when the file is absent. */
    found: string | null;
}

/** Outcome of checking a production against a directory tree. */
export interface ArchiveReport {
    root: string;
    ok: AssetCheck[];
    /** Assets whose file is absent. */
    missing: AssetCheck[];
    /** Assets whose file no longer matches the recorded digest. */
    mismatched: AssetCheck[];
}

/** What covers one absolute project frame. */
export interface FrameLookup {
    frame: number;
    shots: string[];
    panels: string[];
    cues: string[];
}

export interface NativeBinding {
    version(): string;
    build(): BuildInfo;
    renderProject(options: { project: string; out: string } & RenderOptions): RenderResult;
    previewRange(options: { project: string; out: string } & PreviewRangeOptions): RenderResult;
    openGui(options: GuiOpenOptions): { opened: boolean; reason?: string; title?: string };
    pumpEvents(): boolean;
    closeGui(): void;
    isGuiOpen(): boolean;
    previewFrame(options: { project: string; frame: number; out: string }): PreviewResult;
    validateProduction(options: { production: string }): ProductionReport;
    planTasks(options: { production: string }): TaskPlan;
    assetDigest(options: { path: string }): AssetDigest;
    writeStoryboard(options: { project: string; production: string; out: string; only?: string } & StoryboardOptions): { pages: StoryboardPage[] };
    writeComparison(options: { before: string; project: string; production: string; out: string; only?: string } & StoryboardOptions): { path: string; panels: string[]; frames: number[] };
    writeChapters(options: { project: string; production: string; out: string } & StoryboardOptions): StoryboardPage;
    writeSeams(options: { project: string; production: string; out: string } & StoryboardOptions): { path: string; cuts: number };
    writeSceneOverview(options: { project: string; production: string; out: string } & StoryboardOptions): { path: string; scenes: number };
    lookupFrame(options: { production: string; frame: number }): FrameLookup;
    writeContactSheet(options: { project: string; production: string; out: string } & StoryboardOptions): StoryboardPage;
    writeTimeline(options: { project: string; production: string; out: string } & StoryboardOptions): StoryboardPage;
    writeMotionPreview(options: { project: string; production: string; out: string; scale?: number }): RenderResult;
    writeCoverCandidates(options: { project: string; production: string; out: string; count?: number }): { candidates: CoverCandidate[] };
    exportSubtitles(options: { project: string; production: string; format: SubtitleFormat } & SubtitleStyle): SubtitleExport;
    reviseCue(options: { project: string; production: string; cue: string; text: string } & SubtitleStyle): CueRevision;
    inspectDelivery(options: {
        path: string;
        probes?: number;
        expectedSeconds?: number;
        toleranceSeconds?: number;
        expectedWidth?: number;
        expectedHeight?: number;
    }): DeliveryReport;
    checkArchive(options: { root: string; production: string }): ArchiveReport;
    renderWithSubtitles(options: { project: string; production: string; out: string } & SubtitleStyle): RenderResult;
}

const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const PLATFORM_PACKAGE = `@wae/open-cut-${PLATFORM_KEY}`;

/**
 * Specifiers to try: optional env override, the platform package (via
 * `package.json#main`), then the sibling checkout package directory.
 */
export function nativeCandidates(): string[] {
    const override = process.env.OPEN_CUT_NATIVE;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const localPackage = path.resolve(here, '..', '..', `open-cut-${PLATFORM_KEY}`);
    const packages = [PLATFORM_PACKAGE, localPackage];
    return override ? [override, ...packages] : packages;
}

function load(): NativeBinding {
    const errors: string[] = [];
    for (const candidate of nativeCandidates()) {
        try {
            return require(candidate) as NativeBinding;
        }
        catch (error) {
            errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(
        `OpenCut native binding is not available for ${os.platform()}-${os.arch()}.\n` +
            `Set OPEN_CUT_NATIVE to a built .node file, or install ${PLATFORM_PACKAGE}.\n` +
            `Tried:\n${errors.map((line) => `  - ${line}`).join('\n')}`,
    );
}

export const native = load();
