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

register_module![version, build, render_project, preview_frame, validate_production, plan_tasks, asset_digest];
