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
interface Courier {
    id: number;
    vehicle: RobotVehicle;
    route: number;
    crop: Crop;
    start: Point;
    control: Point;
    departure: Point;
    started: number;
    delay: number;
    duration: number;
    sprite: HTMLCanvasElement;
    spriteBytes: number;
    spriteScale: number;
    cargo?: HTMLCanvasElement;
    cargoBytes: number;
    pose: RobotArtworkActor;
    deposited: boolean;
    departing: boolean;
    port?: RobotDispatchPort;
    origin?: RobotDispatchPoint;
}
interface Episode {
    page: number;
    element: HTMLElement;
    layer: HTMLDivElement;
    kind: DocumentRobotDelivery['kind'];
    actors: Courier[];
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
    const actorCount = () => [...episodes.values()].reduce((sum, episode) => sum + episode.actors.length, 0);

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
        paintRobotVehicle(context, actor.pose, actor.started / 1000 + actor.id);
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

    function makeCourier(source: HTMLCanvasElement, crop: Crop, area: Geometry, index: number, used: ReadonlySet<RobotVehicle>, policy: Presentation): Courier | undefined {
        const sourceX = Math.floor(crop.x * source.width), sourceY = Math.floor(crop.y * source.height);
        const sourceWidth = Math.max(1, Math.min(source.width - sourceX, Math.ceil(crop.width * source.width)));
        const sourceHeight = Math.max(1, Math.min(source.height - sourceY, Math.ceil(crop.height * source.height)));
        const scale = Math.min(1, policy.fragmentDimension / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.floor(sourceWidth * scale)), height = Math.max(1, Math.floor(sourceHeight * scale));
        const bytes = width * height * RGBA_BYTES;
        if (cargoBytes + bytes > policy.maxCargoBytes) { return; }
        let cargo: HTMLCanvasElement | undefined, sprite: HTMLCanvasElement | undefined;
        let reserved: { port: RobotDispatchPort; vehicle: RobotVehicle } | undefined;
        try {
            cargo = createCanvas();
            cargo.width = width; cargo.height = height;
            const context = cargo.getContext('2d', { alpha: true });
            if (!context) { return; }
            context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
            let vehicle: RobotVehicle | undefined;
            let origin: RobotDispatchPoint | undefined;
            for (let attempt = 0; attempt < ROBOT_VEHICLES.length * 2; attempt++) {
                const candidate = nextVehicle();
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
            const route = nextRoute();
            const target = { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
            const start = edge(route, area, target);
            const bend = random.range(-0.16, 0.16);
            const actor: Courier = {
                id: ++serial, vehicle, route, crop, start,
                control: { x: (start.x + target.x) / 2 + bend, y: (start.y + target.y) / 2 - Math.abs(bend) },
                departure: edge((route + 1 + Math.floor(random.next() * 2)) % 4, area, target),
                started: now(), delay: origin ? 0 : index * (policy.kind === 'desktop' ? random.range(40, 85) : random.range(90, 180)),
                duration: random.range(DOCUMENT_ROBOT_LIMITS.minDurationMs, DOCUMENT_ROBOT_LIMITS.maxDurationMs),
                sprite, spriteBytes: size.bytes, spriteScale: policy.spriteScale, cargo, cargoBytes: bytes,
                deposited: false, departing: false, port: reserved?.port, origin,
                pose: { vehicle, x: ROBOT_ARTWORK_SIZE.width / 2, y: ROBOT_ARTWORK_SIZE.height / 2,
                    vx: 50, vy: 0, activity: 'deliver', job: 'delivery', temperament: 1,
                    phase: random.range(0, Math.PI * 2), distance: random.range(0, 80), needsHelp: false,
                    carrying: true, cargo: null, progress: 0, look: start.x < target.x ? 1 : -1, notice: null },
            };
            drawVehicle(actor);
            cargo.className = 'pdfDocumentRobotCargo';
            sprite.className = 'pdfDocumentRobotVehicle';
            cargo.dataset.courier = sprite.dataset.courier = String(actor.id);
            for (const image of [cargo, sprite]) {
                image.setAttribute('aria-hidden', 'true');
                Object.assign(image.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none',
                    transformOrigin: '50% 50%', willChange: 'transform, opacity' });
            }
            Object.assign(cargo.style, { zIndex: '1', boxShadow: '0 2px 7px #0003', borderRadius: '2px' });
            Object.assign(sprite.style, { zIndex: '2' });
            cargoBytes += bytes;
            spriteBytes += actor.spriteBytes;
            cargo = sprite = undefined;
            reserved = undefined;
            return actor;
        } catch { return; }
        finally {
            if (cargo) { release(cargo); }
            if (sprite) { release(sprite); }
            if (reserved) { reserved.port.release(reserved.vehicle); }
        }
    }

    function releaseActor(actor: Courier): void {
        if (actor.cargo) {
            release(actor.cargo); actor.cargo = undefined;
            cargoBytes -= actor.cargoBytes;
        }
        release(actor.sprite);
        spriteBytes -= actor.spriteBytes;
        capacityFreed = true;
        actor.port?.release(actor.vehicle);
        actor.port = undefined;
    }

    function dropEpisode(episode: Episode, cancelled: boolean): void {
        for (const actor of episode.actors) { releaseActor(actor); }
        episode.actors.length = 0;
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

    function paintActor(actor: Courier, area: Geometry, at: number): boolean {
        const elapsed = at - actor.started - actor.delay;
        if (elapsed < 0) {
            actor.sprite.style.opacity = '0';
            if (actor.cargo) { actor.cargo.style.opacity = '0'; }
            return true;
        }
        const progress = clamp(elapsed / actor.duration, 0, 1);
        if (progress >= 1) { return false; }
        const project = (point: Point) => ({ x: area.pageLeft + point.x * area.width, y: area.pageTop + point.y * area.height });
        const target = project({ x: actor.crop.x + actor.crop.width / 2, y: actor.crop.y + actor.crop.height / 2 });
        const carrying = progress < 0.62;
        const air = ROBOT_VEHICLES.find(vehicle => vehicle.id === actor.vehicle)!.air;
        const normalScale = actor.spriteScale;
        const bodyScale = normalScale / DOCUMENT_ROBOT_LIMITS.spriteScale;
        const offset = { x: air ? 0 : -29 * bodyScale, y: (air ? -34 : 25) * bodyScale };
        const originScale = actor.origin?.scale ?? normalScale;
        let spriteScale = actor.origin ? originScale + (normalScale - originScale) * ease(clamp(progress / 0.20, 0, 1)) : normalScale;
        const start = actor.origin ? {
            x: actor.origin.x - offset.x * originScale / normalScale,
            y: actor.origin.y - offset.y * originScale / normalScale,
        } : project(actor.start);
        const control = actor.origin
            ? { x: (start.x + target.x) / 2 + (actor.route % 2 ? 70 : -70), y: Math.min(start.y, target.y) - 45 }
            : project(actor.control);
        const point = carrying ? curve(start, control, target, ease(progress / 0.62)) : target;
        if (!carrying && !actor.deposited) {
            actor.deposited = true;
            actor.pose.activity = 'unload'; actor.pose.progress = 1;
            drawVehicle(actor);
            stats.deliveredFragments++;
        }
        let robot = { x: point.x + offset.x * spriteScale / normalScale, y: point.y + offset.y * spriteScale / normalScale };
        let returningToLab = false;
        if (progress >= 0.76) {
            if (!actor.departing) {
                actor.departing = true;
                actor.pose.carrying = false; actor.pose.activity = 'navigate';
                drawVehicle(actor);
                if (actor.cargo) {
                    release(actor.cargo); actor.cargo = undefined;
                    cargoBytes -= actor.cargoBytes;
                    capacityFreed = true;
                }
            }
            const destination = actor.port === dispatchOrigin ? actor.port?.destination(actor.vehicle) : undefined;
            returningToLab = !!destination;
            const returnProgress = ease((progress - 0.76) / 0.24);
            const destinationScale = destination?.scale ?? normalScale;
            spriteScale = normalScale + (destinationScale - normalScale) * returnProgress;
            const departureTarget = destination ? {
                x: destination.x - offset.x * destinationScale / normalScale,
                y: destination.y - offset.y * destinationScale / normalScale,
            } : project(actor.departure);
            if (actor.port && !destination) {
                // A closed lab cannot receive a courier. Its exit stays outside the viewport.
                const viewport = container.getBoundingClientRect();
                const width = win.innerWidth || viewport.right, height = win.innerHeight || viewport.bottom;
                if (actor.route % 2) { departureTarget.y = actor.route === 1 ? -100 : height + 100; }
                else { departureTarget.x = actor.route === 0 ? -100 : width + 100; }
            }
            const departure = curve(target, { x: target.x, y: departureTarget.y }, departureTarget, returnProgress);
            robot = { x: departure.x + offset.x * spriteScale / normalScale, y: departure.y + offset.y * spriteScale / normalScale };
        }
        const opacity = Math.min(1, actor.origin ? 1 : progress / 0.08, returningToLab ? 1 : (1 - progress) / 0.12);
        actor.sprite.style.opacity = String(opacity);
        const tilt = air ? clamp((target.x - start.x) / area.width * 9, -8, 8) * (carrying ? 1 : -0.5) : 0;
        const spriteWidth = ROBOT_ARTWORK_SIZE.width * spriteScale, spriteHeight = ROBOT_ARTWORK_SIZE.height * spriteScale;
        actor.sprite.style.width = spriteWidth.toFixed(2) + 'px'; actor.sprite.style.height = spriteHeight.toFixed(2) + 'px';
        actor.sprite.style.transform = 'translate(' + (robot.x - spriteWidth / 2).toFixed(2) + 'px,' + (robot.y - spriteHeight / 2).toFixed(2) + 'px) rotate(' + tilt.toFixed(2) + 'deg)';
        if (actor.cargo) {
            const cargoScale = carrying ? spriteScale / normalScale : 1;
            const width = actor.crop.width * area.width * cargoScale, height = actor.crop.height * area.height * cargoScale;
            actor.cargo.style.width = width.toFixed(2) + 'px'; actor.cargo.style.height = height.toFixed(2) + 'px';
            actor.cargo.style.opacity = String(carrying ? opacity : clamp((0.76 - progress) / 0.10, 0, 1));
            actor.cargo.style.transform = 'translate(' + (point.x - width / 2).toFixed(2) + 'px,'
                + (point.y - height / 2).toFixed(2) + 'px)';
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
            for (let index = episode.actors.length - 1; index >= 0; index--) {
                const actor = episode.actors[index];
                try {
                    if (actorCount() <= policy.maxActors && resizeSprite(actor, policy) && paintActor(actor, area, at)) { continue; }
                } catch { stats.rejected++; }
                releaseActor(actor);
                episode.actors.splice(index, 1);
            }
            if (!episode.actors.length) { dropEpisode(episode, false); }
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
        const used = new Set([...episodes.values()].flatMap(episode => episode.actors.map(actor => actor.vehicle)));
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
        const actors: Courier[] = [];
        for (let index = 0; index < count; index++) {
            const actor = makeCourier(value.canvas, crops[index], area, index, used, policy);
            if (actor) { actors.push(actor); used.add(actor.vehicle); }
        }
        if (!actors.length) {
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
            for (const actor of actors) { layer.append(actor.cargo!, actor.sprite); }
            doc.body.append(transit);
            transit.append(layer);
            const episode = { page: value.pageNumber, element: value.pageElement, kind: value.kind, layer, actors };
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
            else { for (const actor of actors) { releaseActor(actor); } }
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
                retainedBytes: cargoBytes + spriteBytes, maxActors: policy.maxActors, maxCargoBytes: policy.maxCargoBytes,
                maxSpriteBytes: policy.maxSpriteBytes, presentation: policy.kind, spriteScale: policy.spriteScale, ...stats,
                pages: [...episodes.values()].map(episode => ({
                    page: episode.page, kind: episode.kind,
                    actors: episode.actors.map(actor => ({ id: actor.id, vehicle: actor.vehicle, route: actor.route,
                        target: { x: actor.crop.x, y: actor.crop.y, width: actor.crop.width, height: actor.crop.height },
                        deposited: actor.deposited, departing: actor.departing, fromLab: !!actor.port })),
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
