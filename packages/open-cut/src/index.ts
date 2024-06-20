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
    TextOptions,
} from './dsl.js';
export type {
    AssetFingerprint,
    AudioLevel,
    BuildInfo,
    PreviewResult,
    ProductionCounts,
    ProductionReport,
    RenderOptions,
    RenderResult,
    SceneSpan,
} from './native.js';
export { native } from './native.js';
export type { RenderCheck } from './verify.js';
export { verifyRender } from './verify.js';
export type * from './types.js';

import { native } from './native.js';
import type { BuildInfo } from './native.js';

/** Native library version reported by the Rust core binding. */
export function nativeVersion(): string {
    return native.version();
}

/** Source revision and profile this native binary was built from. */
export function nativeBuild(): BuildInfo {
    return native.build();
}
