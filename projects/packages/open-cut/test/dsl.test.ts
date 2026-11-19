/**
 * Regression cases for the two authoring mistakes the DSL used to allow:
 * a keyframe track authored on the item's own clock silently landed at the
 * scene start, and a screen-space annotation hidden inside a layer fell back
 * to the world buffer where a push-in scales and crops it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Film, layer, text } from '../dist/index.js';

const pan = { x: [{ at: 0, value: 0.1 }, { at: 1, value: 0.9 }] };

test('local keys are offset by the node start, so a pan needs no manual compensation', () => {
    const film = new Film({ width: 320, height: 180, fps: 30 });
    film.scene({
        id: 'a',
        duration: 4,
        items: [text({ id: 'pan', at: 2, dur: 2, content: 'pan', anim: { timeBase: 'local', ...pan } })],
    });
    const item = film.toProject().scenes[0].items?.[0];
    assert.deepEqual(item?.anim?.x?.keys.map((key) => key.at), [60, 90]);
});

test('keys without a time base stay on the scene clock', () => {
    const film = new Film({ width: 320, height: 180, fps: 30 });
    film.scene({
        id: 'a',
        duration: 4,
        items: [text({ id: 'pan', at: 2, dur: 2, content: 'pan', anim: pan })],
    });
    const item = film.toProject().scenes[0].items?.[0];
    assert.deepEqual(item?.anim?.x?.keys.map((key) => key.at), [0, 30]);
});

test('a screen annotation nested in a layer is rejected instead of silently cropping', () => {
    const film = new Film({ width: 320, height: 180, fps: 30 });
    film.scene({
        id: 'a',
        duration: 2,
        items: [layer({ items: [text({ content: 'fixed', space: 'screen' })] })],
    });
    assert.throws(() => film.toProject(), /screen space only applies to top-level scene nodes/);
});

test('witness ids survive compilation into the production book', () => {
    const film = new Film({ width: 320, height: 180, fps: 30 });
    film.scene({ id: 'a', duration: 2, items: [text({ id: 'evidence', content: 'evidence' })] });
    film.production({
        shots: [{
            id: 's1',
            scene: 'a',
            panels: [{ id: 'p1', range: [0, 60], purpose: 'see the mechanism', composition: 'wide', witness: ['evidence'] }],
        }],
    });
    const book = film.toProduction() as { shots: Array<{ panels: Array<{ witness?: string[] }> }> };
    assert.deepEqual(book.shots[0].panels[0].witness, ['evidence']);
});
