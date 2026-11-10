import { installPdfDocumentRobots, DOCUMENT_ROBOT_LIMITS, type DocumentRobotWorkState } from '../../views/pdf-viewer/src/common/pdf-document-robots';
import { installReservedText } from '../../views/pdf-viewer/src/common/reserved-text';

// Only document inputs are fixtures. All label CSS, canvas artwork, layout and scheduling
// come from the production renderer and the browser's real DOM.
const stage = document.querySelector<HTMLElement>('#stage')!;
const pages = [...document.querySelectorAll<HTMLElement>('.page')];
let renderer: ReturnType<typeof installPdfDocumentRobots>;
let identity: HTMLElement | null;
let episode = '';
let samples: unknown[] = [];
let observing = false;
function sample(step: string) {
    const node = stage.querySelector<HTMLElement>('.pdfDocumentRobotWorkStatus');
    const bounds = node?.getBoundingClientRect();
    const style = node && getComputedStyle(node);
    const snapshot = renderer.snapshot();
    return { step, episode, at: performance.now(), width: bounds?.width ?? 0, height: bounds?.height ?? 0,
        x: bounds?.x, y: bounds?.y, opacity: style?.opacity, visibility: style?.visibility,
        connected: !!node?.isConnected, sameNode: node === identity,
        text: node?.querySelector<HTMLElement>('span:not([aria-hidden="true"])')?.textContent ?? node?.textContent,
        phase: snapshot.advance[0]?.phase, actors: snapshot.advance[0]?.actors.length ?? 0,
        viewport: { width: innerWidth, height: innerHeight }, reducedMotion: snapshot.reducedMotion };
}
let currentStep = '';
function observe() {
    if (!observing) return;
    samples.push(sample(currentStep));
    requestAnimationFrame(observe);
}
async function frames(count: number) {
    for (let index = 0; index < count; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}
async function phaseOrFrames(phase: string, maximumFrames: number) {
    for (let index = 0; index < maximumFrames; index++) {
        await frames(1);
        if (renderer.snapshot().advance[0]?.phase === phase) return;
    }
    throw new Error('Production renderer did not reach ' + phase);
}
function work(states: DocumentRobotWorkState[], labels: string[], visibleIndices = states.map((_, index) => index)) {
    renderer.setVisibleWork([{ key: episode,
        layoutPages: [{ pageNumber: 1, label: labels[0] }, { pageNumber: 2, label: labels[1] }],
        pages: visibleIndices.map(index => ({
        pageNumber: index + 1, pageElement: pages[index], label: labels[index], state: states[index],
    })) }]);
    identity ??= stage.querySelector('.pdfDocumentRobotWorkStatus');
}
async function run({ actorless = false, long = false } = {}) {
    renderer?.dispose();
    renderer = installPdfDocumentRobots(stage, { seed: 734, device: 'desktop', ...(actorless ? { maxActors: 0 } : {}) });
    identity = null; samples = []; episode = (actorless ? 'actorless' : 'crew') + (long ? '-long' : '-short');
    const labels = long ? ['Extremely long section label 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Appendix with long descriptive label 9876543210'] : ['9', '10'];
    observing = true; currentStep = 'waiting-spread';
    work(['waiting', 'waiting'], labels); requestAnimationFrame(observe);
    if (!actorless && !renderer.snapshot().reducedMotion) await phaseOrFrames('parked', Math.ceil((DOCUMENT_ROBOT_LIMITS.advance.arrivalMs + DOCUMENT_ROBOT_LIMITS.advance.coordinationMs) / 4) + 120);
    await frames(4);
    for (const [step, states] of [
        ['preparing-spread', ['preparing', 'preparing']],
        ['partial-completion', ['ready', 'waiting']],
        ['preparing-single', ['ready', 'preparing']],
        ['waiting-single', ['ready', 'waiting']],
    ] as [string, DocumentRobotWorkState[]][]) {
        currentStep = step; work(states, labels);
        await frames(6);
        if (!actorless && !renderer.snapshot().reducedMotion) await phaseOrFrames('parked', 240);
        await frames(3);
    }
    observing = false;
    const result = samples;
    currentStep = 'completed'; work(['ready', 'ready'], labels);
    await frames(2);
    return { samples: result, ended: sample('completed') };
}
const boundaryLabels = ['Extremely long section label 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'Appendix with long descriptive label 9876543210'];
async function beginBoundary() {
    renderer?.dispose();
    renderer = installPdfDocumentRobots(stage, { seed: 734, device: 'desktop', maxActors: 0 });
    identity = null; samples = []; episode = 'visible-domain-boundary'; currentStep = 'one-visible-member';
    work(['waiting', 'waiting'], boundaryLabels, [0]);
    observing = true; requestAnimationFrame(observe); await frames(5);
    return sample(currentStep);
}
async function membersBoundary() {
    await beginBoundary();
    currentStep = 'both-visible-members'; work(['waiting', 'preparing'], boundaryLabels); await frames(6);
    currentStep = 'second-visible-member'; work(['ready', 'waiting'], boundaryLabels, [1]); await frames(6);
    currentStep = 'first-visible-member-again'; work(['preparing', 'ready'], boundaryLabels, [0]); await frames(6);
    observing = false; return { samples, ended: sample(currentStep) };
}
async function resizeBoundary() {
    currentStep = 'after-viewport-resize';
    work(['waiting', 'preparing'], boundaryLabels, [0]); await frames(6);
    observing = false; return { samples, ended: sample(currentStep) };
}
async function removeBoundary() {
    renderer.setVisibleWork([]); await frames(2);
    const snapshot = renderer.snapshot();
    return { statusNodes: stage.querySelectorAll('.pdfDocumentRobotWorkStatus').length,
        advanceNodes: stage.querySelectorAll('.pdfDocumentRobotAdvance').length,
        groups: snapshot.advance.length, actors: snapshot.activeActors, bytes: snapshot.retainedBytes };
}
async function fontBoundary() {
    await beginBoundary();
    const node = identity!;
    const before = sample('before-font');
    node.style.fontFamily = 'monospace'; node.style.letterSpacing = '2px';
    currentStep = 'after-font'; work(['preparing', 'waiting'], boundaryLabels, [0]); await frames(6);
    observing = false;
    const live = node.querySelector<HTMLElement>('span:not([aria-hidden="true"])')!;
    const bounds = live.getBoundingClientRect();
    const settled = renderer.snapshot(); await frames(6); const tail = renderer.snapshot();
    return { before, after: sample(currentStep), scrollHeight: node.scrollHeight,
        live: { width: bounds.width, height: bounds.height }, samples,
        idle: { framesBefore: settled.frames, framesAfter: tail.frames, scheduled: tail.scheduled } };
}
function reservationDisposal() {
    const node = document.createElement('div'); node.style.display = 'block'; node.style.gridTemplateColumns = '2px 3px';
    stage.append(node); const before = { display: node.style.display, grid: node.style.gridTemplateColumns };
    const text = installReservedText(node, ['A', 'Longer alternative'], 'A');
    const installed = { display: node.style.display, grid: node.style.gridTemplateColumns };
    text.dispose(); const after = { display: node.style.display, grid: node.style.gridTemplateColumns };
    node.remove(); return { before, installed, after };
}
async function domainBoundary() {
    renderer?.dispose();
    renderer = installPdfDocumentRobots(stage, { seed: 734, device: 'desktop', maxActors: 0 });
    identity = null; samples = []; episode = 'clipped-domain';
    const labels = ['9', '10'];
    work(['waiting', 'waiting'], labels, [0]); await frames(5);
    const before = sample('before-domain');
    labels[1] = 'A hidden member with a long descriptive label 123456789';
    work(['waiting', 'waiting'], labels, [0]);
    const synchronousDomain = sample('synchronous-domain');
    await frames(6); const afterDomain = sample('after-domain');
    labels[0] = '88'; work(['waiting', 'waiting'], labels, [0]);
    const synchronousVisible = sample('synchronous-visible');
    await frames(6); const settled = renderer.snapshot(); await frames(6); const tail = renderer.snapshot();
    return { before, synchronousDomain, afterDomain, synchronousVisible, afterVisible: sample('after-visible'),
        idle: { before: settled.frames, after: tail.frames, scheduled: tail.scheduled } };
}
(window as unknown as { loadingLayout: unknown }).loadingLayout = {
    run, membersBoundary, beginBoundary, resizeBoundary, removeBoundary, fontBoundary, reservationDisposal, domainBoundary, dispose: () => renderer?.dispose(),
};
