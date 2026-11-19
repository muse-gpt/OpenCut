import path from 'node:path';

export type Target = {
    platform: string;
    arch: string;
    triple: string;
    cdylib: string;
};

/**
 * Host ↔ platform-package map for OpenCut native sidecars.
 *
 * Every build / stage / release-path lookup must go through this module so the
 * supported matrix stays in one place. Unsupported hosts fail here instead of
 * producing a package that cannot load. MP4 encoding still requires the host
 * Media Foundation encoder (see `media.codec` upstream); the other native
 * entry points run wherever the addon loads.
 */
export const TARGETS: Record<string, Target> = {
    'x86_64-pc-windows-msvc': { platform: 'win32', arch: 'x64', triple: 'x86_64-pc-windows-msvc', cdylib: 'opencut_napi.dll' },
    'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64', triple: 'x86_64-unknown-linux-gnu', cdylib: 'libopencut_napi.so' },
    'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64', triple: 'aarch64-unknown-linux-gnu', cdylib: 'libopencut_napi.so' },
    'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64', triple: 'x86_64-apple-darwin', cdylib: 'libopencut_napi.dylib' },
    'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64', triple: 'aarch64-apple-darwin', cdylib: 'libopencut_napi.dylib' },
};

const HOST_TO_TRIPLE: Record<string, string> = {
    'win32-x64': 'x86_64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
};

function hostTriple(): string {
    const host = `${process.platform}-${process.arch}`;
    const triple = HOST_TO_TRIPLE[host];
    if (!triple) {
        throw new Error(`Unsupported host ${host}. Supported: ${Object.keys(HOST_TO_TRIPLE).join(', ')}`);
    }
    return triple;
}

/** `OPEN_CUT_TARGET` selects an explicit Rust target triple. */
export function resolveTarget(): Target {
    const triple = process.env.OPEN_CUT_TARGET || hostTriple();
    const target = TARGETS[triple];
    if (!target) {
        throw new Error(`Unsupported Rust target ${triple}. Supported targets: ${Object.keys(TARGETS).join(', ')}`);
    }
    return target;
}

export function usesExplicitTarget(): boolean {
    return Boolean(process.env.OPEN_CUT_TARGET);
}

export function shortName(target: Target): string {
    return `${target.platform}-${target.arch}`;
}

export function packageName(target: Target): string {
    return `open-cut-${shortName(target)}`;
}

export function packageDir(root: string, target: Target): string {
    return path.join(root, 'projects', 'packages', packageName(target));
}

export function nodeFileName(target: Target): string {
    return `open-cut.${shortName(target)}.node`;
}

export function cdylibName(target: Target): string {
    return target.cdylib;
}

export function releaseDir(root: string, target: Target): string {
    return usesExplicitTarget() ? path.join(root, 'target', target.triple, 'release') : path.join(root, 'target', 'release');
}
