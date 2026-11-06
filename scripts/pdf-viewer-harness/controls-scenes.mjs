import assert from 'node:assert/strict';
import { installPanelProbe, withNativeInput } from './panel-probe.mjs';

export const CONTROL_BUDGET = Object.freeze({ actionsMs: 60000, restoreMs: 20000, hostMs: 85000 });

// These assertions consume saved observations as well as the actual browser scenario.
export function controlAssertions(check, near) {
    const idleState = state => {
        check(!state.panelMoving && !state.columnMoving && !state.column?.transition && !state.pull,
            'The settled panel or column still owns motion');
        check(!state.robotScheduled && !state.labScheduled && !state.forklift?.outside,
            'The settled renderers or forklift lease remain active');
    };
    return {
        hits(value) {
            check(value.hits.length === 8 && new Set(value.hits.map(item => item.direction)).size === 8,
                'All eight distinct resize handles must exist');
            check(value.hits.every(item => item.reachable && item.tabIndex === 0 && item.label),
                'A resize handle has no reachable native hit target or accessible identity');
            check(value.protectedControls.every(item => item.ownsCenter), 'Resize hit areas cover the close or drag control');
        },
        firstLeg(baseline, inputs, lastInput, first) {
            check(inputs.length === 3 && inputs.every(state => near(state.offset, baseline.offset, 0.01) && !state.column?.transition),
                'A drag burst changed the applied column before the quiet interval');
            check(first.column?.transition?.startedAt >= lastInput + 270, 'The column skipped its quiet input interval');
            check(first.pull && first.forklift?.outside, 'The column leg has no owned forklift lease');
        },
        heldLeg(first, state) {
            const a = first.column.transition, b = state.column?.transition;
            check(b?.id === a.id && b.startedAt === a.startedAt && b.toX === a.toX
                && state.pull?.actor === first.pull.actor && state.forklift?.id === first.forklift.id && state.forklift.outside,
            'Mid-haul input restarted the clock, target, actor or forklift lease');
        },
        continuation(first, next) {
            check(next.column?.transition?.id !== first.column.transition.id
                && near(next.column?.transition?.fromX, first.column.transition.toX, 0.01)
                && next.pull?.actor === first.pull.actor && next.forklift?.id === first.forklift.id && next.forklift.outside,
            'The latest continuation lost the same actor, lease or completed edge');
        },
        key(active, event, after) {
            check(event.trusted && event.ownsHandle && event.shadowFocus && event.key === 'ArrowLeft',
                'The native key did not originate at the focused shadow resize handle');
            const before = event.before, original = active.column.transition, end = original.startedAt + original.durationMs;
            check(before.column?.transition?.id === original.id && before.pull?.actor === active.pull.actor
                && ['approach', 'pull'].includes(before.pull?.phase), 'The native key arrived after the original engaged leg');
            const same = after.column?.transition?.id === original.id && after.column.transition.startedAt === original.startedAt;
            const continued = after.at >= end && after.column?.transition?.id > original.id
                && after.column.transition.startedAt >= end && near(after.column.transition.fromX, original.toX, 0.01);
            check(after.pull?.actor === active.pull.actor && (same || continued)
                && after.forklift?.outside && after.forklift.id === active.forklift.id,
            'The trusted Lab key cancelled or restarted the active forklift');
        },
        viewport(before, event, after, active) {
            check(event.trusted && event.size.width !== before.viewport.width, 'A native target-local resize was not observed');
            check(near(event.state.offset, before.offset, 0.01), 'Viewport change snapped the applied column');
            check(after.currentGapPx < 15.5 || after.state.column?.transition,
                'The viewport change did not create a different clearance target');
            check(active.column?.transition?.startedAt >= event.at + 270 && active.pull,
                'Viewport rearrangement skipped calm forklift movement');
        },
        idle(first, last, frames, durationMs = 300) {
            idleState(first); idleState(last);
            check(Number.isFinite(first.robotFrames) && Number.isFinite(first.labFrames)
                && first.robotFrames === last.robotFrames && first.labFrames === last.labFrames,
            'A settled document or Lab continued painting');
            check(frames >= 2 && last.at - first.at >= durationMs, 'Idle evidence did not span actual rendering turns');
        },
        idleState,
    };
}

export function collectHandleHits(win, h) {
    const host = h.host, root = h.root;
    if (!host || host.hidden || !root) { throw new Error('Open the floating Motion Lab before its hit test'); }
    const visual = win.visualViewport;
    const viewport = { x: visual?.offsetLeft ?? 0, y: visual?.offsetTop ?? 0,
        width: visual?.width ?? win.innerWidth, height: visual?.height ?? win.innerHeight };
    const hits = [];
    for (const handle of root.querySelectorAll('[data-panel-resize]')) {
        const box = h.rect(handle), points = [];
        // Corner handles have deliberately empty centres. Sample the actual L-shaped arms.
        for (const fx of [0.1, 0.25, 0.5, 0.75, 0.9]) {
            for (const fy of [0.1, 0.25, 0.5, 0.75, 0.9]) {
                const x = box.x + box.width * fx, y = box.y + box.height * fy;
                if (x < viewport.x || y < viewport.y || x >= viewport.x + viewport.width || y >= viewport.y + viewport.height) { continue; }
                if (win.document.elementFromPoint(x, y) === host && root.elementFromPoint(x, y) === handle) { points.push({ x, y }); }
            }
        }
        hits.push({ direction: handle.dataset.panelResize, rect: box, tabIndex: handle.tabIndex,
            label: handle.getAttribute('aria-label'), hit: points[0] ?? null, reachable: points.length > 0 });
    }
    const protectedControls = ['.close', '.panel-drag'].map(selector => {
        const node = root.querySelector(selector), box = h.rect(node);
        if (!node || !box) { throw new Error('The protected control is missing: ' + selector); }
        const x = box.x + box.width / 2, y = box.y + box.height / 2, hit = root.elementFromPoint(x, y);
        return { selector, rect: box, ownsCenter: win.document.elementFromPoint(x, y) === host && (hit === node || node.contains(hit)) };
    });
    return { viewport, panel: h.rect(host), dock: host.dataset.dock, hits, protectedControls };
}

/** One finite page task; the immediate acknowledgment lets the owner send actual native input. */
export function installControlsScene(win, budget, installProbe, makeAssertions, hitTest, owner) {
    const key = '__pdfHarnessControls';
    if (win[key]) { throw new Error('A controls scene already owns this fixture'); }
    let h = win.__pdfHarnessPanel;
    if (!h) { installProbe(win); h = win.__pdfHarnessPanel; }
    const check = (ok, message) => { if (!ok) { throw new Error(message); } };
    const verify = makeAssertions(check, h.near), saved = h.capture(), began = win.performance.now();
    const initialViewport = h.read().viewport;
    const result = { saved, initialViewport, observations: {}, status: 'running' };
    let phase = 'setup', finished = false, stopped, workTimer, restoreTimer;
    const guard = () => { if (stopped) { throw new Error(stopped); } };
    const phaseTo = value => { guard(); phase = value; };
    const until = (predicate, label, limit = 12000) => h.until(() => { guard(); return predicate(); }, label, limit);
    const read = () => { guard(); return h.read(); };
    const pageBounds = () => {
        const state = read(), boxes = state.pages.map(value => value.rect);
        check(boxes.length, 'The controls fixture has no visible page geometry');
        const x = Math.min(...boxes.map(box => box.x)) - state.offset;
        const right = Math.max(...boxes.map(box => box.right)) - state.offset;
        return { x, width: right - x, y: Math.min(...boxes.map(box => box.y)), bottom: Math.max(...boxes.map(box => box.bottom)) };
    };
    async function arrangeRight(overlap = 0) {
        const available = h.room(), pages = pageBounds();
        const width = Math.min(360, available.width / 3), height = Math.min(360, available.height - 32);
        check(pages.x - available.x > 80 && available.x + available.width - pages.x - pages.width > width + 20,
            'Use a numeric fixture zoom with blank space beside the complete visible page');
        const y = Math.max(available.y, Math.min(available.y + available.height - height, Math.max(available.y, pages.y) + 40));
        await h.setRect({ x: overlap ? pages.x + pages.width - overlap : available.x + available.width - width, y, width, height });
        guard(); await h.quiet('initial panel clearance'); guard();
        // Content may cap the requested height. Subsequent moves use the actual rectangle.
        return { available, pages: pageBounds(), y: h.rect(h.host).y, panel: h.rect(h.host) };
    }
    async function idle(durationMs = 300) {
        await h.quiet('both renderers finish'); guard();
        let first, last, frames = 0;
        await until(() => {
            last = read(); first ??= last; frames++;
            verify.idleState(last);
            check(last.robotFrames === first.robotFrames && last.labFrames === first.labFrames, 'Idle rendering resumed');
            return last.at - first.at >= durationMs;
        }, 'observed continuous idle', 3000);
        verify.idle(first, last, frames, durationMs);
        return { first, last, frames, elapsedMs: last.at - first.at };
    }
    async function bursts() {
        phaseTo('input-bursts');
        const layout = await arrangeRight(), right = layout.pages.x + layout.pages.width;
        const evidence = result.observations.bursts = { baseline: read(), inputs: [], haulInputs: [] };
        for (const overlap of [20, 50, 90]) {
            guard(); h.move(right - overlap, layout.y); evidence.lastInput = win.performance.now();
            evidence.inputs.push(read()); await h.frames(1);
        }
        const first = evidence.first = await until(() => { const state = read(); return state.column?.transition ? state : false; }, 'first calm leg');
        verify.firstLeg(evidence.baseline, evidence.inputs, evidence.lastInput, first);
        await until(() => { const state = read(); return state.pull?.phase === 'pull'
            && state.at >= first.column.transition.startedAt + 800 ? state : false; }, 'engaged haul');
        for (const overlap of [120, 160, 200]) {
            guard(); h.move(right - overlap, layout.y);
            const state = read(); evidence.haulInputs.push(state); verify.heldLeg(first, state); await h.frames(1);
        }
        const next = evidence.continuation = await until(() => {
            const state = read();
            if (state.column?.transition?.id === first.column.transition.id) { verify.heldLeg(first, state); }
            return state.column?.transition && state.column.transition.id !== first.column.transition.id ? state : false;
        }, 'one latest continuation');
        verify.continuation(first, next);
        await until(() => {
            const state = read();
            if (state.column?.transition) { check(state.column.transition.id === next.column.transition.id, 'The burst allocated a third leg'); }
            return !state.columnMoving && !state.column?.transition ? state : false;
        }, 'latest clearance');
        evidence.final = await h.quiet('burst return'); guard();
        check(h.near(evidence.final.offset, next.column.transition.toX, 0.01), 'The final column missed its latest destination');
        evidence.idle = await idle(200);
    }
    async function trustedKey() {
        phaseTo('key-setup');
        const layout = await arrangeRight(); guard(); h.move(layout.pages.x + layout.pages.width - 90, layout.y);
        const evidence = result.observations.key = {};
        evidence.active = await until(() => { const state = read(); return state.pull?.phase === 'pull' ? state : false; }, 'key haul');
        const handle = h.handle('w'); check(handle?.isConnected, 'The west resize handle is unavailable');
        handle.focus({ preventScroll: true });
        const remove = h.listen(win, 'keydown', event => {
            if (!evidence.event && event.isTrusted && event.key === 'ArrowLeft') {
                evidence.event = { at: win.performance.now(), key: event.key, trusted: event.isTrusted,
                    ownsHandle: event.composedPath().includes(handle), shadowFocus: h.root.activeElement === handle, before: h.read() };
            }
        }, true);
        try {
            phaseTo('awaiting-trusted-key');
            await until(() => evidence.event, 'native ArrowLeft', 3000); await h.frames(1); guard();
            evidence.after = read(); verify.key(evidence.active, evidence.event, evidence.after);
        } finally { remove(); }
        phaseTo('key-return'); evidence.final = await h.quiet('key return'); guard();
    }
    async function viewport() {
        phaseTo('viewport-setup'); await arrangeRight(90);
        const evidence = result.observations.viewport = { before: read() };
        const size = () => ({ width: win.innerWidth, height: win.innerHeight, dpr: win.devicePixelRatio });
        const original = size();
        const remove = h.listen(win, 'resize', event => {
            if (!evidence.event && (win.innerWidth !== original.width || win.innerHeight !== original.height)) {
                evidence.event = { at: win.performance.now(), trusted: event.isTrusted, size: size(), state: h.read() };
            }
        });
        try {
            phaseTo('awaiting-viewport-expansion');
            await until(() => evidence.event, 'native target resize', 5000); await h.frames(2); guard();
            const state = read(), pages = pageBounds();
            evidence.after = { state, pages, currentGapPx: state.panel.x - (pages.x + pages.width + state.offset) };
            evidence.active = await until(() => { const value = read(); return value.column?.transition ? value : false; }, 'calm viewport leg');
            verify.viewport(evidence.before, evidence.event, evidence.after, evidence.active);
            evidence.resized = await h.quiet('viewport return'); guard();
        } finally { remove(); }
        phaseTo('awaiting-viewport-restore');
        await until(() => win.innerWidth === original.width && win.innerHeight === original.height
            && win.devicePixelRatio === original.dpr, 'original target viewport', 5000);
        evidence.restored = await h.quiet('restored viewport'); guard();
    }
    const stop = reason => {
        if (finished || phase === 'restoring') { return false; }
        stopped ??= String(reason ?? 'Host stopped the controls scene');
        h.dispose();
        return true;
    };
    const api = { status: () => ({ owner, phase, finished, result }), stop,
        dispose() { if (!finished) { return false; } if (win[key] === api) { delete win[key]; } return true; } };
    win[key] = api;
    workTimer = win.setTimeout(() => stop('Controls action deadline'), budget.actionsMs);
    void (async () => {
        try {
            await h.show(true); guard(); await h.quiet('initial Lab work'); guard();
            await arrangeRight(); result.observations.hit = hitTest(win, h); verify.hits(result.observations.hit);
            await bursts(); await trustedKey(); await viewport();
            phaseTo('final-idle'); result.observations.idle = await idle(300);
            result.status = 'passed';
        } catch (error) {
            result.status = 'failed'; result.error = String(error.stack ?? error); result.errorPhase = phase;
            if (stopped) { result.stopReason = stopped; }
        }
        finally {
            win.clearTimeout(workTimer); phase = 'restoring';
            // Stop owns the old probe's pending frame waits before restoration creates another.
            h.dispose();
            try {
                installProbe(win); h = win.__pdfHarnessPanel;
                restoreTimer = win.setTimeout(() => h.dispose(), budget.restoreMs);
                await h.until(() => {
                    const actual = h.read().viewport;
                    return actual.width === initialViewport.width && actual.height === initialViewport.height
                        && actual.dpr === initialViewport.dpr;
                }, 'original viewport before saved panel restoration', budget.restoreMs);
                result.restoration = await h.restore(saved);
                const actual = h.read().viewport;
                check(actual.width === initialViewport.width && actual.height === initialViewport.height
                    && actual.dpr === initialViewport.dpr, 'The target viewport was not restored');
            } catch (error) { result.status = 'failed'; result.restorationError = String(error.stack ?? error); }
            finally { win.clearTimeout(restoreTimer); h.dispose(); }
            result.elapsedMs = win.performance.now() - began; phase = 'finished'; finished = true;
        }
    })();
    return { started: true, actionsMs: budget.actionsMs, restoreMs: budget.restoreMs };
}

export async function runScenario(context) {
    const { config, evaluate, rpc, checkpoint, waitFor, pause } = context;
    const owner = context.options.id + ':' + context.row.tag;
    let expanded = false, keySent = false, restoredViewport = false, previousPhase;
    const metrics = width => rpc('Emulation.setDeviceMetricsOverride', {
        width, height: config.height, deviceScaleFactor: config.dpr, mobile: false,
    });
    const cleanup = context.defer('controls scene and reading restoration', async () => {
        if (expanded) { await metrics(config.width); expanded = false; }
        const status = await evaluate('window.__pdfHarnessControls?.status()');
        if (!status || status.owner !== owner) { return; }
        if (!status.finished) {
            await evaluate('window.__pdfHarnessControls.stop("Host cleanup")');
            await waitFor('window.__pdfHarnessControls.status().finished', { limitMs: CONTROL_BUDGET.restoreMs + 3000, what: 'controls restoration' });
        }
        const final = await evaluate('window.__pdfHarnessControls.status()');
        checkpoint('controls', final.result);
        await evaluate('window.__pdfHarnessControls.dispose()');
        assert.ok(final.result?.restoration?.exactReading && final.result.restoration.exactPanel && final.result.restoration.exactFocus,
            final.result?.restorationError ?? 'The controls scene did not restore its owned state');
    });
    try {
        const ack = await evaluate('(' + installControlsScene.toString() + ')(window,' + JSON.stringify(CONTROL_BUDGET)
            + ',' + installPanelProbe.toString() + ',' + controlAssertions.toString() + ',' + collectHandleHits.toString() + ',' + JSON.stringify(owner) + ')');
        assert.ok(ack.started, 'The controls scene did not acknowledge initialization'); checkpoint('controlsAcknowledgment', ack);
        const deadline = Date.now() + CONTROL_BUDGET.hostMs;
        for (;;) {
            assert.ok(Date.now() < deadline, 'Controls host deadline');
            const state = await evaluate('window.__pdfHarnessControls.status()');
            assert.equal(state.owner, owner, 'The controls task owner changed');
            if (state.phase !== previousPhase) { previousPhase = state.phase; checkpoint('controlsProgress', state); }
            if (state.finished) {
                checkpoint('controls', state.result);
                assert.equal(state.result.status, 'passed', state.result.error ?? state.result.restorationError);
                return state.result;
            }
            if (state.phase === 'awaiting-trusted-key' && !keySent) {
                keySent = true;
                await withNativeInput(rpc, 'Input.dispatchKeyEvent',
                    { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
                    { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
            }
            if (state.phase === 'awaiting-viewport-expansion' && !expanded && !restoredViewport) {
                expanded = true; await metrics(config.width + 200);
            }
            if ((state.phase === 'awaiting-viewport-restore' || state.phase === 'restoring') && expanded) {
                await metrics(config.width); expanded = false; restoredViewport = true;
            }
            await pause(30);
        }
    } finally { await cleanup(); }
}
