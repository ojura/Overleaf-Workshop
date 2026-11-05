import { paintRobotVehicle, RobotRandom, ROBOT_ARTWORK_SIZE, ROBOT_FORKLIFT_ATTACHMENT, ROBOT_AIRLIFT_ATTACHMENT, ROBOT_VEHICLES, type RobotArtworkActor, type RobotVehicle, type RobotDispatchPort, type RobotDispatchPoint } from './prefetch-robots';
import { pdfCachePolicy } from './scroll-prefetch';
import { RobotEncounters, ROBOT_INTERACTION_REACTIONS, type RobotEncounterActor, type RobotEncounterReaction } from './robot-encounters';
import { LabelPlacementSolver, LABEL_PLACEMENT_LIMITS, type LabelPlacement, type LabelPlacementInput, type PlacementRect } from './label-placement';
import { ASAP_CLEANER_ARTWORK_SIZE, paintAsapCleaner } from './robot-cleaner-artwork';
import { computeCargoRoute, needsCargoAirlift, cargoAirliftReason, groundRouteDirection, clampGroundRoutePoint,
    CARGO_ROUTE_POLICY, type CargoRouteState, type CargoAirliftReason, type GroundRouteDirection } from './robot-cargo-routes';
import type { PdfDocumentColumnTransition } from './pdf-document-column';
import { MOTION_LAB_CHOREOGRAPHY, motionLabColumnElapsed, motionLabEase } from './motion-lab-choreography';
import { canCarryRobot } from './robot-rescue';
import { robotScreenMetrics, robotCaptionMetrics, ROBOT_CAPTION_STYLE } from './robot-screen-scale';
import { robotDocumentMetrics, selectRobotImageCrops, type RobotDocumentSize, type RobotImageCrop } from './robot-document-policy';
import { RobotTraffic } from './robot-traffic';
import { installRobotInteraction, type RobotInteractionPoint } from './robot-interaction';
import { createPdfRasterProjection, resizePdfRasterProjection, projectPdfRasterCrop, pdfRasterCropSize, pdfRasterToCrop,
    projectPdfPageRect, clipPdfPageRect, type PdfRasterProjection, type PdfPageProjection } from './pdf-raster-projection';

export const DOCUMENT_ROBOT_LIMITS = Object.freeze({
    maxActors: 4,
    maxCargoBytes: 512 * 1024,
    maxSpriteBytes: 4 * ROBOT_ARTWORK_SIZE.width * ROBOT_ARTWORK_SIZE.height * 4,
    maxFragmentsPerPage: 3,
    fragmentDimension: 160,
    sampleDimension: 64,
    maxFps: 30,
    minDurationMs: 1800,
    maxDurationMs: 2900,
    trafficSettleMs: 180,
    spriteScale: 0.64,
    maxDpr: 3,
    advance: Object.freeze({ arrivalMs: 900, coordinationMs: 550, returnMs: 650, desktopCrew: 2, mobileCrew: 1 }),
    replacement: Object.freeze({ durationMs: 2100, pickupEnd: 0.22, lowerEnd: 0.38, fragmentsPerDesktopPage: 3 }),
    cleaner: Object.freeze({ durationMs: 600, minDurationMs: 260, gestureSteps: 12, desktopScale: 0.85, compactScale: 0.55 }),
    cooperative: Object.freeze({ rasterScale: 1.5, cropScale: 1.8, durationScale: 1.25 }),
    forklift: Object.freeze({ approachEnd: 0.16, liftStart: 0.44, baseInset: 14 }),
    desktop: Object.freeze({
        minWidth: 700,
        minHeight: 480,
        maxActors: 12,
        minActors: 6,
        pixelsPerActor: 100000,
        maxCargoBytes: 3 * 1024 * 1024,
        maxSpriteBytes: 24 * 1024 * 1024,
        fragmentDimension: 256,
        spriteScale: 1.92,
        minSpriteScale: 1.4,
        scaleWidth: 560,
    }),
});

interface Options {
    now?: () => number;
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
    createCanvas?: () => HTMLCanvasElement;
    seed?: number;
    maxActors?: number;
    maxCargoBytes?: number;
    device?: 'desktop' | 'mobile';
    onCapacityAvailable?: () => void;
    onReplacementComplete?: (identity: string) => void;
    documentOffset?: () => number;
    /** Numeric content extent of the current page; the controller supplies it without a new layout read. */
    documentSize?: () => RobotDocumentSize | undefined;
    registerDocumentLayer?: (layer: HTMLElement) => () => void;
    encounterRandom?: () => number;
    createTraffic?: () => Pick<RobotTraffic, 'update' | 'reset'>;
}

export type DocumentRobotOffer = 'started' | 'busy' | 'deferred' | 'skipped';

export type DocumentRobotWorkState = 'waiting' | 'preparing' | 'ready' | 'failed';
export interface DocumentRobotWorkPage {
    pageNumber: number;
    pageElement: HTMLElement;
    label?: string;
    state: DocumentRobotWorkState;
}
export interface DocumentRobotWorkGroup {
    key: string;
    pages: readonly DocumentRobotWorkPage[];
}
/** Image placements normalized in the orientation of the supplied rendered page. */
export interface DocumentRobotImageRegion {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DocumentRobotDelivery {
    pageNumber: number;
    pageElement: HTMLElement;
    canvas: HTMLCanvasElement;
    kind: 'preview' | 'page';
    imageRegions?: readonly DocumentRobotImageRegion[];
    rasterProjection?: PdfRasterProjection;
    pageProjection?: PdfPageProjection;
    displayRasterProjection?: PdfRasterProjection;
}

type Point = { x: number; y: number };
type Crop = { x: number; y: number; width: number; height: number; score: number; imageId?: string;
    imageIds?: readonly string[]; kind?: RobotImageCrop['kind'] };
interface Geometry {
    width: number;
    height: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    pageLeft: number;
    pageTop: number;
    projection?: PdfPageProjection;
}
type DeliveryMode = 'solo' | 'formation' | 'handoff' | 'airlift';
type DeliveryStage = 'rendezvous' | 'handoff' | 'carry' | 'lift' | 'deposit' | 'return';
interface Payload {
    id: number;
    mode: DeliveryMode;
    ground: boolean;
    route: number;
    crop: Crop;
    start: Point;
    control: Point;
    started: number;
    delay: number;
    duration: number;
    canvas?: HTMLCanvasElement;
    mast?: HTMLDivElement;
    sling?: HTMLDivElement;
    cover?: HTMLDivElement;
    landingShadow?: HTMLDivElement;
    underlay?: { canvas: HTMLCanvasElement; bytes: number };
    bytes: number;
    helpers: Courier[];
    progress: number;
    stage: DeliveryStage;
    deposited: boolean;
    handedOff: boolean;
    refinements: number;
    refinementAttempt?: string;
    cleanerShown?: boolean;
    routeState?: CargoRouteState;
    airliftReason?: CargoAirliftReason;
    returnPlanned?: boolean;
    returnCarry?: GroundCarry;
    motion?: Point;
    visibility?: number;
}
interface Cleaner {
    id: number;
    page: number;
    payload: Payload;
    sprite: HTMLCanvasElement;
    bytes: number;
    started: number;
    duration: number;
    phase: number;
    direction: -1 | 1;
    drawn: number;
}
interface RobotBody {
    id: number;
    vehicle: RobotVehicle;
    started: number;
    sprite: HTMLCanvasElement;
    spriteBytes: number;
    spriteScale: number;
    pose: RobotArtworkActor;
    departing: boolean;
    port?: RobotDispatchPort;
    origin?: RobotDispatchPoint;
    launch?: RobotDispatchPoint;
    reactionCarried?: boolean;
    /** Direction of the last committed self-driven leg, independent of gaze and comic motion. */
    drivingDirection?: GroundRouteDirection;
    carried?: boolean;
}
interface Courier extends RobotBody {
    payload: Payload;
    slot: number;
    departure: Point;
    routePhase?: string;
}
interface GroundCarry {
    ground: RobotBody;
    air: RobotBody;
    from: Point;
    airFrom: Point;
    groundScale: number;
    airScale: number;
    reason?: CargoAirliftReason;
    route?: CargoRouteState;
}
interface AdvanceActor {
    body: RobotBody;
    start: Point & { scale: number };
    point: Point & { scale: number };
    formationOffset?: Point;
}
interface AdvanceWork {
    key: string;
    pages: readonly DocumentRobotWorkPage[];
    layer: HTMLDivElement;
    label: HTMLDivElement;
    actors: AdvanceActor[];
    phase: 'arriving' | 'coordinating' | 'parked' | 'returning';
    started: number;
    gestureAt?: number;
    returnAt?: number;
    returnPlanned?: boolean;
    returnCarry?: GroundCarry;
    sling?: HTMLDivElement;
    admitted: boolean;
    signature: string;
    geometry: string;
    message: string;
    labelAnchor?: Point;
    labelSize?: { key: string; width: number; height: number };
    anchor?: { element: HTMLElement; x: number; y: number; left: number; right: number; bottom: number };
}
interface Episode {
    page: number;
    element: HTMLElement;
    layer: HTMLDivElement;
    kind: DocumentRobotDelivery['kind'];
    payloads: Payload[];
    pageSize: RobotDocumentSize;
    pageProjection?: PdfPageProjection;
    displayRasterProjection?: PdfRasterProjection;
}
interface RetiringPiece {
    page: number;
    /** Page geometry relative to the captured reader viewport, without an old page-node reference. */
    area: Geometry;
    payload: Payload;
}
interface RetiringScene {
    identity: string;
    layer: HTMLDivElement;
    pieces: RetiringPiece[];
    started: number;
}
interface ColumnPull {
    motion: Readonly<PdfDocumentColumnTransition>;
    documentSize: RobotDocumentSize;
    body: RobotBody;
    layer: HTMLDivElement;
    start: Point & { scale: number };
    point: Point & { scale: number };
    offsetX: number;
    startOpacity: number;
    opacity: number;
    laneY: number;
    side: -1 | 1;
    phase: 'approach' | 'pull' | 'waiting' | 'return';
    returnAt?: number;
    returnFrom?: Point & { scale: number };
}
interface Presentation {
    kind: 'compact' | 'desktop';
    maxActors: number;
    maxCargoBytes: number;
    maxSpriteBytes: number;
    maxFragmentsPerPage: number;
    fragmentDimension: number;
    spriteScale: number;
    spriteDpr: number;
    documentScale: number;
    cargoEdge: number;
    cleanerScale: number;
    minimumWidth: number;
    minimumHeight: number;
}

interface BodyPlacement {
    body: RobotBody;
    point: Point;
    scale: number;
    opacity: number;
    tilt: number;
    activity: RobotArtworkActor['activity'];
    carrying: boolean;
    progress: number;
    look: number;
    phase: RobotEncounterActor['phase'];
    remainingMs: number;
    group?: number;
    pages: readonly number[];
    advance?: AdvanceActor;
    pullDirection?: -1 | 1;
    payload?: Payload;
    fixed?: boolean;
}
interface CaptionGroup {
    id: string;
    node: HTMLDivElement;
    actors: readonly number[];
    pages: ReadonlySet<number>;
    lines: ReadonlyMap<number, string>;
    until: number;
    readMs: number;
    shownAt?: number;
    detached: boolean;
    measurementKey: string;
    width: number;
    height: number;
    leaders: HTMLDivElement[];
    placement?: LabelPlacement;
}
interface SceneObstacle extends PlacementRect { group?: number }

const RGBA_BYTES = 4;
const attachment = ROBOT_FORKLIFT_ATTACHMENT;
// Preserve the document mast's pixel-rounded silhouette in artwork pixels, before sprite scale.
const FORKLIFT_ATTACHMENT_PX = Object.freeze({
    cargoX: Math.round(attachment.cargo.x * attachment.scale * 10) / 10,
    carryY: (attachment.frontFork.y - attachment.carryLift) * attachment.scale,
    mastLeft: Math.round(attachment.mast.left * attachment.scale),
    mastTop: Math.round(attachment.mast.top * attachment.scale),
    mastBottom: Math.round(attachment.mast.bottom * attachment.scale),
    mastWidth: Math.round((attachment.mast.right - attachment.mast.left) * attachment.scale),
    railWidth: Math.round(attachment.mast.strokeWidth * attachment.scale),
    forkWidth: Math.ceil((attachment.frontFork.right - attachment.frontFork.left) * attachment.scale),
    forkHeight: Math.round(attachment.rearFork.strokeWidth * attachment.scale),
});
const RENDEZVOUS_END = 0.18;
const HANDOFF_START = 0.22;
const HANDOFF_END = 0.36;
const DEPOSIT_START = 0.62;
const RETURN_START = 0.76;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const ease = (value: number) => value * value * (3 - 2 * value);
const straight = (from: Point, to: Point, amount: number): Point => ({ x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount });
const curve = (start: Point, control: Point, end: Point, amount: number): Point => {
    const left = 1 - amount;
    return { x: left * left * start.x + 2 * left * amount * control.x + amount * amount * end.x,
        y: left * left * start.y + 2 * left * amount * control.y + amount * amount * end.y };
};
const release = (canvas: HTMLCanvasElement) => { canvas.remove(); canvas.width = canvas.height = 0; };
const counters = () => ({ episodes: 0, deliveredFragments: 0, removedFragments: 0, refinements: 0, cancelledEpisodes: 0, rejected: 0, skipped: 0 });

/**
 * Finished PDF pixels become short, one-shot deliveries on their own page. The original PDF
 * canvas and text layer remain untouched. Only small cargo and vehicle canvases are retained;
 * there is no page-sized overlay bitmap and no source canvas survives the synchronous copy.
 */
export function installPdfDocumentRobots(container: HTMLElement, options: Options = {}) {
    const doc = container.ownerDocument;
    const win = doc.defaultView!;
    const now = options.now ?? (() => win.performance.now());
    const requestFrame = options.requestFrame ?? (callback => win.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? (id => win.cancelAnimationFrame(id));
    const createCanvas = options.createCanvas ?? (() => doc.createElement('canvas'));
    const seed = new Uint32Array(1);
    if (options.seed === undefined) { win.crypto.getRandomValues(seed); }
    const random = new RobotRandom(options.seed ?? seed[0]);
    const encounterRandom = new RobotRandom((options.seed ?? seed[0]) ^ 0x718b4d23);
    const encounters = new RobotEncounters(options.encounterRandom ?? (() => encounterRandom.next()), DOCUMENT_ROBOT_LIMITS.desktop.maxActors);
    const traffic = options.createTraffic?.() ?? new RobotTraffic();
    const captionPlacement = new LabelPlacementSolver();
    const workLabelPlacement = new LabelPlacementSolver();
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const episodes = new Map<number, Episode>();
    const advance = new Map<string, AdvanceWork>();
    let retiring: RetiringScene | undefined;
    let cleaner: Cleaner | undefined;
    let columnPull: ColumnPull | undefined;
    const transit = doc.createElement('div');
    transit.className = 'pdfDocumentRobotTransit';
    transit.setAttribute('aria-hidden', 'true');
    // Layout containment makes visible descendant overflow ink, rather than scrollable area.
    // Keep it with size containment: https://www.w3.org/TR/css-contain-2/#containment-layout
    Object.assign(transit.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0',
        contain: 'layout size', pointerEvents: 'none', zIndex: '2147483647', overflow: 'visible' });
    const unregisterDocumentLayer = options.registerDocumentLayer?.(transit);
    const seen = new Set<number>();
    let visible = new Set<number>();
    let vehicleBag: RobotVehicle[] = [];
    let routeBag: number[] = [];
    let lastVehicle: RobotVehicle | undefined;
    let lastRoute = -1;
    let serial = 0;
    let payloadSerial = 0;
    let deliveryBag: Array<'solo' | 'pair' | 'trio' | 'handoff' | 'airlift'> = [];
    let enabled = true;
    let disposed = false;
    let frame: { id: number } | undefined;
    let dirty = false, painting = false;
    let lastPaint = -Infinity;
    let cargoBytes = 0;
    let peakCargoBytes = 0;
    let spriteBytes = 0;
    let frames = 0;
    let paintTotalMs = 0, paintMaxMs = 0, paintLastMs = 0;
    let sceneOrigin: Point = { x: 0, y: 0 };
    let stats = counters();
    const pendingDeposits: number[][] = [];
    let dispatchOrigin: RobotDispatchPort | undefined;
    let activePresentation: Presentation['kind'] | undefined;
    let capacityBlocked = false;
    let capacityFreed = false;
    let capacityOnMotionResume = false;
    let captionGroup: CaptionGroup | undefined;
    let captionTimer: number | undefined;
    let interaction: ReturnType<typeof installRobotInteraction> | undefined;
    let hovered: { id: number; point: RobotInteractionPoint; started: number } | undefined;
    let greeting: { id: number; started: number; until: number; line: string } | undefined;
    const hitBoxes = new Map<number, { x: number; y: number; radius: number; placement: BodyPlacement }>();
    let hitScrollLeft = 0, hitScrollTop = 0, hitColumn = 0;

    const hidden = () => doc.hidden || doc.visibilityState === 'hidden';
    const actorsOf = (episode: Episode) => episode.payloads.flatMap(payload => payload.helpers);
    const advanceActors = () => [...advance.values()].flatMap(work => work.actors);
    const currentActors = (): RobotBody[] => [...[...episodes.values()].flatMap(actorsOf), ...advanceActors().map(actor => actor.body),
        ...(columnPull ? [columnPull.body] : [])];
    const allActors = (): RobotBody[] => [...currentActors(), ...(retiring?.pieces.flatMap(piece => piece.payload.helpers) ?? [])];
    const actorCount = () => allActors().length + Number(!!cleaner);
    const moving = () => !!retiring || !!columnPull && columnPull.phase !== 'waiting' || !!greeting
        || episodes.size > 0 || [...advance.values()].some(work => work.actors.length && work.phase !== 'parked');
    const documentOffset = () => { const offset = options.documentOffset?.() ?? 0; return Number.isFinite(offset) ? offset : 0; };

    function viewportBounds(bounds = container.getBoundingClientRect()) {
        const visual = win.visualViewport;
        const left = Math.max(bounds.left, visual?.offsetLeft ?? 0);
        const top = Math.max(bounds.top, visual?.offsetTop ?? 0);
        const right = Math.min(bounds.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? win.innerWidth));
        const bottom = Math.min(bounds.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? win.innerHeight));
        return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
    }

    function syncSceneOrigin(bounds = container.getBoundingClientRect()): void {
        const origin = { x: bounds.left + (container.clientLeft || 0) - (container.scrollLeft || 0) + documentOffset(),
            y: bounds.top + (container.clientTop || 0) - (container.scrollTop || 0) };
        const dx = origin.x - sceneOrigin.x, dy = origin.y - sceneOrigin.y;
        // Parked points and promoted launches already belong to the document. Rebase their
        // saved screen coordinates after compositor scrolling, including while no RAF ran.
        for (const work of advance.values()) {
            for (const actor of work.actors) {
                actor.start.x += dx; actor.start.y += dy;
                actor.point.x += dx; actor.point.y += dy;
            }
            if (work.returnCarry) { rebaseCarry(work.returnCarry, dx, dy); }
        }
        for (const episode of episodes.values()) {
            for (const payload of episode.payloads) { if (payload.returnCarry) { rebaseCarry(payload.returnCarry, dx, dy); } }
        }
        for (const actor of currentActors()) {
            if (actor === columnPull?.body) { continue; }
            if (actor.origin) { actor.origin.x += dx; actor.origin.y += dy; }
            if (actor.launch) { actor.launch.x += dx; actor.launch.y += dy; }
        }
        sceneOrigin = origin;
    }

    function presentation(viewport = viewportBounds()): Presentation {
        const width = viewport.right - viewport.left, height = viewport.bottom - viewport.top;
        const screen = robotScreenMetrics({ width, height, devicePixelRatio: win.devicePixelRatio });
        const policy = DOCUMENT_ROBOT_LIMITS.desktop;
        const desktop = (options.device ?? pdfCachePolicy(win.navigator).name) === 'desktop'
            && screen.availableWidth >= policy.minWidth && screen.availableHeight >= policy.minHeight;
        const maxActors = desktop ? clamp(Math.round(width * height / policy.pixelsPerActor), policy.minActors, policy.maxActors)
            : DOCUMENT_ROBOT_LIMITS.maxActors;
        const maxCargoBytes = desktop ? policy.maxCargoBytes : DOCUMENT_ROBOT_LIMITS.maxCargoBytes;
        const document = robotDocumentMetrics(options.documentSize?.() ?? { width: 0, height: 0 }, desktop ? 'desktop' : 'compact');
        return {
            kind: desktop ? 'desktop' : 'compact',
            maxActors: clamp(Math.floor(options.maxActors ?? maxActors), 0, maxActors),
            maxCargoBytes: clamp(Math.floor(options.maxCargoBytes ?? maxCargoBytes), 0, maxCargoBytes),
            maxSpriteBytes: desktop ? policy.maxSpriteBytes : DOCUMENT_ROBOT_LIMITS.maxSpriteBytes,
            maxFragmentsPerPage: desktop ? policy.maxActors : DOCUMENT_ROBOT_LIMITS.maxFragmentsPerPage,
            fragmentDimension: desktop ? policy.fragmentDimension : DOCUMENT_ROBOT_LIMITS.fragmentDimension,
            spriteScale: (desktop ? clamp(width / policy.scaleWidth, policy.minSpriteScale, policy.spriteScale)
                : DOCUMENT_ROBOT_LIMITS.spriteScale) * screen.cssScale * document.bodyScale,
            spriteDpr: clamp(win.devicePixelRatio || 1, 1, DOCUMENT_ROBOT_LIMITS.maxDpr),
            documentScale: document.bodyScale,
            cargoEdge: document.cargoEdge,
            cleanerScale: (desktop ? DOCUMENT_ROBOT_LIMITS.cleaner.desktopScale : DOCUMENT_ROBOT_LIMITS.cleaner.compactScale)
                * screen.cssScale * document.bodyScale,
            minimumWidth: desktop ? 160 : 128,
            minimumHeight: desktop ? 120 : 96,
        };
    }

    function pagePresentation(policy: Presentation, size: RobotDocumentSize): Presentation {
        const document = robotDocumentMetrics(size, policy.kind);
        return { ...policy, spriteScale: policy.spriteScale / policy.documentScale * document.bodyScale,
            cleanerScale: policy.cleanerScale / policy.documentScale * document.bodyScale,
            documentScale: document.bodyScale, cargoEdge: document.cargoEdge };
    }

    function notifyCapacity(): void {
        const freed = capacityFreed;
        capacityFreed = false;
        if (!freed || !capacityBlocked || disposed || !enabled || hidden() || media.matches
            || actorCount() >= presentation().maxActors) { return; }
        capacityBlocked = false;
        options.onCapacityAvailable?.();
    }

    function geometry(element: HTMLElement, viewport = viewportBounds(), supplied?: PdfPageProjection): Geometry | undefined {
        const page = element.getBoundingClientRect();
        const projection = supplied ?? { content: { x: 0, y: 0, width: element.clientWidth || page.width,
            height: element.clientHeight || page.height }, clip: { x: 0, y: 0,
            width: element.clientWidth || page.width, height: element.clientHeight || page.height } };
        const { content, clip } = projection;
        const width = content.width, height = content.height;
        if (!(width > 0 && height > 0 && page.width > 0 && page.height > 0)) { return; }
        const originX = page.left + (element.clientLeft || 0), originY = page.top + (element.clientTop || 0);
        const pageLeft = originX + content.x, pageTop = originY + content.y;
        const left = clamp((Math.max(viewport.left, originX + clip.x) - pageLeft) / width, 0, 1);
        const top = clamp((Math.max(viewport.top, originY + clip.y) - pageTop) / height, 0, 1);
        const right = clamp((Math.min(viewport.right, originX + clip.x + clip.width) - pageLeft) / width, 0, 1);
        const bottom = clamp((Math.min(viewport.bottom, originY + clip.y + clip.height) - pageTop) / height, 0, 1);
        return right > left && bottom > top ? { width, height, left, top, right, bottom, pageLeft, pageTop, projection } : undefined;
    }

    function nextVehicle(): RobotVehicle {
        if (!vehicleBag.length) {
            vehicleBag = random.shuffle(ROBOT_VEHICLES.map(vehicle => vehicle.id));
            if (vehicleBag[0] === lastVehicle) { [vehicleBag[0], vehicleBag[1]] = [vehicleBag[1], vehicleBag[0]]; }
        }
        return lastVehicle = vehicleBag.shift()!;
    }

    function nextRoute(): number {
        if (!routeBag.length) {
            routeBag = random.shuffle([0, 1, 2, 3]);
            if (routeBag[0] === lastRoute) { [routeBag[0], routeBag[1]] = [routeBag[1], routeBag[0]]; }
        }
        return lastRoute = routeBag.shift()!;
    }

    function edge(route: number, area: Geometry, target: Point): Point {
        const spread = random.range(-0.16, 0.16);
        if (route === 0 || route === 2) {
            return { x: route === 0 ? area.left - 0.12 : area.right + 0.12,
                y: clamp(target.y + spread, area.top + 0.02, area.bottom - 0.02) };
        }
        return { x: clamp(target.x + spread, area.left + 0.02, area.right - 0.02),
            y: route === 1 ? area.top - 0.10 : area.bottom + 0.10 };
    }

    function selectCrops(source: HTMLCanvasElement, area: Geometry, policy: Presentation,
        imageRegions?: readonly DocumentRobotImageRegion[], projection?: PdfRasterProjection): Crop[] {
        const images = selectRobotImageCrops(imageRegions ?? [], area,
            { x: area.left, y: area.top, width: area.right - area.left, height: area.bottom - area.top },
            { bodyScale: policy.documentScale, cargoEdge: policy.cargoEdge });
        if (images.length) { return uniqueCrops(source, images, projection); }
        const width = Math.min(policy.kind === 'desktop' ? 0.36 : 0.24, policy.minimumWidth * policy.documentScale / area.width, (area.right - area.left) * 0.75);
        const height = Math.min(policy.kind === 'desktop' ? 0.24 : 0.16, policy.minimumHeight * policy.documentScale / area.height, (area.bottom - area.top) * 0.75);
        const candidates: Crop[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 3; column++) {
                const x = area.left + (area.right - area.left) * (column + 0.5) / 3;
                const y = area.top + (area.bottom - area.top) * (row + 0.5) / 4;
                candidates.push({ x: clamp(x - width / 2, area.left, area.right - width),
                    y: clamp(y - height / 2, area.top, area.bottom - height),
                    width, height, score: random.next() });
            }
        }
        let sample: HTMLCanvasElement | undefined;
        try {
            sample = createCanvas();
            const scale = DOCUMENT_ROBOT_LIMITS.sampleDimension / Math.max(source.width, source.height);
            sample.width = Math.max(1, Math.round(source.width * scale));
            sample.height = Math.max(1, Math.round(source.height * scale));
            const context = sample.getContext('2d', { willReadFrequently: true });
            if (!context) { return uniqueCrops(source, candidates, projection); }
            context.drawImage(source, 0, 0, sample.width, sample.height);
            const sampleProjection = resizePdfRasterProjection(projection ?? createPdfRasterProjection(source.width, source.height),
                sample.width, sample.height);
            const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
            const background = [pixels[0], pixels[1], pixels[2], pixels[3]];
            for (const crop of candidates) {
                let ink = 0, count = 0;
                const rectangle = projectPdfRasterCrop(sampleProjection, crop)?.pixels;
                if (!rectangle) { crop.score = 0; continue; }
                const left = rectangle.x, right = rectangle.x + rectangle.width;
                const top = rectangle.y, bottom = rectangle.y + rectangle.height;
                for (let y = top; y < bottom; y++) {
                    for (let x = left; x < right; x++) {
                        const at = (y * sample.width + x) * RGBA_BYTES;
                        ink += Math.abs(pixels[at] - background[0]) + Math.abs(pixels[at + 1] - background[1])
                            + Math.abs(pixels[at + 2] - background[2]) + Math.abs(pixels[at + 3] - background[3]);
                        count++;
                    }
                }
                crop.score += ink / Math.max(1, count);
            }
            // An empty page has nothing to deliver. Do not turn white rectangles into props.
            if (candidates.every(crop => crop.score < 1)) { return []; }
        } catch {
            // A canvas without readable pixels can still supply a bounded drawImage fragment.
        } finally { if (sample) { release(sample); } }
        return uniqueCrops(source, candidates.sort((a, b) => b.score - a.score), projection);
    }

    function drawVehicle(actor: RobotBody): void {
        const context = actor.sprite.getContext('2d');
        if (!context) { throw new Error('Robot artwork canvas is unavailable'); }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, actor.sprite.width, actor.sprite.height);
        context.setTransform(actor.sprite.width / ROBOT_ARTWORK_SIZE.width, 0, 0, actor.sprite.height / ROBOT_ARTWORK_SIZE.height, 0, 0);
        paintRobotVehicle(context, actor.pose, actor.started / 1000 + actor.id);
        context.setTransform(1, 0, 0, 1, 0, 0);
    }

    function spriteSize(policy: Presentation, origin?: RobotDispatchPoint) {
        const scale = Math.max(policy.spriteScale, origin?.scale ?? 0) * policy.spriteDpr;
        const width = Math.ceil(ROBOT_ARTWORK_SIZE.width * scale), height = Math.ceil(ROBOT_ARTWORK_SIZE.height * scale);
        return { width, height, bytes: width * height * RGBA_BYTES };
    }

    function resizeSprite(actor: RobotBody, policy: Presentation): boolean {
        const size = spriteSize(policy, actor.origin);
        actor.spriteScale = policy.spriteScale;
        if (actor.sprite.width === size.width && actor.sprite.height === size.height) { return true; }
        if (spriteBytes - actor.spriteBytes + size.bytes > policy.maxSpriteBytes) { return false; }
        actor.sprite.width = size.width; actor.sprite.height = size.height;
        spriteBytes += size.bytes - actor.spriteBytes;
        actor.spriteBytes = size.bytes;
        drawVehicle(actor);
        return true;
    }

    function initializeSceneNode(node: HTMLElement, className: string, zIndex: string): void {
        node.className = className;
        node.setAttribute('aria-hidden', 'true');
        // Admission can precede the next paint; reveal only after geometry is written.
        Object.assign(node.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', opacity: '0', zIndex });
    }

    function decorate(canvas: HTMLCanvasElement, className: string, zIndex: string): void {
        initializeSceneNode(canvas, className, zIndex);
        Object.assign(canvas.style, { transformOrigin: '50% 50%', willChange: 'transform, opacity' });
    }

    function clearCaption(): void {
        if (captionTimer !== undefined) { win.clearTimeout(captionTimer); captionTimer = undefined; }
        captionGroup?.node.remove();
        for (const leader of captionGroup?.leaders ?? []) { leader.remove(); }
        captionGroup = undefined;
        captionPlacement.reset();
        if (!episodes.size && !advance.size && !retiring && !columnPull) { transit.remove(); }
    }

    function expireCaption(group: CaptionGroup): void {
        if (captionTimer !== undefined) { win.clearTimeout(captionTimer); }
        // The one timeout owns only a DOM bubble, never animation, a canvas or a robot lease.
        captionTimer = win.setTimeout(() => {
            if (captionGroup !== group) { return; }
            captionTimer = undefined; clearCaption();
        }, Math.max(0, group.until - now()));
    }

    function detachCaption(): void {
        const group = captionGroup;
        if (!group) { return; }
        if (group.shownAt === undefined) { clearCaption(); return; }
        group.detached = true;
        for (const leader of group.leaders) { leader.remove(); }
        group.leaders = [];
        if (group.placement) { group.placement = { ...group.placement, leaders: [] }; }
    }

    function detachActorCaption(id: number): void {
        if (captionGroup?.actors.includes(id)) { detachCaption(); }
    }

    function clearOwnedCaption(actors: readonly RobotBody[]): void {
        if (captionGroup && actors.some(actor => captionGroup!.actors.includes(actor.id))) { clearCaption(); }
    }

    function sourceRectangle(source: HTMLCanvasElement, crop: Crop, supplied?: PdfRasterProjection) {
        const projection = supplied ?? createPdfRasterProjection(source.width, source.height);
        const rectangle = projectPdfRasterCrop(projection, crop);
        if (!rectangle) { return; }
        const { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight } = rectangle.pixels;
        return { sourceX, sourceY, sourceWidth, sourceHeight, projection };
    }

    function uniqueCrops(source: HTMLCanvasElement, crops: readonly Crop[], projection?: PdfRasterProjection): Crop[] {
        const rectangles = new Set<string>();
        return crops.filter(crop => {
            const rectangle = sourceRectangle(source, crop, projection);
            if (!rectangle) { return false; }
            const { sourceX, sourceY, sourceWidth, sourceHeight } = rectangle;
            const key = sourceX + ':' + sourceY + ':' + sourceWidth + ':' + sourceHeight;
            if (rectangles.has(key)) { return false; }
            rectangles.add(key);
            // Different placement IDs and clamped sample rows can copy the same pixels.
            // Keep the admitted crop's original destination and refine that one payload.
            return true;
        });
    }

    function rasterSize(source: HTMLCanvasElement, crop: Crop, mode: DeliveryMode, policy: Presentation, projection?: PdfRasterProjection) {
        const rectangle = sourceRectangle(source, crop, projection);
        if (!rectangle) { return; }
        const natural = pdfRasterCropSize(rectangle.projection, crop);
        const dimension = policy.fragmentDimension * (mode === 'solo' ? 1 : DOCUMENT_ROBOT_LIMITS.cooperative.rasterScale);
        const scale = Math.min(1, dimension / Math.max(natural.width, natural.height));
        const width = Math.max(1, Math.min(dimension, Math.ceil(natural.width * scale)));
        const height = Math.max(1, Math.min(dimension, Math.ceil(natural.height * scale)));
        return { ...rectangle, width, height, bytes: width * height * RGBA_BYTES,
            transform: pdfRasterToCrop(rectangle.projection, crop, width, height) };
    }

    function makePayload(source: HTMLCanvasElement, crop: Crop, area: Geometry, index: number,
        mode: DeliveryMode, policy: Presentation, ground: boolean, projection?: PdfRasterProjection): Payload | undefined {
        const size = rasterSize(source, crop, mode, policy, projection);
        if (!size) { return; }
        const { sourceX, sourceY, sourceWidth, sourceHeight, width, height, bytes, transform } = size;
        if (cargoBytes + bytes > policy.maxCargoBytes) { return; }
        let canvas: HTMLCanvasElement | undefined;
        try {
            canvas = createCanvas();
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', { alpha: true });
            if (!context) { return; }
            context.setTransform(...transform);
            context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, sourceX, sourceY, sourceWidth, sourceHeight);
            context.setTransform(1, 0, 0, 1, 0, 0);
            const route = ground || mode === 'airlift' ? random.next() < 0.5 ? 0 : 2 : nextRoute();
            const target = { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
            const start = edge(route, area, target), bend = random.range(-0.16, 0.16);
            const payload: Payload = {
                id: ++payloadSerial, mode, ground, route, crop, start,
                control: { x: (start.x + target.x) / 2 + bend, y: (start.y + target.y) / 2 - Math.abs(bend) },
                started: now(), delay: index * (policy.kind === 'desktop' ? random.range(40, 85) : random.range(90, 180)),
                duration: random.range(DOCUMENT_ROBOT_LIMITS.minDurationMs, DOCUMENT_ROBOT_LIMITS.maxDurationMs)
                    * (mode === 'solo' ? 1 : DOCUMENT_ROBOT_LIMITS.cooperative.durationScale),
                canvas, bytes, helpers: [], progress: 0, stage: mode === 'solo' ? 'carry' : 'rendezvous',
                deposited: false, handedOff: false, refinements: 0,
            };
            decorate(canvas, 'pdfDocumentRobotCargo', '1');
            canvas.dataset.payload = String(payload.id);
            Object.assign(canvas.style, { boxShadow: '0 2px 7px #0003', borderRadius: '0' });
            cargoBytes += bytes;
            peakCargoBytes = Math.max(peakCargoBytes, cargoBytes);
            canvas = undefined;
            return payload;
        } catch { return; }
        finally { if (canvas) { release(canvas); } }
    }

    function refine(value: DocumentRobotDelivery): number {
        if (disposed || !enabled || hidden() || !visible.has(value.pageNumber) || !value.canvas.width || !value.canvas.height) { return 0; }
        const episode = episodes.get(value.pageNumber);
        if (!episode || episode.element !== value.pageElement) { return 0; }
        if (value.pageProjection) { episode.pageProjection = value.pageProjection; }
        if (value.displayRasterProjection) { episode.displayRasterProjection = value.displayRasterProjection; }
        if (episode.pageProjection) {
            for (const payload of episode.payloads) { paintArrival(payload, episode.pageProjection, episode.displayRasterProjection); }
        }
        const policy = pagePresentation(presentation(), episode.pageProjection?.content ?? episode.pageSize);
        let count = 0;
        for (const payload of episode.payloads) {
            retireUncovered(payload, episode.element);
            const previous = payload.canvas;
            if (!previous || !previous.parentNode || now() >= payload.started + payload.delay + payload.duration * RETURN_START) { continue; }
            const size = rasterSize(value.canvas, payload.crop, payload.mode, policy, value.rasterProjection);
            if (!size) { continue; }
            const key = size.width + 'x' + size.height;
            if (size.width < previous.width || size.height < previous.height
                || size.width === previous.width && size.height === previous.height || payload.refinementAttempt === key
                || cargoBytes + size.bytes > policy.maxCargoBytes) { continue; }
            payload.refinementAttempt = key;
            let next: HTMLCanvasElement | undefined, committed = false;
            cargoBytes += size.bytes;
            peakCargoBytes = Math.max(peakCargoBytes, cargoBytes);
            try {
                next = createCanvas(); next.width = size.width; next.height = size.height;
                const context = next.getContext('2d', { alpha: true });
                if (!context) { throw new Error('Refined cargo canvas is unavailable'); }
                context.setTransform(...size.transform);
                context.drawImage(value.canvas, size.sourceX, size.sourceY, size.sourceWidth, size.sourceHeight,
                    size.sourceX, size.sourceY, size.sourceWidth, size.sourceHeight);
                context.setTransform(1, 0, 0, 1, 0, 0);
                decorate(next, 'pdfDocumentRobotCargo', '1');
                next.dataset.payload = String(payload.id); next.dataset.courier = String(payload.helpers[0].id);
                for (const property of ['width', 'height', 'opacity', 'transform', 'translate', 'boxShadow', 'borderRadius', 'clipPath'] as const) {
                    next.style[property] = previous.style[property];
                }
                previous.replaceWith(next);
                const oldBytes = payload.bytes;
                payload.canvas = next; payload.bytes = size.bytes; payload.refinements++;
                committed = true; next = undefined;
                stats.refinements++; count++;
                beginCleaner(payload, episode.page, policy);
                if (cleaner?.payload === payload && !payload.underlay) {
                    payload.underlay = { canvas: previous, bytes: oldBytes };
                    try {
                        payload.canvas!.before(previous);
                        previous.className = 'pdfDocumentRobotCargoUnderlay';
                        paintWipe(payload, cleaner.phase, cleaner.direction);
                    } catch { releaseCleaner(); }
                } else { release(previous); cargoBytes -= oldBytes; }
                requestPaint();
            } catch { stats.rejected++; }
            finally {
                if (!committed) { cargoBytes -= size.bytes; }
                if (next) { release(next); }
            }
        }
        return count;
    }

    function releaseCleaner(): void {
        const active = cleaner;
        if (!active) { return; }
        cleaner = undefined;
        finishRefinement(active.payload);
        release(active.sprite); spriteBytes -= active.bytes; capacityFreed = true;
    }

    function finishRefinement(payload: Payload): void {
        if (payload.canvas) { payload.canvas.style.clipPath = ''; }
        const underlay = payload.underlay;
        if (!underlay) { return; }
        payload.underlay = undefined;
        release(underlay.canvas); cargoBytes -= underlay.bytes;
    }

    function paintWipe(payload: Payload, phase: number, direction: -1 | 1): void {
        const underlay = payload.underlay;
        if (!underlay || !payload.canvas) { return; }
        for (const property of ['width', 'height', 'opacity', 'transform', 'translate'] as const) {
            underlay.canvas.style[property] = payload.canvas.style[property];
        }
        const remaining = ((1 - ease(phase)) * 100).toFixed(3) + '%';
        payload.canvas.style.clipPath = direction === 1 ? 'inset(0 ' + remaining + ' 0 0)' : 'inset(0 0 0 ' + remaining + ')';
    }

    function drawCleaner(active: Cleaner): void {
        const context = active.sprite.getContext('2d');
        if (!context) { throw new Error('ASAP artwork canvas is unavailable'); }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, active.sprite.width, active.sprite.height);
        context.setTransform(active.sprite.width / ASAP_CLEANER_ARTWORK_SIZE.width, 0, 0,
            active.sprite.height / ASAP_CLEANER_ARTWORK_SIZE.height, active.sprite.width / 2, active.sprite.height / 2);
        paintAsapCleaner(context, { phase: active.phase, direction: active.direction });
        context.setTransform(1, 0, 0, 1, 0, 0);
    }

    function beginCleaner(payload: Payload, page: number, policy: Presentation): void {
        const remaining = payload.started + payload.delay + payload.duration * RETURN_START - now();
        if (cleaner || payload.cleanerShown || media.matches || remaining < DOCUMENT_ROBOT_LIMITS.cleaner.minDurationMs
            || actorCount() >= policy.maxActors || !payload.canvas?.parentNode) { return; }
        const backingScale = policy.cleanerScale * policy.spriteDpr;
        const width = Math.ceil(ASAP_CLEANER_ARTWORK_SIZE.width * backingScale), height = Math.ceil(ASAP_CLEANER_ARTWORK_SIZE.height * backingScale);
        const bytes = width * height * RGBA_BYTES;
        if (spriteBytes + bytes > policy.maxSpriteBytes) { return; }
        payload.cleanerShown = true;
        let sprite: HTMLCanvasElement | undefined;
        try {
            sprite = createCanvas(); sprite.width = width; sprite.height = height;
            const active: Cleaner = { id: ++serial, page, payload, sprite, bytes, started: now(),
                duration: Math.min(remaining, DOCUMENT_ROBOT_LIMITS.cleaner.durationMs), phase: 0,
                direction: payload.route < 2 ? 1 : -1, drawn: 0 };
            drawCleaner(active);
            decorate(sprite, 'pdfDocumentRobotCleaner', '3');
            sprite.dataset.courier = String(active.id); sprite.dataset.payload = String(payload.id);
            payload.canvas.parentNode.appendChild(sprite);
            spriteBytes += bytes; cleaner = active; sprite = undefined;
        } catch { stats.rejected++; }
        finally { if (sprite) { release(sprite); } }
    }

    function paintCleaner(payload: Payload, point: Point, width: number, height: number, at: number, policy: Presentation): void {
        const active = cleaner;
        if (!active || active.payload !== payload) { return; }
        if (!payload.canvas || at >= active.started + active.duration) { releaseCleaner(); return; }
        active.phase = clamp((at - active.started) / active.duration, 0, 1);
        paintWipe(payload, active.phase, active.direction);
        try {
            const pose = Math.floor(active.phase * DOCUMENT_ROBOT_LIMITS.cleaner.gestureSteps);
            if (pose !== active.drawn) { active.drawn = pose; drawCleaner(active); }
            const scale = Math.min(policy.cleanerScale,
                width * 0.45 / ASAP_CLEANER_ARTWORK_SIZE.width, height * 0.7 / ASAP_CLEANER_ARTWORK_SIZE.height);
            const bodyWidth = ASAP_CLEANER_ARTWORK_SIZE.width * scale, bodyHeight = ASAP_CLEANER_ARTWORK_SIZE.height * scale;
            const amount = ease(active.phase), x = point.x + (amount - 0.5) * width * active.direction;
            const y = point.y + (amount - 0.5) * height * 0.35;
            Object.assign(active.sprite.style, { width: bodyWidth + 'px', height: bodyHeight + 'px',
                opacity: String(Math.min(1, active.phase / 0.12, (1 - active.phase) / 0.18)),
                transform: 'translate(' + (x - sceneOrigin.x - bodyWidth / 2).toFixed(2) + 'px,'
                    + (y - sceneOrigin.y - bodyHeight / 2).toFixed(2) + 'px)' });
        } catch { stats.rejected++; releaseCleaner(); }
    }

    function makeBody(used: ReadonlySet<RobotVehicle>, policy: Presentation, accepts = (_vehicle: RobotVehicle) => true,
        acceptsOrigin = (_vehicle: RobotVehicle, _origin?: RobotDispatchPoint) => true): RobotBody | undefined {
        let sprite: HTMLCanvasElement | undefined;
        let reserved: { port: RobotDispatchPort; vehicle: RobotVehicle } | undefined;
        try {
            let vehicle: RobotVehicle | undefined;
            let origin: RobotDispatchPoint | undefined;
            const unused = ROBOT_VEHICLES.some(spec => accepts(spec.id) && !used.has(spec.id));
            for (let attempt = 0; attempt < ROBOT_VEHICLES.length * 2; attempt++) {
                const candidate = nextVehicle();
                if (!accepts(candidate)) { continue; }
                if (used.has(candidate) && (dispatchOrigin || unused)) { continue; }
                const point = dispatchOrigin?.reserve(candidate);
                if (dispatchOrigin && !point) { continue; }
                if (!acceptsOrigin(candidate, point)) { if (point) { dispatchOrigin?.release(candidate); } continue; }
                vehicle = candidate;
                origin = point ? { ...point } : undefined;
                if (dispatchOrigin) { reserved = { port: dispatchOrigin, vehicle }; }
                break;
            }
            if (!vehicle) { return; }
            const size = spriteSize(policy, origin);
            if (spriteBytes + size.bytes > policy.maxSpriteBytes) { return; }
            sprite = createCanvas();
            sprite.width = size.width; sprite.height = size.height;
            const actor: RobotBody = {
                id: ++serial, vehicle, started: now(),
                sprite, spriteBytes: size.bytes, spriteScale: policy.spriteScale,
                departing: false, port: reserved?.port, origin,
                pose: { vehicle, x: ROBOT_ARTWORK_SIZE.width / 2, y: ROBOT_ARTWORK_SIZE.height / 2,
                    vx: 50, vy: 0, activity: 'navigate', job: 'delivery', temperament: 1,
                    phase: random.range(0, Math.PI * 2), distance: random.range(0, 80), needsHelp: false,
                    carrying: false, cargo: null, progress: 0, look: 1, notice: null },
            };
            drawVehicle(actor);
            decorate(sprite, 'pdfDocumentRobotVehicle', '2');
            sprite.dataset.courier = String(actor.id);
            if (origin) {
                // Replace the borrowed lab body at its current pose immediately. Animation
                // still waits for the shared paint gate, without leaving an empty dock.
                const scale = origin.scale ?? policy.spriteScale;
                const width = ROBOT_ARTWORK_SIZE.width * scale, height = ROBOT_ARTWORK_SIZE.height * scale;
                Object.assign(sprite.style, { width: width.toFixed(2) + 'px', height: height.toFixed(2) + 'px', opacity: '1',
                    transform: 'translate(' + (origin.x - sceneOrigin.x - width / 2).toFixed(2) + 'px,'
                        + (origin.y - sceneOrigin.y - height / 2).toFixed(2) + 'px) rotate(0deg)' });
            }
            spriteBytes += actor.spriteBytes;
            sprite = undefined;
            reserved = undefined;
            return actor;
        } catch { return; }
        finally {
            if (sprite) { release(sprite); }
            if (reserved) { reserved.port.release(reserved.vehicle); }
        }
    }

    function makeCourier(payload: Payload, area: Geometry, used: ReadonlySet<RobotVehicle>, policy: Presentation,
        staged: AdvanceActor[], preferredGround?: RobotVehicle): Courier | undefined {
        const accepts = (vehicle: RobotVehicle) => (payload.ground ? vehicle === 'forklift' : vehicle !== 'forklift')
            && !payload.helpers.some(helper => helper.vehicle === vehicle)
            && (payload.mode !== 'handoff' || ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air === (payload.helpers.length === 0))
            && (payload.mode !== 'airlift' || (payload.helpers.length === 0
                ? !ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air
                    && (!preferredGround || vehicle === preferredGround)
                    && (!!preferredGround || ROBOT_VEHICLES.some(spec => spec.air && !used.has(spec.id) && canCarryRobot(spec.id, vehicle)))
                : ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air && canCarryRobot(vehicle, payload.helpers[0].vehicle)));
        const acceptsOrigin = (vehicle: RobotVehicle, origin?: RobotDispatchPoint) => {
            if (!origin || payload.mode === 'airlift' || ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air) { return true; }
            const offset = cargoBodyOffset(vehicle, payload.helpers.length, policy.spriteScale, payload, area, 0);
            const target = { x: area.pageLeft + (payload.crop.x + payload.crop.width / 2) * area.width + offset.x,
                y: payload.ground ? area.pageTop + area.height - DOCUMENT_ROBOT_LIMITS.forklift.baseInset * policy.spriteScale
                    : area.pageTop + (payload.crop.y + payload.crop.height / 2) * area.height + offset.y };
            if (needsCargoAirlift(origin, target)) { return false; }
            if (payload.mode !== 'formation') { return true; }
            const ground = payload.helpers.find(helper => !ROBOT_VEHICLES.find(spec => spec.id === helper.vehicle)!.air
                && (helper.launch || helper.origin));
            if (!ground) { return true; }
            const launch = (ground.launch ?? ground.origin)!;
            const groundOffset = helperOffset(ground, area, 0);
            // A formation gathers at the first actual ground launch before carrying together.
            return !needsCargoAirlift(origin, { x: launch.x - groundOffset.x + offset.x,
                y: launch.y - groundOffset.y + offset.y });
        };
        const index = staged.findIndex(actor => !used.has(actor.body.vehicle) && accepts(actor.body.vehicle)
            && acceptsOrigin(actor.body.vehicle, actor.point));
        const waiting = index >= 0 ? staged.splice(index, 1)[0] : undefined;
        const body = waiting?.body ?? makeBody(new Set([...used, ...staged.map(actor => actor.body.vehicle)]), policy,
            vehicle => accepts(vehicle) && (payload.mode !== 'airlift' || payload.helpers.length > 0 || vehicle === 'lugv'), acceptsOrigin);
        if (!body) { return; }
        return promoteCourier(body, payload, area, waiting?.point);
    }

    function promoteCourier(body: RobotBody, payload: Payload, area: Geometry, launch?: RobotDispatchPoint): Courier | undefined {
        try {
            encounters.forget(body.id); detachActorCaption(body.id);
            if (launch) { body.launch = { ...launch }; }
            const target = { x: payload.crop.x + payload.crop.width / 2, y: payload.crop.y + payload.crop.height / 2 };
            const actor: Courier = Object.assign(body, { payload, slot: payload.helpers.length,
                departure: edge((payload.route + 1 + Math.floor(random.next() * 2)) % 4, area, target) });
            actor.pose.activity = 'deliver'; actor.pose.carrying = true;
            actor.pose.expression = undefined; actor.pose.gesturePhase = undefined; actor.pose.notice = null;
            actor.pose.look = payload.start.x < target.x ? 1 : -1;
            actor.sprite.dataset.payload = String(payload.id);
            drawVehicle(actor);
            return actor;
        } catch { releaseActor(body); return; }
    }

    function commitGroundDrive(body: RobotBody, from: Point, to: Point): void {
        if (ROBOT_VEHICLES.find(spec => spec.id === body.vehicle)!.air) { return; }
        body.drivingDirection = groundRouteDirection(from, to) ?? body.drivingDirection;
    }

    function rebaseCarry(carry: GroundCarry, dx: number, dy: number): void {
        carry.from.x += dx; carry.from.y += dy;
        carry.airFrom.x += dx; carry.airFrom.y += dy;
    }

    /** The caller adopts a new/staged body immediately. Existing payload helpers are never borrowed. */
    function recruitAircraft(ground: RobotBody, owned: readonly { body: RobotBody; point: Point }[], policy: Presentation,
        allowNew: boolean): { body: RobotBody; point?: Point & { scale?: number }; adopted: boolean } | undefined {
        const accepts = (vehicle: RobotVehicle) => ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air && canCarryRobot(vehicle, ground.vehicle);
        const existing = owned.find(value => accepts(value.body.vehicle));
        if (existing) { return { ...existing, adopted: false }; }
        if (!allowNew) { return; }
        for (const work of advance.values()) {
            if (work.phase === 'returning') { continue; }
            const index = work.actors.findIndex(actor => accepts(actor.body.vehicle));
            if (index < 0) { continue; }
            const actor = work.actors.splice(index, 1)[0];
            if (!work.actors.length) { work.phase = 'parked'; }
            work.message = advanceMessage(work); work.label.textContent = work.message;
            return { body: actor.body, point: { ...actor.point }, adopted: true };
        }
        if (actorCount() >= policy.maxActors) { return; }
        const body = makeBody(new Set(allActors().map(actor => actor.vehicle)), policy, accepts);
        return body ? { body, point: body.origin ? { ...body.origin } : undefined, adopted: true } : undefined;
    }

    function makeSling(): HTMLDivElement {
        const sling = doc.createElement('div');
        initializeSceneNode(sling, 'pdfDocumentRobotSling', '1');
        Object.assign(sling.style, { borderStyle: 'solid', borderWidth: '0 1.5px', borderColor: '#bdcdd1', boxSizing: 'border-box' });
        return sling;
    }

    function carryRoute(carry: GroundCarry, target: Point, progress: number): CargoRouteState {
        return carry.route = computeCargoRoute({ progress, from: carry.from, to: target, airFrom: carry.airFrom,
            cargoOffset: { x: 0, y: 0 }, airOffset: airliftOffset(carry.ground, carry.air),
            groundRun: CARGO_ROUTE_POLICY.defaultGroundRun * carry.ground.spriteScale, carryReason: carry.reason });
    }

    function releaseActor(actor: RobotBody): void {
        encounters.forget(actor.id);
        hitBoxes.delete(actor.id);
        if (hovered?.id === actor.id) { hovered = undefined; }
        if (greeting?.id === actor.id) { greeting = undefined; }
        detachActorCaption(actor.id);
        release(actor.sprite);
        spriteBytes -= actor.spriteBytes;
        capacityFreed = true;
        actor.port?.release(actor.vehicle);
        actor.port = undefined;
    }

    function clearColumnPull(): void {
        const active = columnPull;
        if (!active) { return; }
        columnPull = undefined;
        releaseActor(active.body);
        active.layer.remove();
        if (!episodes.size && !advance.size && !retiring && !captionGroup) { transit.remove(); }
    }

    function setColumnTransition(motion: Readonly<PdfDocumentColumnTransition> | undefined): void {
        if (!motion) {
            if (!columnPull) { return; }
            const end = columnPull.motion.startedAt + columnPull.motion.durationMs;
            if (now() + 0.01 < end) { clearColumnPull(); cancelFrameIfEmpty(); notifyCapacity(); }
            else {
                columnPull.returnAt ??= columnPull.motion.holdAtEnd ? now() : end;
                columnPull.motion = { ...columnPull.motion, holdAtEnd: false };
                // The column just wrote its final translation. Read geometry in the queued paint.
                dirty = true;
                schedule();
            }
            return;
        }
        const area = motion.bounds;
        if (disposed || !enabled || hidden() || media.matches || !area
            || ![motion.fromX, motion.toX, motion.startedAt, motion.durationMs, area.x, area.y, area.width, area.height].every(Number.isFinite)
            || motion.durationMs <= 0 || motion.durationMs > MOTION_LAB_CHOREOGRAPHY.columnDurationMs || area.width <= 0 || area.height <= 0
            || Math.abs(motion.toX - motion.fromX) < 0.5) { clearColumnPull(); return; }
        if (columnPull?.motion.id === motion.id) {
            const active = columnPull;
            active.motion = { ...active.motion, bounds: { ...area }, holdAtEnd: motion.holdAtEnd };
            if (motion.holdAtEnd) { active.returnAt = undefined; active.returnFrom = undefined; }
            else if (active.phase === 'waiting') { active.returnAt = now(); active.returnFrom = undefined; }
            // Geometry and continuation intent do not restart the committed leg.
            dirty = true; schedule();
            return;
        }
        clearRetiring(); releaseCleaner();
        // The controller supplies one page's content extent. Direct callers without
        // that information use the finite motion bounds as their presentation size.
        const documentSize = options.documentSize?.() ?? { width: area.width, height: area.height };
        const viewport = viewportBounds(), policy = pagePresentation(presentation(viewport), documentSize);
        const previous = columnPull;
        if (actorCount() - Number(!!previous) >= policy.maxActors
            || allActors().some(actor => actor !== previous?.body && actor.vehicle === 'forklift')) { clearColumnPull(); return; }
        const side: -1 | 1 = motion.toX < motion.fromX ? 1 : -1;
        const pull = ROBOT_FORKLIFT_ATTACHMENT.pull[side === 1 ? 'right' : 'left'];
        const top = Math.max(area.y, viewport.top), bottom = Math.min(area.y + area.height, viewport.bottom);
        const body = previous?.body ?? makeBody(new Set(allActors().map(actor => actor.vehicle)), policy, vehicle => vehicle === 'forklift',
            (_vehicle, origin) => !origin || origin.y + pull.y * ROBOT_FORKLIFT_ATTACHMENT.scale * policy.spriteScale >= top
                && origin.y + pull.y * ROBOT_FORKLIFT_ATTACHMENT.scale * policy.spriteScale <= bottom);
        if (!body) { return; }
        let layer = previous?.layer;
        try {
            syncSceneOrigin();
            const offsetX = documentOffset();
            // The compositor can advance between actor paints. Continue from the
            // displayed point while keeping this actor's sprite and Lab reservation.
            const displayed = previous && { ...previous.point, x: previous.point.x + offsetX - previous.offsetX };
            const laneY = displayed?.y ?? body.origin?.y ?? clamp(area.y + area.height * 0.8, top + 80, Math.max(top + 80, bottom - 35));
            const edgeX = area.x + (side === 1 ? 0 : area.width) + offsetX;
            const targetX = edgeX - pull.x * ROBOT_FORKLIFT_ATTACHMENT.scale * policy.spriteScale;
            const start = displayed ?? (body.origin ? { ...body.origin, scale: body.origin.scale ?? policy.spriteScale }
                : { x: targetX - side * 110, y: laneY, scale: policy.spriteScale });
            const opacity = previous?.opacity ?? (body.origin ? 1 : 0);
            if (!layer) {
                layer = doc.createElement('div');
                layer.className = 'pdfDocumentRobotColumnPull'; layer.setAttribute('aria-hidden', 'true');
                Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
                layer.append(body.sprite); container.append(transit); transit.append(layer);
            }
            columnPull = { motion: { ...motion, bounds: { ...area } }, documentSize: { ...documentSize }, body, layer, start,
                point: { ...start }, offsetX, startOpacity: opacity, opacity, laneY, side, phase: 'approach' };
            activePresentation = policy.kind;
            requestPaint();
        } catch {
            if (columnPull?.body === body) { clearColumnPull(); }
            else { releaseActor(body); layer?.remove(); }
            stats.rejected++;
        }
    }

    function paintColumnPull(at: number, viewport: ReturnType<typeof viewportBounds>, policy: Presentation,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, placements: BodyPlacement[]): void {
        const active = columnPull;
        if (!active) { return; }
        policy = pagePresentation(policy, active.documentSize);
        const { body, motion, side } = active;
        const end = motion.startedAt + motion.durationMs;
        if (!motion.holdAtEnd && at >= (active.returnAt ?? end) + DOCUMENT_ROBOT_LIMITS.advance.returnMs
            || actorCount() > policy.maxActors || !resizeSprite(body, policy)) {
            clearColumnPull(); return;
        }
        const pull = ROBOT_FORKLIFT_ATTACHMENT.pull[side === 1 ? 'right' : 'left'];
        const offsetX = documentOffset();
        const edgeX = motion.bounds!.x + (side === 1 ? 0 : motion.bounds!.width) + offsetX;
        const target = { x: edgeX - pull.x * ROBOT_FORKLIFT_ATTACHMENT.scale * policy.spriteScale, y: active.laneY };
        const progress = clamp((at - motion.startedAt) / motion.durationMs, 0, 1);
        const elapsed = motionLabColumnElapsed(at - motion.startedAt, motion.durationMs);
        const approach = motionLabEase(elapsed / MOTION_LAB_CHOREOGRAPHY.approachMs);
        let point = straight(active.start, target, approach);
        let scale = active.start.scale + (policy.spriteScale - active.start.scale) * approach;
        let opacity = active.startOpacity + (1 - active.startOpacity) * Math.min(1, progress * 15);
        active.phase = elapsed < MOTION_LAB_CHOREOGRAPHY.approachMs ? 'approach' : 'pull';
        if (at >= end && motion.holdAtEnd) {
            active.phase = 'waiting'; point = target; scale = policy.spriteScale; opacity = 1;
        } else if (at >= end || active.returnAt !== undefined) {
            active.returnAt ??= end;
            active.returnFrom ??= { ...target, scale: policy.spriteScale };
            active.phase = 'return';
            const amount = ease(clamp((at - active.returnAt) / DOCUMENT_ROBOT_LIMITS.advance.returnMs, 0, 1));
            const dock = destinations.get(body);
            const destination = dock && !needsCargoAirlift(active.returnFrom, dock) ? dock
                : { x: side === 1 ? viewport.left - 140 : viewport.right + 140, y: active.returnFrom.y, scale: policy.spriteScale };
            point = straight(active.returnFrom, destination, amount);
            scale = active.returnFrom.scale + ((destination.scale ?? policy.spriteScale) - active.returnFrom.scale) * amount;
            opacity = destination === dock ? 1 : 1 - amount;
        }
        active.point = { ...point, scale }; active.offsetX = offsetX; active.opacity = opacity;
        placements.push({ body, point, scale, opacity, tilt: 0, activity: active.phase === 'pull' ? 'assist' : 'navigate',
            carrying: false, progress: Math.round(progress * 12) / 12, look: side, phase: 'parked', fixed: true,
            remainingMs: active.phase === 'waiting' ? 0 : (active.returnAt ?? end) + DOCUMENT_ROBOT_LIMITS.advance.returnMs - at,
            pages: [...visible],
            pullDirection: active.phase === 'pull' ? side : undefined });
    }

    function paintArrival(payload: Payload, page: PdfPageProjection, displayed?: PdfRasterProjection): void {
        const cover = payload.cover;
        if (!cover || !payload.canvas) { return; }
        const dpr = Math.max(1, win.devicePixelRatio || 1);
        const raster = displayed ?? createPdfRasterProjection(Math.max(1, Math.ceil(page.content.width * dpr)),
            Math.max(1, Math.ceil(page.content.height * dpr)), page.content.width * dpr, page.content.height * dpr);
        // A magnified preview can carry filtered or encoded photo colour in the first outside source texel.
        // Extend only the cover footprint on the displayed raster's grid, including retained rotation.
        const sampled = projectPdfRasterCrop(raster, payload.crop, 1)?.sampled;
        const bounds = sampled && projectPdfPageRect(page, sampled);
        const density = Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
        const viewportScale = win.visualViewport?.scale ?? 1;
        const guard = 1 / (density * (Number.isFinite(viewportScale) && viewportScale > 0 ? viewportScale : 1));
        // A fractional CSS edge can leave one composited display pixel visible beyond that source-pixel margin.
        // Cover that pixel at the current pinch scale, without changing cargo sampling or the logical photo target.
        const mask = bounds && clipPdfPageRect(page, { x: bounds.x - guard, y: bounds.y - guard,
            width: bounds.width + guard * 2, height: bounds.height + guard * 2 });
        if (!mask) { releasePayload(payload); return; }
        for (const [property, value] of [['left', mask.x], ['top', mask.y], ['width', mask.width], ['height', mask.height]] as const) {
            const css = value + 'px';
            if (cover.style[property] !== css) { cover.style[property] = css; }
        }
    }

    function releaseLandingShadow(payload: Payload): void {
        payload.landingShadow?.remove(); payload.landingShadow = undefined;
    }

    function releasePayload(payload: Payload): void {
        releaseLandingShadow(payload);
        if (cleaner?.payload === payload) { releaseCleaner(); }
        finishRefinement(payload);
        payload.cover?.remove(); payload.cover = undefined;
        payload.mast?.remove(); payload.mast = undefined;
        if (!payload.canvas) { return; }
        release(payload.canvas); payload.canvas = undefined;
        cargoBytes -= payload.bytes;
        capacityFreed = true;
    }

    function depositPayload(payload: Payload): void {
        if (payload.deposited || !payload.canvas) { return; }
        payload.deposited = true;
        stats.deliveredFragments++;
        // Refinement or visibility refresh can reach the deadline before the queued paint.
        // Retain only numeric helper IDs for that paint's cue, never their leases or rasters.
        if (pendingDeposits.length < DOCUMENT_ROBOT_LIMITS.desktop.maxActors) {
            pendingDeposits.push(payload.helpers.map(actor => actor.id));
        }
        const parent = payload.canvas.parentNode, shown = Number(payload.canvas.style.opacity) > 0;
        const boxShadow = payload.canvas.style.boxShadow;
        releasePayload(payload);
        // Keep only the shadow during the existing settle interval. The native photo is
        // already uncovered and no copied bitmap or independent animation clock survives.
        const elapsed = now() - payload.started - payload.delay - payload.duration * DEPOSIT_START;
        if (!parent?.isConnected || !shown || elapsed >= MOTION_LAB_CHOREOGRAPHY.settleMs) { return; }
        let shadow: HTMLDivElement | undefined;
        try {
            shadow = doc.createElement('div');
            initializeSceneNode(shadow, 'pdfDocumentRobotLandingShadow', '1');
            shadow.dataset.payload = String(payload.id);
            Object.assign(shadow.style, { boxShadow, borderRadius: '0' });
            parent.appendChild(shadow);
            payload.landingShadow = shadow;
        } catch { shadow?.remove(); }
    }

    function paintLandingShadow(payload: Payload, area: Geometry, at: number): void {
        const shadow = payload.landingShadow;
        if (!shadow) { return; }
        const elapsed = at - payload.started - payload.delay - payload.duration * DEPOSIT_START;
        if (elapsed >= MOTION_LAB_CHOREOGRAPHY.settleMs) { releaseLandingShadow(payload); return; }
        const opacity = 1 - ease(clamp(elapsed / MOTION_LAB_CHOREOGRAPHY.settleMs, 0, 1));
        Object.assign(shadow.style, {
            width: payload.crop.width * area.width + 'px', height: payload.crop.height * area.height + 'px', opacity: String(opacity),
            transform: 'translate(' + (area.pageLeft + payload.crop.x * area.width - sceneOrigin.x).toFixed(4) + 'px,'
                + (area.pageTop + payload.crop.y * area.height - sceneOrigin.y).toFixed(4) + 'px)',
        });
    }

    function retireUncovered(payload: Payload, pageElement: HTMLElement | undefined): void {
        if (!payload.canvas) { return; }
        if (!payload.cover?.isConnected || payload.cover.parentNode !== pageElement) {
            releasePayload(payload);
        } else if (now() >= payload.started + payload.delay + payload.duration * DEPOSIT_START) {
            depositPayload(payload);
        }
    }

    /** PDF.js may remove page children during reset; only this live episode can restore its cover. */
    function restoreArrivals(pageNumber: number, pageElement: HTMLElement): void {
        const episode = episodes.get(pageNumber);
        if (disposed || !enabled || hidden() || !visible.has(pageNumber) || episode?.element !== pageElement) { return; }
        for (const payload of episode.payloads) {
            const cover = payload.cover;
            if (!payload.canvas || !cover) { continue; }
            if (!pageElement.isConnected || payload.deposited
                || cover.parentNode && cover.parentNode !== pageElement) { releasePayload(payload); continue; }
            if (now() >= payload.started + payload.delay + payload.duration * DEPOSIT_START) { depositPayload(payload); continue; }
            try { if (cover.parentNode !== pageElement) { pageElement.append(cover); } }
            catch { releasePayload(payload); }
        }
    }

    function dropPayload(payload: Payload): void {
        for (const actor of payload.helpers) { releaseActor(actor); }
        payload.helpers.length = 0;
        payload.returnCarry = undefined;
        releasePayload(payload);
        payload.sling?.remove(); payload.sling = undefined;
    }

    function clearRetiring(): void {
        const scene = retiring;
        if (!scene) { return; }
        retiring = undefined;
        clearOwnedCaption(scene.pieces.flatMap(piece => piece.payload.helpers));
        for (const piece of scene.pieces) { dropPayload(piece.payload); }
        scene.pieces.length = 0;
        scene.layer.remove();
        if (!episodes.size && !advance.size && !captionGroup && !columnPull) { transit.remove(); }
        options.onReplacementComplete?.(scene.identity);
    }

    function dropRetiringPiece(scene: RetiringScene, index: number, cancelled = true): void {
        const [piece] = scene.pieces.splice(index, 1);
        if (piece) {
            if (cancelled) { clearOwnedCaption(piece.payload.helpers); }
            dropPayload(piece.payload);
        }
        if (!scene.pieces.length && retiring === scene) { clearRetiring(); }
    }

    function reclaimRetiring(policy: Presentation): void {
        const wanted = Math.min(2, policy.maxActors), bytes = Math.min(policy.maxCargoBytes, policy.fragmentDimension ** 2 * RGBA_BYTES);
        const usedVehicles = () => new Set([...episodes.values()].flatMap(actorsOf)
            .concat(retiring?.pieces.flatMap(piece => piece.payload.helpers) ?? []).map(actor => actor.vehicle)).size;
        // Useful new delivery takes capacity from old teardown before it can be reported busy.
        while (retiring && (actorCount() - advanceActors().length + wanted > policy.maxActors
            || cargoBytes + bytes > policy.maxCargoBytes
            || dispatchOrigin && usedVehicles() + wanted > ROBOT_VEHICLES.length)) {
            dropRetiringPiece(retiring, 0);
        }
    }

    function retireDocument(values: readonly DocumentRobotDelivery[], identity: string): void {
        resetDocument();
        if (disposed || !enabled || hidden() || media.matches || !identity) {
            options.onReplacementComplete?.(identity); return;
        }
        const viewport = viewportBounds(), policy = presentation(viewport);
        if (!policy.maxActors || !policy.maxCargoBytes) { options.onReplacementComplete?.(identity); return; }
        syncSceneOrigin();
        const layer = doc.createElement('div');
        layer.className = 'pdfDocumentRobotRetiring'; layer.setAttribute('aria-hidden', 'true');
        Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'visible' });
        const scene: RetiringScene = { identity, layer, pieces: [], started: now() };
        retiring = scene;
        try {
            container.append(transit); transit.append(layer);
            const used = new Set<RobotVehicle>(), pages = new Set<number>();
            for (const value of values.slice(0, policy.maxActors)) {
                if (pages.has(value.pageNumber) || !Number.isSafeInteger(value.pageNumber) || value.pageNumber < 1
                    || !value.canvas.width || !value.canvas.height) { continue; }
                pages.add(value.pageNumber);
                const area = geometry(value.pageElement, viewport, value.pageProjection);
                if (!area || area.width * (area.right - area.left) < policy.minimumWidth
                    || area.height * (area.bottom - area.top) < policy.minimumHeight) { continue; }
                const pagePolicy = pagePresentation(policy, area);
                const crops = selectCrops(value.canvas, area, pagePolicy, value.imageRegions, value.rasterProjection)
                    .slice(0, policy.kind === 'desktop' ? DOCUMENT_ROBOT_LIMITS.replacement.fragmentsPerDesktopPage : 1);
                for (const crop of crops) {
                    if (actorCount() >= policy.maxActors) { break; }
                    const ground = area.bottom >= 0.98 && crop.y + crop.height / 2 >= 0.6 && !used.has('forklift');
                    const payload = makeDelivery(value.canvas, crop, area, scene.pieces.length, 'solo', 1, used, pagePolicy, [], ground,
                        value.rasterProjection);
                    if (!payload) { continue; }
                    payload.duration = DOCUMENT_ROBOT_LIMITS.replacement.durationMs;
                    payload.delay = Math.min(payload.delay, 200);
                    used.add(payload.helpers[0].vehicle);
                    scene.pieces.push({ page: value.pageNumber, payload,
                        area: { ...area, pageLeft: area.pageLeft - viewport.left, pageTop: area.pageTop - viewport.top } });
                    if (payload.mast) { layer.append(payload.mast); }
                    layer.append(payload.canvas!, ...payload.helpers.map(actor => actor.sprite));
                }
            }
            if (!scene.pieces.length) { clearRetiring(); return; }
            activePresentation = policy.kind;
            requestPaint();
        } catch { stats.rejected++; clearRetiring(); cancelFrameIfEmpty(); }
    }

    function dropEpisode(episode: Episode, cancelled: boolean): void {
        if (cancelled && captionGroup?.pages.has(episode.page)) { clearCaption(); }
        for (const payload of episode.payloads) { dropPayload(payload); }
        episode.payloads.length = 0;
        episode.layer.remove();
        episodes.delete(episode.page);
        if (!episodes.size && !advance.size && !retiring && !captionGroup && !columnPull) { transit.remove(); }
        if (cancelled) { stats.cancelledEpisodes++; }
    }

    function cancelFrameIfEmpty(): void {
        if (!episodes.size && !advance.size && !retiring && !columnPull) { dirty = false; }
        if (!moving() && !dirty && frame) { cancelFrame(frame.id); frame = undefined; }
    }

    function clearActive(): void {
        clearColumnPull();
        releaseCleaner();
        encounters.clear();
        traffic.reset();
        pendingDeposits.length = 0;
        hovered = undefined; greeting = undefined; hitBoxes.clear();
        interaction?.setEnabled(false);
        interaction?.setEnabled(enabled && !hidden() && !media.matches);
        clearCaption();
        capacityBlocked = false;
        capacityOnMotionResume = false;
        dirty = false;
        if (frame) { cancelFrame(frame.id); frame = undefined; }
        clearRetiring();
        for (const episode of [...episodes.values()]) { dropEpisode(episode, true); }
        for (const work of [...advance.values()]) { dropAdvance(work); }
        workLabelPlacement.reset();
        activePresentation = undefined;
        capacityFreed = false;
        lastPaint = -Infinity;
    }

    function resetDocument(): void {
        clearActive(); encounters.reset(); seen.clear(); visible.clear(); stats = counters();
        frames = 0; paintTotalMs = paintMaxMs = paintLastMs = peakCargoBytes = 0;
    }

    const pendingWorkPages = (work: AdvanceWork) => work.pages.filter(page => page.state === 'waiting' || page.state === 'preparing');

    function clearAdvanceCarry(work: AdvanceWork): void {
        work.returnCarry = undefined; work.sling?.remove(); work.sling = undefined;
    }

    function dropAdvance(work: AdvanceWork): void {
        for (const actor of work.actors) { releaseActor(actor.body); }
        work.actors.length = 0;
        clearAdvanceCarry(work);
        work.layer.remove();
        advance.delete(work.key);
        if (!episodes.size && !advance.size && !retiring && !captionGroup && !columnPull) { transit.remove(); }
    }

    function advanceGeometry(work: AdvanceWork, viewport = viewportBounds(), policy = presentation(viewport)) {
        const areas = work.pages.filter(page => page.pageElement.isConnected !== false)
            .map(page => ({ element: page.pageElement, area: geometry(page.pageElement, viewport) }))
            .filter((value): value is { element: HTMLElement; area: Geometry } => !!value.area
                && value.area.width * (value.area.right - value.area.left) >= policy.minimumWidth
                && value.area.height * (value.area.bottom - value.area.top) >= policy.minimumHeight);
        if (!areas.length) { return; }
        const left = Math.min(...areas.map(({ area }) => area.pageLeft + area.left * area.width));
        const right = Math.max(...areas.map(({ area }) => area.pageLeft + area.right * area.width));
        const top = Math.min(...areas.map(({ area }) => area.pageTop + area.top * area.height));
        const bottom = Math.max(...areas.map(({ area }) => area.pageTop + area.bottom * area.height));
        const element = work.anchor?.element ?? areas[0].element;
        if (element.isConnected === false) { return; }
        const reference = element.getBoundingClientRect();
        if (!(reference.width > 0 && reference.height > 0)) { return; }
        const pagePolicy = pagePresentation(policy, areas.find(value => value.element === element)?.area ?? reference);
        const scale = pagePolicy.spriteScale;
        const x = work.anchor ? reference.left + work.anchor.x * reference.width : (left + right) / 2;
        const y = work.anchor ? reference.top + work.anchor.y * reference.height : top + Math.min((bottom - top) * 0.35, 115 * scale);
        return { x, y, left, right, top, bottom, reference, element, policy: pagePolicy,
            stageLeft: work.anchor ? reference.left + work.anchor.left * reference.width : viewport.left,
            stageRight: work.anchor ? reference.left + work.anchor.right * reference.width : viewport.right,
            stageBottom: work.anchor ? reference.top + work.anchor.bottom * reference.height : viewport.bottom,
            signature: [left, right, top, bottom, x, y, scale].join(',') };
    }

    function advanceMessage(work: AdvanceWork): string {
        const pending = pendingWorkPages(work);
        if (!pending.length) { return ''; }
        const labels = pending.map(page => (page.label || String(page.pageNumber)).slice(0, 48));
        const operation = pending.some(page => page.state === 'preparing') ? 'Preparing' : 'Waiting for';
        const heading = operation + (pending.length === 1 ? ' page ' : ' pages ') + labels.join(' + ');
        return heading + (!work.actors.length ? '' : '\n' + (work.phase === 'arriving' ? 'Delivery crew assembling'
            : work.phase === 'coordinating' ? 'Coordinating the handoff' : 'Crew in position'));
    }

    function beginAdvanceReturn(work: AdvanceWork): void {
        if (!work.actors.length) { dropAdvance(work); return; }
        if (work.phase !== 'returning') {
            work.phase = 'returning'; work.returnAt = now();
            for (const actor of work.actors) {
                encounters.forget(actor.body.id); detachActorCaption(actor.body.id);
                actor.start = { ...actor.point };
            }
            work.label.style.opacity = '0';
        }
    }

    function advanceTarget(work: AdvanceWork, actor: AdvanceActor, index: number,
        area: NonNullable<ReturnType<typeof advanceGeometry>>): Point {
        const offset = actor.formationOffset ?? { x: (index - (work.actors.length - 1) / 2) * 102, y: index % 2 ? 9 : -9 };
        const target = { x: clamp(area.x + offset.x * area.policy.spriteScale, area.stageLeft + 35, area.stageRight - 35), y: area.y + offset.y };
        return ROBOT_VEHICLES.find(spec => spec.id === actor.body.vehicle)!.air ? target : clampGroundRoutePoint(actor.start, target);
    }

    function planAdvanceReturn(work: AdvanceWork, viewport: ReturnType<typeof viewportBounds>, policy: Presentation,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, at: number): void {
        if (work.returnPlanned) { return; }
        work.returnPlanned = true;
        const actor = work.actors.find(value => value.body.vehicle === 'lugv');
        if (!actor) { return; }
        const target = destinations.get(actor.body) ?? { x: viewport.right + 140, y: actor.start.y };
        const reason = cargoAirliftReason(actor.start, target, actor.body.vehicle, actor.body.drivingDirection);
        if (!reason) { commitGroundDrive(actor.body, actor.start, target); return; }
        const early = (at - work.returnAt!) / DOCUMENT_ROBOT_LIMITS.advance.returnMs < CARGO_ROUTE_POLICY.recruitEnd;
        const claim = recruitAircraft(actor.body, work.actors.map(value => ({ body: value.body, point: value.start })), policy, early);
        if (!claim) { commitGroundDrive(actor.body, actor.start, clampGroundRoutePoint(actor.start, target)); return; }
        if (claim.adopted && !resizeSprite(claim.body, policy)) { releaseActor(claim.body); return; }
        let adopted: AdvanceActor | undefined;
        try {
            const airFrom = claim.point ?? { x: actor.start.x + 90, y: actor.start.y - 140 * claim.body.spriteScale };
            if (claim.adopted) {
                const start = { ...airFrom, scale: claim.point?.scale ?? claim.body.spriteScale };
                adopted = { body: claim.body, start: { ...start }, point: { ...start } };
                work.actors.push(adopted); work.layer.append(claim.body.sprite);
            }
            const sling = makeSling(); work.layer.append(sling); work.sling = sling;
            work.returnCarry = { ground: actor.body, air: claim.body, from: { ...actor.start }, airFrom: { ...airFrom },
                groundScale: actor.start.scale, airScale: claim.point?.scale ?? claim.body.spriteScale, reason };
            for (const body of [actor.body, claim.body]) { encounters.forget(body.id); detachActorCaption(body.id); }
            if (reason !== 'turn') { commitGroundDrive(actor.body, actor.start, target); }
        } catch {
            work.sling?.remove(); work.sling = undefined;
            if (adopted) { work.actors.splice(work.actors.indexOf(adopted), 1); }
            if (claim.adopted) { releaseActor(claim.body); }
        }
    }

    function paintAdvance(work: AdvanceWork, at: number, viewport: ReturnType<typeof viewportBounds>, policy: Presentation,
        area: ReturnType<typeof advanceGeometry>, destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, placements: BodyPlacement[]): void {
        work.labelAnchor = undefined;
        if (!area) {
            if (captionGroup && work.pages.some(page => captionGroup!.pages.has(page.pageNumber))) { clearCaption(); }
            for (const actor of work.actors) { releaseActor(actor.body); }
            clearAdvanceCarry(work);
            work.actors.length = 0; work.phase = 'parked'; work.label.style.opacity = '0';
            return;
        }
        policy = area.policy;
        const timing = DOCUMENT_ROBOT_LIMITS.advance;
        const elapsed = at - work.started;
        if (work.phase === 'returning' && at - work.returnAt! >= timing.returnMs) { dropAdvance(work); return; }
        if (work.phase === 'returning') { planAdvanceReturn(work, viewport, policy, destinations, at); }
        const carry = work.returnCarry;
        const returnProgress = work.phase === 'returning' ? clamp((at - work.returnAt!) / timing.returnMs, 0, 1) : 0;
        const route = carry && carryRoute(carry, destinations.get(carry.ground)
            ?? { x: viewport.right + 140, y: carry.from.y }, returnProgress);
        if (carry && route && work.sling) { paintSling(work.sling, carry.ground, carry.air, route); }
        if (work.phase !== 'returning') {
            if (!work.actors.length || media.matches) { work.phase = 'parked'; }
            else if (work.gestureAt !== undefined) {
                work.phase = at - work.gestureAt < timing.coordinationMs ? 'coordinating' : 'parked';
                if (work.phase === 'parked') { work.gestureAt = undefined; }
            } else {
                work.phase = elapsed < timing.arrivalMs ? 'arriving'
                    : elapsed < timing.arrivalMs + timing.coordinationMs ? 'coordinating' : 'parked';
            }
            work.labelAnchor = {
                x: clamp(area.x, area.stageLeft + 70, area.stageRight - 70) - sceneOrigin.x,
                y: Math.min(area.stageBottom - 62, area.y + ROBOT_ARTWORK_SIZE.height * policy.spriteScale * 0.42) - sceneOrigin.y,
            };
        }
        work.message = advanceMessage(work);
        if (work.label.textContent !== work.message) { work.label.textContent = work.message; }
        for (let index = work.actors.length - 1; index >= 0; index--) {
            const actor = work.actors[index], body = actor.body;
            if (!resizeSprite(body, policy)) {
                if (carry && (body === carry.ground || body === carry.air)) { dropAdvance(work); return; }
                releaseActor(body); work.actors.splice(index, 1); continue;
            }
            const target = advanceTarget(work, actor, index, area);
            const air = ROBOT_VEHICLES.find(spec => spec.id === body.vehicle)!.air;
            body.carried = false;
            const arrival = ease(clamp(elapsed / timing.arrivalMs, 0, 1));
            let point: Point = air ? curve(actor.start, { x: target.x, y: actor.start.y }, target, arrival) : straight(actor.start, target, arrival);
            let scale = actor.start.scale + (policy.spriteScale - actor.start.scale) * arrival;
            let opacity = body.origin ? 1 : Math.min(1, arrival * 5), tilt = 0;
            if (work.phase === 'coordinating') {
                const progress = clamp((at - (work.gestureAt ?? work.started + timing.arrivalMs)) / timing.coordinationMs, 0, 1);
                const signal = Math.sin(progress * Math.PI);
                point = { x: target.x + signal * (index % 2 ? -7 : 7), y: target.y };
                tilt = signal * (index % 2 ? -4 : 4);
            } else if (work.phase === 'parked') { point = target; scale = policy.spriteScale; opacity = 1; }
            else if (work.phase === 'returning') {
                const progress = ease(clamp((at - work.returnAt!) / timing.returnMs, 0, 1));
                const destination = destinations.get(body);
                const end = destination && (air || !needsCargoAirlift(actor.start, destination)) ? destination
                    : { x: viewport.right + 140, y: actor.start.y, scale: policy.spriteScale };
                point = air ? curve(actor.start, { x: end.x, y: actor.start.y }, end, progress) : straight(actor.start, end, progress);
                scale = actor.start.scale + ((end.scale ?? policy.spriteScale) - actor.start.scale) * progress;
                opacity = end === destination ? 1 : 1 - progress;
                if (carry && route && (body === carry.ground || body === carry.air)) {
                    body.carried = body === carry.ground && route.groundCarried;
                    point = body === carry.ground ? route.ground : route.air;
                    const released = ease(clamp((returnProgress - CARGO_ROUTE_POLICY.setDownEnd) / (1 - CARGO_ROUTE_POLICY.setDownEnd), 0, 1));
                    const incomingScale = body === carry.ground ? carry.groundScale : carry.airScale;
                    const grownScale = incomingScale + (body.spriteScale - incomingScale) * ease(clamp(returnProgress / CARGO_ROUTE_POLICY.driveEnd, 0, 1));
                    scale = grownScale + ((destination?.scale ?? policy.spriteScale) - grownScale) * released;
                    if (body === carry.air && destination && !route.groundCarried && returnProgress >= CARGO_ROUTE_POLICY.setDownEnd) {
                        point = straight(route.air, destination, released);
                    }
                    opacity = destination ? 1 : 1 - progress;
                }
            }
            const paired = !!carry && !!route && (body === carry.ground || body === carry.air);
            const carrying = paired && body === carry!.air && route!.groundCarried;
            const activity = paired && route!.phase !== 'arrived' ? body === carry!.ground
                ? route!.phase === 'recruit' || route!.phase === 'rendezvous' ? 'signal' : route!.groundCarried ? 'park' : 'navigate'
                : route!.groundCarried ? 'assist' : route!.phase === 'rendezvous' ? 'load' : 'navigate'
                : work.phase === 'arriving' || work.phase === 'returning' ? 'navigate'
                : work.phase === 'coordinating' ? 'assist' : 'park';
            const look = work.actors.length > 1 ? index ? -1 : 1 : 1;
            const remainingMs = work.phase === 'returning' ? timing.returnMs - (at - work.returnAt!)
                : work.phase === 'parked' ? 0 : (work.gestureAt ?? work.started + timing.arrivalMs) + timing.coordinationMs - at;
            placements.push({ body, point, scale, opacity, tilt, activity, carrying, progress: 0, look,
                phase: paired || work.phase === 'parked' ? 'parked' : work.phase === 'returning' ? 'return' : 'advance', remainingMs,
                group: paired ? -(carry!.ground.id + 1) : undefined,
                pages: work.pages.map(page => page.pageNumber), advance: actor });
        }
        if (!work.actors.length) { work.phase = 'parked'; }
    }

    function setVisiblePages(ids: readonly number[], settings: { preserveReplacement?: boolean } = {}): void {
        if (!ids.length) { clearColumnPull(); }
        if (!ids.length && !settings.preserveReplacement) { clearRetiring(); }
        visible = new Set(ids);
        if (captionGroup && ![...captionGroup.pages].some(page => visible.has(page))) { clearCaption(); }
        for (const episode of [...episodes.values()]) {
            if (!visible.has(episode.page)) { dropEpisode(episode, true); }
            else { for (const payload of episode.payloads) { retireUncovered(payload, episode.element); } }
        }
        for (const work of [...advance.values()]) {
            work.pages = work.pages.filter(page => visible.has(page.pageNumber));
            if (!work.pages.length) { dropAdvance(work); }
        }
        cancelFrameIfEmpty();
        notifyCapacity();
    }

    function setVisibleWork(groups: readonly DocumentRobotWorkGroup[]): void {
        if (disposed || !enabled || hidden()) { return; }
        const valid = (page: DocumentRobotWorkPage) => Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0;
        setVisiblePages(groups.flatMap(group => group.pages.filter(valid).map(page => page.pageNumber)));
        const keys = new Set(groups.map(group => group.key));
        for (const work of [...advance.values()]) { if (!keys.has(work.key)) { dropAdvance(work); } }
        const bounds = container.getBoundingClientRect();
        syncSceneOrigin(bounds);
        const viewport = viewportBounds(bounds), policy = presentation(viewport);
        let changed = false;
        for (const group of groups) {
            const pages = group.pages.filter(valid);
            if (!pages.length) { continue; }
            let work = advance.get(group.key);
            const missing = pages.some(page => page.state === 'waiting' || page.state === 'preparing');
            if (!work && !missing) { continue; }
            if (!work) {
                const layer = doc.createElement('div'), label = doc.createElement('div');
                layer.className = 'pdfDocumentRobotAdvance';
                Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
                initializeSceneNode(label, 'pdfDocumentRobotWorkStatus', '3');
                Object.assign(label.style, { boxSizing: 'border-box',
                    borderRadius: '5px', border: '1px solid ' + ROBOT_CAPTION_STYLE.borderColor, background: ROBOT_CAPTION_STYLE.background,
                    color: ROBOT_CAPTION_STYLE.color, fontFamily: 'system-ui, sans-serif', fontWeight: String(ROBOT_CAPTION_STYLE.fontWeight),
                    textAlign: 'center', whiteSpace: 'pre-line', overflowWrap: 'anywhere',
                    boxShadow: '0 3px 12px #0002' });
                layer.append(label);
                work = { key: group.key, pages, layer, label, actors: [], phase: 'parked', started: now(),
                    admitted: false, signature: '', geometry: '', message: '' };
                advance.set(group.key, work);
                try { container.append(transit); transit.append(layer); }
                catch { work.admitted = true; stats.rejected++; }
            }
            const signature = pages.map(page => [page.pageNumber, page.label, page.state].join(':')).join(',');
            const stateChanged = signature !== work.signature;
            work.pages = pages; work.signature = signature;
            if (!missing) { beginAdvanceReturn(work); changed = true; continue; }
            const area = advanceGeometry(work, viewport, policy);
            const geometryChanged = (area?.signature ?? '') !== work.geometry;
            work.geometry = area?.signature ?? '';
            if (stateChanged && work.phase === 'parked' && work.actors.length) {
                work.gestureAt = now(); work.phase = 'coordinating';
            }
            if (!media.matches && area && !work.admitted && pages.some(page => !seen.has(page.pageNumber)
                && (page.state === 'waiting' || page.state === 'preparing'))) {
                const stagingLimit = Math.min(policy.kind === 'desktop' ? 4 : 2, Math.floor(policy.maxActors / 2));
                const crew = Math.min(policy.kind === 'desktop' ? DOCUMENT_ROBOT_LIMITS.advance.desktopCrew : DOCUMENT_ROBOT_LIMITS.advance.mobileCrew,
                    stagingLimit - advanceActors().length, policy.maxActors - actorCount());
                if (crew <= 0) { capacityBlocked = true; }
                else {
                    work.admitted = true;
                    const used = new Set(allActors().map(actor => actor.vehicle));
                    try {
                        for (let index = 0; index < crew; index++) {
                            const body = makeBody(used, area.policy);
                            if (!body) { break; }
                            const start = { ...(body.origin ?? { x: viewport.right + 90, y: area.y + index * 20 }),
                                scale: body.origin?.scale ?? area.policy.spriteScale };
                            work.actors.push({ body, start: { ...start }, point: { ...start } });
                            work.layer.append(body.sprite); used.add(body.vehicle);
                        }
                    } catch {
                        for (const actor of work.actors) { releaseActor(actor.body); }
                        work.actors.length = 0; stats.rejected++;
                    }
                    if (work.actors.length) {
                        work.actors.forEach((actor, index) => {
                            actor.formationOffset = { x: (index - (work!.actors.length - 1) / 2) * 102, y: index % 2 ? 9 : -9 };
                            commitGroundDrive(actor.body, actor.start, advanceTarget(work!, actor, index, area));
                        });
                        // The visible slice selects an entrance once. Later scrolls keep that
                        // destination on the same page, even when the viewport clips the page.
                        const reference = area.reference;
                        work.anchor = { element: area.element,
                            x: (area.x - reference.left) / reference.width, y: (area.y - reference.top) / reference.height,
                            left: (viewport.left - reference.left) / reference.width,
                            right: (viewport.right - reference.left) / reference.width,
                            bottom: (viewport.bottom - reference.top) / reference.height };
                        work.phase = 'arriving'; work.started = now(); activePresentation = policy.kind;
                    }
                    changed = true;
                }
            }
            changed ||= stateChanged || geometryChanged;
        }
        if (changed) { requestPaint(); }
        cancelFrameIfEmpty();
        schedule();
        notifyCapacity();
    }

    function takeAdvanceActors(pageNumber: number): AdvanceActor[] {
        const works = [...advance.values()].sort((a, b) => Number(b.pages.some(page => page.pageNumber === pageNumber))
            - Number(a.pages.some(page => page.pageNumber === pageNumber)));
        return works.flatMap(work => {
            const actors = work.actors.splice(0);
            clearAdvanceCarry(work);
            for (const actor of actors) { actor.body.carried = false; }
            work.phase = 'parked';
            work.message = advanceMessage(work); work.label.textContent = work.message;
            if (!pendingWorkPages(work).length) { dropAdvance(work); }
            return actors;
        });
    }

    function cargoBodyOffset(vehicle: RobotVehicle, slot: number, spriteScale: number,
        payload: Pick<Payload, 'ground' | 'mode' | 'crop'>, area: Geometry, progress: number): Point {
        const bodyScale = spriteScale / DOCUMENT_ROBOT_LIMITS.spriteScale;
        const air = ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air;
        if (payload.ground) { return { x: -FORKLIFT_ATTACHMENT_PX.cargoX * spriteScale,
            y: payload.crop.height * area.height / 2 - FORKLIFT_ATTACHMENT_PX.carryY * spriteScale }; }
        if (payload.mode === 'solo' || payload.mode === 'airlift') {
            return { x: air ? 0 : -29 * bodyScale, y: (air ? -34 : 25) * bodyScale };
        }
        const width = payload.crop.width * area.width, height = payload.crop.height * area.height;
        if (payload.mode === 'handoff') {
            const ground = { x: -width * 0.32, y: height * 0.35 + 20 * bodyScale };
            if (!air) { return ground; }
            const lower = ease(clamp((progress - HANDOFF_START) / (HANDOFF_END - HANDOFF_START), 0, 1));
            return { x: (ground.x - 12 * bodyScale) * lower,
                y: (-height * 0.45 - 22 * bodyScale) * (1 - lower) + (ground.y - 36 * bodyScale) * lower };
        }
        if (slot === 2) { return { x: 0, y: (air ? -1 : 1) * (height * 0.42 + 22 * bodyScale) }; }
        return { x: (slot === 0 ? -1 : 1) * (width * 0.42 + 10 * bodyScale),
            y: (air ? -1 : 1) * (height * 0.35 + 14 * bodyScale) };
    }

    function helperOffset(actor: Courier, area: Geometry, progress: number): Point {
        return cargoBodyOffset(actor.vehicle, actor.slot, actor.spriteScale, actor.payload, area, progress);
    }

    function cargoDestination(vehicle: RobotVehicle, slot: number, scale: number,
        payload: Pick<Payload, 'ground' | 'mode' | 'crop'>, area: Geometry, progress = 0): Point {
        const offset = cargoBodyOffset(vehicle, slot, scale, payload, area, progress);
        return { x: area.pageLeft + (payload.crop.x + payload.crop.width / 2) * area.width + offset.x,
            y: payload.ground ? area.pageTop + area.height - DOCUMENT_ROBOT_LIMITS.forklift.baseInset * scale
                : area.pageTop + (payload.crop.y + payload.crop.height / 2) * area.height + offset.y };
    }

    function airliftOffset(ground: RobotBody, air: RobotBody): Point {
        const attachment = ROBOT_AIRLIFT_ATTACHMENT;
        return { x: attachment.groundGrab.x * attachment.groundScale * ground.spriteScale
                - attachment.airGrab.x * attachment.airScale * air.spriteScale,
            y: attachment.groundGrab.y * attachment.groundScale * ground.spriteScale
                - attachment.airGrab.y * attachment.airScale * air.spriteScale };
    }

    function payloadPath(payload: Payload, area: Geometry, progress: number) {
        const project = (point: Point) => ({ x: area.pageLeft + point.x * area.width, y: area.pageTop + point.y * area.height });
        const target = project({ x: payload.crop.x + payload.crop.width / 2, y: payload.crop.y + payload.crop.height / 2 });
        const leader = payload.helpers[0];
        const offset = helperOffset(leader, area, 0);
        const launch = leader.launch ?? leader.origin;
        const initialScale = (launch?.scale ?? leader.spriteScale) / leader.spriteScale;
        let start = launch ? { x: launch.x - offset.x * initialScale, y: launch.y - offset.y * initialScale } : project(payload.start);
        let control = launch ? { x: (start.x + target.x) / 2 + (payload.route % 2 ? 70 : -70), y: Math.min(start.y, target.y) - 45 }
            : project(payload.control);
        const groundTeam = payload.helpers.some(actor => !ROBOT_VEHICLES.find(spec => spec.id === actor.vehicle)!.air);
        let groundStart = start;
        if (launch && !ROBOT_VEHICLES.find(spec => spec.id === leader.vehicle)!.air) {
            start = { x: launch.x - offset.x, y: launch.y - offset.y };
        }
        if (groundTeam && !payload.ground && payload.mode !== 'airlift') {
            const ground = payload.helpers.find(actor => !ROBOT_VEHICLES.find(spec => spec.id === actor.vehicle)!.air
                && (actor.launch || actor.origin));
            const groundLaunch = ground && (ground.launch ?? ground.origin);
            const groundOffset = ground && helperOffset(ground, area, 0);
            const edgeX = payload.route < 2 ? area.pageLeft - 80 : area.pageLeft + area.width + 80;
            groundStart = groundLaunch && groundOffset
                ? { x: groundLaunch.x - groundOffset.x, y: groundLaunch.y - groundOffset.y }
                : clampGroundRoutePoint(target, { x: edgeX, y: project(payload.start).y });
            if (payload.mode !== 'handoff') { start = groundStart; }
            control = { x: (start.x + target.x) / 2, y: (start.y + target.y) / 2 };
        }
        const rendezvous = groundTeam && payload.mode === 'handoff'
            ? straight(groundStart, target, 0.38) : curve(start, control, target, 0.38);
        const groundY = area.pageTop + area.height - DOCUMENT_ROBOT_LIMITS.forklift.baseInset * leader.spriteScale;
        let route: CargoRouteState | undefined;
        let point: Point;
        if (payload.mode === 'airlift') {
            const groundFrom = launch ?? { x: project(payload.start).x + offset.x, y: groundY };
            const air = payload.helpers[1], airFrom = air.launch ?? air.origin
                ?? { x: groundFrom.x + (payload.route === 0 ? -90 : 90), y: groundFrom.y - 140 * air.spriteScale };
            route = computeCargoRoute({ progress: clamp(progress / DEPOSIT_START, 0, 1),
                from: groundFrom, to: { x: target.x + offset.x, y: target.y + offset.y }, airFrom,
                cargoOffset: { x: -offset.x, y: -offset.y }, airOffset: airliftOffset(leader, air),
                bounds: { left: area.pageLeft - 50, right: area.pageLeft + area.width + 50 },
                groundRun: CARGO_ROUTE_POLICY.defaultGroundRun * leader.spriteScale, carryReason: payload.airliftReason });
            point = route.cargo;
        }
        else if (progress >= DEPOSIT_START) { point = target; }
        else if (payload.ground) {
            const timing = DOCUMENT_ROBOT_LIMITS.forklift;
            const carryY = groundY + FORKLIFT_ATTACHMENT_PX.carryY * leader.spriteScale - payload.crop.height * area.height / 2;
            const entrance = { x: launch ? target.x : project(payload.start).x, y: carryY }, dock = { x: target.x, y: carryY };
            const begin = launch ? timing.approachEnd : 0;
            if (progress < begin) { point = straight(start, entrance, ease(progress / begin)); }
            else if (progress < timing.liftStart) {
                point = curve(entrance, { x: (entrance.x + dock.x) / 2, y: carryY }, dock,
                    ease((progress - begin) / (timing.liftStart - begin)));
            } else { point = { x: target.x,
                y: carryY + (target.y - carryY) * ease((progress - timing.liftStart) / (DEPOSIT_START - timing.liftStart)) }; }
        }
        else if (payload.mode === 'handoff') {
            // Arbanas et al., Autonomous Robots (2018), doi:10.1007/s10514-018-9712-y:
            // rendezvous and parcel handoff finish before the ground vehicle transports the team.
            if (progress < HANDOFF_START) { point = curve(start, control, rendezvous, ease(progress / HANDOFF_START)); }
            else if (progress < HANDOFF_END) { point = rendezvous; }
            else { point = straight(rendezvous, target, ease((progress - HANDOFF_END) / (DEPOSIT_START - HANDOFF_END))); }
        } else {
            const begin = payload.mode === 'formation' ? RENDEZVOUS_END : 0;
            point = curve(start, control, target, ease(clamp((progress - begin) / (DEPOSIT_START - begin), 0, 1)));
        }
        return { start, control, target, groundStart, rendezvous, point, project, groundY, route };
    }

    function paintActor(actor: Courier, pageNumber: number, area: Geometry, path: ReturnType<typeof payloadPath>,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, viewport: ReturnType<typeof viewportBounds>, placements: BodyPlacement[]): void {
        const payload = actor.payload, progress = payload.progress;
        const air = ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!.air;
        const pair = progress >= RETURN_START ? payload.returnCarry : payload.mode === 'airlift'
            ? { ground: payload.helpers[0], air: payload.helpers[1] } : undefined;
        const paired = !!pair && (actor === pair.ground || actor === pair.air);
        const offset = helperOffset(actor, area, progress);
        const normalScale = actor.spriteScale;
        const launch = actor.launch ?? actor.origin;
        const originScale = launch?.scale ?? normalScale;
        const growthEnd = payload.mode === 'airlift' ? CARGO_ROUTE_POLICY.driveEnd * DEPOSIT_START : 0.20;
        let spriteScale = launch ? originScale + (normalScale - originScale) * ease(clamp(progress / growthEnd, 0, 1)) : normalScale;
        let robot = { x: path.point.x + offset.x, y: path.point.y + offset.y };
        actor.carried = false; actor.routePhase = undefined;
        if (paired && path.route) {
            robot = air ? path.route.air : path.route.ground;
            actor.carried = !air && path.route.groundCarried;
            actor.routePhase = path.route.phase;
        } else if (payload.mode === 'solo') {
            const offsetScale = air ? spriteScale / normalScale : 1;
            robot = { x: path.point.x + offset.x * offsetScale, y: path.point.y + offset.y * offsetScale };
            if (payload.ground && (!launch || progress >= DOCUMENT_ROBOT_LIMITS.forklift.approachEnd)) { robot.y = path.groundY; }
        } else if (payload.mode === 'handoff' && !air && progress < HANDOFF_START) {
            const destination = { x: path.rendezvous.x + offset.x, y: path.rendezvous.y + offset.y };
            const start = launch ?? { x: path.groundStart.x + offset.x, y: path.groundStart.y + offset.y };
            robot = straight(start, destination, ease(clamp(progress / RENDEZVOUS_END, 0, 1)));
        } else if (payload.mode === 'handoff' && !air && progress < HANDOFF_END) {
            robot = { x: path.rendezvous.x + offset.x, y: path.rendezvous.y + offset.y };
        } else if (payload.mode === 'formation' && progress < RENDEZVOUS_END) {
            const destination = { x: path.start.x + offset.x, y: path.start.y + offset.y };
            const start = launch ?? destination;
            robot = air ? curve(start, { x: destination.x, y: start.y }, destination, ease(progress / RENDEZVOUS_END))
                : straight(start, destination, ease(progress / RENDEZVOUS_END));
        } else if (launch && payload.mode === 'handoff' && air && progress < HANDOFF_START) {
            robot.x = path.point.x + offset.x * spriteScale / normalScale;
            robot.y = path.point.y + offset.y * spriteScale / normalScale;
        }
        let returningToLab = false;
        if (progress >= RETURN_START) {
            actor.departing = true;
            const destination = destinations.get(actor);
            returningToLab = !!destination;
            const returnProgress = ease((progress - RETURN_START) / (1 - RETURN_START));
            const destinationScale = destination?.scale ?? normalScale;
            if (paired && path.route) {
                const legProgress = (progress - RETURN_START) / (1 - RETURN_START);
                const releaseProgress = !path.route.requiresAir ? returnProgress
                    : ease(clamp((legProgress - CARGO_ROUTE_POLICY.setDownEnd)
                        / (1 - CARGO_ROUTE_POLICY.setDownEnd), 0, 1));
                const incomingScale = actor === pair!.ground ? payload.returnCarry!.groundScale : payload.returnCarry!.airScale;
                const grownScale = incomingScale + (normalScale - incomingScale) * ease(clamp(legProgress / CARGO_ROUTE_POLICY.driveEnd, 0, 1));
                spriteScale = grownScale + (destinationScale - grownScale) * releaseProgress;
                if (air && destination && !path.route.groundCarried
                    && (!path.route.requiresAir || path.route.phase === 'final-drive')) {
                    robot = straight(path.route.air, destination, releaseProgress);
                }
            } else {
                spriteScale = normalScale + (destinationScale - normalScale) * returnProgress;
                const from = { x: path.target.x + offset.x, y: payload.ground ? path.groundY : path.target.y + offset.y };
                const shallowDock = destination && (air || !needsCargoAirlift(from, destination));
                returningToLab = !!shallowDock;
                const departureTarget = shallowDock ? { x: destination.x, y: destination.y }
                    : air ? path.project(actor.departure)
                        : clampGroundRoutePoint(from, { x: payload.route < 2 ? viewport.left - 140 : viewport.right + 140,
                            y: path.project(actor.departure).y + offset.y });
                if (actor.port && !shallowDock && air) {
                const width = win.innerWidth || viewport.right, height = win.innerHeight || viewport.bottom;
                if (payload.route % 2) { departureTarget.y = payload.route === 1 ? -100 : height + 100; }
                else { departureTarget.x = payload.route === 0 ? -100 : width + 100; }
                }
                robot = air ? curve(from, { x: from.x, y: departureTarget.y }, departureTarget, returnProgress)
                    : straight(from, departureTarget, returnProgress);
            }
        }
        const photoLoaded = !!payload.canvas;
        const carrying = paired && air ? !!path.route?.groundCarried
            : photoLoaded && !(payload.mode === 'handoff' && (air ? payload.handedOff : !payload.handedOff));
        const lifting = photoLoaded && payload.ground && progress >= DOCUMENT_ROBOT_LIMITS.forklift.liftStart;
        const liftProgress = lifting ? Math.round(clamp((progress - DOCUMENT_ROBOT_LIMITS.forklift.liftStart)
            / (DEPOSIT_START - DOCUMENT_ROBOT_LIMITS.forklift.liftStart), 0, 1) * 12) / 12 : 0;
        const activity = paired && path.route && path.route.phase !== 'arrived'
            ? !air ? path.route.phase === 'recruit' || path.route.phase === 'rendezvous' ? 'signal'
                : path.route.groundCarried ? 'park' : 'navigate'
                : path.route.groundCarried ? 'assist' : path.route.phase === 'rendezvous' ? 'load' : 'navigate'
            : actor.departing || !photoLoaded && !payload.deposited ? 'navigate' : payload.deposited || lifting ? 'unload'
            : payload.mode === 'handoff' ? air ? payload.handedOff ? 'park' : 'deliver'
                : payload.handedOff ? 'deliver' : progress >= RENDEZVOUS_END ? 'load' : 'navigate'
                : payload.mode === 'formation' ? 'assist' : 'deliver';
        const opacity = Math.min(1, launch ? 1 : progress / 0.08, returningToLab ? 1 : (1 - progress) / 0.12);
        const tilt = air && !paired && !(payload.mode === 'handoff' && payload.handedOff && !actor.departing)
            ? clamp((path.target.x - path.start.x) / area.width * 9, -8, 8) * (carrying ? 1 : -0.5) : 0;
        placements.push({ body: actor, point: robot, scale: spriteScale, opacity, tilt, activity, carrying,
            progress: lifting ? liftProgress : payload.deposited ? 1 : 0, look: payload.start.x < payload.crop.x + payload.crop.width / 2 ? 1 : -1,
            phase: paired && actor.departing ? 'parked' : actor.departing ? 'return'
                : payload.deposited ? 'deposit' : photoLoaded ? 'cargo' : 'return',
            remainingMs: !photoLoaded ? (1 - progress) * payload.duration
                : Math.max(0, (payload.ground ? DOCUMENT_ROBOT_LIMITS.forklift.liftStart : DEPOSIT_START) - progress) * payload.duration,
            group: payload.id, pages: [pageNumber], payload,
            fixed: payload.deposited && !actor.departing || payload.ground && lifting || payload.stage === 'handoff' });
    }

    function planPayloadReturn(payload: Payload, area: Geometry, path: ReturnType<typeof payloadPath>, layer: HTMLElement,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, viewport: ReturnType<typeof viewportBounds>, policy: Presentation): void {
        if (payload.returnPlanned) { return; }
        payload.returnPlanned = true;
        const ground = payload.mode === 'airlift' ? payload.helpers[0] : payload.helpers.find(actor => actor.vehicle === 'lugv');
        if (!ground) { return; }
        const from = payload.mode === 'airlift' ? path.route!.ground
            : cargoDestination(ground.vehicle, ground.slot, ground.spriteScale, payload, area);
        const target = destinations.get(ground) ?? { x: payload.route < 2 ? viewport.left - 140 : viewport.right + 140,
            y: payload.mode === 'airlift' ? path.groundY : from.y };
        const reason = cargoAirliftReason(from, target, ground.vehicle, ground.drivingDirection);
        if (!reason && payload.mode !== 'airlift') { commitGroundDrive(ground, from, target); return; }
        const early = (payload.progress - RETURN_START) / (1 - RETURN_START) < CARGO_ROUTE_POLICY.recruitEnd;
        const claim = recruitAircraft(ground, payload.helpers.map(body => ({ body,
            point: payload.mode === 'airlift' && body === payload.helpers[1] ? path.route!.air
                : cargoDestination(body.vehicle, body.slot, body.spriteScale, payload, area, RETURN_START) })), policy, early);
        if (!claim) { commitGroundDrive(ground, from, clampGroundRoutePoint(from, target)); return; }
        if (claim.adopted && !resizeSprite(claim.body, policy)) { releaseActor(claim.body); return; }
        let adopted: Courier | undefined, sling: HTMLDivElement | undefined;
        try {
            const airFrom = claim.point ?? { x: from.x + 90, y: from.y - 140 * claim.body.spriteScale };
            if (claim.adopted) {
                adopted = promoteCourier(claim.body, payload, area, claim.point);
                if (!adopted) { return; }
                payload.helpers.push(adopted); layer.append(adopted.sprite);
            }
            if (!payload.sling) { sling = makeSling(); layer.append(sling); payload.sling = sling; }
            payload.returnCarry = { ground, air: claim.body, from: { ...from }, airFrom: { ...airFrom },
                groundScale: ground.spriteScale, airScale: claim.point?.scale ?? claim.body.spriteScale, reason };
            for (const body of [ground, claim.body]) { encounters.forget(body.id); detachActorCaption(body.id); }
            if (reason !== 'turn') { commitGroundDrive(ground, from, target); }
        } catch {
            if (sling) { sling.remove(); payload.sling = undefined; }
            if (adopted) { payload.helpers.splice(payload.helpers.indexOf(adopted), 1); releaseActor(adopted); }
        }
    }

    function paintPayload(payload: Payload, pageNumber: number, area: Geometry, at: number,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, viewport: ReturnType<typeof viewportBounds>,
        placements: BodyPlacement[], captionObstacles: SceneObstacle[], policy: Presentation): boolean {
        const episode = episodes.get(pageNumber);
        if (area.projection) { paintArrival(payload, area.projection, episode?.displayRasterProjection); }
        retireUncovered(payload, episodes.get(pageNumber)?.element);
        const elapsed = at - payload.started - payload.delay;
        if (elapsed < 0) {
            for (const actor of payload.helpers) { actor.sprite.style.opacity = '0'; }
            if (payload.canvas) { payload.canvas.style.opacity = '0'; }
            return true;
        }
        const progress = payload.progress = clamp(elapsed / payload.duration, 0, 1);
        if (progress >= 1) { return false; }
        payload.handedOff = payload.mode === 'handoff' && progress >= HANDOFF_END;
        payload.stage = progress >= RETURN_START ? 'return' : progress >= DEPOSIT_START ? 'deposit'
            : payload.ground && progress >= DOCUMENT_ROBOT_LIMITS.forklift.liftStart ? 'lift'
            : payload.mode === 'handoff' && progress >= HANDOFF_START && progress < HANDOFF_END ? 'handoff'
                : payload.mode !== 'solo' && progress < (payload.mode === 'handoff' ? HANDOFF_START : RENDEZVOUS_END) ? 'rendezvous' : 'carry';
        if (progress >= DEPOSIT_START) { depositPayload(payload); }
        if (progress >= RETURN_START) { releasePayload(payload); }
        else if (payload.cover) { payload.cover.style.opacity = '1'; }
        const path = payloadPath(payload, area, progress);
        paintLandingShadow(payload, area, at);
        if (progress >= RETURN_START && episode) {
            planPayloadReturn(payload, area, path, episode.layer, destinations, viewport, policy);
            const carry = payload.returnCarry;
            if (carry) {
                path.route = carryRoute(carry, destinations.get(carry.ground)
                    ?? { x: payload.route < 2 ? viewport.left - 140 : viewport.right + 140,
                        y: payload.mode === 'airlift' ? path.groundY : carry.from.y }, (progress - RETURN_START) / (1 - RETURN_START));
                if (payload.sling) { paintSling(payload.sling, carry.ground, carry.air, path.route); }
            }
        }
        if (path.route) {
            payload.routeState = path.route;
            if (payload.mode === 'airlift' && progress < DEPOSIT_START) {
                payload.stage = ['drive', 'recruit', 'rendezvous'].includes(path.route.phase) ? 'rendezvous'
                    : path.route.phase === 'lift' || path.route.phase === 'set-down' ? 'lift' : 'carry';
            }
            if (payload.mode === 'airlift' && progress < RETURN_START && payload.sling) {
                paintSling(payload.sling, payload.helpers[0], payload.helpers[1], path.route);
            }
        }
        for (const actor of payload.helpers) { paintActor(actor, pageNumber, area, path, destinations, viewport, placements); }
        if (payload.canvas) {
            const leader = payload.helpers[0];
            const initialScale = ((leader.launch ?? leader.origin)?.scale ?? leader.spriteScale) / leader.spriteScale;
            const scale = payload.deposited ? 1 : initialScale + (1 - initialScale) * ease(clamp(progress / 0.20, 0, 1));
            const width = payload.crop.width * area.width * scale, height = payload.crop.height * area.height * scale;
            payload.canvas.style.width = width + 'px'; payload.canvas.style.height = height + 'px';
            payload.canvas.style.opacity = String(payload.deposited ? clamp((RETURN_START - progress) / 0.10, 0, 1)
                : clamp(progress / (payload.mode === 'formation' ? RENDEZVOUS_END : 0.08), 0, 1));
            payload.canvas.style.transform = 'translate(' + (path.point.x - sceneOrigin.x - width / 2).toFixed(4) + 'px,'
                + (path.point.y - sceneOrigin.y - height / 2).toFixed(4) + 'px)';
            captionObstacles.push({ x: path.point.x - sceneOrigin.x - width / 2, y: path.point.y - sceneOrigin.y - height / 2,
                width, height, group: payload.id });
            if (cleaner?.payload === payload) { paintCleaner(payload, path.point, width, height, at, policy); }
            paintMast(payload, path.groundY, path.point, height,
                (leader.launch || leader.origin) && progress < DOCUMENT_ROBOT_LIMITS.forklift.approachEnd ? '0' : payload.canvas.style.opacity);
        }
        return true;
    }

    function paintMast(payload: Payload, groundY: number, point: Point, cargoHeight: number, opacity: string): void {
        if (!payload.mast) { return; }
        const scale = payload.helpers[0].spriteScale;
        const bottom = groundY + FORKLIFT_ATTACHMENT_PX.mastBottom * scale, cargoBottom = point.y + cargoHeight / 2;
        const top = Math.min(groundY + FORKLIFT_ATTACHMENT_PX.mastTop * scale, cargoBottom);
        Object.assign(payload.mast.style, {
            left: point.x + (FORKLIFT_ATTACHMENT_PX.mastLeft - FORKLIFT_ATTACHMENT_PX.cargoX) * scale - sceneOrigin.x + 'px',
            top: top - sceneOrigin.y + 'px', width: FORKLIFT_ATTACHMENT_PX.mastWidth * scale + 'px', height: Math.max(1, bottom - top) + 'px',
            borderWidth: '0 ' + FORKLIFT_ATTACHMENT_PX.railWidth * scale + 'px', opacity,
        });
        const fork = payload.mast.firstElementChild as HTMLElement;
        Object.assign(fork.style, { top: cargoBottom - top + 'px', width: FORKLIFT_ATTACHMENT_PX.forkWidth * scale + 'px',
            height: FORKLIFT_ATTACHMENT_PX.forkHeight * scale + 'px' });
    }

    function paintSling(sling: HTMLDivElement, ground: RobotBody, air: RobotBody, route: CargoRouteState): void {
        if (!route.groundCarried) { sling.style.opacity = '0'; return; }
        const attachment = ROBOT_AIRLIFT_ATTACHMENT;
        const width = attachment.slingWidth * ground.spriteScale;
        const top = route.air.y + 18 * attachment.airScale * air.spriteScale;
        const bottom = route.ground.y + attachment.groundGrab.y * attachment.groundScale * ground.spriteScale;
        Object.assign(sling.style, { left: route.ground.x - width / 2 - sceneOrigin.x + 'px',
            top: top - sceneOrigin.y + 'px', width: width + 'px', height: Math.max(1, bottom - top) + 'px', opacity: '1' });
    }

    function paintRetiring(scene: RetiringScene, at: number, viewport: ReturnType<typeof viewportBounds>, policy: Presentation,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, placements: BodyPlacement[], captionObstacles: SceneObstacle[]): void {
        const timing = DOCUMENT_ROBOT_LIMITS.replacement;
        for (let index = scene.pieces.length - 1; index >= 0; index--) {
            const piece = scene.pieces[index], payload = piece.payload;
            const pagePolicy = pagePresentation(policy, piece.area);
            try {
                const elapsed = at - payload.started - payload.delay;
                if (elapsed < 0) { continue; }
                const progress = payload.progress = clamp(elapsed / payload.duration, 0, 1);
                if (progress >= 1 || actorCount() > policy.maxActors || !payload.helpers.every(actor => resizeSprite(actor, pagePolicy))) {
                    dropRetiringPiece(scene, index, progress < 1); continue;
                }
                // PDF.js resets scrollTop before restoring its initial view. Only this short
                // retired scene stays in captured viewport coordinates; normal cargo is page-local.
                const area = { ...piece.area, pageLeft: viewport.left + piece.area.pageLeft, pageTop: viewport.top + piece.area.pageTop };
                const width = payload.crop.width * area.width, height = payload.crop.height * area.height;
                const target = { x: area.pageLeft + (payload.crop.x + payload.crop.width / 2) * area.width,
                    y: area.pageTop + (payload.crop.y + payload.crop.height / 2) * area.height };
                const leader = payload.helpers[0];
                const groundBody = !ROBOT_VEHICLES.find(spec => spec.id === leader.vehicle)!.air;
                const groundY = area.pageTop + area.height - DOCUMENT_ROBOT_LIMITS.forklift.baseInset * leader.spriteScale;
                const carryY = groundY + FORKLIFT_ATTACHMENT_PX.carryY * leader.spriteScale - height / 2;
                let exit = { x: payload.route === 0 ? viewport.left - width - 100 : payload.route === 2 ? viewport.right + width + 100 : target.x,
                    y: payload.ground ? carryY : groundBody ? target.y
                        : payload.route === 1 ? viewport.top - height - 100 : payload.route === 3 ? viewport.bottom + height + 100 : target.y };
                if (groundBody && !payload.ground) {
                    exit = clampGroundRoutePoint(target, { x: payload.route < 2 ? viewport.left - width - 100 : viewport.right + width + 100,
                        y: area.pageTop + payload.start.y * area.height });
                }
                let point = target;
                const begin = payload.ground ? timing.lowerEnd : timing.pickupEnd;
                if (payload.ground && progress >= timing.pickupEnd && progress < begin) {
                    point = { x: target.x, y: target.y + (carryY - target.y) * ease((progress - timing.pickupEnd) / (begin - timing.pickupEnd)) };
                } else if (progress >= begin) {
                    const from = { x: target.x, y: payload.ground ? carryY : target.y };
                    point = curve(from, { x: (from.x + exit.x) / 2, y: groundBody ? (from.y + exit.y) / 2 : Math.min(from.y, exit.y) - 45 }, exit,
                        ease(clamp((progress - begin) / (RETURN_START - begin), 0, 1)));
                }
                payload.stage = progress < timing.pickupEnd ? 'rendezvous' : progress >= RETURN_START ? 'return' : 'carry';
                if (progress >= RETURN_START && !payload.deposited) {
                    if (payload.canvas) { stats.removedFragments++; }
                    payload.deposited = true; releasePayload(payload);
                }
                if (payload.canvas) {
                    const opacity = clamp(progress / 0.08, 0, 1);
                    Object.assign(payload.canvas.style, { width: width + 'px', height: height + 'px', opacity: String(opacity),
                        transform: 'translate(' + (point.x - sceneOrigin.x - width / 2).toFixed(2) + 'px,'
                            + (point.y - sceneOrigin.y - height / 2).toFixed(2) + 'px)' });
                    captionObstacles.push({ x: point.x - sceneOrigin.x - width / 2, y: point.y - sceneOrigin.y - height / 2, width, height });
                    paintMast(payload, groundY, point, height, progress < timing.pickupEnd ? '0' : String(opacity));
                }
                for (const actor of payload.helpers) {
                    const offset = helperOffset(actor, area, 0), normalScale = actor.spriteScale;
                    const pickup = { x: target.x + offset.x, y: payload.ground ? groundY : target.y + offset.y };
                    const origin = actor.origin ?? { x: exit.x + offset.x, y: payload.ground ? groundY : exit.y + offset.y, scale: normalScale };
                    let robot = { x: point.x + offset.x, y: payload.ground ? groundY : point.y + offset.y };
                    let scale = normalScale, returningToLab = false;
                    if (progress < timing.pickupEnd) {
                        const amount = ease(progress / timing.pickupEnd);
                        robot = groundBody ? straight(origin, pickup, amount) : curve(origin, { x: pickup.x, y: origin.y }, pickup, amount);
                        scale = (origin.scale ?? normalScale) + (normalScale - (origin.scale ?? normalScale)) * amount;
                    } else if (progress >= RETURN_START) {
                        actor.departing = true;
                        const destination = destinations.get(actor);
                        returningToLab = !!destination && (!groundBody || !needsCargoAirlift(robot, destination));
                        if (destination && returningToLab) {
                            const amount = ease((progress - RETURN_START) / (1 - RETURN_START));
                            robot = groundBody ? straight(robot, destination, amount) : curve(robot, { x: robot.x, y: destination.y }, destination, amount);
                            scale = normalScale + ((destination.scale ?? normalScale) - normalScale) * amount;
                        }
                    }
                    placements.push({ body: actor, point: robot, scale,
                        opacity: Math.min(1, actor.origin ? 1 : progress / 0.08, returningToLab ? 1 : (1 - progress) / 0.12),
                        tilt: 0, activity: !payload.canvas ? 'navigate' : progress < timing.pickupEnd ? 'load' : 'deliver',
                        carrying: progress >= timing.pickupEnd && !!payload.canvas, progress: 0,
                        look: exit.x < target.x ? -1 : 1, phase: 'parked', fixed: true, remainingMs: (1 - progress) * payload.duration,
                        group: payload.id, pages: [piece.page] });
                }
            } catch { stats.rejected++; dropRetiringPiece(scene, index); }
        }
    }

    function paintWorkLabels(placements: readonly BodyPlacement[], viewport: ReturnType<typeof viewportBounds>, obstacles: readonly PlacementRect[]): void {
        const bounds = { x: viewport.left - sceneOrigin.x + 8, y: viewport.top - sceneOrigin.y + 8,
            width: viewport.right - viewport.left - 16, height: viewport.bottom - viewport.top - 16 };
        const labels: LabelPlacementInput[] = [];
        const nodes = new Map<string, HTMLDivElement>();
        const metrics = robotCaptionMetrics({ devicePixelRatio: win.devicePixelRatio });
        for (const work of advance.values()) {
            work.label.style.opacity = '0';
            if (!work.labelAnchor || work.phase === 'returning' || !work.message || bounds.width < 100 || bounds.height <= 0
                || labels.length >= LABEL_PLACEMENT_LIMITS.labels - 1) { continue; }
            const maxWidth = Math.min(224, bounds.width);
            const key = [work.message, maxWidth, metrics.fontSize, metrics.lineHeight].join('|');
            if (work.labelSize?.key !== key) {
                Object.assign(work.label.style, { fontSize: metrics.fontSize + 'px', lineHeight: metrics.lineHeight + 'px',
                    padding: metrics.paddingY + 'px ' + metrics.paddingX + 'px', width: 'max-content',
                    maxWidth: maxWidth + 'px', height: 'auto' });
                const measured = work.label.getBoundingClientRect();
                work.labelSize = { key, width: measured.width, height: measured.height };
                work.label.style.height = measured.height + 'px';
            }
            const { width, height } = work.labelSize;
            if (!(width > 0 && height > 0)) { continue; }
            const id = 'work:' + work.key;
            nodes.set(id, work.label);
            labels.push({ id, anchor: work.labelAnchor, width, height, radius: 6, clearance: 4,
                priority: work.pages.some(page => page.state === 'preparing') ? 2 : 1, leaderAnchors: [] });
        }
        if (bounds.width <= 0 || bounds.height <= 0) { workLabelPlacement.reset(); return; }
        // Reserve the visible speech rectangle first, including a static bubble whose robots
        // already returned. Clip it to the viewport so it always consumes exactly one slot.
        const speech = captionGroup?.node.style.opacity === '1' ? captionGroup.placement : undefined;
        let reserved = false;
        if (speech) {
            const x = Math.max(bounds.x, speech.x), y = Math.max(bounds.y, speech.y);
            const width = Math.min(bounds.x + bounds.width, speech.x + speech.width) - x;
            const height = Math.min(bounds.y + bounds.height, speech.y + speech.height) - y;
            if (width > 0 && height > 0) {
                const center = { x: x + width / 2, y: y + height / 2 };
                labels.push({ id: 'speech', anchor: center, width, height, priority: 3,
                    candidates: [{ ...center, base: center }], leaderAnchors: [] });
                reserved = true;
            }
        }
        const bodies = placements.filter(value => value.opacity > 0.2).map(value => ({
            x: value.point.x - sceneOrigin.x - ROBOT_ARTWORK_SIZE.width * value.scale / 2,
            y: value.point.y - sceneOrigin.y - ROBOT_ARTWORK_SIZE.height * value.scale / 2,
            width: ROBOT_ARTWORK_SIZE.width * value.scale, height: ROBOT_ARTWORK_SIZE.height * value.scale,
        }));
        const placed = workLabelPlacement.layout({ now: now(), bounds, labels, obstacles: [...bodies, ...obstacles], maxVisible: reserved ? 2 : 1 });
        for (const placement of placed) {
            const node = nodes.get(placement.id);
            if (node) { Object.assign(node.style, { left: placement.x + 'px', top: placement.y + 'px', opacity: placement.blocked ? '0' : '1' }); }
        }
    }

    function paintCaption(placements: readonly BodyPlacement[], reactions: ReadonlyMap<number, RobotEncounterReaction>,
        viewport: ReturnType<typeof viewportBounds>, policy: Presentation, obstacles: readonly PlacementRect[]): void {
        const at = now();
        if (captionGroup && at >= captionGroup.until) { clearCaption(); }
        const { fontSize, lineHeight, paddingX, paddingY } = robotCaptionMetrics({ devicePixelRatio: win.devicePixelRatio });
        const width = Math.min(policy.kind === 'desktop' ? 256 : 224, viewport.right - viewport.left - 20);
        const measurementKey = [width, fontSize, lineHeight].join(',');
        if (captionGroup?.shownAt !== undefined && captionGroup.measurementKey !== measurementKey) {
            // A changed layout invalidates even a detached caption's last readable box.
            clearCaption(); return;
        }
        const selected = placements.find(value => reactions.get(value.body.id)?.caption
            && reactions.get(value.body.id)!.captionId === captionGroup?.id)
            ?? placements.find(value => reactions.get(value.body.id)?.caption);
        const captionId = selected && reactions.get(selected.body.id)!.captionId;
        if (captionGroup && captionId !== captionGroup.id) {
            // An explicit greeting may replace a hover hint. Ordinary cues wait for the
            // current readable text to expire; they do not queue or take its ownership.
            if (captionId?.startsWith('greet:') && captionGroup.id.startsWith('hover:')) { clearCaption(); }
            else { detachCaption(); return; }
        }
        if (captionGroup?.detached) { return; }
        const participating = captionId === undefined ? [] : placements.filter(value => reactions.get(value.body.id)?.captionId === captionId);
        const speakers = participating.filter(value => reactions.get(value.body.id)!.caption);
        if (!speakers.length) {
            detachCaption();
            return;
        }
        const first = reactions.get(speakers[0].body.id)!;
        if (first.captionUntil <= at) { detachCaption(); return; }
        const lines = speakers.map(value => ROBOT_VEHICLES.find(spec => spec.id === value.body.vehicle)!.name
            + ': ' + reactions.get(value.body.id)!.caption);
        if (width < 100) { clearCaption(); return; }
        if (captionGroup?.id !== first.captionId) {
            clearCaption();
            const node = doc.createElement('div');
            initializeSceneNode(node, 'pdfDocumentRobotCaption', '4');
            Object.assign(node.style, { boxSizing: 'border-box',
                padding: paddingY + 'px ' + paddingX + 'px', borderRadius: '5px', border: '1px solid ' + ROBOT_CAPTION_STYLE.borderColor,
                background: ROBOT_CAPTION_STYLE.background, color: ROBOT_CAPTION_STYLE.color,
                fontFamily: 'system-ui, sans-serif', fontWeight: String(ROBOT_CAPTION_STYLE.fontWeight),
                textAlign: 'center', whiteSpace: 'pre-line', overflowWrap: 'anywhere', boxShadow: '0 2px 8px #0002' });
            const text = lines.join('\n');
            if (node.textContent !== text) { node.textContent = text; }
            const group: CaptionGroup = { id: first.captionId, node, until: first.captionUntil,
                readMs: first.captionUntil - at, detached: false,
                actors: participating.map(value => value.body.id), pages: new Set(participating.flatMap(value => [...value.pages])),
                lines: new Map(speakers.map(value => [value.body.id, reactions.get(value.body.id)!.caption])),
                measurementKey: '', width: 0, height: 0, leaders: [] };
            captionGroup = group;
            transit.append(node);
            // An unseen cue has the source's original finite expiry. First visibility
            // starts its readable interval once, without extending the actor's lifetime.
            expireCaption(group);
        }
        const group = captionGroup!, caption = group.node;
        if (group.measurementKey !== measurementKey) {
            group.measurementKey = measurementKey;
            Object.assign(caption.style, { fontSize: fontSize + 'px', lineHeight: lineHeight + 'px',
                width: width + 'px', height: 'auto', opacity: '0' });
            // Read wrapped text once per text/font/width combination; motion uses these cached dimensions.
            const measured = caption.getBoundingClientRect();
            group.width = measured.width;
            group.height = measured.height;
            caption.style.height = group.height + 'px';
        }
        const height = group.height;
        if (!(group.width > 0 && height > 0) || height > viewport.bottom - viewport.top - 16) {
            if (group.shownAt !== undefined) { detachCaption(); return; }
            caption.style.opacity = '0';
            for (const leader of group.leaders) { leader.style.opacity = '0'; }
            return;
        }
        const point = (value: BodyPlacement) => ({ x: value.point.x - sceneOrigin.x, y: value.point.y - sceneOrigin.y });
        const anchors = speakers.map(value => {
            const center = point(value);
            return { x: center.x, y: center.y - ROBOT_ARTWORK_SIZE.height * value.scale * 0.28 };
        });
        const anchor = { x: anchors.reduce((sum, value) => sum + value.x, 0) / anchors.length,
            y: anchors.reduce((sum, value) => sum + value.y, 0) / anchors.length };
        const bodies = placements.filter(value => value.opacity > 0.2).map(value => {
            const center = point(value), width = ROBOT_ARTWORK_SIZE.width * value.scale, height = ROBOT_ARTWORK_SIZE.height * value.scale;
            return { x: center.x - width / 2, y: center.y - height / 2, width, height };
        });
        const placement = captionPlacement.layout({ now: now(),
            bounds: { x: viewport.left - sceneOrigin.x + 8, y: viewport.top - sceneOrigin.y + 8,
                width: viewport.right - viewport.left - 16, height: viewport.bottom - viewport.top - 16 },
            labels: [{ id: group.id, anchor, width: group.width, height, radius: 20, clearance: 6, priority: 1,
                leaderAnchors: anchors }], obstacles: [...bodies, ...obstacles],
        })[0];
        if (!placement) {
            if (group.shownAt !== undefined) { detachCaption(); }
            else { caption.style.opacity = '0'; }
            return;
        }
        // Parked hover owns one dirty paint, so immediate geometric admission decides
        // visibility. Animated exchanges keep the solver's finite transition state.
        const opacity = first.captionId.startsWith('hover:') ? placement.blocked ? 0 : 1 : placement.opacity;
        if (group.shownAt !== undefined && (placement.blocked || opacity <= 0)) { detachCaption(); return; }
        if (!placement.blocked && opacity > 0 && group.shownAt === undefined) {
            group.shownAt = at; group.until = at + group.readMs; expireCaption(group);
        }
        group.placement = placement;
        Object.assign(caption.style, { left: placement.x + 'px', top: placement.y + 'px', opacity: opacity > 0 ? '1' : '0' });
        for (let index = 0; index < Math.max(group.leaders.length, placement.leaders.length); index++) {
            const line = placement.leaders[index];
            let leader = group.leaders[index];
            if (!line) { if (leader) { leader.style.opacity = '0'; } continue; }
            if (!leader) {
                leader = doc.createElement('div');
                initializeSceneNode(leader, 'pdfDocumentRobotCaptionLeader', '3');
                Object.assign(leader.style, { height: '1.5px', background: ROBOT_CAPTION_STYLE.borderColor, transformOrigin: '0 50%' });
                group.leaders.push(leader); transit.append(leader);
            }
            const dx = line.to.x - line.from.x, dy = line.to.y - line.from.y;
            Object.assign(leader.style, { left: line.from.x + 'px', top: line.from.y + 'px',
                width: Math.hypot(dx, dy) + 'px', transform: 'rotate(' + Math.atan2(dy, dx) + 'rad)', opacity: String(opacity) });
        }
    }

    function paintBodies(placements: readonly BodyPlacement[], successfulDeposits: readonly number[][], at: number,
        viewport: ReturnType<typeof viewportBounds>, policy: Presentation, captionObstacles: readonly SceneObstacle[]): void {
        const live = placements.filter(({ body }) => body.sprite.width > 0 && body.sprite.parentNode);
        const reactions = encounters.update(at, live.map(value => {
            const radius = ROBOT_VEHICLES.find(spec => spec.id === value.body.vehicle)!.radius * value.scale;
            const visible = value.point.x + radius > viewport.left && value.point.x - radius < viewport.right
                && value.point.y + radius > viewport.top && value.point.y - radius < viewport.bottom;
            return { id: value.body.id, x: value.point.x - sceneOrigin.x, y: value.point.y - sceneOrigin.y, radius,
                opacity: visible ? value.opacity : 0, phase: value.fixed && value.phase === 'cargo' ? 'parked' : value.phase,
                group: value.group, remainingMs: value.remainingMs, vehicle: value.body.vehicle, scale: value.scale };
        }), successfulDeposits);
        if (greeting && (at >= greeting.until || !live.some(value => value.body.id === greeting!.id))) { greeting = undefined; }
        const attention = greeting ?? hovered;
        const focus = attention && live.find(value => value.body.id === attention.id);
        if (focus && attention && (greeting || ![...reactions.values()].some(value => value.caption))) {
            const existing = reactions.get(focus.body.id);
            const isGreeting = !!greeting;
            const captionUntil = attention.started + (isGreeting ? ROBOT_INTERACTION_REACTIONS.captionMs : ROBOT_INTERACTION_REACTIONS.hoverMs);
            const line = greeting?.line ?? (focus.carrying && focus.payload?.canvas ? ROBOT_INTERACTION_REACTIONS.carrying
                : focus.phase === 'return' ? ROBOT_INTERACTION_REACTIONS.returning
                    : focus.phase === 'parked' ? ROBOT_INTERACTION_REACTIONS.waiting : ROBOT_INTERACTION_REACTIONS.preparing);
            if (isGreeting) {
                for (const [id, reaction] of reactions) { reactions.set(id, { ...reaction, caption: '' }); }
            }
            reactions.set(focus.body.id, { x: 0, y: 0, tilt: 0, expression: 'pleased', badge: null,
                ...existing, activity: existing?.activity ?? (isGreeting && !focus.carrying ? 'celebrate' : undefined),
                look: hovered?.id === focus.body.id ? hovered.point.x < focus.point.x ? -1 : 1 : existing?.look,
                gesturePhase: isGreeting ? Math.floor((at - attention.started) / ROBOT_INTERACTION_REACTIONS.gestureMs * 12) : existing?.gesturePhase ?? 0,
                caption: captionUntil > at ? line : '', captionId: (isGreeting ? 'greet:' : 'hover:') + focus.body.id + ':' + attention.started,
                captionUntil });
        }
        const key = (value: BodyPlacement) => value.payload?.id ?? value.group ?? -(value.body.id + 1);
        const grounded = new Set(live.filter(value => !ROBOT_VEHICLES.find(spec => spec.id === value.body.vehicle)!.air
            && !reactions.get(value.body.id)?.carried && !(value.body as Courier).carried).map(key));
        const fixedGroups = new Set(live.filter(value => value.fixed || value.phase === 'parked').map(key));
        const motions = new Map<number, Point>();
        for (const value of live) {
            const reaction = reactions.get(value.body.id), group = key(value);
            const motion = fixedGroups.has(group) ? { x: 0, y: 0 }
                : { x: reaction?.x ?? 0, y: grounded.has(group) ? 0 : reaction?.y ?? 0 };
            const previous = motions.get(group);
            if (!previous || Math.hypot(motion.x, motion.y) > Math.hypot(previous.x, previous.y)) { motions.set(group, motion); }
        }
        const rescue = encounters.snapshot().active?.rescue;
        const coupled = new Set(live.filter(value => rescue?.participantIds.includes(value.body.id)).map(key));
        const coupledKey = coupled.size ? Math.min(...coupled) : undefined;
        const spacingKey = (value: BodyPlacement) => coupled.has(key(value)) ? coupledKey! : key(value);
        const groups = new Map<number, BodyPlacement[]>();
        for (const value of live) {
            const id = spacingKey(value);
            if (!groups.has(id)) { groups.set(id, []); }
            groups.get(id)!.push(value);
        }
        const spacingGroups = [...groups].map(([id, members]) => {
            const points = members.map(value => ({ x: value.point.x + (motions.get(key(value))?.x ?? 0),
                y: value.point.y + (motions.get(key(value))?.y ?? 0) }));
            const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
            const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
            const radius = Math.max(...members.map((value, index) => Math.hypot(points[index].x - x, points[index].y - y)
                + ROBOT_VEHICLES.find(spec => spec.id === value.body.vehicle)!.radius * value.scale));
            const fixed = members.some(value => value.fixed || value.phase === 'parked');
            const remainingMs = Math.max(0, Math.min(...members.map(value => value.remainingMs)));
            return { id, x, y, radius, ground: members.some(value => !ROBOT_VEHICLES.find(spec => spec.id === value.body.vehicle)!.air
                    && !reactions.get(value.body.id)?.carried && !(value.body as Courier).carried),
                fixed, canFade: !fixed || members.every(value => !!value.payload),
                offsetScale: fixed ? 0 : ease(clamp(remainingMs / DOCUMENT_ROBOT_LIMITS.trafficSettleMs, 0, 1)),
                weight: members.some(value => value.carrying) ? 2 : 1,
                remainingMs };
        });
        const spacing = traffic.update(at, spacingGroups);
        // The solver checks the actual endpoint-scaled positions and owns finite yielding.
        // Every helper, crop and hardware layer then receives that same group result.
        const finalMotion = new Map<number, Point>();
        const visibility = new Map<number, number>();
        for (const value of live) {
            const motion = motions.get(key(value))!, avoid = spacing.get(spacingKey(value));
            const total = { x: motion.x + (avoid?.x ?? 0), y: motion.y + (avoid?.y ?? 0) };
            const shown = clamp(avoid?.visibility ?? 1, 0, 1);
            finalMotion.set(key(value), total);
            visibility.set(key(value), shown);
            if (value.payload) { value.payload.motion = total; value.payload.visibility = shown; }
        }
        for (const episode of episodes.values()) {
            for (const payload of episode.payloads) {
                const motion = finalMotion.get(payload.id) ?? { x: 0, y: 0 };
                const shown = visibility.get(payload.id) ?? 1;
                const translate = motion.x.toFixed(3) + 'px ' + motion.y.toFixed(3) + 'px';
                for (const element of [payload.canvas, payload.underlay?.canvas, payload.mast, payload.sling,
                    cleaner?.payload === payload ? cleaner.sprite : undefined]) {
                    if (element) {
                        element.style.translate = translate;
                        element.style.opacity = String((Number(element.style.opacity) || 0) * shown);
                    }
                }
                if (payload.landingShadow) {
                    payload.landingShadow.style.opacity = String(Number(payload.landingShadow.style.opacity) * shown);
                }
            }
        }
        const displayed: BodyPlacement[] = [];
        hitBoxes.clear(); hitScrollLeft = container.scrollLeft || 0; hitScrollTop = container.scrollTop || 0; hitColumn = documentOffset();
        const failed = new Set<RobotBody>();
        for (const value of live) {
            const { body, scale } = value;
            const opacity = value.opacity * (visibility.get(key(value)) ?? 1);
            try {
                const reaction = reactions.get(body.id);
                const motion = finalMotion.get(key(value))!;
                const point = { x: value.point.x + motion.x, y: value.point.y + motion.y };
                body.reactionCarried = !!reaction?.carried;
                const activity = reaction?.activity ?? value.activity, look = reaction?.look ?? value.look;
                const expression = reaction?.expression, gesturePhase = reaction?.gesturePhase, notice = reaction?.badge ?? null;
                const pullDirection = value.pullDirection;
                if (body.pose.activity !== activity || body.pose.look !== look || body.pose.carrying !== value.carrying
                    || body.pose.progress !== value.progress || body.pose.expression !== expression
                    || body.pose.gesturePhase !== gesturePhase || body.pose.notice !== notice || body.pose.pullDirection !== pullDirection
                    || body.pose.malfunction !== reaction?.malfunction) {
                    Object.assign(body.pose, { activity, look, carrying: value.carrying, progress: value.progress, expression,
                        gesturePhase, notice, pullDirection, malfunction: reaction?.malfunction });
                    drawVehicle(body);
                }
                if (value.advance) { value.advance.point = { ...point, scale }; }
                const width = ROBOT_ARTWORK_SIZE.width * scale, height = ROBOT_ARTWORK_SIZE.height * scale;
                Object.assign(body.sprite.style, { width: width.toFixed(2) + 'px', height: height.toFixed(2) + 'px', opacity: String(opacity),
                    transform: 'translate(' + (point.x - sceneOrigin.x - width / 2).toFixed(2) + 'px,'
                        + (point.y - sceneOrigin.y - height / 2).toFixed(2) + 'px) rotate(' + (value.tilt + (value.carrying ? 0 : reaction?.tilt ?? 0)).toFixed(2) + 'deg)' });
                displayed.push({ ...value, point, opacity });
                if (opacity > 0.2) {
                    const radius = ROBOT_VEHICLES.find(spec => spec.id === body.vehicle)!.radius * scale;
                    hitBoxes.set(body.id, { x: point.x, y: point.y, radius, placement: { ...value, point } });
                }
            } catch { failed.add(body); stats.rejected++; }
        }
        interaction?.update();
        const displayedObstacles = captionObstacles.filter(obstacle => obstacle.group === undefined
            || (visibility.get(obstacle.group) ?? 1) > 0.2).map(obstacle => {
            const offset = obstacle.group === undefined ? undefined : finalMotion.get(obstacle.group);
            return { x: obstacle.x + (offset?.x ?? 0), y: obstacle.y + (offset?.y ?? 0), width: obstacle.width, height: obstacle.height };
        });
        if (!failed.size) {
            const captionActors = displayed.filter(value => captionGroup?.actors.includes(value.body.id));
            if (captionActors.length && captionActors.every(value => (visibility.get(key(value)) ?? 1) <= 0.2)) { detachCaption(); }
            paintCaption(displayed.filter(value => value.opacity > 0.2), reactions, viewport, policy, displayedObstacles);
            paintWorkLabels(displayed, viewport, displayedObstacles); return;
        }
        if (columnPull && failed.has(columnPull.body)) { clearColumnPull(); }
        for (const episode of [...episodes.values()]) {
            for (let index = episode.payloads.length - 1; index >= 0; index--) {
                if (episode.payloads[index].helpers.some(actor => failed.has(actor))) {
                    dropPayload(episode.payloads[index]); episode.payloads.splice(index, 1);
                }
            }
            if (!episode.payloads.length) { dropEpisode(episode, true); }
        }
        if (retiring) {
            const scene = retiring;
            for (let index = scene.pieces.length - 1; index >= 0; index--) {
                if (scene.pieces[index].payload.helpers.some(actor => failed.has(actor))) { dropRetiringPiece(scene, index); }
            }
        }
        for (const work of advance.values()) {
            if (work.returnCarry && (failed.has(work.returnCarry.ground) || failed.has(work.returnCarry.air))) {
                dropAdvance(work); continue;
            }
            work.actors = work.actors.filter(actor => {
                if (!failed.has(actor.body)) { return true; }
                releaseActor(actor.body); return false;
            });
            if (!work.actors.length) {
                work.phase = 'parked'; work.message = advanceMessage(work); work.label.textContent = work.message;
            }
        }
        paintWorkLabels(displayed.filter(value => !failed.has(value.body)), viewport, displayedObstacles);
    }

    function paint(at: number, scheduled = false): void {
        const began = win.performance.now();
        painting = true; dirty = false;
        const period = 1000 / DOCUMENT_ROBOT_LIMITS.maxFps;
        lastPaint = scheduled && Number.isFinite(lastPaint)
            ? lastPaint + Math.max(1, Math.floor((at - lastPaint + 0.01) / period)) * period : at;
        try {
            const bounds = container.getBoundingClientRect();
            const viewport = viewportBounds(bounds);
            syncSceneOrigin(bounds);
            const policy = presentation(viewport);
            if (activePresentation && activePresentation !== policy.kind) {
                const blocked = capacityBlocked;
                clearActive();
                capacityBlocked = blocked;
                capacityFreed = true;
                notifyCapacity();
                return;
            }
            // Read page and lab geometry before any sprite style writes. The scroll container
            // supplies clipping; the browser carries this content-local layer between paints.
            const areas = new Map([...episodes.values()].map(episode => [episode, geometry(episode.element, viewport, episode.pageProjection)]));
            const workAreas = new Map([...advance.values()].map(work => [work, advanceGeometry(work, viewport, policy)]));
            const destinations = new Map<RobotBody, RobotDispatchPoint | undefined>();
            const destination = (actor: RobotBody) => {
                try {
                    if (actor.port === dispatchOrigin) { destinations.set(actor, actor.port?.destination(actor.vehicle)); }
                } catch { stats.rejected++; }
            };
            for (const episode of episodes.values()) {
                for (const payload of episode.payloads) {
                    if (at >= payload.started + payload.delay + payload.duration * RETURN_START) { payload.helpers.forEach(destination); }
                }
            }
            for (const work of advance.values()) {
                if (work.phase === 'returning') { work.actors.forEach(actor => destination(actor.body)); }
            }
            for (const piece of retiring?.pieces ?? []) {
                const payload = piece.payload;
                if (at >= payload.started + payload.delay + payload.duration * RETURN_START) { payload.helpers.forEach(destination); }
            }
            if (columnPull && !columnPull.motion.holdAtEnd
                && at >= columnPull.motion.startedAt + columnPull.motion.durationMs) { destination(columnPull.body); }
            const placements: BodyPlacement[] = [], captionObstacles: SceneObstacle[] = [];
            try { paintColumnPull(at, viewport, policy, destinations, placements); }
            catch { clearColumnPull(); stats.rejected++; }
            if (retiring) { paintRetiring(retiring, at, viewport, policy, destinations, placements, captionObstacles); }
            for (const episode of [...episodes.values()]) {
                if (!visible.has(episode.page) || episode.element.isConnected === false) { dropEpisode(episode, true); continue; }
                const area = areas.get(episode);
                if (!area) { dropEpisode(episode, true); continue; }
                const pagePolicy = pagePresentation(policy, area);
                for (let index = episode.payloads.length - 1; index >= 0; index--) {
                    const payload = episode.payloads[index];
                    try {
                        if (actorCount() <= policy.maxActors && payload.helpers.every(actor => resizeSprite(actor, pagePolicy))
                            && paintPayload(payload, episode.page, area, at, destinations, viewport, placements, captionObstacles, pagePolicy)) { continue; }
                    } catch { stats.rejected++; }
                    dropPayload(payload);
                    episode.payloads.splice(index, 1);
                }
                if (!episode.payloads.length) { dropEpisode(episode, false); }
            }
            for (const work of [...advance.values()]) {
                try { paintAdvance(work, at, viewport, policy, workAreas.get(work), destinations, placements); }
                catch {
                    for (const actor of work.actors) { releaseActor(actor.body); }
                    clearAdvanceCarry(work);
                    work.actors.length = 0; work.admitted = true; work.phase = 'parked';
                    work.message = advanceMessage(work); work.label.textContent = work.message;
                    stats.rejected++;
                }
            }
            paintBodies(placements, pendingDeposits.splice(0), at, viewport, policy, captionObstacles);
            notifyCapacity();
        } finally {
            painting = false;
            frames++;
            paintLastMs = Math.max(0, win.performance.now() - began);
            paintTotalMs += paintLastMs; paintMaxMs = Math.max(paintMaxMs, paintLastMs);
        }
    }

    function requestPaint(): void {
        if (disposed || !enabled || hidden()) { return; }
        dirty = true;
        const at = now();
        if (!painting && (media.matches || at - lastPaint + 0.01 >= 1000 / DOCUMENT_ROBOT_LIMITS.maxFps)) {
            paint(at, !media.matches);
        }
        schedule();
    }

    function schedule(): void {
        if (frame || !moving() && !dirty || disposed || !enabled || hidden() || media.matches) { return; }
        const pending = { id: 0 };
        frame = pending;
        pending.id = requestFrame(at => {
            if (frame !== pending) { return; }
            frame = undefined;
            if (disposed || !enabled || hidden() || media.matches) { return; }
            if (at - lastPaint + 0.01 >= 1000 / DOCUMENT_ROBOT_LIMITS.maxFps) {
                paint(at, true);
            }
            schedule();
        });
    }

    function makeDelivery(source: HTMLCanvasElement, crop: Crop, area: Geometry, index: number, mode: DeliveryMode,
        helpers: number, used: ReadonlySet<RobotVehicle>, policy: Presentation, staged: AdvanceActor[], ground = false,
        projection?: PdfRasterProjection, preferredGround?: RobotVehicle): Payload | undefined {
        const payload = makePayload(source, crop, area, index, mode, policy, ground, projection);
        if (!payload) { return; }
        for (let helper = 0; helper < helpers; helper++) {
            const actor = makeCourier(payload, area, used, policy, staged, preferredGround);
            if (!actor) {
                const leader = payload.helpers[0], launch = leader && (leader.launch ?? leader.origin);
                if (preferredGround && helper === 1 && launch && !needsCargoAirlift(launch,
                    cargoDestination(leader.vehicle, 0, leader.spriteScale, payload, area))) {
                    payload.mode = 'solo'; break;
                }
                dropPayload(payload); return;
            }
            payload.helpers.push(actor);
        }
        if (payload.helpers.some(actor => actor.origin || actor.launch)) { payload.delay = 0; }
        const path = payloadPath(payload, area, 0);
        if (payload.mode === 'airlift') {
            const leader = payload.helpers[0];
            payload.airliftReason = cargoAirliftReason(path.route!.ground,
                cargoDestination(leader.vehicle, 0, leader.spriteScale, payload, area), leader.vehicle, leader.drivingDirection);
        }
        for (const actor of payload.helpers) {
            if (payload.airliftReason === 'turn') { continue; }
            const offset = helperOffset(actor, area, 0);
            const from = actor.launch ?? actor.origin ?? (payload.mode === 'airlift' && actor === payload.helpers[0]
                ? path.route!.ground : { x: path.start.x + offset.x, y: path.start.y + offset.y });
            commitGroundDrive(actor, from, cargoDestination(actor.vehicle, actor.slot, actor.spriteScale, payload, area));
        }
        payload.canvas!.dataset.courier = String(payload.helpers[0].id);
        if (ground) {
            try {
                const mast = doc.createElement('div'), fork = doc.createElement('div');
                initializeSceneNode(mast, 'pdfDocumentRobotMast', '0');
                Object.assign(mast.style, { borderStyle: 'solid', borderColor: '#a9bccb', boxSizing: 'border-box' });
                Object.assign(fork.style, { position: 'absolute', left: '0', pointerEvents: 'none', background: '#7ea7df' });
                mast.append(fork); payload.mast = mast;
            } catch { dropPayload(payload); return; }
        }
        if (payload.mode === 'airlift') {
            try {
                payload.sling = makeSling();
            } catch { dropPayload(payload); return; }
        }
        return payload;
    }

    function largerCrop(crop: Crop, area: Geometry): Crop {
        const width = Math.min(crop.width * DOCUMENT_ROBOT_LIMITS.cooperative.cropScale, (area.right - area.left) * 0.84);
        const height = Math.min(crop.height * DOCUMENT_ROBOT_LIMITS.cooperative.cropScale, (area.bottom - area.top) * 0.84);
        return { ...crop, width, height,
            x: clamp(crop.x + crop.width / 2 - width / 2, area.left, area.right - width),
            y: clamp(crop.y + crop.height / 2 - height / 2, area.top, area.bottom - height) };
    }

    function offer(value: DocumentRobotDelivery): DocumentRobotOffer {
        if (disposed || !enabled || hidden() || !visible.has(value.pageNumber)
            || !Number.isSafeInteger(value.pageNumber) || value.pageNumber < 1 || seen.has(value.pageNumber)) { return 'skipped'; }
        if (media.matches) { seen.add(value.pageNumber); stats.skipped++; return 'skipped'; }
        if (!value.canvas.width || !value.canvas.height) { return 'deferred'; }
        const viewport = viewportBounds();
        let policy = presentation(viewport);
        const area = geometry(value.pageElement, viewport, value.pageProjection);
        if (!area || area.width * (area.right - area.left) < policy.minimumWidth
            || area.height * (area.bottom - area.top) < policy.minimumHeight) { return 'deferred'; }
        policy = pagePresentation(policy, area);
        if (!policy.maxActors || !policy.maxCargoBytes) { seen.add(value.pageNumber); stats.skipped++; return 'skipped'; }
        releaseCleaner();
        clearColumnPull();
        reclaimRetiring(policy);
        const used = new Set([...episodes.values()].flatMap(actorsOf)
            .concat(retiring?.pieces.flatMap(piece => piece.payload.helpers) ?? []).map(actor => actor.vehicle));
        if (actorCount() - advanceActors().length >= policy.maxActors || episodes.size && activePresentation !== policy.kind
            || dispatchOrigin && used.size >= ROBOT_VEHICLES.length) {
            capacityBlocked = true; return 'busy';
        }
        const crops = selectCrops(value.canvas, area, policy, value.imageRegions, value.rasterProjection);
        if (!crops.length) { seen.add(value.pageNumber); stats.skipped++; return 'skipped'; }
        syncSceneOrigin();
        // Ready pixels have priority over parked work. Their bodies are reused, never duplicated.
        const staged = takeAdvanceActors(value.pageNumber);
        const pageArea = area.width * (area.right - area.left) * area.height * (area.bottom - area.top);
        const crew = policy.kind === 'desktop' ? Math.max(2, Math.round(pageArea / DOCUMENT_ROBOT_LIMITS.desktop.pixelsPerActor))
            : 2 + Math.floor(random.next() * 2);
        const largeImage = !!crops[0].imageId && crops[0].width * area.width >= policy.minimumWidth
            && crops[0].height * area.height >= policy.minimumHeight;
        const count = Math.min(policy.maxActors - actorCount(), policy.maxFragmentsPerPage, crew, largeImage ? Math.max(3, crops.length) : crops.length,
            dispatchOrigin ? ROBOT_VEHICLES.length - used.size : Infinity);
        const payloads: Payload[] = [];
        let assigned = 0;
        if (!deliveryBag.length) { deliveryBag = random.shuffle(['solo', 'solo', 'pair', 'handoff', 'trio', 'airlift'] as const); }
        const choice = deliveryBag.shift()!;
        // A visible page base is a real ground route. Prefer its lower photograph or ink crop;
        // an upper crop remains available to the flying/cooperative crew.
        const lower = area.bottom >= 0.98 && !used.has('forklift')
            && (count >= 3 && (choice !== 'trio' || count >= 4) || count === 1 || choice === 'solo')
            ? [...crops].filter(crop => crop.y + crop.height / 2 >= 0.6 && crop.score >= 1)
                .sort((a, b) => b.y + b.height - a.y - a.height || b.score - a.score)[0] : undefined;
        const remaining = [...crops];
        if (lower) {
            const ground = makeDelivery(value.canvas, lower, area, 0, 'solo', 1, used, policy, staged, true, value.rasterProjection);
            if (ground) {
                payloads.push(ground); assigned++; used.add('forklift');
                remaining.splice(remaining.indexOf(lower), 1);
            }
        }
        const first = remaining[0];
        const enlarged = first && (first.imageId ? first : largerCrop(first, area));
        const turningLugv = enlarged && staged.find(actor => actor.body.vehicle === 'lugv'
            && cargoAirliftReason(actor.point, cargoDestination('lugv', 0, policy.spriteScale,
                { mode: 'airlift', ground: false, crop: enlarged }, area), 'lugv', actor.body.drivingDirection) === 'turn');
        const stagedGround = staged.some(actor => actor.body.vehicle !== 'forklift'
            && !ROBOT_VEHICLES.find(spec => spec.id === actor.body.vehicle)!.air
            && ROBOT_VEHICLES.some(spec => spec.air && !used.has(spec.id) && canCarryRobot(spec.id, actor.body.vehicle)));
        let sharedCrop = false;
        if (first && enlarged && (largeImage || stagedGround || turningLugv || choice !== 'solo') && count - assigned >= 2 && first.score >= 1
            && (largeImage || stagedGround || turningLugv || enlarged.width >= first.width * 1.4 && enlarged.height >= first.height * 1.4)) {
            const helpers = !stagedGround && !turningLugv && choice === 'trio' ? Math.min(3, count - assigned) : 2;
            const shared = makeDelivery(value.canvas, enlarged, area, payloads.length,
                turningLugv || stagedGround || choice === 'airlift' ? 'airlift' : choice === 'handoff' ? 'handoff' : 'formation', helpers, used, policy, staged,
                false, value.rasterProjection, turningLugv ? 'lugv' : undefined);
            if (shared) {
                payloads.push(shared); assigned += shared.helpers.length;
                sharedCrop = true;
                for (const actor of shared.helpers) { used.add(actor.vehicle); }
            }
        }
        for (let index = sharedCrop ? 1 : 0; index < remaining.length && assigned < count; index++) {
            const payload = makeDelivery(value.canvas, remaining[index], area, payloads.length, 'solo', 1, used, policy, staged,
                false, value.rasterProjection);
            if (payload) {
                payloads.push(payload); assigned++;
                used.add(payload.helpers[0].vehicle);
            }
        }
        for (const actor of staged) { releaseActor(actor.body); }
        if (!payloads.length) {
            if (actorCount()) { capacityBlocked = true; return 'busy'; }
            stats.rejected++; seen.add(value.pageNumber); return 'skipped';
        }
        let layer: HTMLDivElement | undefined;
        try {
            layer = doc.createElement('div');
            layer.className = 'pdfDocumentRobots';
            layer.dataset.page = String(value.pageNumber);
            layer.setAttribute('aria-hidden', 'true');
            Object.assign(layer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'visible' });
            for (const payload of payloads) {
                if (payload.mast) { layer.append(payload.mast); }
                if (payload.sling) { layer.append(payload.sling); }
                layer.append(payload.canvas!, ...payload.helpers.map(actor => actor.sprite));
            }
            container.append(transit);
            transit.append(layer);
            const episode: Episode = { page: value.pageNumber, element: value.pageElement, kind: value.kind, layer, payloads,
                pageSize: { width: area.width, height: area.height },
                pageProjection: value.pageProjection, displayRasterProjection: value.displayRasterProjection };
            episodes.set(value.pageNumber, episode);
            for (const payload of payloads) {
                const cover = doc.createElement('div');
                initializeSceneNode(cover, 'pdfDocumentRobotArrival', '4');
                cover.dataset.payload = String(payload.id);
                if (payload.crop.imageId) { cover.dataset.imageId = payload.crop.imageId; }
                Object.assign(cover.style, { background: 'var(--page-bg-color, #fff)', opacity: '1',
                    border: '0', borderRadius: '0', boxShadow: 'none' });
                payload.cover = cover;
                value.pageElement.append(cover);
                paintArrival(payload, area.projection!, value.displayRasterProjection);
            }
            activePresentation = policy.kind;
            seen.add(value.pageNumber);
            requestPaint();
            stats.episodes++;
            return 'started';
        } catch {
            const episode = episodes.get(value.pageNumber);
            if (episode) { dropEpisode(episode, true); }
            else { for (const payload of payloads) { dropPayload(payload); } }
            layer?.remove();
            if (!episodes.size && !advance.size && !retiring && !captionGroup && !columnPull) { transit.remove(); }
            seen.add(value.pageNumber);
            stats.rejected++;
            return 'skipped';
        }
    }

    function visibilityChanged(): void {
        if (hidden()) { clearActive(); }
        else { interaction?.setEnabled(enabled && !media.matches); }
    }
    function motionChanged(): void {
        interaction?.setEnabled(enabled && !hidden() && !media.matches);
        const groups = [...advance.values()].map(work => ({ key: work.key, pages: work.pages }));
        const ids = [...visible];
        const restoreStatus = () => { if (groups.length) { setVisibleWork(groups); setVisiblePages(ids); } };
        if (media.matches) {
            const waiting = capacityBlocked || capacityOnMotionResume;
            clearActive();
            capacityOnMotionResume = waiting;
            restoreStatus();
        } else {
            restoreStatus();
            if (!capacityOnMotionResume) { return; }
            capacityOnMotionResume = false;
            capacityBlocked = capacityFreed = true;
            notifyCapacity();
        }
    }
    interaction = installRobotInteraction(container, {
        hitTest(point) {
            const dx = hitScrollLeft - (container.scrollLeft || 0) + documentOffset() - hitColumn;
            const dy = hitScrollTop - (container.scrollTop || 0);
            const hit = [...hitBoxes].reverse().find(([, box]) => Math.abs(point.x - box.x - dx) <= box.radius
                && Math.abs(point.y - box.y - dy) <= box.radius);
            return hit ? { id: hit[0] } : undefined;
        },
        onHover(id, point) {
            if (id === undefined || !point) {
                if (!hovered) { return; }
                hovered = undefined;
                if (captionGroup?.id.startsWith('hover:')) { detachCaption(); }
            } else { hovered = { id, point, started: hovered?.id === id ? hovered.started : now() }; }
            requestPaint();
        },
        onGreet(id) {
            if (!hitBoxes.has(id) || hidden() || media.matches || !enabled) { return; }
            const policy = ROBOT_INTERACTION_REACTIONS;
            greeting = { id, started: now(), until: now() + policy.gestureMs,
                line: policy.greetings[Math.min(policy.greetings.length - 1, Math.floor(encounterRandom.next() * policy.greetings.length))] };
            requestPaint();
        },
    });
    interaction.setEnabled(enabled && !hidden() && !media.matches);
    doc.addEventListener('visibilitychange', visibilityChanged);
    media.addEventListener('change', motionChanged);

    return {
        offer,
        refine,
        restoreArrivals,
        revealArrivals() {
            for (const episode of episodes.values()) {
                for (const payload of episode.payloads) { releasePayload(payload); }
            }
            requestPaint();
        },
        setVisibleWork,
        setColumnTransition,
        cancelColumnMotion() { clearColumnPull(); cancelFrameIfEmpty(); notifyCapacity(); },
        retireDocument,
        cancelReplacement(identity?: string) {
            if (!retiring || identity !== undefined && retiring.identity !== identity) { return; }
            clearRetiring(); cancelFrameIfEmpty(); notifyCapacity();
        },
        deliver(value: DocumentRobotDelivery): boolean { return offer(value) === 'started'; },
        hasHandled(page: number): boolean { return seen.has(page); },
        setDispatchOrigin(port: RobotDispatchPort | undefined) {
            dispatchOrigin = port;
            if (episodes.size || advance.size || retiring || columnPull) {
                try { container.append(transit); }
                catch { clearActive(); stats.rejected++; }
            }
        },
        get enabled() { return enabled; },
        setEnabled(value: boolean) { if (!disposed) { enabled = value; interaction?.setEnabled(value && !hidden() && !media.matches);
            if (!value) { clearActive(); } } },
        setVisiblePages,
        reset: resetDocument,
        snapshot() {
            const policy = presentation();
            return {
                enabled, reducedMotion: media.matches, scheduled: frame !== undefined, frames, paintTotalMs, paintMaxMs, paintLastMs,
                encounters: encounters.snapshot(),
                interaction: { hovered: hovered?.id, greeting: greeting?.id, hitActors: hitBoxes.size },
                caption: captionGroup ? { actors: [...captionGroup.actors], pages: [...captionGroup.pages],
                    until: captionGroup.until, text: captionGroup.node.textContent, pendingExpiry: captionTimer !== undefined,
                    placement: captionGroup.placement ? { ...captionGroup.placement,
                        leaders: captionGroup.placement.leaders.map(line => ({ from: { ...line.from }, to: { ...line.to } })) } : undefined } : undefined,
                activeEpisodes: episodes.size + Number(!!retiring), activeActors: actorCount(), cargoBytes, peakCargoBytes, spriteBytes,
                documentOffset: documentOffset(),
                columnPull: columnPull ? { id: columnPull.motion.id, actor: columnPull.body.id, vehicle: columnPull.body.vehicle,
                    phase: columnPull.phase, startedAt: columnPull.motion.startedAt,
                    spriteScale: columnPull.body.spriteScale, documentSize: { ...columnPull.documentSize },
                    deadline: columnPull.phase === 'waiting' ? undefined
                        : (columnPull.returnAt ?? columnPull.motion.startedAt + columnPull.motion.durationMs)
                            + DOCUMENT_ROBOT_LIMITS.advance.returnMs } : undefined,
                activeArrivalCovers: [...episodes.values()].reduce((count, episode) => count
                    + episode.payloads.filter(payload => payload.cover?.parentNode).length, 0),
                activeRefinements: [...episodes.values()].reduce((count, episode) => count
                    + episode.payloads.filter(payload => payload.underlay).length, 0),
                activePayloads: [...episodes.values()].reduce((count, episode) => count + episode.payloads.filter(payload => payload.canvas).length, 0)
                    + (retiring?.pieces.filter(piece => piece.payload.canvas).length ?? 0),
                retainedBytes: cargoBytes + spriteBytes, maxActors: policy.maxActors, maxCargoBytes: policy.maxCargoBytes,
                maxSpriteBytes: policy.maxSpriteBytes, presentation: policy.kind, spriteScale: policy.spriteScale, ...stats,
                cleaner: cleaner ? { id: cleaner.id, page: cleaner.page, payloadId: cleaner.payload.id,
                    started: cleaner.started, duration: cleaner.duration, phase: cleaner.phase, bytes: cleaner.bytes } : undefined,
                replacement: retiring ? { identity: retiring.identity, started: retiring.started,
                    payloads: retiring.pieces.map(({ page, payload }) => ({ id: payload.id, page, imageId: payload.crop.imageId,
                        cropKind: payload.crop.kind ?? 'fragment', imageIds: payload.crop.imageIds,
                        progress: payload.progress, stage: payload.stage, helpers: payload.helpers.map(actor => actor.id),
                        target: { x: payload.crop.x, y: payload.crop.y, width: payload.crop.width, height: payload.crop.height } })),
                    actors: retiring.pieces.flatMap(piece => piece.payload.helpers.map(actor => ({ id: actor.id, vehicle: actor.vehicle, fromLab: !!actor.port }))),
                } : undefined,
                advance: [...advance.values()].map(work => ({ key: work.key, pages: work.pages.map(page => page.pageNumber),
                    phase: work.phase, message: work.message,
                    returnCarry: work.returnCarry ? { ground: work.returnCarry.ground.id, air: work.returnCarry.air.id,
                        reason: work.returnCarry.reason, route: work.returnCarry.route ? { ...work.returnCarry.route,
                            ground: { ...work.returnCarry.route.ground }, air: { ...work.returnCarry.route.air }, cargo: { ...work.returnCarry.route.cargo } } : undefined } : undefined,
                    actors: work.actors.map(actor => ({ id: actor.body.id, vehicle: actor.body.vehicle, fromLab: !!actor.body.port,
                        drivingDirection: actor.body.drivingDirection, carried: !!actor.body.carried,
                        spriteScale: actor.body.spriteScale,
                        reaction: actor.body.pose.expression ?? null, malfunction: actor.body.pose.malfunction ?? null,
                        opacity: Number(actor.body.sprite.style.opacity) || 0,
                        caption: captionGroup?.lines.get(actor.body.id) ?? null })) })),
                pages: [...episodes.values()].map(episode => ({
                    page: episode.page, kind: episode.kind,
                    documentSize: { ...(episode.pageProjection?.content ?? episode.pageSize) },
                    payloads: episode.payloads.map(payload => ({ id: payload.id, mode: payload.mode, ground: payload.ground, imageId: payload.crop.imageId,
                        cropKind: payload.crop.kind ?? 'fragment', imageIds: payload.crop.imageIds,
                        deadline: payload.started + payload.delay + payload.duration, refinements: payload.refinements,
                        arrivalCovered: !!payload.cover?.parentNode, refinementPending: !!payload.underlay,
                        refinementProgress: cleaner?.payload === payload ? ease(cleaner.phase) : 1,
                        rasterWidth: payload.canvas?.width ?? 0, rasterHeight: payload.canvas?.height ?? 0,
                        helpers: payload.helpers.map(actor => actor.id), progress: payload.progress, stage: payload.stage,
                        deposited: payload.deposited, handedOff: payload.handedOff,
                        motion: payload.motion ? { ...payload.motion } : { x: 0, y: 0 },
                        visibility: payload.visibility ?? 1,
                        routeState: payload.routeState ? { ...payload.routeState, ground: { ...payload.routeState.ground },
                            air: { ...payload.routeState.air }, cargo: { ...payload.routeState.cargo } } : undefined,
                        carrier: payload.mode === 'handoff' ? payload.handedOff ? 'ground' : 'aerial' : 'team',
                        target: { x: payload.crop.x, y: payload.crop.y, width: payload.crop.width, height: payload.crop.height } })),
                    actors: actorsOf(episode).map(actor => ({ id: actor.id, vehicle: actor.vehicle, route: actor.payload.route,
                        drivingDirection: actor.drivingDirection,
                        spriteScale: actor.spriteScale,
                        payloadId: actor.payload.id, role: actor.payload.mode === 'handoff' || actor.payload.mode === 'airlift'
                            ? ROBOT_VEHICLES.find(spec => spec.id === actor.vehicle)!.air ? 'aerial' : 'ground' : actor.payload.mode === 'solo' ? 'solo' : 'helper',
                        target: { x: actor.payload.crop.x, y: actor.payload.crop.y, width: actor.payload.crop.width, height: actor.payload.crop.height },
                        deposited: actor.payload.deposited, departing: actor.departing, fromLab: !!actor.port,
                        locomotion: ROBOT_VEHICLES.find(spec => spec.id === actor.vehicle)!.air ? 'air' : 'ground',
                        carried: !!actor.carried || !!actor.reactionCarried, routePhase: actor.routePhase,
                        carrying: actor.pose.carrying, activity: actor.pose.activity,
                        reaction: actor.pose.expression ?? null, malfunction: actor.pose.malfunction ?? null,
                        opacity: Number(actor.sprite.style.opacity) || 0,
                        caption: captionGroup?.lines.get(actor.id) ?? null })),
                })),
            };
        },
        dispose() {
            if (disposed) { return; }
            disposed = true; enabled = false;
            interaction?.dispose();
            clearActive(); seen.clear(); visible.clear();
            dispatchOrigin = undefined;
            transit.remove();
            unregisterDocumentLayer?.();
            doc.removeEventListener('visibilitychange', visibilityChanged);
            media.removeEventListener('change', motionChanged);
        },
    };
}
