import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evaluateHarness } from './scenario-connection.mjs';

// Serialized into the explicitly supplied state-reader extension context. Normalization
// uses the browser's exact target-to-tab mapping, never a URL match.
export async function pageZoomOwner(action, targetId, invocation) {
    if (typeof invocation !== 'string' || !invocation) { throw new Error('An invocation identity is required'); }
    const owners = globalThis.__pdfHarnessZoomOwners ??= new Map();
    let owner = owners.get(targetId);
    if (action === 'install') {
        if (owner) { throw new Error('The fixture tab already has a zoom owner'); }
        owner = { invocation, pending: Promise.resolve(), error: undefined };
        owners.set(targetId, owner);
        owner.initialize = (async () => {
            const targets = await chrome.debugger.getTargets();
            const matches = targets.filter(target => target.id === targetId && Number.isInteger(target.tabId));
            if (matches.length !== 1) { throw new Error('The exact fixture tab is unavailable'); }
            const tabId = matches[0].tabId;
            const settings = await chrome.tabs.getZoomSettings(tabId);
            const factor = await chrome.tabs.getZoom(tabId);
            Object.assign(owner, { tabId, settings, factor });
            owner.apply = () => {
                if (owner.stopping) { return owner.pending; }
                owner.pending = owner.pending.then(async () => {
                    if (owner.stopping) { return; }
                    if (await chrome.tabs.getZoom(tabId) === 1) { return; }
                    // The caller serializes this write after document commitment.
                    // Establish the scope immediately before every write, even when it was reported.
                    owner.changed = true;
                    await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' });
                    await chrome.tabs.setZoom(tabId, 1);
                }).catch(error => { owner.error ??= String(error?.stack ?? error); });
                return owner.pending;
            };
        })();
    }
    if (!owner) { throw new Error('The fixture zoom owner is unavailable'); }
    if (owner.invocation !== invocation) { throw new Error('The fixture zoom owner belongs to another invocation'); }
    if (action === 'close') {
        owner.stopping = true;
        try {
            await owner.initialize;
            await owner.pending;
            // Restoring per-origin scope inherits its current factor. Writing the saved factor
            // here would overwrite an origin change made by another browser user during testing.
            const { mode, scope } = owner.settings;
            if (owner.changed) {
                await chrome.tabs.setZoomSettings(owner.tabId, { mode, scope });
                if (scope === 'per-tab' && mode !== 'disabled') { await chrome.tabs.setZoom(owner.tabId, owner.factor); }
            }
            return { original: { settings: owner.settings, factor: owner.factor },
                restored: { settings: await chrome.tabs.getZoomSettings(owner.tabId), factor: await chrome.tabs.getZoom(owner.tabId) },
                ...(owner.error ? { error: owner.error } : {}) };
        } finally { if (owners.get(targetId) === owner) { owners.delete(targetId); } }
    }
    await owner.initialize;
    await owner.apply();
    if (owner.error) { throw new Error('Fixture zoom normalization failed: ' + owner.error); }
    return { original: { settings: owner.settings, factor: owner.factor },
        current: { settings: await chrome.tabs.getZoomSettings(owner.tabId), factor: await chrome.tabs.getZoom(owner.tabId) } };
}

export async function normalizeTabZoom(browser, helperTarget, targetId) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const helper = targetInfos.find(target => target.targetId === helperTarget);
    assert.ok(helper && helper.type === 'other' && /^chrome-extension:\/\/[^/]+\/bridge\.html$/.test(helper.url),
        'The explicit state-reader helper target is required');
    const session = await browser.attach(helperTarget);
    const invocation = randomUUID();
    const call = action => evaluateHarness(session, '(' + pageZoomOwner.toString() + ')('
        + JSON.stringify(action) + ',' + JSON.stringify(targetId) + ',' + JSON.stringify(invocation) + ')');
    let closed;
    const close = () => closed ??= (async () => {
        try { return await call('close'); } finally { await session.detach(); }
    })();
    try {
        const initial = await call('install');
        return { initial, ensure: () => call('ensure'), close };
    } catch (error) {
        try { await close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Zoom setup and cleanup failed'); }
        throw error;
    }
}
