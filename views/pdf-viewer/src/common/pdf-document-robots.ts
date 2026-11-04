import { paintRobotVehicle, RobotRandom, ROBOT_ARTWORK_SIZE, ROBOT_FORKLIFT_ATTACHMENT, ROBOT_VEHICLES, type RobotArtworkActor, type RobotVehicle, type RobotDispatchPort, type RobotDispatchPoint } from './prefetch-robots';
import { pdfCachePolicy } from './scroll-prefetch';

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
    spriteScale: 0.64,
    advance: Object.freeze({ arrivalMs: 900, coordinationMs: 550, returnMs: 650, desktopCrew: 2, mobileCrew: 1 }),
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
        maxDpr: 3,
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
}

type Point = { x: number; y: number };
type Crop = { x: number; y: number; width: number; height: number; score: number; imageId?: string };
interface Geometry {
    width: number;
    height: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    pageLeft: number;
    pageTop: number;
}
type DeliveryMode = 'solo' | 'formation' | 'handoff';
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
    bytes: number;
    helpers: Courier[];
    progress: number;
    stage: DeliveryStage;
    deposited: boolean;
    handedOff: boolean;
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
}
interface Courier extends RobotBody {
    payload: Payload;
    slot: number;
    departure: Point;
}
interface AdvanceActor {
    body: RobotBody;
    start: Point & { scale: number };
    point: Point & { scale: number };
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
    admitted: boolean;
    signature: string;
    geometry: string;
    message: string;
    anchor?: { element: HTMLElement; x: number; y: number; left: number; right: number; bottom: number };
}
interface Episode {
    page: number;
    element: HTMLElement;
    layer: HTMLDivElement;
    kind: DocumentRobotDelivery['kind'];
    payloads: Payload[];
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
    minimumWidth: number;
    minimumHeight: number;
}

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
const curve = (start: Point, control: Point, end: Point, amount: number): Point => {
    const left = 1 - amount;
    return { x: left * left * start.x + 2 * left * amount * control.x + amount * amount * end.x,
        y: left * left * start.y + 2 * left * amount * control.y + amount * amount * end.y };
};
const release = (canvas: HTMLCanvasElement) => { canvas.remove(); canvas.width = canvas.height = 0; };
const counters = () => ({ episodes: 0, deliveredFragments: 0, cancelledEpisodes: 0, rejected: 0, skipped: 0 });

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
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const episodes = new Map<number, Episode>();
    const advance = new Map<string, AdvanceWork>();
    const transit = doc.createElement('div');
    transit.className = 'pdfDocumentRobotTransit';
    transit.setAttribute('aria-hidden', 'true');
    // Layout containment makes visible descendant overflow ink, rather than scrollable area.
    // Keep it with size containment: https://www.w3.org/TR/css-contain-2/#containment-layout
    Object.assign(transit.style, { position: 'absolute', left: '0', top: '0', width: '0', height: '0',
        contain: 'layout size', pointerEvents: 'none', zIndex: '2147483647', overflow: 'visible' });
    const seen = new Set<number>();
    let visible = new Set<number>();
    let vehicleBag: RobotVehicle[] = [];
    let routeBag: number[] = [];
    let lastVehicle: RobotVehicle | undefined;
    let lastRoute = -1;
    let serial = 0;
    let payloadSerial = 0;
    let deliveryBag: Array<'solo' | 'pair' | 'trio' | 'handoff'> = [];
    let enabled = true;
    let disposed = false;
    let frame: { id: number } | undefined;
    let dirty = false, painting = false;
    let lastPaint = -Infinity;
    let cargoBytes = 0;
    let spriteBytes = 0;
    let frames = 0;
    let paintTotalMs = 0, paintMaxMs = 0, paintLastMs = 0;
    let sceneOrigin: Point = { x: 0, y: 0 };
    let stats = counters();
    let dispatchOrigin: RobotDispatchPort | undefined;
    let activePresentation: Presentation['kind'] | undefined;
    let capacityBlocked = false;
    let capacityFreed = false;
    let capacityOnMotionResume = false;

    const hidden = () => doc.hidden || doc.visibilityState === 'hidden';
    const actorsOf = (episode: Episode) => episode.payloads.flatMap(payload => payload.helpers);
    const advanceActors = () => [...advance.values()].flatMap(work => work.actors);
    const allActors = (): RobotBody[] => [...[...episodes.values()].flatMap(actorsOf), ...advanceActors().map(actor => actor.body)];
    const actorCount = () => allActors().length;
    const moving = () => episodes.size > 0 || [...advance.values()].some(work => work.actors.length && work.phase !== 'parked');

    function viewportBounds(bounds = container.getBoundingClientRect()) {
        const visual = win.visualViewport;
        const left = Math.max(bounds.left, visual?.offsetLeft ?? 0);
        const top = Math.max(bounds.top, visual?.offsetTop ?? 0);
        const right = Math.min(bounds.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? win.innerWidth));
        const bottom = Math.min(bounds.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? win.innerHeight));
        return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
    }

    function syncSceneOrigin(bounds = container.getBoundingClientRect()): void {
        const origin = { x: bounds.left + (container.clientLeft || 0) - (container.scrollLeft || 0),
            y: bounds.top + (container.clientTop || 0) - (container.scrollTop || 0) };
        const dx = origin.x - sceneOrigin.x, dy = origin.y - sceneOrigin.y;
        // Parked points and promoted launches already belong to the document. Rebase their
        // saved screen coordinates after compositor scrolling, including while no RAF ran.
        for (const work of advance.values()) {
            for (const actor of work.actors) {
                actor.start.x += dx; actor.start.y += dy;
                actor.point.x += dx; actor.point.y += dy;
            }
        }
        for (const actor of allActors()) {
            if (actor.origin) { actor.origin.x += dx; actor.origin.y += dy; }
            if (actor.launch) { actor.launch.x += dx; actor.launch.y += dy; }
        }
        sceneOrigin = origin;
    }

    function presentation(viewport = viewportBounds()): Presentation {
        const width = viewport.right - viewport.left, height = viewport.bottom - viewport.top;
        const policy = DOCUMENT_ROBOT_LIMITS.desktop;
        const desktop = (options.device ?? pdfCachePolicy(win.navigator).name) === 'desktop'
            && width >= policy.minWidth && height >= policy.minHeight;
        const maxActors = desktop ? clamp(Math.round(width * height / policy.pixelsPerActor), policy.minActors, policy.maxActors)
            : DOCUMENT_ROBOT_LIMITS.maxActors;
        const maxCargoBytes = desktop ? policy.maxCargoBytes : DOCUMENT_ROBOT_LIMITS.maxCargoBytes;
        return {
            kind: desktop ? 'desktop' : 'compact',
            maxActors: clamp(Math.floor(options.maxActors ?? maxActors), 0, maxActors),
            maxCargoBytes: clamp(Math.floor(options.maxCargoBytes ?? maxCargoBytes), 0, maxCargoBytes),
            maxSpriteBytes: desktop ? policy.maxSpriteBytes : DOCUMENT_ROBOT_LIMITS.maxSpriteBytes,
            maxFragmentsPerPage: desktop ? policy.maxActors : DOCUMENT_ROBOT_LIMITS.maxFragmentsPerPage,
            fragmentDimension: desktop ? policy.fragmentDimension : DOCUMENT_ROBOT_LIMITS.fragmentDimension,
            spriteScale: desktop ? clamp(width / policy.scaleWidth, policy.minSpriteScale, policy.spriteScale) : DOCUMENT_ROBOT_LIMITS.spriteScale,
            spriteDpr: desktop ? clamp(win.devicePixelRatio || 1, 1, policy.maxDpr) : 1,
            minimumWidth: desktop ? 160 : 128,
            minimumHeight: desktop ? 120 : 96,
        };
    }

    function notifyCapacity(): void {
        const freed = capacityFreed;
        capacityFreed = false;
        if (!freed || !capacityBlocked || disposed || !enabled || hidden() || media.matches
            || actorCount() >= presentation().maxActors) { return; }
        capacityBlocked = false;
        options.onCapacityAvailable?.();
    }

    function geometry(element: HTMLElement, viewport = viewportBounds()): Geometry | undefined {
        const page = element.getBoundingClientRect();
        const width = page.width;
        const height = page.height;
        if (!(width > 0 && height > 0 && page.width > 0 && page.height > 0)) { return; }
        const left = clamp((viewport.left - page.left) / page.width, 0, 1);
        const top = clamp((viewport.top - page.top) / page.height, 0, 1);
        const right = clamp((viewport.right - page.left) / page.width, 0, 1);
        const bottom = clamp((viewport.bottom - page.top) / page.height, 0, 1);
        return right > left && bottom > top ? { width, height, left, top, right, bottom, pageLeft: page.left, pageTop: page.top } : undefined;
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
        imageRegions?: readonly DocumentRobotImageRegion[]): Crop[] {
        const ids = new Set<string>();
        const images: Crop[] = [];
        for (const image of imageRegions ?? []) {
            if (!image.id || ids.has(image.id) || ![image.x, image.y, image.width, image.height].every(Number.isFinite)
                || image.width <= 0 || image.height <= 0) { continue; }
            const x = clamp(image.x, 0, 1), y = clamp(image.y, 0, 1);
            const width = clamp(image.x + image.width, 0, 1) - x, height = clamp(image.y + image.height, 0, 1) - y;
            const visibleWidth = Math.min(x + width, area.right) - Math.max(x, area.left);
            const visibleHeight = Math.min(y + height, area.bottom) - Math.max(y, area.top);
            if (visibleWidth * area.width < 32 || visibleHeight * area.height < 32) { continue; }
            ids.add(image.id);
            images.push({ x, y, width, height, imageId: image.id, score: 1 + visibleWidth * visibleHeight });
        }
        if (images.length) { return images.sort((a, b) => b.score - a.score).slice(0, 12); }
        const width = Math.min(policy.kind === 'desktop' ? 0.36 : 0.24, policy.minimumWidth / area.width, (area.right - area.left) * 0.75);
        const height = Math.min(policy.kind === 'desktop' ? 0.24 : 0.16, policy.minimumHeight / area.height, (area.bottom - area.top) * 0.75);
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
            if (!context) { return candidates; }
            context.drawImage(source, 0, 0, sample.width, sample.height);
            const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
            const background = [pixels[0], pixels[1], pixels[2], pixels[3]];
            for (const crop of candidates) {
                let ink = 0, count = 0;
                const left = Math.floor(crop.x * sample.width), right = Math.ceil((crop.x + crop.width) * sample.width);
                const top = Math.floor(crop.y * sample.height), bottom = Math.ceil((crop.y + crop.height) * sample.height);
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
        return candidates.sort((a, b) => b.score - a.score);
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
        const scale = policy.kind === 'desktop' ? Math.max(policy.spriteScale, origin?.scale ?? 0) * policy.spriteDpr : 1;
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

    function makePayload(source: HTMLCanvasElement, crop: Crop, area: Geometry, index: number,
        mode: DeliveryMode, policy: Presentation, ground: boolean): Payload | undefined {
        const sourceX = Math.floor(crop.x * source.width), sourceY = Math.floor(crop.y * source.height);
        const sourceWidth = Math.max(1, Math.min(source.width - sourceX, Math.ceil(crop.width * source.width)));
        const sourceHeight = Math.max(1, Math.min(source.height - sourceY, Math.ceil(crop.height * source.height)));
        const dimension = policy.fragmentDimension * (mode === 'solo' ? 1 : DOCUMENT_ROBOT_LIMITS.cooperative.rasterScale);
        const scale = Math.min(1, dimension / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.floor(sourceWidth * scale)), height = Math.max(1, Math.floor(sourceHeight * scale));
        const bytes = width * height * RGBA_BYTES;
        if (cargoBytes + bytes > policy.maxCargoBytes) { return; }
        let canvas: HTMLCanvasElement | undefined;
        try {
            canvas = createCanvas();
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d', { alpha: true });
            if (!context) { return; }
            context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
            const route = ground ? random.next() < 0.5 ? 0 : 2 : nextRoute();
            const target = { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
            const start = edge(route, area, target), bend = random.range(-0.16, 0.16);
            const payload: Payload = {
                id: ++payloadSerial, mode, ground, route, crop, start,
                control: { x: (start.x + target.x) / 2 + bend, y: (start.y + target.y) / 2 - Math.abs(bend) },
                started: now(), delay: index * (policy.kind === 'desktop' ? random.range(40, 85) : random.range(90, 180)),
                duration: random.range(DOCUMENT_ROBOT_LIMITS.minDurationMs, DOCUMENT_ROBOT_LIMITS.maxDurationMs)
                    * (mode === 'solo' ? 1 : DOCUMENT_ROBOT_LIMITS.cooperative.durationScale),
                canvas, bytes, helpers: [], progress: 0, stage: mode === 'solo' ? 'carry' : 'rendezvous',
                deposited: false, handedOff: false,
            };
            decorate(canvas, 'pdfDocumentRobotCargo', '1');
            canvas.dataset.payload = String(payload.id);
            Object.assign(canvas.style, { boxShadow: '0 2px 7px #0003', borderRadius: '2px' });
            cargoBytes += bytes;
            canvas = undefined;
            return payload;
        } catch { return; }
        finally { if (canvas) { release(canvas); } }
    }

    function makeBody(used: ReadonlySet<RobotVehicle>, policy: Presentation, accepts = (_vehicle: RobotVehicle) => true): RobotBody | undefined {
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
        staged: AdvanceActor[]): Courier | undefined {
        const accepts = (vehicle: RobotVehicle) => (payload.ground ? vehicle === 'forklift' : vehicle !== 'forklift')
            && !payload.helpers.some(helper => helper.vehicle === vehicle)
            && (payload.mode !== 'handoff' || ROBOT_VEHICLES.find(spec => spec.id === vehicle)!.air === (payload.helpers.length === 0));
        const index = staged.findIndex(actor => !used.has(actor.body.vehicle) && accepts(actor.body.vehicle));
        const waiting = index >= 0 ? staged.splice(index, 1)[0] : undefined;
        const body = waiting?.body ?? makeBody(new Set([...used, ...staged.map(actor => actor.body.vehicle)]), policy, accepts);
        if (!body) { return; }
        try {
            if (waiting) { body.launch = { ...waiting.point }; }
            const target = { x: payload.crop.x + payload.crop.width / 2, y: payload.crop.y + payload.crop.height / 2 };
            const actor: Courier = Object.assign(body, { payload, slot: payload.helpers.length,
                departure: edge((payload.route + 1 + Math.floor(random.next() * 2)) % 4, area, target) });
            actor.pose.activity = 'deliver'; actor.pose.carrying = true;
            actor.pose.look = payload.start.x < target.x ? 1 : -1;
            actor.sprite.dataset.payload = String(payload.id);
            drawVehicle(actor);
            return actor;
        } catch { releaseActor(body); return; }
    }

    function releaseActor(actor: RobotBody): void {
        release(actor.sprite);
        spriteBytes -= actor.spriteBytes;
        capacityFreed = true;
        actor.port?.release(actor.vehicle);
        actor.port = undefined;
    }

    function releasePayload(payload: Payload): void {
        payload.mast?.remove(); payload.mast = undefined;
        if (!payload.canvas) { return; }
        release(payload.canvas); payload.canvas = undefined;
        cargoBytes -= payload.bytes;
        capacityFreed = true;
    }

    function dropPayload(payload: Payload): void {
        for (const actor of payload.helpers) { releaseActor(actor); }
        payload.helpers.length = 0;
        releasePayload(payload);
    }

    function dropEpisode(episode: Episode, cancelled: boolean): void {
        for (const payload of episode.payloads) { dropPayload(payload); }
        episode.payloads.length = 0;
        episode.layer.remove();
        episodes.delete(episode.page);
        if (!episodes.size && !advance.size) { transit.remove(); }
        if (cancelled) { stats.cancelledEpisodes++; }
    }

    function cancelFrameIfEmpty(): void {
        if (!episodes.size && !advance.size) { dirty = false; }
        if (!moving() && !dirty && frame) { cancelFrame(frame.id); frame = undefined; }
    }

    function clearActive(): void {
        capacityBlocked = false;
        capacityOnMotionResume = false;
        dirty = false;
        if (frame) { cancelFrame(frame.id); frame = undefined; }
        for (const episode of [...episodes.values()]) { dropEpisode(episode, true); }
        for (const work of [...advance.values()]) { dropAdvance(work); }
        activePresentation = undefined;
        capacityFreed = false;
        lastPaint = -Infinity;
    }

    const pendingWorkPages = (work: AdvanceWork) => work.pages.filter(page => page.state === 'waiting' || page.state === 'preparing');

    function dropAdvance(work: AdvanceWork): void {
        for (const actor of work.actors) { releaseActor(actor.body); }
        work.actors.length = 0;
        work.layer.remove();
        advance.delete(work.key);
        if (!episodes.size && !advance.size) { transit.remove(); }
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
        const scale = policy.spriteScale;
        const x = work.anchor ? reference.left + work.anchor.x * reference.width : (left + right) / 2;
        const y = work.anchor ? reference.top + work.anchor.y * reference.height : top + Math.min((bottom - top) * 0.35, 115 * scale);
        return { x, y, left, right, top, bottom, reference, element,
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
            for (const actor of work.actors) { actor.start = { ...actor.point }; }
            work.label.style.opacity = '0';
        }
    }

    function paintAdvance(work: AdvanceWork, at: number, viewport: ReturnType<typeof viewportBounds>, policy: Presentation,
        area: ReturnType<typeof advanceGeometry>, destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>): void {
        if (!area) {
            for (const actor of work.actors) { releaseActor(actor.body); }
            work.actors.length = 0; work.phase = 'parked'; work.label.style.opacity = '0';
            return;
        }
        const timing = DOCUMENT_ROBOT_LIMITS.advance;
        const elapsed = at - work.started;
        if (work.phase === 'returning' && at - work.returnAt! >= timing.returnMs) { dropAdvance(work); return; }
        if (work.phase !== 'returning') {
            if (!work.actors.length || media.matches) { work.phase = 'parked'; }
            else if (work.gestureAt !== undefined) {
                work.phase = at - work.gestureAt < timing.coordinationMs ? 'coordinating' : 'parked';
                if (work.phase === 'parked') { work.gestureAt = undefined; }
            } else {
                work.phase = elapsed < timing.arrivalMs ? 'arriving'
                    : elapsed < timing.arrivalMs + timing.coordinationMs ? 'coordinating' : 'parked';
            }
            work.label.style.opacity = '1';
        }
        work.message = advanceMessage(work);
        work.label.textContent = work.message;
        work.label.style.left = clamp(area.x, area.stageLeft + 70, area.stageRight - 70) - sceneOrigin.x + 'px';
        work.label.style.top = Math.min(area.stageBottom - 62, area.y + ROBOT_ARTWORK_SIZE.height * policy.spriteScale * 0.42) - sceneOrigin.y + 'px';
        work.label.style.maxWidth = Math.max(120, Math.min(300, viewport.right - viewport.left - 24)) + 'px';
        for (let index = work.actors.length - 1; index >= 0; index--) {
            const actor = work.actors[index], body = actor.body;
            if (!resizeSprite(body, policy)) { releaseActor(body); work.actors.splice(index, 1); continue; }
            const offset = (index - (work.actors.length - 1) / 2) * 102 * policy.spriteScale;
            const target = { x: clamp(area.x + offset, area.stageLeft + 35, area.stageRight - 35), y: area.y + (index % 2 ? 9 : -9) };
            const arrival = ease(clamp(elapsed / timing.arrivalMs, 0, 1));
            let point: Point = curve(actor.start, { x: target.x, y: actor.start.y }, target, arrival);
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
                const end = destination ?? { x: viewport.right + 140, y: actor.start.y, scale: policy.spriteScale };
                point = curve(actor.start, { x: end.x, y: actor.start.y }, end, progress);
                scale = actor.start.scale + ((end.scale ?? policy.spriteScale) - actor.start.scale) * progress;
                opacity = destination ? 1 : 1 - progress;
            }
            const activity = work.phase === 'arriving' || work.phase === 'returning' ? 'navigate'
                : work.phase === 'coordinating' ? 'assist' : 'park';
            const look = work.actors.length > 1 ? index ? -1 : 1 : 1;
            if (body.pose.activity !== activity || body.pose.look !== look || body.pose.carrying) {
                body.pose.activity = activity; body.pose.look = look; body.pose.carrying = false; drawVehicle(body);
            }
            actor.point = { ...point, scale };
            body.sprite.style.width = (ROBOT_ARTWORK_SIZE.width * scale).toFixed(2) + 'px';
            body.sprite.style.height = (ROBOT_ARTWORK_SIZE.height * scale).toFixed(2) + 'px';
            body.sprite.style.opacity = String(opacity);
            body.sprite.style.transform = 'translate(' + (point.x - sceneOrigin.x - ROBOT_ARTWORK_SIZE.width * scale / 2).toFixed(2) + 'px,'
                + (point.y - sceneOrigin.y - ROBOT_ARTWORK_SIZE.height * scale / 2).toFixed(2) + 'px) rotate(' + tilt.toFixed(2) + 'deg)';
        }
        if (!work.actors.length) { work.phase = 'parked'; }
    }

    function setVisiblePages(ids: readonly number[]): void {
        visible = new Set(ids);
        for (const episode of [...episodes.values()]) { if (!visible.has(episode.page)) { dropEpisode(episode, true); } }
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
                Object.assign(label.style, { transform: 'translateX(-50%)',
                    padding: '7px 11px', borderRadius: '10px', border: '1px solid #c9b58b', background: '#fff8e9f2',
                    color: '#463b29', font: '500 13px/1.4 system-ui, sans-serif', textAlign: 'center', whiteSpace: 'pre-line',
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
                            const body = makeBody(used, policy);
                            if (!body) { break; }
                            const start = { ...(body.origin ?? { x: viewport.right + 90, y: area.y + index * 20 }),
                                scale: body.origin?.scale ?? policy.spriteScale };
                            work.actors.push({ body, start: { ...start }, point: { ...start } });
                            work.layer.append(body.sprite); used.add(body.vehicle);
                        }
                    } catch {
                        for (const actor of work.actors) { releaseActor(actor.body); }
                        work.actors.length = 0; stats.rejected++;
                    }
                    if (work.actors.length) {
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
            work.phase = 'parked';
            work.message = advanceMessage(work); work.label.textContent = work.message;
            if (!pendingWorkPages(work).length) { dropAdvance(work); }
            return actors;
        });
    }

    function helperOffset(actor: Courier, area: Geometry, progress: number): Point {
        const payload = actor.payload;
        const bodyScale = actor.spriteScale / DOCUMENT_ROBOT_LIMITS.spriteScale;
        const air = ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!.air;
        if (payload.ground) { return { x: -FORKLIFT_ATTACHMENT_PX.cargoX * actor.spriteScale,
            y: payload.crop.height * area.height / 2 - FORKLIFT_ATTACHMENT_PX.carryY * actor.spriteScale }; }
        if (payload.mode === 'solo') { return { x: air ? 0 : -29 * bodyScale, y: (air ? -34 : 25) * bodyScale }; }
        const width = payload.crop.width * area.width, height = payload.crop.height * area.height;
        if (payload.mode === 'handoff') {
            const ground = { x: -width * 0.32, y: height * 0.35 + 20 * bodyScale };
            if (!air) { return ground; }
            const lower = ease(clamp((progress - HANDOFF_START) / (HANDOFF_END - HANDOFF_START), 0, 1));
            return { x: (ground.x - 12 * bodyScale) * lower,
                y: (-height * 0.45 - 22 * bodyScale) * (1 - lower) + (ground.y - 36 * bodyScale) * lower };
        }
        if (actor.slot === 2) { return { x: 0, y: -height * 0.42 - 22 * bodyScale }; }
        return { x: (actor.slot === 0 ? -1 : 1) * (width * 0.42 + 10 * bodyScale),
            y: (air ? -1 : 1) * (height * 0.35 + 14 * bodyScale) };
    }

    function payloadPath(payload: Payload, area: Geometry, progress: number) {
        const project = (point: Point) => ({ x: area.pageLeft + point.x * area.width, y: area.pageTop + point.y * area.height });
        const target = project({ x: payload.crop.x + payload.crop.width / 2, y: payload.crop.y + payload.crop.height / 2 });
        const leader = payload.helpers[0];
        const offset = helperOffset(leader, area, 0);
        const launch = leader.launch ?? leader.origin;
        const initialScale = (launch?.scale ?? leader.spriteScale) / leader.spriteScale;
        const start = launch ? { x: launch.x - offset.x * initialScale, y: launch.y - offset.y * initialScale } : project(payload.start);
        const control = launch ? { x: (start.x + target.x) / 2 + (payload.route % 2 ? 70 : -70), y: Math.min(start.y, target.y) - 45 }
            : project(payload.control);
        const rendezvous = curve(start, control, target, 0.38);
        const groundY = area.pageTop + area.height - DOCUMENT_ROBOT_LIMITS.forklift.baseInset * leader.spriteScale;
        let point: Point;
        if (progress >= DEPOSIT_START) { point = target; }
        else if (payload.ground) {
            const timing = DOCUMENT_ROBOT_LIMITS.forklift;
            const carryY = groundY + FORKLIFT_ATTACHMENT_PX.carryY * leader.spriteScale - payload.crop.height * area.height / 2;
            const entrance = { x: project(payload.start).x, y: carryY }, dock = { x: target.x, y: carryY };
            const begin = launch ? timing.approachEnd : 0;
            if (progress < begin) { point = curve(start, { x: entrance.x, y: start.y }, entrance, ease(progress / begin)); }
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
            else { point = curve(rendezvous, { x: (rendezvous.x + target.x) / 2, y: Math.min(rendezvous.y, target.y) }, target,
                ease((progress - HANDOFF_END) / (DEPOSIT_START - HANDOFF_END))); }
        } else {
            const begin = payload.mode === 'formation' ? RENDEZVOUS_END : 0;
            point = curve(start, control, target, ease(clamp((progress - begin) / (DEPOSIT_START - begin), 0, 1)));
        }
        return { start, control, target, rendezvous, point, project, groundY };
    }

    function paintActor(actor: Courier, area: Geometry, path: ReturnType<typeof payloadPath>,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, viewport: ReturnType<typeof viewportBounds>): void {
        const payload = actor.payload, progress = payload.progress;
        const air = ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!.air;
        const offset = helperOffset(actor, area, progress);
        const normalScale = actor.spriteScale;
        const launch = actor.launch ?? actor.origin;
        const originScale = launch?.scale ?? normalScale;
        let spriteScale = launch ? originScale + (normalScale - originScale) * ease(clamp(progress / 0.20, 0, 1)) : normalScale;
        let robot = { x: path.point.x + offset.x, y: path.point.y + offset.y };
        if (payload.mode === 'solo') {
            robot = { x: path.point.x + offset.x * spriteScale / normalScale, y: path.point.y + offset.y * spriteScale / normalScale };
            if (payload.ground && (!launch || progress >= DOCUMENT_ROBOT_LIMITS.forklift.approachEnd)) { robot.y = path.groundY; }
        } else if (payload.mode === 'handoff' && !air && progress < HANDOFF_START) {
            const destination = { x: path.rendezvous.x + offset.x, y: path.rendezvous.y + offset.y };
            const start = launch ?? { x: path.start.x + offset.x, y: path.start.y + offset.y };
            robot = curve(start, { x: destination.x, y: start.y }, destination, ease(clamp(progress / RENDEZVOUS_END, 0, 1)));
        } else if (payload.mode === 'handoff' && !air && progress < HANDOFF_END) {
            robot = { x: path.rendezvous.x + offset.x, y: path.rendezvous.y + offset.y };
        } else if (payload.mode === 'formation' && progress < RENDEZVOUS_END) {
            const destination = { x: path.start.x + offset.x, y: path.start.y + offset.y };
            const start = launch ?? destination;
            robot = curve(start, { x: destination.x, y: start.y }, destination, ease(progress / RENDEZVOUS_END));
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
            spriteScale = normalScale + (destinationScale - normalScale) * returnProgress;
            const departureTarget = destination ? { x: destination.x, y: destination.y } : path.project(actor.departure);
            if (payload.ground && !destination) { departureTarget.y = path.groundY; }
            if (actor.port && !destination) {
                const width = win.innerWidth || viewport.right, height = win.innerHeight || viewport.bottom;
                if (payload.route % 2) { departureTarget.y = payload.route === 1 ? -100 : height + 100; }
                else { departureTarget.x = payload.route === 0 ? -100 : width + 100; }
            }
            const from = { x: path.target.x + offset.x, y: payload.ground ? path.groundY : path.target.y + offset.y };
            robot = curve(from, { x: from.x, y: departureTarget.y }, departureTarget, returnProgress);
        }
        const carrying = !payload.deposited && !(payload.mode === 'handoff' && (air ? payload.handedOff : !payload.handedOff));
        const lifting = payload.ground && progress >= DOCUMENT_ROBOT_LIMITS.forklift.liftStart;
        const liftProgress = lifting ? Math.round(clamp((progress - DOCUMENT_ROBOT_LIMITS.forklift.liftStart)
            / (DEPOSIT_START - DOCUMENT_ROBOT_LIMITS.forklift.liftStart), 0, 1) * 12) / 12 : 0;
        const activity = actor.departing ? 'navigate' : payload.deposited || lifting ? 'unload'
            : payload.mode === 'handoff' ? air ? payload.handedOff ? 'park' : 'deliver'
                : payload.handedOff ? 'deliver' : progress >= RENDEZVOUS_END ? 'load' : 'navigate'
                : payload.mode === 'formation' ? 'assist' : 'deliver';
        if (actor.pose.activity !== activity || actor.pose.carrying !== carrying || lifting && actor.pose.progress !== liftProgress) {
            actor.pose.activity = activity; actor.pose.carrying = carrying;
            actor.pose.progress = lifting ? liftProgress : payload.deposited ? 1 : progress;
            drawVehicle(actor);
        }
        const opacity = Math.min(1, launch ? 1 : progress / 0.08, returningToLab ? 1 : (1 - progress) / 0.12);
        actor.sprite.style.opacity = String(opacity);
        const tilt = air && !(payload.mode === 'handoff' && payload.handedOff && !actor.departing)
            ? clamp((path.target.x - path.start.x) / area.width * 9, -8, 8) * (carrying ? 1 : -0.5) : 0;
        const spriteWidth = ROBOT_ARTWORK_SIZE.width * spriteScale, spriteHeight = ROBOT_ARTWORK_SIZE.height * spriteScale;
        actor.sprite.style.width = spriteWidth.toFixed(2) + 'px'; actor.sprite.style.height = spriteHeight.toFixed(2) + 'px';
        actor.sprite.style.transform = 'translate(' + (robot.x - sceneOrigin.x - spriteWidth / 2).toFixed(2) + 'px,'
            + (robot.y - sceneOrigin.y - spriteHeight / 2).toFixed(2) + 'px) rotate(' + tilt.toFixed(2) + 'deg)';
    }

    function paintPayload(payload: Payload, area: Geometry, at: number,
        destinations: ReadonlyMap<RobotBody, RobotDispatchPoint | undefined>, viewport: ReturnType<typeof viewportBounds>): boolean {
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
        if (progress >= DEPOSIT_START && !payload.deposited) { payload.deposited = true; stats.deliveredFragments++; }
        if (progress >= RETURN_START) { releasePayload(payload); }
        const path = payloadPath(payload, area, progress);
        for (const actor of payload.helpers) { paintActor(actor, area, path, destinations, viewport); }
        if (payload.canvas) {
            const leader = payload.helpers[0];
            const initialScale = ((leader.launch ?? leader.origin)?.scale ?? leader.spriteScale) / leader.spriteScale;
            const scale = payload.deposited ? 1 : initialScale + (1 - initialScale) * ease(clamp(progress / 0.20, 0, 1));
            const width = payload.crop.width * area.width * scale, height = payload.crop.height * area.height * scale;
            payload.canvas.style.width = width.toFixed(2) + 'px'; payload.canvas.style.height = height.toFixed(2) + 'px';
            payload.canvas.style.opacity = String(payload.deposited ? clamp((RETURN_START - progress) / 0.10, 0, 1)
                : clamp(progress / (payload.mode === 'formation' ? RENDEZVOUS_END : 0.08), 0, 1));
            payload.canvas.style.transform = 'translate(' + (path.point.x - sceneOrigin.x - width / 2).toFixed(2) + 'px,'
                + (path.point.y - sceneOrigin.y - height / 2).toFixed(2) + 'px)';
            if (payload.mast) {
                const scale = leader.spriteScale;
                const bottom = path.groundY + FORKLIFT_ATTACHMENT_PX.mastBottom * scale, cargoBottom = path.point.y + height / 2;
                const top = Math.min(path.groundY + FORKLIFT_ATTACHMENT_PX.mastTop * scale, cargoBottom);
                Object.assign(payload.mast.style, {
                    left: path.point.x + (FORKLIFT_ATTACHMENT_PX.mastLeft - FORKLIFT_ATTACHMENT_PX.cargoX) * scale - sceneOrigin.x + 'px',
                    top: top - sceneOrigin.y + 'px', width: FORKLIFT_ATTACHMENT_PX.mastWidth * scale + 'px', height: Math.max(1, bottom - top) + 'px',
                    borderWidth: '0 ' + FORKLIFT_ATTACHMENT_PX.railWidth * scale + 'px',
                    opacity: (leader.launch || leader.origin) && progress < DOCUMENT_ROBOT_LIMITS.forklift.approachEnd ? '0' : payload.canvas.style.opacity,
                });
                const fork = payload.mast.firstElementChild as HTMLElement;
                Object.assign(fork.style, { top: cargoBottom - top + 'px', width: FORKLIFT_ATTACHMENT_PX.forkWidth * scale + 'px',
                    height: FORKLIFT_ATTACHMENT_PX.forkHeight * scale + 'px' });
            }
        }
        return true;
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
            const areas = new Map([...episodes.values()].map(episode => [episode, geometry(episode.element, viewport)]));
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
            for (const episode of [...episodes.values()]) {
                if (!visible.has(episode.page) || episode.element.isConnected === false) { dropEpisode(episode, true); continue; }
                const area = areas.get(episode);
                if (!area) { dropEpisode(episode, true); continue; }
                for (let index = episode.payloads.length - 1; index >= 0; index--) {
                    const payload = episode.payloads[index];
                    try {
                        if (actorCount() <= policy.maxActors && payload.helpers.every(actor => resizeSprite(actor, policy))
                            && paintPayload(payload, area, at, destinations, viewport)) { continue; }
                    } catch { stats.rejected++; }
                    dropPayload(payload);
                    episode.payloads.splice(index, 1);
                }
                if (!episode.payloads.length) { dropEpisode(episode, false); }
            }
            for (const work of [...advance.values()]) {
                try { paintAdvance(work, at, viewport, policy, workAreas.get(work), destinations); }
                catch {
                    for (const actor of work.actors) { releaseActor(actor.body); }
                    work.actors.length = 0; work.admitted = true; work.phase = 'parked';
                    work.message = advanceMessage(work); work.label.textContent = work.message;
                    stats.rejected++;
                }
            }
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
        helpers: number, used: ReadonlySet<RobotVehicle>, policy: Presentation, staged: AdvanceActor[], ground = false): Payload | undefined {
        const payload = makePayload(source, crop, area, index, mode, policy, ground);
        if (!payload) { return; }
        for (let helper = 0; helper < helpers; helper++) {
            const actor = makeCourier(payload, area, used, policy, staged);
            if (!actor) { dropPayload(payload); return; }
            payload.helpers.push(actor);
        }
        if (payload.helpers.some(actor => actor.origin || actor.launch)) { payload.delay = 0; }
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
        const policy = presentation(viewport);
        const area = geometry(value.pageElement, viewport);
        if (!area || area.width * (area.right - area.left) < policy.minimumWidth
            || area.height * (area.bottom - area.top) < policy.minimumHeight) { return 'deferred'; }
        if (!policy.maxActors || !policy.maxCargoBytes) { seen.add(value.pageNumber); stats.skipped++; return 'skipped'; }
        const used = new Set([...episodes.values()].flatMap(episode => actorsOf(episode).map(actor => actor.vehicle)));
        if (actorCount() - advanceActors().length >= policy.maxActors || episodes.size && activePresentation !== policy.kind
            || dispatchOrigin && used.size >= ROBOT_VEHICLES.length) {
            capacityBlocked = true; return 'busy';
        }
        const crops = selectCrops(value.canvas, area, policy, value.imageRegions);
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
        if (!deliveryBag.length) { deliveryBag = random.shuffle(['solo', 'solo', 'pair', 'handoff', 'trio'] as const); }
        const choice = deliveryBag.shift()!;
        // A visible page base is a real ground route. Prefer its lower photograph or ink crop;
        // an upper crop remains available to the flying/cooperative crew.
        const lower = area.bottom >= 0.98 && !used.has('forklift')
            && (count >= 3 && (choice !== 'trio' || count >= 4) || count === 1 || choice === 'solo')
            ? [...crops].filter(crop => crop.y + crop.height / 2 >= 0.6 && crop.score >= 1)
                .sort((a, b) => b.y + b.height - a.y - a.height || b.score - a.score)[0] : undefined;
        const remaining = [...crops];
        if (lower) {
            const ground = makeDelivery(value.canvas, lower, area, 0, 'solo', 1, used, policy, staged, true);
            if (ground) {
                payloads.push(ground); assigned++; used.add('forklift');
                remaining.splice(remaining.indexOf(lower), 1);
            }
        }
        const first = remaining[0];
        const enlarged = first && (first.imageId ? first : largerCrop(first, area));
        let sharedCrop = false;
        if (first && enlarged && (largeImage || choice !== 'solo') && count - assigned >= 2 && first.score >= 1
            && (largeImage || enlarged.width >= first.width * 1.4 && enlarged.height >= first.height * 1.4)) {
            const helpers = choice === 'trio' ? Math.min(3, count - assigned) : 2;
            const shared = makeDelivery(value.canvas, enlarged, area, payloads.length, choice === 'handoff' ? 'handoff' : 'formation', helpers, used, policy, staged);
            if (shared) {
                payloads.push(shared); assigned += shared.helpers.length;
                sharedCrop = true;
                for (const actor of shared.helpers) { used.add(actor.vehicle); }
            }
        }
        for (let index = sharedCrop ? 1 : 0; index < remaining.length && assigned < count; index++) {
            const payload = makeDelivery(value.canvas, remaining[index], area, payloads.length, 'solo', 1, used, policy, staged);
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
                layer.append(payload.canvas!, ...payload.helpers.map(actor => actor.sprite));
            }
            container.append(transit);
            transit.append(layer);
            const episode = { page: value.pageNumber, element: value.pageElement, kind: value.kind, layer, payloads };
            episodes.set(value.pageNumber, episode);
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
            if (!episodes.size && !advance.size) { transit.remove(); }
            seen.add(value.pageNumber);
            stats.rejected++;
            return 'skipped';
        }
    }

    function visibilityChanged(): void { if (hidden()) { clearActive(); } }
    function motionChanged(): void {
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
    doc.addEventListener('visibilitychange', visibilityChanged);
    media.addEventListener('change', motionChanged);

    return {
        offer,
        setVisibleWork,
        deliver(value: DocumentRobotDelivery): boolean { return offer(value) === 'started'; },
        hasHandled(page: number): boolean { return seen.has(page); },
        setDispatchOrigin(port: RobotDispatchPort | undefined) {
            dispatchOrigin = port;
            if (episodes.size || advance.size) {
                try { container.append(transit); }
                catch { clearActive(); stats.rejected++; }
            }
        },
        get enabled() { return enabled; },
        setEnabled(value: boolean) { if (!disposed) { enabled = value; if (!value) { clearActive(); } } },
        setVisiblePages,
        reset() { clearActive(); seen.clear(); visible.clear(); stats = counters(); frames = 0; paintTotalMs = paintMaxMs = paintLastMs = 0; },
        snapshot() {
            const policy = presentation();
            return {
                enabled, reducedMotion: media.matches, scheduled: frame !== undefined, frames, paintTotalMs, paintMaxMs, paintLastMs,
                activeEpisodes: episodes.size, activeActors: actorCount(), cargoBytes, spriteBytes,
                activePayloads: [...episodes.values()].reduce((count, episode) => count + episode.payloads.filter(payload => payload.canvas).length, 0),
                retainedBytes: cargoBytes + spriteBytes, maxActors: policy.maxActors, maxCargoBytes: policy.maxCargoBytes,
                maxSpriteBytes: policy.maxSpriteBytes, presentation: policy.kind, spriteScale: policy.spriteScale, ...stats,
                advance: [...advance.values()].map(work => ({ key: work.key, pages: work.pages.map(page => page.pageNumber),
                    phase: work.phase, message: work.message,
                    actors: work.actors.map(actor => ({ id: actor.body.id, vehicle: actor.body.vehicle, fromLab: !!actor.body.port })) })),
                pages: [...episodes.values()].map(episode => ({
                    page: episode.page, kind: episode.kind,
                    payloads: episode.payloads.map(payload => ({ id: payload.id, mode: payload.mode, ground: payload.ground, imageId: payload.crop.imageId,
                        helpers: payload.helpers.map(actor => actor.id), progress: payload.progress, stage: payload.stage,
                        deposited: payload.deposited, handedOff: payload.handedOff,
                        carrier: payload.mode === 'handoff' ? payload.handedOff ? 'ground' : 'aerial' : 'team',
                        target: { x: payload.crop.x, y: payload.crop.y, width: payload.crop.width, height: payload.crop.height } })),
                    actors: actorsOf(episode).map(actor => ({ id: actor.id, vehicle: actor.vehicle, route: actor.payload.route,
                        payloadId: actor.payload.id, role: actor.payload.mode === 'handoff'
                            ? ROBOT_VEHICLES.find(spec => spec.id === actor.vehicle)!.air ? 'aerial' : 'ground' : actor.payload.mode === 'solo' ? 'solo' : 'helper',
                        target: { x: actor.payload.crop.x, y: actor.payload.crop.y, width: actor.payload.crop.width, height: actor.payload.crop.height },
                        deposited: actor.payload.deposited, departing: actor.departing, fromLab: !!actor.port })),
                })),
            };
        },
        dispose() {
            if (disposed) { return; }
            disposed = true; enabled = false;
            clearActive(); seen.clear(); visible.clear();
            dispatchOrigin = undefined;
            transit.remove();
            doc.removeEventListener('visibilitychange', visibilityChanged);
            media.removeEventListener('change', motionChanged);
        },
    };
}
