//! Node-API capability surface for OpenCut.
//!
//! The N-API module is the only implementation path used by the CLI and the
//! TypeScript authoring surface. It moves scene data between JavaScript and
//! the render core and contains no platform `cfg` branches.

#![deny(missing_docs)]

use media::render::{FrameRange, RenderOptions, RenderStats};
use serde_json::json;
use wae::{CallContext, Env, Error, JsValue, Result, function, register_module};

/// Library version used by `@wae/open-cut` to verify the native binary.
#[function]
fn version(ctx: CallContext) -> Result<JsValue> {
    ctx.env().string(env!("CARGO_PKG_VERSION"))
}

/// Build provenance of this binary: crate version and source revision.
///
/// `sourceRev` is the commit the addon was compiled from (`unknown` when the
/// build ran outside a checkout) and `dirty` says whether that tree had
/// uncommitted changes. The upstream `media` revision is pinned in
/// `Cargo.lock`, not guessed here.
#[function]
fn build(ctx: CallContext) -> Result<JsValue> {
    json_to_js(
        ctx.env(),
        &json!({
            "version": env!("CARGO_PKG_VERSION"),
            "sourceRev": env!("OPEN_CUT_SOURCE_REV"),
            "dirty": env!("OPEN_CUT_SOURCE_DIRTY") == "true",
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        }),
    )
}

/// GPU compositor facts (ADR 0005): adapter availability, the preference
/// `MEDIA_COMPOSITOR` resolves to and the adapter identity.
#[function(js_name = "gpuStatus")]
fn gpu_status(ctx: CallContext) -> Result<JsValue> {
    let info = media::gpu::probe_gpu();
    json_to_js(
        ctx.env(),
        &json!({
            "status": match info.status {
                media::gpu::GpuStatus::Available => "available",
                media::gpu::GpuStatus::Unavailable => "unavailable",
                media::gpu::GpuStatus::Disabled => "disabled",
            },
            "preferred": match info.preferred {
                media::gpu::CompositorKind::Gpu => "gpu",
                media::gpu::CompositorKind::Cpu => "cpu",
            },
            "adapterName": info.adapter_name,
            "backend": info.backend,
            "deviceType": info.device_type,
            "message": info.message,
        }),
    )
}

/// Render a project JSON string into an MP4 file.
///
/// Argument: `{ project, out, startFrame?, endFrame?, cancelFile?, audioCodec? }`.
/// Returns render statistics. `startFrame`/`endFrame` select a half-open frame
/// range that is renumbered from zero. `cancelFile` is a path polled between
/// frames: creating that file stops the run with a `cancelled` error and
/// publishes nothing, leaving any previous output intact. `audioCodec` names a
/// required codec (`aac`, `flac`): when the machine cannot provide it the run
/// fails instead of delivering a different one. Rendering is synchronous on
/// the calling thread, so cancellation is driven from outside this process.
#[function(js_name = "renderProject")]
fn render_project(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("renderProject requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let out = arg.get_named("out")?.as_string()?;
    let path = std::path::Path::new(&out);
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::new(format!("cannot create output directory: {e}")))?;
    }
    let range = match (optional_u32(arg, "startFrame")?, optional_u32(arg, "endFrame")?) {
        (None, None) => None,
        (start, end) => {
            let start = start.unwrap_or(0);
            let end = end.ok_or_else(|| Error::new("endFrame is required when startFrame is set"))?;
            Some(FrameRange { start, end })
        }
    };
    let cancel_file = optional_string(arg, "cancelFile")?;
    let cancel = || {
        cancel_file
            .as_ref()
            .is_some_and(|path| std::path::Path::new(path).exists())
    };
    let audio_codec = optional_string(arg, "audioCodec")?;
    if let Some(codec) = audio_codec.as_deref() {
        if codec != "aac" && codec != "flac" {
            return Err(Error::new(format!("invalid_input: audioCodec `{codec}` is not `aac` or `flac`")));
        }
    }
    let limiter_ceiling_db = optional_f32(arg, "limiterCeilingDb")?;
    let loudness_target_lufs = optional_f32(arg, "loudnessTargetLufs")?;
    let compositor = optional_string(arg, "compositor")?;
    let options = RenderOptions {
        range,
        cancel: Some(&cancel),
        audio_codec: audio_codec.as_deref(),
        limiter_ceiling_db,
        loudness_target_lufs,
        compositor: compositor.as_deref(),
        ..Default::default()
    };
    let stats = media::render::render_project_with(&project, path, &options, &mut |done, total| {
        if done == total || done % 30 == 0 {
            println!("opencut: frame {done}/{total}");
        }
    })
    .map_err(core_error)?;
    json_to_js(ctx.env(), &to_json(&stats))
}

/// Render one project frame into a PNG.
///
/// Argument: `{ project, frame, out }`. This is the preview path: it runs the
/// same contract checks and painter as `renderProject`, so a reviewed frame is
/// the frame an export receives. Audio is not synthesized for a preview.
#[function(js_name = "previewFrame")]
fn preview_frame(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("previewFrame requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let out = arg.get_named("out")?.as_string()?;
    let frame = optional_u32(arg, "frame")?.ok_or_else(|| Error::new("previewFrame requires a frame index"))?;
    let stats = media::render::preview_frame(&project, frame, std::path::Path::new(&out)).map_err(core_error)?;
    json_to_js(
        ctx.env(),
        &json!({
            "frame": stats.frame,
            "width": stats.width,
            "height": stats.height,
            "fonts": stats.fonts,
            "projectHash": stats.project_hash,
        }),
    )
}

/// Validate a production book and report every problem at once.
///
/// Argument: `{ production }`, the JSON of a `media.scene::Production`: the
/// render project plus shots, panels, cues, assets, tasks and delivery
/// targets. Returns `{ ok, problems, counts }`. Problems are referenced by the
/// handle the author wrote, so a review page can point at the broken shot or
/// cue instead of a joined message. Parsing failures are reported as
/// `invalid_input`; a structurally valid book with broken references returns
/// `ok: false` and the list.
#[function(js_name = "validateProduction")]
fn validate_production(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("validateProduction requires an options object"))?;
    let raw = arg.get_named("production")?.as_string()?;
    let production: media::scene::Production =
        serde_json::from_str(&raw).map_err(|error| Error::new(format!("invalid_input: {error}")))?;
    let problems = production.problems();
    let panels: usize = production.shots.iter().map(|shot| shot.panels.len()).sum();
    json_to_js(
        ctx.env(),
        &json!({
            "ok": problems.is_empty(),
            "problems": problems,
            "counts": {
                "shots": production.shots.len(),
                "panels": panels,
                "cues": production.cues.len(),
                "assets": production.assets.len(),
                "tasks": production.tasks.len(),
                "delivery": production.delivery.len(),
            },
        }),
    )
}

/// Plan which tasks still have to run.
///
/// Argument: `{ production }`. Returns `{ run, fresh, problems }`: `run` lists
/// tasks whose latest attempt does not match the declared fingerprints, in
/// declaration order, and `fresh` lists tasks whose latest attempt is a
/// current success. `problems` is the same list `validateProduction` returns,
/// so a host can refuse to start a plan on a broken book.
#[function(js_name = "planTasks")]
fn plan_tasks(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("planTasks requires an options object"))?;
    let raw = arg.get_named("production")?.as_string()?;
    let production: media::scene::Production =
        serde_json::from_str(&raw).map_err(|error| Error::new(format!("invalid_input: {error}")))?;
    let run: Vec<&str> = production.pending_tasks().iter().map(|task| task.id.as_str()).collect();
    let fresh: Vec<&str> = production.fresh_tasks().iter().map(|task| task.id.as_str()).collect();
    json_to_js(
        ctx.env(),
        &json!({ "run": run, "fresh": fresh, "problems": production.problems() }),
    )
}

/// Digest a file's bytes with the same function render reports quote.
///
/// Argument: `{ path }`. Returns `{ digest, bytes }`. A production asset's
/// `digest` can be filled from this call and later compared against the render
/// report without translating between hashes.
#[function(js_name = "assetDigest")]
fn asset_digest(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("assetDigest requires an options object"))?;
    let path = arg.get_named("path")?.as_string()?;
    let bytes = std::fs::read(&path).map_err(|error| Error::new(format!("io: {path}: {error}")))?;
    json_to_js(ctx.env(), &json!({ "digest": media::types::digest(&bytes), "bytes": bytes.len() }))
}

/// Write storyboard pages from a project and its production book.
///
/// Argument: `{ project, production, out, width?, height?, rows?, margin?,
/// gap?, titleSize?, labelSize? }`. `out` is a directory; one page per
/// `rows` panels is written. Returns `{ pages: [{ index, path, cells }] }`,
/// where each cell names the shot, the panel, the three key frames drawn and
/// the dialogue line. A production that fails validation writes nothing.
#[function(js_name = "writeStoryboard")]
fn write_storyboard(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeStoryboard requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    // `only` is a comma-separated list of panel handles: a revision re-renders
    // just those pages, and each page keeps the number the full book gives it.
    let only: Vec<String> = optional_string(arg, "only")?
        .map(|list| list.split(',').map(|panel| panel.trim().to_owned()).filter(|panel| !panel.is_empty()).collect())
        .unwrap_or_default();
    let pages = media::render::write_storyboard_selected(&project, &production, std::path::Path::new(&out), &options, &only).map_err(core_error)?;
    let pages: Vec<serde_json::Value> = pages
        .iter()
        .map(|page| {
            json!({
                "index": page.index,
                "path": page.path,
                "cells": page.cells.iter().map(cell_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    json_to_js(ctx.env(), &json!({ "pages": pages }))
}

/// Write one contact sheet: the middle frame of every panel in a grid.
///
/// Argument: `{ project, production, out, width?, height?, columns?, rows?,
/// margin?, gap?, titleSize?, labelSize? }`. `out` is the PNG path.
#[function(js_name = "writeContactSheet")]
fn write_contact_sheet(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeContactSheet requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    let sheet = media::render::write_contact_sheet(&project, &production, std::path::Path::new(&out), &options).map_err(core_error)?;
    json_to_js(
        ctx.env(),
        &json!({
            "index": sheet.index,
            "path": sheet.path,
            "cells": sheet.cells.iter().map(cell_json).collect::<Vec<_>>(),
        }),
    )
}

/// Reopen a delivered file and report what the decoder actually sees.
///
/// Argument: `{ path, probes?, expectedSeconds?, toleranceSeconds? }`. Returns
/// frame size, sampled-frame luminance, frozen neighbours, audio peak/RMS/
/// clipping and a suspect list. When `expectedSeconds` is given, the measured
/// duration is compared with it and a mismatch becomes a suspect naming both
/// values. Frames are sampled, not counted; a file that does not decode is an
/// error.
#[function(js_name = "inspectDelivery")]
fn inspect_delivery(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("inspectDelivery requires an options object"))?;
    let path = arg.get_named("path")?.as_string()?;
    let probes = optional_u32(arg, "probes")?.unwrap_or(8).max(2) as usize;
    let mut report = media::render::inspect_delivery(std::path::Path::new(&path), probes, media::types::SAMPLE_RATE).map_err(core_error)?;
    if let Some(expected) = optional_f32(arg, "expectedSeconds")? {
        let tolerance = optional_f32(arg, "toleranceSeconds")?.unwrap_or(0.5);
        if let Some(suspect) = report.duration_suspect(expected as f64, tolerance as f64) {
            report.suspects.push(suspect);
        }
    }
    let expected_width = optional_u32(arg, "expectedWidth")?;
    let expected_height = optional_u32(arg, "expectedHeight")?;
    if expected_width.is_some() || expected_height.is_some() {
        let (width, height) = (expected_width.unwrap_or(report.width), expected_height.unwrap_or(report.height));
        if (width, height) != (report.width, report.height) {
            report.suspects.push(format!(
                "delivered {}x{} but the render declared {}x{}",
                report.width, report.height, width, height
            ));
        }
    }
    let value = serde_json::to_value(&report).map_err(|error| Error::new(format!("encode report: {error}")))?;
    json_to_js(ctx.env(), &value)
}

/// Re-read a production's asset closure against a directory tree.
///
/// Argument: `{ root, project, production }`. Every asset is read from disk and
/// compared with its recorded digest. Missing and changed files are reported
/// separately, so an archive is never built over a hole.
#[function(js_name = "checkArchive")]
fn check_archive(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("checkArchive requires an options object"))?;
    let root = arg.get_named("root")?.as_string()?;
    let production = parse_production(arg)?;
    let report = media::render::check_archive(std::path::Path::new(&root), &production).map_err(core_error)?;
    let value = serde_json::to_value(&report).map_err(|error| Error::new(format!("encode report: {error}")))?;
    json_to_js(ctx.env(), &value)
}

/// Look up which shots, panels and cues cover one absolute frame.
///
/// Argument: `{ production, frame }`. Returns `{ frame, shots, panels, cues }`. This is the review-page reverse lookup: point at a frame
/// and get the handles to edit, instead of scanning the whole book.
#[function(js_name = "lookupFrame")]
fn lookup_frame(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("lookupFrame requires an options object"))?;
    let production = parse_production(arg)?;
    let frame = optional_u32(arg, "frame")?.ok_or_else(|| Error::new("lookupFrame requires a frame index"))?;
    let value = serde_json::to_value(production.at_frame(frame)).map_err(|error| Error::new(format!("encode lookup: {error}")))?;
    json_to_js(ctx.env(), &value)
}

/// Write a seam page: each cut as the last and first drawn frames side by side.
///
/// Argument: `{ project, production, out, ...layout }`.
#[function(js_name = "writeSeams")]
fn write_seams(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeSeams requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    let page = media::render::write_seams(&project, &production, std::path::Path::new(&out), &options).map_err(core_error)?;
    json_to_js(ctx.env(), &json!({ "path": page.path, "cuts": page.cells.len() }))
}

/// Write a scene overview: one establishing frame per scene with its span and
/// the shots that use it.
///
/// Argument: `{ project, production, out, ...layout }`.
#[function(js_name = "writeSceneOverview")]
fn write_scene_overview(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeSceneOverview requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    let page = media::render::write_scene_overview(&project, &production, std::path::Path::new(&out), &options).map_err(core_error)?;
    json_to_js(ctx.env(), &json!({ "path": page.path, "scenes": page.cells.len() }))
}

/// Render the film with its subtitle cues burned into the picture.
///
/// Argument: `{ project, production, out, maxChars?, maxLines?, minFrames?,
/// maxCps? }`. Cues are resolved from shot-local to project frames once and
/// wrapped by the same subtitle owner the exporter uses, so the burned words
/// and the exported SRT/VTT cannot drift apart. A cue that is too fast to read
/// fails before any frame is written.
#[function(js_name = "renderWithSubtitles")]
fn render_with_subtitles(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("renderWithSubtitles requires an options object"))?;
    let project_json = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let parsed_project: media::scene::Project =
        serde_json::from_str(&project_json).map_err(|error| Error::new(format!("invalid_input: {error}")))?;
    let mut style = media::scene::SubtitleStyle::default();
    if let Some(value) = optional_u32(arg, "maxChars")? {
        style.max_chars = value as usize;
    }
    if let Some(value) = optional_u32(arg, "maxLines")? {
        style.max_lines = value as usize;
    }
    if let Some(value) = optional_u32(arg, "minFrames")? {
        style.min_frames = value;
    }
    if let Some(value) = optional_f32(arg, "maxCps")? {
        style.max_cps = value;
    }
    let cues = media::scene::absolute_cues(&parsed_project, &production, &style).map_err(core_error)?;
    media::scene::check_reading(&cues, &style, parsed_project.time_base()).map_err(core_error)?;
    let audio_codec = optional_string(arg, "audioCodec")?;
    if let Some(codec) = audio_codec.as_deref() {
        if codec != "aac" && codec != "flac" {
            return Err(Error::new(format!("invalid_input: audioCodec `{codec}` is not `aac` or `flac`")));
        }
    }
    let burned: Vec<media::render::BurnInCue> =
        cues.iter().map(|cue| media::render::BurnInCue { range: [cue.start, cue.end], lines: cue.lines.clone() }).collect();
    let options = media::render::RenderOptions { subtitles: Some(&burned), audio_codec: audio_codec.as_deref(), ..Default::default() };
    let stats = media::render::render_project_with(&project_json, std::path::Path::new(&out), &options, &mut |_, _| {})
        .map_err(core_error)?;
    json_to_js(ctx.env(), &to_json(&stats))
}

/// Write a before/after page for the selected panels.
///
/// Argument: `{ before, project, production, out, only?, ...layout }`. Both
/// revisions are rendered with the same painter, so the difference is the edit
/// and not an encode artifact.
#[function(js_name = "writeComparison")]
fn write_comparison(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeComparison requires an options object"))?;
    let before = arg.get_named("before")?.as_string()?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    let only = panel_filter(arg)?;
    let page = media::render::write_comparison(&before, &project, &production, std::path::Path::new(&out), &only, &options).map_err(core_error)?;
    json_to_js(ctx.env(), &json!({ "path": page.path, "panels": page.panels, "frames": page.frames }))
}

/// Write a chapter overview: one row per shot with its first and last frame.
#[function(js_name = "writeChapters")]
fn write_chapters(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeChapters requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    let page = media::render::write_chapters(&project, &production, std::path::Path::new(&out), &options).map_err(core_error)?;
    json_to_js(
        ctx.env(),
        &json!({
            "index": page.index,
            "path": page.path,
            "cells": page.cells.iter().map(cell_json).collect::<Vec<_>>(),
        }),
    )
}

/// Reads the comma-separated `only` panel filter.
fn panel_filter(arg: JsValue) -> Result<Vec<String>> {
    Ok(optional_string(arg, "only")?
        .map(|list| list.split(',').map(|panel| panel.trim().to_owned()).filter(|panel| !panel.is_empty()).collect())
        .unwrap_or_default())
}

/// Recompute one cue after its text changes, without applying the edit.
///
/// Argument: `{ project, production, cue, text, maxChars?, maxLines?,
/// maxFrames?, maxCps? }`. Returns the new lines or the reason they do not
/// fit, plus the shots and panels the cue overlaps so a host can re-render only
/// those storyboard rows.
#[function(js_name = "reviseCue")]
fn revise_cue(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("reviseCue requires an options object"))?;
    let project_json = arg.get_named("project")?.as_string()?;
    let project: media::scene::Project =
        serde_json::from_str(&project_json).map_err(|error| Error::new(format!("invalid_input: {error}")))?;
    let production = parse_production(arg)?;
    let cue = media::scene::CueId::new(arg.get_named("cue")?.as_string()?).map_err(core_error)?;
    let text = arg.get_named("text")?.as_string()?;
    let mut style = media::scene::SubtitleStyle::default();
    if let Some(value) = optional_u32(arg, "maxChars")? {
        style.max_chars = value as usize;
    }
    if let Some(value) = optional_u32(arg, "maxLines")? {
        style.max_lines = value as usize;
    }
    if let Some(value) = optional_u32(arg, "minFrames")? {
        style.min_frames = value;
    }
    if let Some(value) = optional_f32(arg, "maxCps")? {
        style.max_cps = value;
    }
    let revision = media::scene::revise_cue(&project, &production, &cue, &text, &style).map_err(core_error)?;
    let lines = match &revision.lines {
        Ok(lines) => json!({ "ok": true, "lines": lines }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    json_to_js(
        ctx.env(),
        &json!({
            "cue": revision.cue.as_str(),
            "range": revision.range,
            "shots": revision.shots,
            "panels": revision.panels,
            "reading": revision.reading,
            "lines": lines,
        }),
    )
}

/// Export the production's cues as a subtitle file body.
///
/// Argument: `{ project, production, format, maxChars?, maxLines?, minFrames?,
/// maxCps? }`. `format` is `srt` or `vtt`. Returns `{ format, text, cues }`.
/// Cues are resolved from shot-local to project frames once; a cue that is too
/// fast to read or needs more lines than the style allows fails instead of
/// being retimed or shrunk.
#[function(js_name = "exportSubtitles")]
fn export_subtitles(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("exportSubtitles requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let format = match arg.get_named("format")?.as_string()?.as_str() {
        "srt" => media::scene::SubtitleFormat::Srt,
        "vtt" => media::scene::SubtitleFormat::WebVtt,
        other => return Err(Error::new(format!("invalid_input: unknown subtitle format `{other}`"))),
    };
    let mut style = media::scene::SubtitleStyle::default();
    if let Some(value) = optional_u32(arg, "maxChars")? {
        style.max_chars = value as usize;
    }
    if let Some(value) = optional_u32(arg, "maxLines")? {
        style.max_lines = value as usize;
    }
    if let Some(value) = optional_u32(arg, "minFrames")? {
        style.min_frames = value;
    }
    if let Some(value) = optional_f32(arg, "maxCps")? {
        style.max_cps = value;
    }
    let parsed_project: media::scene::Project =
        serde_json::from_str(&project).map_err(|error| Error::new(format!("invalid_input: {error}")))?;
    let text = media::scene::export(&parsed_project, &production, &style, format).map_err(core_error)?;
    json_to_js(
        ctx.env(),
        &json!({
            "format": match format { media::scene::SubtitleFormat::Srt => "srt", media::scene::SubtitleFormat::WebVtt => "vtt" },
            "text": text,
            "cues": production.cues.len(),
        }),
    )
}

/// Write a timeline overview: one row per shot, panel ticks and a cue strip.
///
/// Argument: `{ project, production, out, width?, height?, margin?, gap?,
/// titleSize?, labelSize? }`. `out` is the PNG path.
#[function(js_name = "writeTimeline")]
fn write_timeline(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeTimeline requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let options = storyboard_options(arg)?;
    let page = media::render::write_timeline(&project, &production, std::path::Path::new(&out), &options).map_err(core_error)?;
    json_to_js(
        ctx.env(),
        &json!({
            "index": page.index,
            "path": page.path,
            "cells": page.cells.iter().map(cell_json).collect::<Vec<_>>(),
        }),
    )
}

/// Write cover candidates from frames the film actually shows.
///
/// Argument: `{ project, production, out, count? }`. `out` is a directory;
/// candidates are written as `cover-01.png`… and returned sorted by the
/// shortlist score, so a human still picks the final cover.
#[function(js_name = "writeCoverCandidates")]
fn write_cover_candidates(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeCoverCandidates requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let count = optional_u32(arg, "count")?.unwrap_or(4).max(1);
    let candidates = media::render::write_cover_candidates(&project, &production, std::path::Path::new(&out), count).map_err(core_error)?;
    let candidates: Vec<serde_json::Value> = candidates
        .iter()
        .map(|candidate| json!({ "frame": candidate.frame, "path": candidate.path, "score": candidate.score }))
        .collect();
    json_to_js(ctx.env(), &json!({ "candidates": candidates }))
}

/// Render a low-detail motion preview of the whole film.
///
/// Argument: `{ project, production, out, scale? }`. `scale` is clamped to
/// `0.1..=1.0`; timing, scenes and audio are unchanged, only the raster gets
/// smaller. Returns the usual render statistics.
#[function(js_name = "writeMotionPreview")]
fn write_motion_preview(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("writeMotionPreview requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let production = parse_production(arg)?;
    let out = arg.get_named("out")?.as_string()?;
    let path = std::path::Path::new(&out);
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| Error::new(format!("cannot create output directory: {error}")))?;
    }
    let scale = optional_f32(arg, "scale")?.unwrap_or(0.5);
    let stats = media::render::write_motion_preview(&project, &production, path, scale, &mut |done, total| {
        if done == total || done % 60 == 0 {
            println!("opencut: motion {done}/{total}");
        }
    })
    .map_err(core_error)?;
    json_to_js(ctx.env(), &to_json(&stats))
}

/// Render a reviewed frame range into an MP4 at a reduced raster.
///
/// Argument: `{ project, out, startFrame, endFrame, scale? }`. The range is
/// half-open and renumbered from zero, matching `renderProject`. `scale` is
/// clamped to `0.1..=1.0` and rounds up to even dimensions, so review output
/// keeps the same timing and scenes but compresses faster than a final export.
#[function(js_name = "previewRange")]
fn preview_range(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("previewRange requires an options object"))?;
    let project = arg.get_named("project")?.as_string()?;
    let out = arg.get_named("out")?.as_string()?;
    let start = optional_u32(arg, "startFrame")?.ok_or_else(|| Error::new("previewRange requires startFrame"))?;
    let end = optional_u32(arg, "endFrame")?.ok_or_else(|| Error::new("previewRange requires endFrame"))?;
    let scale = optional_f32(arg, "scale")?;
    let cache = optional_string(arg, "cacheDir")?.map(std::path::PathBuf::from);
    let path = std::path::Path::new(&out);
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| Error::new(format!("cannot create output directory: {error}")))?;
    }
    let (data, _) = render_range_cached(
        &project,
        path,
        FrameRange { start, end },
        scale,
        cache.as_deref(),
        &mut |done, total| {
            if done == total || done % 30 == 0 {
                println!("opencut: preview {done}/{total}");
            }
        },
    )?;
    json_to_js(ctx.env(), &data)
}

/// FNV-1a builder shared by preview cache keys.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// Stable key for one preview: renderer version, project JSON, range, scale.
fn preview_key(project: &str, range: FrameRange, scale: Option<f32>) -> String {
    let mut hash = Fnv::new();
    hash.write(env!("CARGO_PKG_VERSION").as_bytes());
    hash.write(b"\x1f");
    hash.write(project.as_bytes());
    hash.write(b"\x1f");
    hash.write(&range.start.to_le_bytes());
    hash.write(&range.end.to_le_bytes());
    hash.write(&scale.unwrap_or(1.0).to_le_bytes());
    format!("{:016x}", hash.0)
}

/// Renders an interval, reusing `<cacheDir>/previews` when the inputs repeat.
///
/// The cache stores the MP4 plus its stats sidecar, so a hit returns the same
/// provenance except for `backend`, `out`, `bytes` and `cached`. The preview is
/// always copied to `out` because the WebView can only read inside its content
/// directory, while the cache lives with the project.
fn render_range_cached(
    project: &str,
    out: &std::path::Path,
    range: FrameRange,
    scale: Option<f32>,
    cache: Option<&std::path::Path>,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<(serde_json::Value, bool)> {
    if range.end <= range.start {
        return Err(Error::new("invalid_input: endFrame must be greater than startFrame"));
    }
    let key = preview_key(project, range, scale);
    let Some(cache) = cache else {
        let stats = render_range(project, out, range, scale, progress)?;
        let mut data = to_json(&stats);
        data["cacheKey"] = json!(key);
        data["cached"] = json!(false);
        return Ok((data, false));
    };
    let previews = cache.join("previews");
    std::fs::create_dir_all(&previews).map_err(|error| Error::new(format!("cannot create cache directory: {error}")))?;
    let cached = previews.join(format!("{key}.mp4"));
    let sidecar = previews.join(format!("{key}.json"));
    if let (Ok(text), Ok(metadata)) = (std::fs::read_to_string(&sidecar), std::fs::metadata(&cached)) {
        if metadata.len() > 0 {
            if let Ok(mut data) = serde_json::from_str::<serde_json::Value>(&text) {
                copy_file(&cached, out)?;
                data["out"] = json!(out.to_string_lossy());
                data["bytes"] = json!(metadata.len());
                data["backend"] = json!("cache");
                data["cacheKey"] = json!(key);
                data["cached"] = json!(true);
                return Ok((data, true));
            }
        }
    }
    let stats = render_range(project, &cached, range, scale, progress)?;
    let mut data = to_json(&stats);
    if let Err(error) = std::fs::write(&sidecar, data.to_string()) {
        println!("opencut: cannot write preview cache sidecar: {error}");
    }
    copy_file(&cached, out)?;
    data["out"] = json!(out.to_string_lossy());
    data["cacheKey"] = json!(key);
    data["cached"] = json!(false);
    Ok((data, false))
}

fn copy_file(from: &std::path::Path, to: &std::path::Path) -> Result<()> {
    if from == to {
        return Ok(());
    }
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|error| Error::new(format!("cannot copy preview to {}: {error}", to.display())))
}

/// Shared interval render used by `previewRange` and the GUI host.
fn render_range(
    project: &str,
    out: &std::path::Path,
    range: FrameRange,
    scale: Option<f32>,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<RenderStats> {
    if range.end <= range.start {
        return Err(Error::new("invalid_input: endFrame must be greater than startFrame"));
    }
    let project = scaled_project(project, scale)?;
    let options = RenderOptions {
        range: Some(range),
        ..Default::default()
    };
    media::render::render_project_with(&project, out, &options, progress).map_err(core_error)
}

/// Rewrites a project's raster for review previews without touching timing.
fn scaled_project(project: &str, scale: Option<f32>) -> Result<String> {
    let Some(scale) = scale else {
        return Ok(project.to_owned());
    };
    let scale = scale.clamp(0.1, 1.0);
    let mut value: serde_json::Value = serde_json::from_str(project)
        .map_err(|error| Error::new(format!("invalid_input: project json: {error}")))?;
    let even = |value: f32| {
        let rounded = value.round().max(2.0) as u32;
        if rounded % 2 == 0 { rounded } else { rounded + 1 }
    };
    let width = value.get("width").and_then(|width| width.as_f64()).unwrap_or(1920.0) as f32;
    let height = value.get("height").and_then(|height| height.as_f64()).unwrap_or(1080.0) as f32;
    value["width"] = json!(even(width * scale));
    value["height"] = json!(even(height * scale));
    value["supersample"] = serde_json::Value::Null;
    serde_json::to_string(&value).map_err(|error| Error::new(format!("project json: {error}")))
}

/// Project snapshot kept for the GUI host. The window stays open across IPC
/// calls, so the loaded project and the staged UI directory live here instead
/// of being resent per request.
struct GuiState {
    content_dir: std::path::PathBuf,
    cache_dir: Option<std::path::PathBuf>,
    project: String,
    session: serde_json::Value,
}

static GUI_STATE: std::sync::OnceLock<std::sync::Mutex<Option<GuiState>>> = std::sync::OnceLock::new();

fn gui_state() -> &'static std::sync::Mutex<Option<GuiState>> {
    GUI_STATE.get_or_init(|| std::sync::Mutex::new(None))
}

thread_local! {
    static GUI_HOST: std::cell::RefCell<Option<wae::webview::WebViewHost>> = const { std::cell::RefCell::new(None) };
}

struct GuiIpc;

impl wae::webview::IpcHandler for GuiIpc {
    fn on_ipc(&mut self, message: &str, sink: &wae::webview::IpcSink) -> wae::webview::IpcOutcome {
        use wae::webview::IpcOutcome;
        let request: serde_json::Value = match serde_json::from_str(message) {
            Ok(request) => request,
            Err(error) => return IpcOutcome::ReplyToPage(error_json("ipc_invalid", &error.to_string())),
        };
        let kind = request.get("type").and_then(|kind| kind.as_str()).unwrap_or_default();
        match kind {
            "session" => match gui_state().lock() {
                Ok(state) => match state.as_ref() {
                    Some(state) => IpcOutcome::ReplyToPage(ok_json(&state.session)),
                    None => IpcOutcome::ReplyToPage(error_json("gui_not_ready", "no project is loaded")),
                },
                Err(_) => IpcOutcome::ReplyToPage(error_json("gui_state_poisoned", "project state is unavailable")),
            },
            "preview.range" => IpcOutcome::ReplyToPage(self.preview_range(&request, sink)),
            "close" => IpcOutcome::CloseWindow,
            _ => IpcOutcome::ReplyToPage(error_json(
                "ipc_unknown_type",
                &format!("unknown message type `{kind}`"),
            )),
        }
    }
}

impl GuiIpc {
    fn preview_range(&self, request: &serde_json::Value, sink: &wae::webview::IpcSink) -> String {
        let start = request.get("startFrame").and_then(|value| value.as_u64());
        let end = request.get("endFrame").and_then(|value| value.as_u64());
        let (Some(start), Some(end)) = (start, end) else {
            return error_json("ipc_invalid", "preview.range requires startFrame and endFrame");
        };
        let (start, end) = match (u32::try_from(start), u32::try_from(end)) {
            (Ok(start), Ok(end)) => (start, end),
            _ => return error_json("ipc_invalid", "preview.range frames must fit in u32"),
        };
        let scale = request.get("scale").and_then(|value| value.as_f64()).map(|value| value as f32);
        let (project, content_dir, cache_dir) = match gui_state().lock() {
            Ok(state) => match state.as_ref() {
                Some(state) => (state.project.clone(), state.content_dir.clone(), state.cache_dir.clone()),
                None => return error_json("gui_not_ready", "no project is loaded"),
            },
            Err(_) => return error_json("gui_state_poisoned", "project state is unavailable"),
        };
        let previews = content_dir.join("previews");
        if let Err(error) = std::fs::create_dir_all(&previews) {
            return error_json("preview_io", &format!("cannot create preview directory: {error}"));
        }
        let name = format!("preview-{start}-{end}.mp4");
        let out = previews.join(&name);
        let stats = render_range_cached(
            &project,
            &out,
            FrameRange { start, end },
            scale,
            cache_dir.as_deref(),
            &mut |done, total| {
                if done % 10 == 0 || done == total {
                    let _ = sink.post(&json!({ "type": "progress", "done": done, "total": total }).to_string());
                }
            },
        );
        match stats {
            Ok((data, _)) => {
                let mut data = data;
                let key = data["cacheKey"].as_str().unwrap_or("0").to_owned();
                data["url"] = json!(format!("previews/{name}?k={key}"));
                ok_json(&data)
            }
            Err(error) => error_json("preview_failed", &format!("{error}")),
        }
    }
}

fn ok_json(data: &serde_json::Value) -> String {
    json!({ "ok": true, "data": data }).to_string()
}

fn error_json(code: &str, message: &str) -> String {
    json!({ "ok": false, "error": { "code": code, "message": message } }).to_string()
}

/// Open the review workbench window for an already loaded project.
///
/// Argument: `{ contentDir, title?, project, session }`. `project` and
/// `session` are JSON strings: the project drives preview renders and the
/// session is what the page reads on mount. Opening twice focuses the existing
/// window instead of replacing it.
#[function(js_name = "openGui")]
fn open_gui(ctx: CallContext) -> Result<JsValue> {
    let arg = ctx
        .args()
        .first()
        .copied()
        .ok_or_else(|| Error::new("openGui requires an options object"))?;
    if is_gui_alive() {
        return json_to_js(ctx.env(), &json!({ "opened": false, "reason": "gui_already_open" }));
    }
    let content_dir = arg.get_named("contentDir")?.as_string()?;
    let cache_dir = optional_string(arg, "cacheDir")?.map(std::path::PathBuf::from);
    let project = arg.get_named("project")?.as_string()?;
    let session = arg.get_named("session")?.as_string()?;
    let title = optional_string(arg, "title")?.unwrap_or_else(|| "OpenCut".to_owned());
    let session: serde_json::Value = serde_json::from_str(&session)
        .map_err(|error| Error::new(format!("invalid_input: session json: {error}")))?;
    {
        let mut state = gui_state()
            .lock()
            .map_err(|_| Error::new("gui_state_poisoned: project state is unavailable"))?;
        *state = Some(GuiState {
            content_dir: std::path::PathBuf::from(&content_dir),
            cache_dir,
            project,
            session,
        });
    }
    let mut options = wae::webview::OpenOptions::from_content_dir(&content_dir, &title);
    options.width = 1440;
    options.height = 900;
    let host = wae::webview::open(options, Box::new(GuiIpc))
        .map_err(|error| Error::new(format!("gui_open_failed: {error}")))?;
    GUI_HOST.with(|slot| *slot.borrow_mut() = Some(host));
    json_to_js(ctx.env(), &json!({ "opened": true, "title": title }))
}

/// Pump one batch of GUI events. Returns `false` once the window is gone.
#[function(js_name = "pumpEvents")]
fn pump_events(ctx: CallContext) -> Result<JsValue> {
    let alive = GUI_HOST.with(|slot| match slot.borrow_mut().as_mut() {
        Some(host) => host.pump(),
        None => false,
    });
    ctx.env().boolean(alive)
}

/// Close the GUI window if one is open.
#[function(js_name = "closeGui")]
fn close_gui(ctx: CallContext) -> Result<JsValue> {
    GUI_HOST.with(|slot| {
        if let Some(mut host) = slot.borrow_mut().take() {
            let _ = host.close();
        }
    });
    Ok(ctx.env().null()?)
}

/// Whether a GUI window is currently open.
#[function(js_name = "isGuiOpen")]
fn is_gui_open(ctx: CallContext) -> Result<JsValue> {
    ctx.env().boolean(is_gui_alive())
}

fn is_gui_alive() -> bool {
    GUI_HOST.with(|slot| slot.borrow_mut().as_mut().is_some_and(|host| host.is_alive()))
}

fn parse_production(arg: JsValue) -> Result<media::scene::Production> {
    let raw = arg.get_named("production")?.as_string()?;
    serde_json::from_str(&raw).map_err(|error| Error::new(format!("invalid_input: {error}")))
}

fn cell_json(cell: &media::render::StoryboardCell) -> serde_json::Value {
    json!({
        "shot": cell.shot,
        "panel": cell.panel,
        "frames": cell.frames,
        "dialogue": cell.dialogue,
    })
}

fn storyboard_options(arg: JsValue) -> Result<media::render::StoryboardOptions> {
    let mut options = media::render::StoryboardOptions::default();
    if let Some(width) = optional_u32(arg, "width")? {
        options.width = width;
    }
    if let Some(height) = optional_u32(arg, "height")? {
        options.height = height;
    }
    if let Some(rows) = optional_u32(arg, "rows")? {
        options.rows = rows.max(1);
    }
    if let Some(columns) = optional_u32(arg, "columns")? {
        options.columns = columns.max(1);
    }
    if let Some(value) = optional_f32(arg, "margin")? {
        options.margin = value;
    }
    if let Some(value) = optional_f32(arg, "gap")? {
        options.gap = value;
    }
    if let Some(value) = optional_f32(arg, "titleSize")? {
        options.title_size = value;
    }
    if let Some(value) = optional_f32(arg, "labelSize")? {
        options.label_size = value;
    }
    Ok(options)
}

fn optional_f32(arg: JsValue, name: &str) -> Result<Option<f32>> {
    let value = arg.get_named(name)?;
    if value.is_undefined()? {
        return Ok(None);
    }
    let number = match value.as_f64() {
        Ok(number) => number,
        // `null` is how a caller spells "not set"; any other non-numeric value
        // is a contract violation instead of a silent default.
        Err(_) if value.as_i64().is_err() => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some(number as f32))
}

fn optional_u32(arg: JsValue, name: &str) -> Result<Option<u32>> {
    let value = arg.get_named(name)?;
    if value.is_undefined()? {
        return Ok(None);
    }
    let number = match value.as_i64() {
        Ok(number) => number,
        // `null` is how a caller spells "not set"; any other non-numeric value
        // is a contract violation instead of a silent "whole film".
        Err(_) if value.as_f64().is_err() => return Ok(None),
        Err(error) => return Err(error),
    };
    u32::try_from(number).map(Some).map_err(|_| Error::new(format!("{name} must be a non-negative frame index")))
}

fn optional_string(arg: JsValue, name: &str) -> Result<Option<String>> {
    wae::optional_string_prop(arg, name)
}

fn core_error(error: media::Error) -> Error {
    Error::new(format!("{}: {}", error.code(), error))
}

fn to_json(stats: &RenderStats) -> serde_json::Value {
    json!({
        "frames": stats.frames,
        "width": stats.width,
        "height": stats.height,
        "fps": stats.fps,
        "seconds": stats.seconds,
        "out": stats.out,
        "bytes": stats.bytes,
        "backend": stats.backend,
        "compositor": stats.compositor,
        "audio": stats.audio,
        "range": stats.range,
        "fonts": stats.fonts,
        "fontHashes": stats.font_hashes,
        "projectHash": stats.project_hash,
        "assets": stats.assets,
        "scenes": stats.scenes,
        "audioLevel": stats.audio_level.map(|level| json!({
            "peakDbfs": level.peak_db,
            "rmsDbfs": level.rms_db,
            "clipped": level.clipped,
            "samples": level.samples,
        })),
        "limiter": stats.limiter.map(|limiter| json!({
            "max_reduction_db": limiter.max_reduction_db,
            "output_peak_db": limiter.output_peak_db,
            "limited": limiter.limited,
        })),
        "loudness": stats.loudness.map(|loudness| json!({
            "target_lufs": loudness.target_lufs,
            "measured_lufs": loudness.measured_lufs,
            "achieved_lufs": loudness.achieved_lufs,
            "gain_db": loudness.gain_db,
        })),
        "optionalMissing": stats.optional_missing,
    })
}

fn json_to_js(env: Env, value: &serde_json::Value) -> Result<JsValue> {
    match value {
        serde_json::Value::Null => env.null(),
        serde_json::Value::Bool(inner) => env.boolean(*inner),
        serde_json::Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                env.int64(integer)
            } else {
                env.double(number.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(text) => env.string(text),
        serde_json::Value::Array(items) => {
            let array = env.array_with_length(items.len())?;
            for (index, item) in items.iter().enumerate() {
                array.set_element(index as u32, json_to_js(env, item)?)?;
            }
            Ok(array)
        }
        serde_json::Value::Object(map) => {
            let object = env.object()?;
            for (key, item) in map {
                object.set_named(key, json_to_js(env, item)?)?;
            }
            Ok(object)
        }
    }
}

register_module![
    version,
    build,
    gpu_status,
    render_project,
    preview_frame,
    validate_production,
    plan_tasks,
    asset_digest,
    write_storyboard,
    write_contact_sheet,
    write_timeline,
    write_motion_preview,
    write_cover_candidates,
    export_subtitles,
    revise_cue,
    write_comparison,
    write_chapters,
    write_seams,
    write_scene_overview,
    lookup_frame,
    inspect_delivery,
    check_archive,
    render_with_subtitles,
    preview_range,
    open_gui,
    pump_events,
    close_gui,
    is_gui_open
];
