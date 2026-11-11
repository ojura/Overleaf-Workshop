import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const repo = path.resolve(__dirname, '../..');
describe('semantic robot dialogue admission', function () {
    let directory: string, module: any;
    before(async () => {
        const { bundleOptions, viewerRoot } = await importModule(path.join(repo, 'scripts/build-pdf-viewer.mjs'));
        const esbuild = await importModule('esbuild');
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-dialogue-'));
        try {
            await esbuild.build({ ...bundleOptions, entryPoints: [path.join(viewerRoot, 'src/common/robot-dialogue.ts')], outfile: path.join(directory, 'dialogue.mjs') });
            module = await importModule(path.join(directory, 'dialogue.mjs'));
        } finally { await esbuild.stop(); }
    });
    after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const actor = { id: 1, vehicle: 'pioneer', name: 'Alpha' };
    const catalogue = () => Array.from({ length: 8 }, (_, index) => ({ id: 'authored-' + index,
        opportunities: ['carrying', 'deposit'], lines: ['authored meaning ' + index], source: 'synthetic unit fixture' }));
    it('covers all eligible authored meanings through actually admitted ordinary opportunities', () => {
        const model = new module.RobotDialogueSelection(catalogue(), 13), shown = new Set();
        for (let index = 0; index < 8; index++) {
            const choice = model.reserve('photo-' + index, index % 2 ? 'deposit' : 'carrying', [actor]);
            assert.ok(choice); assert.strictEqual(model.admit(choice), true); shown.add(choice.entry.id); model.release(choice);
        }
        assert.strictEqual(shown.size, 8);
        assert.ok(model.snapshot().coverage.every((entry: any) => entry.count === 1));
    });
    it('keeps a reserved episode immutable and commits only its first readable admission', () => {
        const model = new module.RobotDialogueSelection(catalogue(), 1);
        const choice = model.reserve('logical-work', 'carrying', [actor]);
        assert.strictEqual(model.reserve('logical-work', 'deposit', [actor]), choice);
        assert.strictEqual(model.snapshot().shown, 0);
        assert.strictEqual(model.admit(choice), true); assert.strictEqual(model.admit(choice), false);
        assert.strictEqual(model.snapshot().shown, 1); model.release(choice);
        assert.strictEqual(model.admit(choice), false);
    });
    it('does not consume authored coverage when an unseen caption is displaced or blocked', () => {
        const model = new module.RobotDialogueSelection(catalogue(), 2);
        const choice = model.reserve('blocked', 'carrying', [actor]); model.release(choice);
        assert.deepStrictEqual(model.snapshot().coverage, []);
        assert.strictEqual(model.snapshot().shown, 0); assert.strictEqual(model.snapshot().dropped, 1);
    });
    it('requires every authored speaker role instead of truncating an exchange or inventing a character', () => {
        const model = new module.RobotDialogueSelection([{ id: 'named-exchange', opportunities: ['deposit'],
            lines: ['Alpha holds.', 'Bravo receives.'], roles: [{ names: ['Alpha'] }, { names: ['Bravo'] }], source: 'synthetic role fixture' }]);
        assert.strictEqual(model.reserve('solo', 'deposit', [actor]), undefined);
        assert.strictEqual(model.reserve('wrong', 'deposit', [actor, { id: 2, vehicle: 'pioneer', name: 'Charlie' }]), undefined);
        const choice = model.reserve('team', 'deposit', [actor, { id: 2, vehicle: 'pioneer', name: 'Bravo' }]);
        assert.deepStrictEqual(choice.speakers, [1, 2]); assert.strictEqual(choice.lines.length, 2);
    });
    it('keeps incident-only speech ineligible during ordinary work and bounds active reservations', () => {
        const model = new module.RobotDialogueSelection([{ id: 'actual-bump', opportunities: ['bump'], lines: ['Collision.'], source: 'synthetic incident fixture' }], 0, 1);
        assert.strictEqual(model.reserve('ordinary', 'carrying', [actor]), undefined);
        const choice = model.reserve('actual', 'bump', [actor]); assert.ok(choice);
        assert.strictEqual(model.reserve('overflow', 'bump', [actor]), undefined);
        model.clear(); assert.strictEqual(model.snapshot().reserved, 0);
    });
    it('does not let a persistently non-fitting unseen entry starve fitting speech', () => {
        const model = new module.RobotDialogueSelection([
            { id: 'short', opportunities: ['carrying'], lines: ['Fits.'], source: 'synthetic geometry fixture' },
            { id: 'long', opportunities: ['carrying'], lines: ['A longer authored meaning.'], source: 'synthetic geometry fixture' },
        ], 3);
        let readable = 0;
        for (let index = 0; index < 12; index++) {
            const choice = model.reserve('work-' + index, 'carrying', [actor], 'narrow');
            if (choice.entry.id === 'long') { model.rejectGeometry(choice); }
            else { model.admit(choice); model.release(choice); readable++; }
        }
        assert.ok(readable >= 10);
        assert.strictEqual(model.snapshot().coverage.some((entry: any) => entry.id === 'long'), false);
        const retried = model.reserve('wider-work', 'carrying', [actor], 'wider');
        assert.strictEqual(retried.entry.id, 'long'); model.admit(retried);
        assert.ok(model.snapshot().coverage.some((entry: any) => entry.id === 'long' && entry.count === 1));
    });
    it('uses canonical authored meanings across opportunities and retains rare incident semantics', () => {
        const catalogue = module.robotDialogueCatalogue([{ id: 'same-meaning', kind: 'success', lines: ['A completed work line.'], source: 'synthetic canonical fixture' }]);
        const entry = catalogue.find((value: any) => value.id === 'same-meaning');
        assert.deepStrictEqual(entry.opportunities, ['success', 'deposit']);
        assert.ok(module.ROBOT_CURATED_WORK_DIALOGUE.some((value: any) => value.id === 'work-origami' && value.opportunities.includes('carrying')));
        assert.ok(module.ROBOT_CURATED_WORK_DIALOGUE.some((value: any) => value.id === 'new-rjet' && !value.opportunities.includes('carrying')));
    });

    it('gives book callbacks directly to current actors instead of retelling absent speakers', () => {
        const retelling = /bi rekao|bi rekli|bi odgovorio|iz Pioneer priče|je u priči rekao|je odgovorio|Scout Mini kaže:/;
        for (const [id, value] of Object.entries(module.ROBOT_AUTHORED_UTTERANCES) as [string, any][]) {
            assert.ok(!retelling.test(value.text), id + ' is direct speech');
        }
        const entries = module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);
        const current = [{ id: 11, vehicle: 'hexapod', name: 'ALKA' }, { id: 12, vehicle: 'mecanum', name: 'XENA' }];
        for (const id of ['bump-scout', 'scout-var-story', 'scout-mug-story', 'echo-sonar', 'foxtrot-path', 'bravo-lasers', 'charlie-qr', 'delta-route']) {
            const entry = entries.find((value: any) => value.id === id); assert.ok(entry);
            const choice = new module.RobotDialogueSelection([entry]).reserve(id, entry.opportunities[0], current);
            assert.ok(choice, id + ' has actual current speakers');
            assert.ok(choice.speakers.every((speaker: number) => current.some(value => value.id === speaker)));
            assert.strictEqual(new Set(choice.speakers).size, choice.lines.length);
        }
    });

    it('keeps shared carrying, handoff and completion words in their actual work phases', () => {
        const entries = module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);
        const current = [{ id: 11, vehicle: 'hexapod', name: 'ALKA' }, { id: 12, vehicle: 'mecanum', name: 'XENA' }];
        const reserve = (id: string, opportunity: string, actors = current) => {
            const entry = entries.find((value: any) => value.id === id); assert.ok(entry);
            return new module.RobotDialogueSelection([entry]).reserve('work', opportunity, actors);
        };
        assert.strictEqual(reserve('pioneer-share', 'carrying', current.slice(0, 1)), undefined);
        assert.deepStrictEqual(reserve('pioneer-share', 'carrying').entry.meaningIds, ['pioneer-share-lead']);
        assert.strictEqual(reserve('pioneer-share-deposit', 'carrying'), undefined);
        assert.strictEqual(reserve('pioneer-share-deposit', 'deposit', current.slice(0, 1)), undefined);
        assert.deepStrictEqual(reserve('pioneer-share-deposit', 'deposit').entry.meaningIds, ['pioneer-share-reply']);
        assert.strictEqual(reserve('success-handoff', 'success'), undefined);
        assert.strictEqual(reserve('success-handoff', 'deposit'), undefined);
        assert.strictEqual(reserve('success-handoff', 'set-down', current.slice(0, 1)), undefined);
        assert.deepStrictEqual(reserve('success-handoff', 'set-down').speakers, [11, 12]);
    });

    it('keeps named first-person jokes with the actual named speaker and complete exchange', () => {
        const entries = module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);
        const ground = [{ id: 11, vehicle: 'hexapod', name: 'ALKA' }, { id: 12, vehicle: 'mecanum', name: 'XENA' }];
        const eagle = { id: 13, vehicle: 'quad', name: 'EagleRed' };
        const highFive = new module.RobotDialogueSelection([entries.find((value: any) => value.id === 'eagle-alpha-five')]);
        assert.strictEqual(highFive.reserve('ground', 'reunion', ground), undefined);
        assert.strictEqual(highFive.reserve('solo', 'reunion', [eagle]), undefined);
        const exchange = highFive.reserve('pair', 'reunion', [...ground, eagle]);
        assert.deepStrictEqual(exchange.speakers, [13, 11]);
        assert.deepStrictEqual(exchange.lines, ['Iz zraka šaljem peticu!', 'Spremna!']);
        const scout = new module.RobotDialogueSelection([entries.find((value: any) => value.id === 'scout-predecessors')]);
        assert.strictEqual(scout.reserve('other-robots', 'greeting', [...ground, eagle]), undefined);
        const actualScout = { id: 14, vehicle: 'scout-mini-fixture', name: 'Scout Mini' };
        assert.deepStrictEqual(scout.reserve('scout-present', 'greeting', [...ground, actualScout]).speakers, [14]);
    });

    it('keeps VIV as a participant without making it speak the comparison with itself', () => {
        const entries = module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);
        const viv = { id: 21, vehicle: 'rover', name: 'VIV' }, colleague = { id: 22, vehicle: 'hexapod', name: 'ALKA' };
        const reserve = (id: string, actors: typeof viv[]) => {
            const entry = entries.find((value: any) => value.id === id); assert.ok(entry);
            return new module.RobotDialogueSelection([entry]).reserve('event', entry.opportunities[0], actors);
        };
        assert.strictEqual(reserve('success-solo-pioneer', [viv]), undefined);
        assert.deepStrictEqual(reserve('success-solo-pioneer', [colleague]).speakers, [22]);
        for (const id of ['reunion-pioneers', 'success-team-pioneer']) {
            assert.strictEqual(reserve(id, [colleague]), undefined, 'the plural callback still requires a partner');
            assert.strictEqual(reserve(id, [viv, { ...viv, id: 23 }]), undefined);
            assert.deepStrictEqual(reserve(id, [viv, colleague]).speakers, [22], 'VIV counts as a partner while the colleague speaks');
        }
        const excludeNames = ['VIV'];
        const entry = entries.find((value: any) => value.id === 'success-solo-pioneer');
        const model = new module.RobotDialogueSelection([{ ...entry, roles: [{ excludeNames }] }]);
        excludeNames.length = 0;
        assert.strictEqual(model.reserve('caller-mutated-role', 'deposit', [viv]), undefined, 'the selector owns an immutable role copy');
    });

    it('shares exposure and pending reservations across explicit utterance aliases', () => {
        const entries = [
            { id: 'incident', meaningIds: ['shared'], opportunities: ['success'], lines: ['One authored meaning.'], source: 'synthetic' },
            { id: 'work', meaningIds: ['shared'], opportunities: ['carrying'], lines: ['One authored meaning.'], source: 'synthetic' },
            { id: 'other', meaningIds: ['other'], opportunities: ['carrying'], lines: ['Another authored meaning.'], source: 'synthetic' },
        ];
        const model = new module.RobotDialogueSelection(entries, 1);
        const incident = model.reserve('incident', 'success', [actor]);
        assert.strictEqual(model.reserve('parallel', 'carrying', [actor]).entry.id, 'other');
        model.admit(incident); model.release(incident);
        const second = model.reserve('next', 'carrying', [actor]);
        assert.strictEqual(second.entry.id, 'other');
        assert.deepStrictEqual(model.snapshot().coverage.map((value: any) => value.id), ['shared']);
        assert.throws(() => new module.RobotDialogueSelection([
            ...entries, { ...entries[0], id: 'invalid-alias', lines: ['Different text.'] },
        ]), /same text/);
    });

    it('clears pending choices without consuming their readable coverage', () => {
        const model = new module.RobotDialogueSelection(catalogue(), 3);
        const choice = model.reserve('unseen', 'carrying', [actor]);
        model.clear();
        assert.strictEqual(model.snapshot().reserved, 0);
        assert.strictEqual(model.admit(choice), false);
        assert.deepStrictEqual(model.snapshot().coverage, []);
    });

    it('reuses truthful preparation and future-reward return meanings without admitting completed-success claims', () => {
        const entries = module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);
        const eligible = (opportunity: string) => entries.filter((entry: any) => {
            const model = new module.RobotDialogueSelection([entry]);
            return !!model.reserve('event', opportunity, [actor]);
        });
        const preparation = eligible('preparing');
        assert.ok(preparation.length >= 5);
        assert.ok(preparation.some((entry: any) => entry.id === 'work-care'));
        assert.deepStrictEqual(eligible('returning').map((entry: any) => entry.id).sort(), ['success-caca', 'success-matko']);
        assert.ok(!preparation.some((entry: any) => entry.id === 'success-maric'));
    });


});
