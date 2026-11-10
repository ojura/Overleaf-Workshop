import { createApp, nextTick } from '../../views/chat-view/node_modules/vue';
import App from '../../views/chat-view/src/App.vue';
import { installPrefetchDiagnostics, type PrefetchDiagnosticSample } from '../../views/pdf-viewer/src/common/prefetch-performance';
import { RobotChoreographer } from '../../views/pdf-viewer/src/common/prefetch-robots';

const state: PrefetchDiagnosticSample = { direction: 0, velocityPxPerMs: 0, accelerationPxPerMs2: 0,
    pageLatencyMs: 100, preloadPx: 0, readyDistancePx: 0, safetySeconds: null, bufferSeconds: null,
    visible: [1], renderAhead: [], prepared: [], pending: [], failed: [], previewPages: 0, previewBytes: 0, canvasBytes: 0 };
let app: ReturnType<typeof createApp> | undefined;
let lab: ReturnType<typeof installPrefetchDiagnostics> | undefined;
let ownedModel: RobotChoreographer | undefined;
const modelSnapshot = RobotChoreographer.prototype.snapshot;
RobotChoreographer.prototype.snapshot = function () { ownedModel = this; return modelSnapshot.call(this); };
if (new URL(location.href).searchParams.get('mode') === 'lab') {
    const container = document.createElement('div');
    container.id = 'viewerContainer';
    Object.assign(container.style, { position: 'relative', width: '100vw', height: '100vh' });
    document.body.append(container);
    lab = installPrefetchDiagnostics(container, () => state, { enabled: true,
        measurementsPreference: { read: () => true, write: () => {} } });
} else {
    app = createApp(App); app.mount('#app');
    window.postMessage({ type: 'get-messages', userId: 'fixture-owner', content: [{ id: 'fixture-message',
        content: 'A production message component for layout observation.', timestamp: Date.now(), user_id: 'fixture-author',
        user: { id: 'fixture-author', first_name: 'Fixture', last_name: 'Author', email: 'fixture@example.test' }, clientId: 'fixture-client' }] }, '*');
}
(window as unknown as { dynamicLayout: unknown }).dynamicLayout = {
    async unread(ids: string[]) {
        // App provides the same reactive record to the real message and notice components.
        (app as any)._instance.provides.unreadRecord.value = ids;
        await nextTick();
    },
    sample(patch: Partial<PrefetchDiagnosticSample>) { Object.assign(state, patch); },
    labSnapshot: () => lab?.labSnapshot(),
    counters(value: number) {
        // Exercise the real numeric renderer with large upstream model counters; no CSS or DOM
        // text is replaced by the fixture. The model is owned by this isolated test page.
        const stats = (ownedModel as any).stats;
        stats.yields = stats.assists = stats.replans = value;
        const stage = document.querySelector('#pdf-prefetch-diagnostics')?.shadowRoot?.querySelector('[data-robot-stage]') as any;
        stage.robotLab.invalidateGeometry();
    },
    dispose() { app?.unmount(); lab?.dispose(); },
};
