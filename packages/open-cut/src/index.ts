/**
 * `@wae/open-cut` — code-first video editing.
 *
 * The public authoring surface is the DSL; the native binding is re-exported
 * for hosts that want the raw IR path.
 */
export { Film, anim, bands, callout, card, chart, code, colorToken, counter, footnote, glow, grain, image, instance, layer, path, progress, shape, text, video } from './dsl.js';
export type {
    AssetInput,
    AssetKind,
    AssetSource,
    CameraInput,
    CalloutOptions,
    CardOptions,
    ChartOptions,
    CodeOptions,
    ComponentInput,
    CounterOptions,
    CueInput,
    CueTiming,
    DeliveryInput,
    FilmOptions,
    FootnoteOptions,
    GlowOptions,
    ItemInput,
    LayerOptions,
    NodeOptions,
    PanelInput,
    PathOptions,
    ProductionInput,
    SceneInput,
    ShapeOptions,
    ShotInput,
    TaskInput,
    TaskRunInput,
    TaskStatus,
    TextOptions,
} from './dsl.js';
export type {
    ArchiveReport,
    AssetCheck,
    AssetDigest,
    AssetFingerprint,
    AudioLevel,
    BuildInfo,
    CoverCandidate,
    CueRevision,
    DeliveryAudio,
    DeliveryReport,
    PreviewResult,
    ProductionCounts,
    ProductionReport,
    RenderOptions,
    RenderResult,
    SceneSpan,
    StoryboardCell,
    StoryboardOptions,
    StoryboardPage,
    SubtitleExport,
    SubtitleFormat,
    SubtitleStyle,
    TaskPlan,
} from './native.js';
export { native } from './native.js';
export type { RenderCheck } from './verify.js';
export { verifyRender } from './verify.js';
export type * from './types.js';

import { native } from './native.js';
import type { ArchiveReport, AssetDigest, BuildInfo, DeliveryReport } from './native.js';

/** Native library version reported by the Rust core binding. */
export function nativeVersion(): string {
    return native.version();
}

/** Source revision and profile this native binary was built from. */
export function nativeBuild(): BuildInfo {
    return native.build();
}

/** Digest of one file, computed with the function render reports quote.
 *
 *  A production asset's `digest` can be filled from this call and compared
 *  with a render report without translating between hashes. */
export function assetDigest(path: string): AssetDigest {
    return native.assetDigest({ path });
}

/**
 * Reopens a delivered file and reports what the decoder actually sees.
 *
 * Frames are sampled at evenly spaced times, so this proves the file decodes
 * there and is not a full frame count. `suspects` is advisory: a dark or held
 * scene is reported, not failed.
 */
export function inspectDelivery(path: string, probes = 8): DeliveryReport {
    return native.inspectDelivery({ path, probes });
}

/**
 * Re-reads every asset of a production under `root` and compares it with the
 * recorded digest.
 *
 * `missing` and `mismatched` are separate so an archive is never built over a
 * hole or a silently replaced file.
 */
export function checkArchive(root: string, production: string | object): ArchiveReport {
    return native.checkArchive({ root, production: typeof production === 'string' ? production : JSON.stringify(production) });
}
