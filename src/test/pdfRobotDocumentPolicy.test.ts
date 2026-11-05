import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '..', '..');

describe('Document robot CSS footprint policy', function () {
    this.timeout(30_000);
    let directory: string, api: any;
    before(async () => {
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-robot-document-policy-'));
        try {
            await esbuild.build({ entryPoints: [path.join(repo, 'views/pdf-viewer/src/common/robot-document-policy.ts')],
                outfile: path.join(directory, 'policy.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
            api = await importModule(path.join(directory, 'policy.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => { if (directory) { fs.rmSync(directory, { recursive: true, force: true }); } });

    const full = { x: 0, y: 0, width: 1, height: 1 };
    const photos = [
        { id: 'left', x: 0.04, y: 0.2, width: 0.44, height: 0.35 },
        { id: 'right', x: 0.50, y: 0.2, width: 0.44, height: 0.35 },
    ];
    const page = (zoom = 1) => ({ width: 640 * zoom, height: 900 * zoom });
    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);
    const rotate = (rect: any) => ({ ...rect, x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width });
    const crops = (regions = photos, size = page(), visible = full, kind = 'desktop'): any[] =>
        api.selectRobotImageCrops(regions, size, visible, api.robotDocumentMetrics(size, kind));

    it('uses bounded square-root document growth with neutral quarter-turns', () => {
        for (const zoom of [0.5, 1, 1.5, 2, 3, 4]) {
            const size = page(zoom), value = api.robotDocumentMetrics(size, 'desktop');
            near(value.bodyScale, Math.max(0.8, Math.min(1.35, Math.sqrt(zoom))));
            near(value.cargoEdge, value.bodyScale * 400);
            near(api.robotDocumentMetrics({ width: size.height, height: size.width }, 'desktop').bodyScale, value.bodyScale);
            near(api.robotDocumentMetrics(size, 'compact').bodyScale, value.bodyScale);
            near(api.robotDocumentMetrics(size, 'compact').cargoEdge, value.bodyScale * 256);
        }
    });

    it('keeps invalid and extreme extent inputs finite without modifying the caller', () => {
        const baseline = api.robotDocumentMetrics(page(), 'desktop');
        for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
            assert.deepStrictEqual(api.robotDocumentMetrics({ width: invalid, height: 900 }, 'desktop'), baseline);
        }
        const size = Object.freeze({ width: Number.MAX_VALUE, height: Number.MAX_VALUE });
        assert.deepStrictEqual(api.robotDocumentMetrics(size, 'desktop'), { bodyScale: 1.35, cargoEdge: 540 });
        assert.strictEqual(size.width, Number.MAX_VALUE);
        assert.ok(Object.isFrozen(api.ROBOT_DOCUMENT_POLICY));
    });

    it('chooses one tight collage, whole photographs, then page-anchored portions', () => {
        for (const zoom of [0.5, 1, 1.5, 2, 3, 4]) {
            const selected = crops(photos, page(zoom));
            const kind = zoom === 0.5 ? 'collage' : zoom <= 1.5 ? 'image' : 'portion';
            assert.ok(selected.length > 0 && selected.length <= 12);
            assert.ok(selected.every(value => value.kind === kind));
            if (kind === 'collage') {
                assert.strictEqual(selected.length, 1);
                assert.deepStrictEqual(selected[0].imageIds, ['left', 'right']);
                near(selected[0].width, 0.9);
            } else if (kind === 'image') {
                assert.strictEqual(selected.length, 2);
                for (const selectedImage of selected) {
                    const original = photos.find(value => value.id === selectedImage.imageId)!;
                    for (const key of ['x', 'y', 'width', 'height'] as const) { assert.strictEqual(selectedImage[key], original[key]); }
                }
            } else {
                const edge = api.robotDocumentMetrics(page(zoom), 'desktop').cargoEdge;
                assert.ok(selected.every(value => value.width * 640 * zoom <= edge + 1e-9
                    && value.height * 900 * zoom <= edge + 1e-9));
            }
            assert.deepStrictEqual(crops([...photos].reverse(), page(zoom)), selected, 'manifest ordering does not change identity');
        }
    });

    it('groups an aligned dense four-picture collage identically after a quarter-turn', () => {
        const grid = [0, 1, 2, 3].map(index => ({ id: 'photo-' + index,
            x: 0.1 + index % 2 * 0.126, y: 0.2 + Math.floor(index / 2) * 0.104, width: 0.12, height: 0.1 }));
        const selected = crops(grid);
        assert.strictEqual(selected.length, 1);
        assert.strictEqual(selected[0].kind, 'collage');
        assert.deepStrictEqual(selected[0].imageIds, grid.map(value => value.id));
        const turned = crops(grid.map(rotate), { width: 900, height: 640 });
        assert.strictEqual(turned.length, 1);
        assert.strictEqual(turned[0].imageId, selected[0].imageId);
        const expected = rotate(selected[0]);
        for (const key of ['x', 'y', 'width', 'height']) { near(turned[0][key], expected[key]); }
    });

    it('rotates oversized image portions on the logical page without changing their CSS envelope', () => {
        const image = [{ id: 'large', x: 0.1, y: 0.2, width: 0.8, height: 0.6 }];
        const upright = crops(image, page(2));
        const turned = crops(image.map(rotate), { width: 1800, height: 1280 });
        assert.strictEqual(upright.length, 4);
        assert.strictEqual(turned.length, 4);
        assert.ok(turned.every(value => value.kind === 'portion'));
        const geometry = (values: any[]) => values.map(value => [value.x, value.y, value.width, value.height]
            .map(edge => edge.toFixed(10)).join(':')).sort();
        assert.deepStrictEqual(geometry(turned), geometry(upright.map(rotate)));
    });

    it('keeps caption-sized gutters, misaligned rows and sparse groups separate', () => {
        const first = { id: 'a', x: 0.1, y: 0.1, width: 0.2, height: 0.15 };
        const cases = [
            [first, { ...first, id: 'b', y: 0.27 }],
            [first, { ...first, id: 'b', x: 0.306, y: 0.11 }],
            [first, { ...first, id: 'b', x: 0.306 }, { ...first, id: 'c', y: 0.254 }],
        ];
        for (const regions of cases) {
            const selected = crops(regions);
            assert.strictEqual(selected.length, regions.length);
            assert.ok(selected.every(value => value.kind === 'image'), 'the planner must not cover the space between separated pictures');
        }
    });

    it('does not form collages from overlapping or partly clipped placements', () => {
        const first = { id: 'a', x: 0.1, y: 0.1, width: 0.2, height: 0.15 };
        const overlap = crops([first, { ...first, id: 'b', x: 0.15 }]);
        assert.strictEqual(overlap.length, 2);
        assert.ok(overlap.every(value => value.kind === 'image'));
        const clipped = crops([first, { ...first, id: 'b', x: 0.306 }], page(), { x: 0.2, y: 0, width: 0.8, height: 1 });
        assert.strictEqual(clipped.length, 2);
        assert.ok(clipped.every(value => value.kind === 'image'));
        assert.strictEqual(crops([first, { ...first, id: 'duplicate' }]).length, 1, 'identical placements cannot create duplicate group members');
    });

    it('keeps a giant image grid fixed as the visible window moves and bounds its work', () => {
        const image = [{ id: 'giant', x: 0.01, y: 0.01, width: 0.98, height: 0.98 }];
        const size = { width: 12_800, height: 18_000 };
        const first = crops(image, size, { x: 0.36, y: 0.38, width: 0.1, height: 0.1 });
        const shifted = crops(image, size, { x: 0.37, y: 0.39, width: 0.1, height: 0.1 });
        assert.ok(first.length > 0 && first.length <= 12 && shifted.length <= 12);
        const common = first.filter(value => shifted.some(other => other.imageId === value.imageId));
        assert.ok(common.length > 0, 'nearby views retain common source-grid cells');
        for (const value of common) {
            const other = shifted.find(candidate => candidate.imageId === value.imageId);
            for (const key of ['imageId', 'imageIds', 'x', 'y', 'width', 'height', 'kind']) { assert.deepStrictEqual(other[key], value[key]); }
        }
        for (const value of [...first, ...shifted]) {
            assert.ok(value.width * size.width <= 540 + 1e-9 && value.height * size.height <= 540 + 1e-9);
            assert.ok(value.x >= 0.01 && value.y >= 0.01 && value.x + value.width <= 0.99 + 1e-12 && value.y + value.height <= 0.99 + 1e-12);
        }
        const extreme = crops(image, { width: 1e12, height: 1e12 }, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
        assert.strictEqual(extreme.length, 12, 'planning does not walk billions of offscreen or visible cells');
    });

    it('rejects unusable geometry and image slivers before allocating crop candidates', () => {
        assert.deepStrictEqual(crops(photos, { width: 0, height: 900 }), []);
        assert.deepStrictEqual(crops(photos, page(), { x: NaN, y: 0, width: 1, height: 1 }), []);
        assert.deepStrictEqual(crops(photos, page(), { x: 2, y: 2, width: 1, height: 1 }), []);
        assert.deepStrictEqual(crops([{ id: 'bad', x: 0.1, y: 0.1, width: Infinity, height: 0.2 }]), []);
        assert.deepStrictEqual(crops([{ id: 'sliver', x: 0.1, y: 0.1, width: 0.2, height: 0.2 }], page(),
            { x: 0.299, y: 0, width: 0.7, height: 1 }), []);
        const frozen = Object.freeze(photos.map(value => Object.freeze({ ...value })));
        const original = JSON.stringify(frozen);
        api.selectRobotImageCrops(frozen, Object.freeze(page()), Object.freeze(full), Object.freeze(api.robotDocumentMetrics(page(), 'desktop')));
        assert.strictEqual(JSON.stringify(frozen), original);
    });
});
