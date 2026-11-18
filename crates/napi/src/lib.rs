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

/// Render a project JSON string into an MP4 file.
///
/// Argument: `{ project, out, startFrame?, endFrame?, cancelFile? }`. Returns
/// render statistics. `startFrame`/`endFrame` select a half-open frame range
/// that is renumbered from zero. `cancelFile` is a path polled between frames:
/// creating that file stops the run with a `cancelled` error and publishes
/// nothing, leaving any previous output intact. Rendering is synchronous on
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
    let options = RenderOptions { range, cancel: Some(&cancel), ..Default::default() };
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
    revise_cue
];
