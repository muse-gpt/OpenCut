import type { RenderOptions } from './native.js';

export function resolveCompositor(explicit: string | undefined, optionName = 'compositor'): NonNullable<RenderOptions['compositor']> {
    const value = explicit ?? process.env.OPENCUT_COMPOSITOR ?? 'auto';
    if (value === 'auto' || value === 'gpu' || value === 'cpu') {
        return value;
    }
    const source = explicit === undefined ? 'OPENCUT_COMPOSITOR' : optionName;
    throw new Error(
        `${source} must be auto, gpu or cpu, got ${JSON.stringify(value)}. ` +
        'Use gpu to require GPU rendering. Vulkan and Direct3D 12 are backend names; render reports the selected backend.',
    );
}
