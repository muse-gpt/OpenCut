# @wae/open-cut-darwin-arm64

Prebuilt native artifact for macOS arm64. **Not a public import target.**

Pulled automatically when installing `@wae/open-cut` on matching hosts. MP4
encoding and media import run through Windows Media Foundation, so `render`
and films with imported clips report `unsupported` here; the review tools that
need no host codec (validate, plan, frame lookup, subtitle export and revision,
plus preview and storyboard pages for films without imported media) run here.
