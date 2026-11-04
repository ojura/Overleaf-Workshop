import { paintRobotVehicle, RobotRandom, ROBOT_ARTWORK_SIZE, ROBOT_VEHICLES, type RobotArtworkActor, type RobotVehicle, type RobotDispatchPort, type RobotDispatchPoint } from './prefetch-robots';
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
    cooperative: Object.freeze({ rasterScale: 1.5, cropScale: 1.8, durationScale: 1.25 }),
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

export interface DocumentRobotDelivery {
    pageNumber: number;
    pageElement: HTMLElement;
    canvas: HTMLCanvasElement;
    kind: 'preview' | 'page';
}

type Point = { x: number; y: number };
type Crop = { x: number; y: number; width: number; height: number; score: number };
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
type DeliveryStage = 'rendezvous' | 'handoff' | 'carry' | 'deposit' | 'return';
interface Payload {
    id: number;
    mode: DeliveryMode;
    route: number;
    crop: Crop;
    start: Point;
    control: Point;
    started: number;
    delay: number;
    duration: number;
    canvas?: HTMLCanvasElement;
    bytes: number;
    helpers: Courier[];
    progress: number;
    stage: DeliveryStage;
    deposited: boolean;
    handedOff: boolean;
}
interface Courier {
    id: number;
    vehicle: RobotVehicle;
    payload: Payload;
    slot: number;
    departure: Point;
    sprite: HTMLCanvasElement;
    spriteBytes: number;
    spriteScale: number;
    pose: RobotArtworkActor;
    departing: boolean;
    port?: RobotDispatchPort;
    origin?: RobotDispatchPoint;
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
    const transit = doc.createElement('div');
    transit.className = 'pdfDocumentRobotTransit';
    transit.setAttribute('aria-hidden', 'true');
    Object.assign(transit.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647', overflow: 'hidden' });
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
    let lastPaint = -Infinity;
    let cargoBytes = 0;
    let spriteBytes = 0;
    let frames = 0;
    let stats = counters();
    let dispatchOrigin: RobotDispatchPort | undefined;
    let activePresentation: Presentation['kind'] | undefined;
    let capacityBlocked = false;
    let capacityFreed = false;
    let capacityOnMotionResume = false;

    const hidden = () => doc.hidden || doc.visibilityState === 'hidden';
    const actorsOf = (episode: Episode) => episode.payloads.flatMap(payload => payload.helpers);
    const actorCount = () => [...episodes.values()].reduce((sum, episode) => sum + actorsOf(episode).length, 0);

    function viewportBounds() {
        const bounds = container.getBoundingClientRect();
        const visual = win.visualViewport;
        const left = Math.max(bounds.left, visual?.offsetLeft ?? 0);
        const top = Math.max(bounds.top, visual?.offsetTop ?? 0);
        const right = Math.min(bounds.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? win.innerWidth));
        const bottom = Math.min(bounds.bottom, (visual?.offsetTop ?? 0) + (visual?.height ?? win.innerHeight));
        return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
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

    function selectCrops(source: HTMLCanvasElement, area: Geometry, policy: Presentation): Crop[] {
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

    function drawVehicle(actor: Courier): void {
        const context = actor.sprite.getContext('2d');
        if (!context) { throw new Error('Robot artwork canvas is unavailable'); }
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, actor.sprite.width, actor.sprite.height);
        context.setTransform(actor.sprite.width / ROBOT_ARTWORK_SIZE.width, 0, 0, actor.sprite.height / ROBOT_ARTWORK_SIZE.height, 0, 0);
        paintRobotVehicle(context, actor.pose, actor.payload.started / 1000 + actor.id);
        context.setTransform(1, 0, 0, 1, 0, 0);
    }

    function spriteSize(policy: Presentation, origin?: RobotDispatchPoint) {
        const scale = policy.kind === 'desktop' ? Math.max(policy.spriteScale, origin?.scale ?? 0) * policy.spriteDpr : 1;
        const width = Math.ceil(ROBOT_ARTWORK_SIZE.width * scale), height = Math.ceil(ROBOT_ARTWORK_SIZE.height * scale);
        return { width, height, bytes: width * height * RGBA_BYTES };
    }

    function resizeSprite(actor: Courier, policy: Presentation): boolean {
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

    function decorate(canvas: HTMLCanvasElement, className: string, zIndex: string): void {
        canvas.className = className;
        canvas.setAttribute('aria-hidden', 'true');
        Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none',
            transformOrigin: '50% 50%', willChange: 'transform, opacity', zIndex });
    }

    function makePayload(source: HTMLCanvasElement, crop: Crop, area: Geometry, index: number,
        mode: DeliveryMode, policy: Presentation): Payload | undefined {
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
            const route = nextRoute();
            const target = { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
            const start = edge(route, area, target), bend = random.range(-0.16, 0.16);
            const payload: Payload = {
                id: ++payloadSerial, mode, route, crop, start,
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

    function makeCourier(payload: Payload, area: Geometry, used: ReadonlySet<RobotVehicle>, policy: Presentation): Courier | undefined {
        let sprite: HTMLCanvasElement | undefined;
        let reserved: { port: RobotDispatchPort; vehicle: RobotVehicle } | undefined;
        try {
            let vehicle: RobotVehicle | undefined;
            let origin: RobotDispatchPoint | undefined;
            for (let attempt = 0; attempt < ROBOT_VEHICLES.length * 2; attempt++) {
                const candidate = nextVehicle();
                if (payload.helpers.some(helper => helper.vehicle === candidate)) { continue; }
                if (payload.mode === 'handoff' && ROBOT_VEHICLES.find(spec => spec.id === candidate)!.air !== (payload.helpers.length === 0)) { continue; }
                if (used.has(candidate) && (dispatchOrigin || used.size < ROBOT_VEHICLES.length)) { continue; }
                const point = dispatchOrigin?.reserve(candidate);
                if (dispatchOrigin && !point) { continue; }
                vehicle = candidate;
                origin = point;
                if (dispatchOrigin) { reserved = { port: dispatchOrigin, vehicle }; }
                break;
            }
            if (!vehicle) { return; }
            const size = spriteSize(policy, origin);
            if (spriteBytes + size.bytes > policy.maxSpriteBytes) { return; }
            sprite = createCanvas();
            sprite.width = size.width; sprite.height = size.height;
            const target = { x: payload.crop.x + payload.crop.width / 2, y: payload.crop.y + payload.crop.height / 2 };
            const actor: Courier = {
                id: ++serial, vehicle, payload, slot: payload.helpers.length,
                departure: edge((payload.route + 1 + Math.floor(random.next() * 2)) % 4, area, target),
                sprite, spriteBytes: size.bytes, spriteScale: policy.spriteScale,
                departing: false, port: reserved?.port, origin,
                pose: { vehicle, x: ROBOT_ARTWORK_SIZE.width / 2, y: ROBOT_ARTWORK_SIZE.height / 2,
                    vx: 50, vy: 0, activity: 'deliver', job: 'delivery', temperament: 1,
                    phase: random.range(0, Math.PI * 2), distance: random.range(0, 80), needsHelp: false,
                    carrying: true, cargo: null, progress: 0, look: payload.start.x < target.x ? 1 : -1, notice: null },
            };
            drawVehicle(actor);
            decorate(sprite, 'pdfDocumentRobotVehicle', '2');
            sprite.dataset.courier = String(actor.id);
            sprite.dataset.payload = String(payload.id);
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

    function releaseActor(actor: Courier): void {
        release(actor.sprite);
        spriteBytes -= actor.spriteBytes;
        capacityFreed = true;
        actor.port?.release(actor.vehicle);
        actor.port = undefined;
    }

    function releasePayload(payload: Payload): void {
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
        if (!episodes.size) { transit.remove(); }
        if (cancelled) { stats.cancelledEpisodes++; }
    }

    function cancelFrameIfEmpty(): void {
        if (!episodes.size && frame) { cancelFrame(frame.id); frame = undefined; }
    }

    function clearActive(): void {
        capacityBlocked = false;
        capacityOnMotionResume = false;
        if (frame) { cancelFrame(frame.id); frame = undefined; }
        for (const episode of [...episodes.values()]) { dropEpisode(episode, true); }
        activePresentation = undefined;
        capacityFreed = false;
        lastPaint = -Infinity;
    }

    function helperOffset(actor: Courier, area: Geometry, progress: number): Point {
        const payload = actor.payload;
        const bodyScale = actor.spriteScale / DOCUMENT_ROBOT_LIMITS.spriteScale;
        const air = ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!.air;
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
        const initialScale = (leader.origin?.scale ?? leader.spriteScale) / leader.spriteScale;
        const start = leader.origin ? { x: leader.origin.x - offset.x * initialScale, y: leader.origin.y - offset.y * initialScale } : project(payload.start);
        const control = leader.origin ? { x: (start.x + target.x) / 2 + (payload.route % 2 ? 70 : -70), y: Math.min(start.y, target.y) - 45 }
            : project(payload.control);
        const rendezvous = curve(start, control, target, 0.38);
        let point: Point;
        if (progress >= DEPOSIT_START) { point = target; }
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
        return { start, control, target, rendezvous, point, project };
    }

    function paintActor(actor: Courier, area: Geometry, path: ReturnType<typeof payloadPath>): void {
        const payload = actor.payload, progress = payload.progress;
        const air = ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!.air;
        const offset = helperOffset(actor, area, progress);
        const normalScale = actor.spriteScale;
        const originScale = actor.origin?.scale ?? normalScale;
        let spriteScale = actor.origin ? originScale + (normalScale - originScale) * ease(clamp(progress / 0.20, 0, 1)) : normalScale;
        let robot = { x: path.point.x + offset.x, y: path.point.y + offset.y };
        if (payload.mode === 'solo') {
            robot = { x: path.point.x + offset.x * spriteScale / normalScale, y: path.point.y + offset.y * spriteScale / normalScale };
        } else if (payload.mode === 'handoff' && !air && progress < HANDOFF_START) {
            const destination = { x: path.rendezvous.x + offset.x, y: path.rendezvous.y + offset.y };
            const start = actor.origin ?? { x: path.start.x + offset.x, y: path.start.y + offset.y };
            robot = curve(start, { x: destination.x, y: start.y }, destination, ease(clamp(progress / RENDEZVOUS_END, 0, 1)));
        } else if (payload.mode === 'handoff' && !air && progress < HANDOFF_END) {
            robot = { x: path.rendezvous.x + offset.x, y: path.rendezvous.y + offset.y };
        } else if (payload.mode === 'formation' && progress < RENDEZVOUS_END) {
            const destination = { x: path.start.x + offset.x, y: path.start.y + offset.y };
            const start = actor.origin ?? destination;
            robot = curve(start, { x: destination.x, y: start.y }, destination, ease(progress / RENDEZVOUS_END));
        } else if (actor.origin && payload.mode === 'handoff' && air && progress < HANDOFF_START) {
            robot.x = path.point.x + offset.x * spriteScale / normalScale;
            robot.y = path.point.y + offset.y * spriteScale / normalScale;
        }
        let returningToLab = false;
        if (progress >= RETURN_START) {
            actor.departing = true;
            const destination = actor.port === dispatchOrigin ? actor.port?.destination(actor.vehicle) : undefined;
            returningToLab = !!destination;
            const returnProgress = ease((progress - RETURN_START) / (1 - RETURN_START));
            const destinationScale = destination?.scale ?? normalScale;
            spriteScale = normalScale + (destinationScale - normalScale) * returnProgress;
            const departureTarget = destination ? { x: destination.x, y: destination.y } : path.project(actor.departure);
            if (actor.port && !destination) {
                const viewport = container.getBoundingClientRect();
                const width = win.innerWidth || viewport.right, height = win.innerHeight || viewport.bottom;
                if (payload.route % 2) { departureTarget.y = payload.route === 1 ? -100 : height + 100; }
                else { departureTarget.x = payload.route === 0 ? -100 : width + 100; }
            }
            const from = { x: path.target.x + offset.x, y: path.target.y + offset.y };
            robot = curve(from, { x: from.x, y: departureTarget.y }, departureTarget, returnProgress);
        }
        const carrying = !payload.deposited && !(payload.mode === 'handoff' && (air ? payload.handedOff : !payload.handedOff));
        const activity = actor.departing ? 'navigate' : payload.deposited ? 'unload'
            : payload.mode === 'handoff' ? air ? payload.handedOff ? 'park' : 'deliver'
                : payload.handedOff ? 'deliver' : progress >= RENDEZVOUS_END ? 'load' : 'navigate'
                : payload.mode === 'formation' ? 'assist' : 'deliver';
        if (actor.pose.activity !== activity || actor.pose.carrying !== carrying) {
            actor.pose.activity = activity; actor.pose.carrying = carrying; actor.pose.progress = payload.deposited ? 1 : progress;
            drawVehicle(actor);
        }
        const opacity = Math.min(1, actor.origin ? 1 : progress / 0.08, returningToLab ? 1 : (1 - progress) / 0.12);
        actor.sprite.style.opacity = String(opacity);
        const tilt = air && !(payload.mode === 'handoff' && payload.handedOff && !actor.departing)
            ? clamp((path.target.x - path.start.x) / area.width * 9, -8, 8) * (carrying ? 1 : -0.5) : 0;
        const spriteWidth = ROBOT_ARTWORK_SIZE.width * spriteScale, spriteHeight = ROBOT_ARTWORK_SIZE.height * spriteScale;
        actor.sprite.style.width = spriteWidth.toFixed(2) + 'px'; actor.sprite.style.height = spriteHeight.toFixed(2) + 'px';
        actor.sprite.style.transform = 'translate(' + (robot.x - spriteWidth / 2).toFixed(2) + 'px,' + (robot.y - spriteHeight / 2).toFixed(2) + 'px) rotate(' + tilt.toFixed(2) + 'deg)';
    }

    function paintPayload(payload: Payload, area: Geometry, at: number): boolean {
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
            : payload.mode === 'handoff' && progress >= HANDOFF_START && progress < HANDOFF_END ? 'handoff'
                : payload.mode !== 'solo' && progress < (payload.mode === 'handoff' ? HANDOFF_START : RENDEZVOUS_END) ? 'rendezvous' : 'carry';
        if (progress >= DEPOSIT_START && !payload.deposited) { payload.deposited = true; stats.deliveredFragments++; }
        if (progress >= RETURN_START) { releasePayload(payload); }
        const path = payloadPath(payload, area, progress);
        for (const actor of payload.helpers) { paintActor(actor, area, path); }
        if (payload.canvas) {
            const leader = payload.helpers[0];
            const initialScale = (leader.origin?.scale ?? leader.spriteScale) / leader.spriteScale;
            const scale = payload.deposited ? 1 : initialScale + (1 - initialScale) * ease(clamp(progress / 0.20, 0, 1));
            const width = payload.crop.width * area.width * scale, height = payload.crop.height * area.height * scale;
            payload.canvas.style.width = width.toFixed(2) + 'px'; payload.canvas.style.height = height.toFixed(2) + 'px';
            payload.canvas.style.opacity = String(payload.deposited ? clamp((RETURN_START - progress) / 0.10, 0, 1)
                : clamp(progress / (payload.mode === 'formation' ? RENDEZVOUS_END : 0.08), 0, 1));
            payload.canvas.style.transform = 'translate(' + (path.point.x - width / 2).toFixed(2) + 'px,' + (path.point.y - height / 2).toFixed(2) + 'px)';
        }
        return true;
    }

    function paint(at: number): void {
        const viewport = viewportBounds();
        const policy = presentation(viewport);
        if (activePresentation && activePresentation !== policy.kind) {
            const blocked = capacityBlocked;
            clearActive();
            capacityBlocked = blocked;
            capacityFreed = true;
            notifyCapacity();
            return;
        }
        const bounds = transit.getBoundingClientRect();
        // Fixed transit may cross page edges, but never covers the viewer's controls.
        transit.style.clipPath = 'inset(' + Math.max(0, viewport.top - bounds.top) + 'px '
            + Math.max(0, bounds.right - viewport.right) + 'px ' + Math.max(0, bounds.bottom - viewport.bottom) + 'px '
            + Math.max(0, viewport.left - bounds.left) + 'px)';
        for (const episode of [...episodes.values()]) {
            if (!visible.has(episode.page) || episode.element.isConnected === false) { dropEpisode(episode, true); continue; }
            const area = geometry(episode.element, viewport);
            if (!area) { dropEpisode(episode, true); continue; }
            for (let index = episode.payloads.length - 1; index >= 0; index--) {
                const payload = episode.payloads[index];
                try {
                    if (actorCount() <= policy.maxActors && payload.helpers.every(actor => resizeSprite(actor, policy)) && paintPayload(payload, area, at)) { continue; }
                } catch { stats.rejected++; }
                dropPayload(payload);
                episode.payloads.splice(index, 1);
            }
            if (!episode.payloads.length) { dropEpisode(episode, false); }
        }
        frames++;
        notifyCapacity();
    }

    function schedule(): void {
        if (frame || !episodes.size || disposed || !enabled || hidden() || media.matches) { return; }
        const pending = { id: 0 };
        frame = pending;
        pending.id = requestFrame(at => {
            if (frame !== pending) { return; }
            frame = undefined;
            if (disposed || !enabled || hidden() || media.matches) { return; }
            if (at - lastPaint >= 1000 / DOCUMENT_ROBOT_LIMITS.maxFps) {
                lastPaint = at;
                paint(at);
            }
            schedule();
        });
    }

    function makeDelivery(source: HTMLCanvasElement, crop: Crop, area: Geometry, index: number, mode: DeliveryMode,
        helpers: number, used: ReadonlySet<RobotVehicle>, policy: Presentation): Payload | undefined {
        const payload = makePayload(source, crop, area, index, mode, policy);
        if (!payload) { return; }
        for (let helper = 0; helper < helpers; helper++) {
            const actor = makeCourier(payload, area, used, policy);
            if (!actor) { dropPayload(payload); return; }
            payload.helpers.push(actor);
        }
        if (payload.helpers.some(actor => actor.origin)) { payload.delay = 0; }
        payload.canvas!.dataset.courier = String(payload.helpers[0].id);
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
        if (actorCount() >= policy.maxActors || episodes.size && activePresentation !== policy.kind
            || dispatchOrigin && used.size >= ROBOT_VEHICLES.length) {
            capacityBlocked = true; return 'busy';
        }
        const crops = selectCrops(value.canvas, area, policy);
        if (!crops.length) { seen.add(value.pageNumber); stats.skipped++; return 'skipped'; }
        const pageArea = area.width * (area.right - area.left) * area.height * (area.bottom - area.top);
        const crew = policy.kind === 'desktop' ? Math.max(2, Math.round(pageArea / DOCUMENT_ROBOT_LIMITS.desktop.pixelsPerActor))
            : 2 + Math.floor(random.next() * 2);
        const count = Math.min(policy.maxActors - actorCount(), policy.maxFragmentsPerPage, crew, crops.length,
            dispatchOrigin ? ROBOT_VEHICLES.length - used.size : Infinity);
        const payloads: Payload[] = [];
        let assigned = 0;
        if (!deliveryBag.length) { deliveryBag = random.shuffle(['solo', 'solo', 'pair', 'handoff', 'trio'] as const); }
        const choice = deliveryBag.shift()!;
        const enlarged = largerCrop(crops[0], area);
        if (choice !== 'solo' && count >= 2 && crops[0].score >= 1
            && enlarged.width >= crops[0].width * 1.4 && enlarged.height >= crops[0].height * 1.4) {
            const helpers = choice === 'trio' ? Math.min(3, count) : 2;
            const shared = makeDelivery(value.canvas, enlarged, area, 0, choice === 'handoff' ? 'handoff' : 'formation', helpers, used, policy);
            if (shared) {
                payloads.push(shared); assigned += shared.helpers.length;
                for (const actor of shared.helpers) { used.add(actor.vehicle); }
            }
        }
        for (let index = payloads.length ? 1 : 0; index < count && assigned < count; index++) {
            const payload = makeDelivery(value.canvas, crops[index], area, payloads.length, 'solo', 1, used, policy);
            if (payload) {
                payloads.push(payload); assigned++;
                used.add(payload.helpers[0].vehicle);
            }
        }
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
            for (const payload of payloads) { layer.append(payload.canvas!, ...payload.helpers.map(actor => actor.sprite)); }
            doc.body.append(transit);
            transit.append(layer);
            const episode = { page: value.pageNumber, element: value.pageElement, kind: value.kind, layer, payloads };
            episodes.set(value.pageNumber, episode);
            activePresentation = policy.kind;
            seen.add(value.pageNumber);
            paint(now());
            schedule();
            stats.episodes++;
            return 'started';
        } catch {
            const episode = episodes.get(value.pageNumber);
            if (episode) { dropEpisode(episode, true); }
            else { for (const payload of payloads) { dropPayload(payload); } }
            layer?.remove();
            if (!episodes.size) { transit.remove(); }
            seen.add(value.pageNumber);
            stats.rejected++;
            return 'skipped';
        }
    }

    function visibilityChanged(): void { if (hidden()) { clearActive(); } }
    function motionChanged(): void {
        if (media.matches) {
            const waiting = capacityBlocked || capacityOnMotionResume;
            clearActive();
            capacityOnMotionResume = waiting;
        } else if (capacityOnMotionResume) {
            capacityOnMotionResume = false;
            capacityBlocked = capacityFreed = true;
            notifyCapacity();
        }
    }
    doc.addEventListener('visibilitychange', visibilityChanged);
    media.addEventListener('change', motionChanged);

    return {
        offer,
        deliver(value: DocumentRobotDelivery): boolean { return offer(value) === 'started'; },
        hasHandled(page: number): boolean { return seen.has(page); },
        setDispatchOrigin(port: RobotDispatchPort | undefined) {
            dispatchOrigin = port;
            if (episodes.size) {
                try { doc.body.append(transit); }
                catch { clearActive(); stats.rejected++; }
            }
        },
        get enabled() { return enabled; },
        setEnabled(value: boolean) { if (!disposed) { enabled = value; if (!value) { clearActive(); } } },
        setVisiblePages(ids: readonly number[]) {
            visible = new Set(ids);
            for (const episode of [...episodes.values()]) { if (!visible.has(episode.page)) { dropEpisode(episode, true); } }
            cancelFrameIfEmpty();
            notifyCapacity();
        },
        reset() { clearActive(); seen.clear(); visible.clear(); stats = counters(); frames = 0; },
        snapshot() {
            const policy = presentation();
            return {
                enabled, reducedMotion: media.matches, scheduled: frame !== undefined, frames,
                activeEpisodes: episodes.size, activeActors: actorCount(), cargoBytes, spriteBytes,
                activePayloads: [...episodes.values()].reduce((count, episode) => count + episode.payloads.filter(payload => payload.canvas).length, 0),
                retainedBytes: cargoBytes + spriteBytes, maxActors: policy.maxActors, maxCargoBytes: policy.maxCargoBytes,
                maxSpriteBytes: policy.maxSpriteBytes, presentation: policy.kind, spriteScale: policy.spriteScale, ...stats,
                pages: [...episodes.values()].map(episode => ({
                    page: episode.page, kind: episode.kind,
                    payloads: episode.payloads.map(payload => ({ id: payload.id, mode: payload.mode,
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
