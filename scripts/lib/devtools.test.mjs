// Tests of the input helpers of scripts/lib/devtools.mjs, against a session that records what it
// is sent. npm run test:unit runs them with node --test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clickAt, pressKey } from './devtools.mjs';

/** A session that records the commands sent to it. */
function recorder() {
    const sent = [];
    return { sent, send: async (method, params) => { sent.push({ method, ...params }); return {}; } };
}

test('pressKey sends a key down and up with the modifiers, key, code and key code of the combination', async () => {
    const cases = [
        ['Ctrl+Shift+P', { modifiers: 10, key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80 }],
        ['Ctrl+P', { modifiers: 2, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 }],
        ['Ctrl+Alt+B', { modifiers: 3, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 }],
        ['Ctrl+0', { modifiers: 2, key: '0', code: 'Digit0', windowsVirtualKeyCode: 48 }],
        ['Ctrl+=', { modifiers: 2, key: '=', code: 'Equal', windowsVirtualKeyCode: 187 }],
        ['Ctrl+-', { modifiers: 2, key: '-', code: 'Minus', windowsVirtualKeyCode: 189 }],
        ['Escape', { modifiers: 0, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
        ['Enter', { modifiers: 0, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }],
    ];
    for (const [combo, expected] of cases) {
        const session = recorder();
        await pressKey(session, combo);
        const event = { method: 'Input.dispatchKeyEvent', ...expected, nativeVirtualKeyCode: expected.windowsVirtualKeyCode };
        assert.deepEqual(session.sent, [{ ...event, type: 'rawKeyDown' }, { ...event, type: 'keyUp' }], combo);
    }
});

test('pressKey refuses a modifier and a key that it does not know, before it sends anything', async () => {
    for (const combo of ['Hyper+X', 'Ctrl+F5', 'Ctrl+Tab', '']) {
        const session = recorder();
        await assert.rejects(pressKey(session, combo), /pressKey: /, combo);
        assert.deepEqual(session.sent, [], combo);
    }
});

test('clickAt presses and releases the left button at the point', async () => {
    const session = recorder();
    await clickAt(session, 10, 20);
    assert.deepEqual(session.sent, ['mousePressed', 'mouseReleased'].map(type => ({ method: 'Input.dispatchMouseEvent', type, x: 10, y: 20, button: 'left', clickCount: 1 })));
});
