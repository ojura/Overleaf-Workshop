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
            ...Array.from({ length: 4 }, (_, index) => ({ id: 'short-' + index, opportunities: ['carrying'],
                lines: ['Fits ' + index + '.'], source: 'synthetic geometry fixture' })),
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
        const reserve = (id: string, opportunity: string, actors = current, facts: string[] = []) => {
            const entry = entries.find((value: any) => value.id === id); assert.ok(entry);
            return new module.RobotDialogueSelection([entry]).reserve('work', opportunity, actors.map(actor => ({ ...actor, facts })));
        };
        assert.strictEqual(reserve('pioneer-share', 'carrying', current.slice(0, 1), ['shared-cargo']), undefined);
        assert.deepStrictEqual(reserve('pioneer-share', 'carrying', current, ['shared-cargo']).entry.meaningIds, ['pioneer-share-lead']);
        assert.strictEqual(reserve('pioneer-share-deposit', 'carrying'), undefined);
        assert.strictEqual(reserve('pioneer-share-deposit', 'deposit', current.slice(0, 1), ['completed']), undefined);
        assert.deepStrictEqual(reserve('pioneer-share-deposit', 'deposit', current, ['completed']).entry.meaningIds, ['pioneer-share-reply']);
        assert.strictEqual(reserve('success-handoff', 'success'), undefined);
        assert.strictEqual(reserve('success-handoff', 'deposit'), undefined);
        assert.strictEqual(reserve('success-handoff', 'set-down', current.slice(0, 1), ['placing']), undefined);
        assert.deepStrictEqual(reserve('success-handoff', 'set-down', current, ['placing']).speakers, [11, 12]);
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
        const parallel = model.reserve('parallel', 'carrying', [actor]);
        assert.strictEqual(parallel.entry.id, 'other');
        model.admit(incident); model.release(incident);
        assert.strictEqual(model.reserve('while-pending', 'carrying', [actor]), undefined);
        model.release(parallel);
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
            return !!model.reserve('event', opportunity, [actor, { id: 2, vehicle: 'forklift', name: 'Navines' }]);
        });
        const preparation = eligible('preparing');
        assert.ok(preparation.length >= 5);
        assert.ok(preparation.some((entry: any) => entry.id === 'work-care'));
        const returning = eligible('returning').map((entry: any) => entry.id);
        assert.ok(returning.includes('success-caca') && returning.includes('success-matko'));
        assert.ok(returning.includes('work-care') && returning.includes('work-organism'), 'ordinary remarks remain available during return');
        assert.ok(returning.includes('success-maric'), 'ordinary praise and comparisons remain shared conversation');
        assert.ok(!returning.includes('success-memories'), 'a return label does not manufacture a completed-delivery fact');
        assert.ok(!preparation.some((entry: any) => entry.id === 'success-memories'));
    });

    describe('shared authored repertoire', () => {
        const crew = [actor, { id: 2, vehicle: 'forklift', name: 'Navines' }];
        const authored = () => module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);
        const entry = (id: string) => authored().find((value: any) => value.id === id);

        it('offers ordinary authored conversation across activities instead of small event buckets', () => {
            for (const opportunity of ['passing', 'carrying', 'waiting', 'preparing', 'returning']) {
                for (const id of ['miss-coffee', 'reunion-beer', 'work-organism', 'scout-var-story',
                    'success-matko', 'success-caca', 'buddy-consensus', 'success-care', 'work-album', 'pioneer-hold',
                    'success-nailed', 'success-fit', 'success-maric', 'success-precision', 'success-mbzirc', 'success-barbara']) {
                    const choice = new module.RobotDialogueSelection([entry(id)]).reserve('scene', opportunity, crew);
                    assert.ok(choice, id + ' is ordinary conversation during ' + opportunity);
                    assert.ok(choice.speakers.every((speaker: number) => crew.some(value => value.id === speaker)));
                }
            }
        });

        it('uses real speaker facts for literal work claims instead of granting facts from a label', () => {
            const cases = [
                ['work-found', 'cargo'], ['pioneer-share', 'shared-cargo'], ['work-robo-band', 'shared-cargo'],
                ['set-down-count', 'placing'], ['pioneer-share-deposit', 'completed'],
                ['new-rjet', 'replacing'], ['buffer-dough', 'preparing'],
            ];
            for (const [id, fact] of cases) {
                const value = entry(id);
                assert.strictEqual(new module.RobotDialogueSelection([value]).reserve('label', value.opportunities[0], crew), undefined,
                    id + ' needs actual evidence even at its original event label');
                const current = [crew[0], { ...crew[1], facts: [fact] }];
                const choice = new module.RobotDialogueSelection([value]).reserve('actual', 'passing', current);
                assert.ok(choice, id + ' is truthful whenever its actual speaker has ' + fact);
                assert.deepStrictEqual(choice.speakers, [2], id + ' belongs to the participating actor with the fact');
            }
            for (const id of ['success-sofia', 'work-found']) {
                for (const fact of ['cargo', 'completed']) {
                    assert.ok(new module.RobotDialogueSelection([entry(id)]).reserve('pickup-or-result', 'passing',
                        [{ ...actor, facts: [fact] }]), 'the acquired-object claim is true at pickup or successful delivery');
                }
            }
        });

        it('requires every factual line of a full exchange and keeps rescue claims with their actual speaker', () => {
            for (const [id, fact] of [['success-handoff', 'placing']]) {
                const value = entry(id);
                const one = [{ ...crew[0], facts: [fact] }, crew[1]];
                assert.strictEqual(new module.RobotDialogueSelection([value]).reserve('one', 'passing', one), undefined);
                const both = crew.map(value => ({ ...value, facts: [fact] }));
                assert.deepStrictEqual(new module.RobotDialogueSelection([value]).reserve('both', 'passing', both).speakers, [1, 2]);
            }
            for (const [id, fact] of [['rescue-smoke', 'smoke'], ['rescue-lugv', 'carried'], ['reunion-lift', 'carried'],
                ['bump-collision', 'collision'], ['success-memories', 'completed']]) {
                const value = entry(id);
                assert.strictEqual(new module.RobotDialogueSelection([value]).reserve('label', value.opportunities[0], crew), undefined);
                const actual = [crew[0], { ...crew[1], facts: [fact] }];
                const choice = new module.RobotDialogueSelection([value]).reserve('actual', 'passing', actual);
                assert.ok(choice, id + ' has actual supporting event evidence');
                assert.deepStrictEqual(choice.speakers, [2, 1], 'the factual first line belongs to its real subject');
            }
        });

        it('draws repeated actual passages from many authored meanings and former event origins', () => {
            const model = new module.RobotDialogueSelection(authored(), 13);
            const meanings = new Set<string>(), origins = new Set<string>(), recent: string[][] = [];
            for (let index = 0; index < 12; index++) {
                const choice = model.reserve('passage-' + index, 'passing', crew);
                assert.ok(choice, 'another real passage has the shared ordinary repertoire available');
                for (const id of choice.entry.meaningIds) {
                    assert.ok(!recent.slice(-3).some(previous => previous.includes(id)), 'readable aliases respect recent history');
                    meanings.add(id);
                }
                choice.entry.opportunities.forEach((origin: string) => origins.add(origin));
                recent.push([...choice.entry.meaningIds]);
                assert.strictEqual(model.admit(choice), true); model.release(choice);
            }
            assert.ok(meanings.size >= 12, 'passages use a broad authored repertoire');
            assert.ok(origins.size >= 4, 'the original event labels do not partition ordinary speech');
        });

        it('holds active canonical aliases apart without charging unseen reservations as admissions', () => {
            const model = new module.RobotDialogueSelection(authored(), 13);
            const first = model.reserve('first', 'passing', crew, 'default', ['work-care']);
            assert.ok(first);
            assert.strictEqual(model.reserve('parallel-alias', 'carrying', crew, 'default', ['success-care']), undefined,
                'a pending exchange cannot queue the same sentence as another pending cue');
            assert.strictEqual(model.snapshot().shown, 0); assert.deepStrictEqual(model.snapshot().coverage, []);
            model.release(first);
            const released = model.reserve('released-alias', 'passing', crew, 'default', ['success-care']);
            assert.ok(released, 'releasing an unshown choice immediately restores its availability');
            model.admit(released); model.release(released);
            assert.strictEqual(model.reserve('recent-alias', 'passing', crew, 'default', ['work-care']), undefined,
                'the same canonical sentence has one admission history across its aliases');
        });

        it('checks original assigned speakers and facts again before an unread cue becomes visible', () => {
            const model = new module.RobotDialogueSelection([entry('work-found')]);
            const carrying = [{ ...actor, facts: ['cargo'] }];
            const choice = model.reserve('hidden-pickup', 'carrying', carrying);
            assert.ok(choice);
            assert.strictEqual(module.robotDialogueChoiceSupported(choice, carrying), true);
            assert.strictEqual(module.robotDialogueChoiceSupported(choice, [actor]), false,
                'a delayed first display cannot inherit the cargo that has already left');
            assert.strictEqual(module.robotDialogueChoiceSupported(choice, [{ ...carrying[0], id: 3 }]), false,
                'another qualified actor cannot silently replace the reserved speaker');
            model.release(choice);
            assert.strictEqual(model.snapshot().shown, 0); assert.deepStrictEqual(model.snapshot().coverage, []);
        });
    });

    describe('readable repetition spacing', () => {
        const crew = [actor, { id: 2, vehicle: 'forklift', name: 'Navines' }];
        const authored = () => module.robotDialogueCatalogue(module.ROBOT_ENCOUNTER_DIALOGUE);

        it('lets a repeated passage yield when its alternative was already heard while carrying', () => {
            const model = new module.RobotDialogueSelection(authored(), 13);
            for (let index = 0; index < 3; index++) {
                const carrying = model.reserve('carrying-' + index, 'carrying', crew, 'default', ['pioneer-hold']);
                assert.ok(carrying); assert.strictEqual(model.admit(carrying), true); model.release(carrying);
                if (index < 2) {
                    for (const id of ['work-care', 'work-album', 'work-organism']) {
                        const other = model.reserve('intervening-' + index + ':' + id, 'carrying', crew, 'default', [id]);
                        assert.ok(other); model.admit(other); model.release(other);
                    }
                }
            }
            const passing = model.reserve('passing-1', 'passing', crew, 'default', ['private-zone', 'pioneer-hold']);
            assert.strictEqual(passing.entry.id, 'private-zone');
            model.admit(passing); model.release(passing);
            assert.strictEqual(model.reserve('passing-2', 'passing', crew, 'default', ['private-zone', 'pioneer-hold']), undefined,
                'an explicitly restricted request yields instead of repeating the lower lifetime count');
            assert.strictEqual(model.snapshot().opportunities.passing, 1);
        });

        it('reopens passage meanings after intervening readable speech while preserving unseen coverage', () => {
            const model = new module.RobotDialogueSelection(authored(), 13);
            const passing = (key: string) => model.reserve(key, 'passing', crew, 'default', ['private-zone', 'pioneer-hold']);
            const show = (key: string, opportunity: string, id: string) => {
                const choice = model.reserve(key, opportunity, crew, 'default', [id]);
                assert.ok(choice); assert.strictEqual(model.admit(choice), true); model.release(choice);
            };
            show('passage-a', 'passing', 'private-zone');
            show('passage-b', 'passing', 'pioneer-hold');
            assert.strictEqual(passing('passage-c'), undefined);
            const unseen = model.reserve('unseen-work', 'carrying', crew, 'default', ['work-care']);
            assert.ok(unseen); model.release(unseen); model.clear();
            assert.strictEqual(passing('passage-d'), undefined,
                'releases and cleanup preserve the last readable passage history');
            assert.strictEqual(model.snapshot().shown, 2);
            show('readable-work-a', 'carrying', 'work-care');
            assert.strictEqual(passing('passage-e'), undefined);
            show('readable-work-b', 'carrying', 'work-album');
            const resumed = passing('passage-f');
            assert.strictEqual(resumed.entry.id, 'private-zone', 'three intervening readable admissions reopen the meaning');
            model.admit(resumed); model.release(resumed);
            assert.strictEqual(model.snapshot().opportunities.passing, 3);
            model.reset();
            assert.ok(passing('new-scene'), 'a new document starts fresh speech history');
        });

        it('prefers older eligible speech over lifetime count catch-up', () => {
            const model = new module.RobotDialogueSelection([
                { id: 'frequent', opportunities: ['carrying'], meaningIds: ['frequent'], lines: ['Frequently needed.'], source: 'synthetic' },
                { id: 'recent', opportunities: ['carrying', 'deposit'], meaningIds: ['recent'], lines: ['Just heard.'], source: 'synthetic' },
                { id: 'fresh', opportunities: ['carrying'], meaningIds: ['fresh'], lines: ['Another task.'], source: 'synthetic' },
                ...Array.from({ length: 3 }, (_, index) => ({ id: 'elsewhere-' + index, opportunities: ['waiting'],
                    meaningIds: ['elsewhere-' + index], lines: ['Waiting ' + index + '.'], source: 'synthetic' })),
            ], 13);
            const initial = model.reserve('initial', 'carrying', crew, 'default', ['frequent']);
            model.admit(initial); model.release(initial);
            for (let index = 0; index < 3; index++) {
                const waiting = model.reserve('initial-wait-' + index, 'waiting', crew, 'default', ['elsewhere-' + index]);
                model.admit(waiting); model.release(waiting);
            }
            for (const [index, id] of ['frequent', 'fresh', 'recent'].entries()) {
                const choice = model.reserve('seed-' + index, 'carrying', crew, 'default', [id]);
                assert.ok(choice); model.admit(choice); model.release(choice);
            }
            const elsewhere = model.reserve('waiting-work', 'waiting', crew);
            model.admit(elsewhere); model.release(elsewhere);
            const choice = model.reserve('next-work', 'carrying', crew);
            assert.strictEqual(choice.entry.id, 'frequent', 'recent speech waits while an eligible older meaning can be heard');
        });

        it('varies successive coverage rounds while reproducing the same admitted history', () => {
            const record = () => {
                const model = new module.RobotDialogueSelection(catalogue(), 13), rounds: string[][] = [];
                for (let round = 0; round < 5; round++) {
                    const ids: string[] = [];
                    for (let index = 0; index < 8; index++) {
                        const choice = model.reserve('work-' + index, 'carrying', [actor]);
                        assert.ok(choice); model.admit(choice); ids.push(choice.entry.id); model.release(choice);
                    }
                    assert.strictEqual(new Set(ids).size, 8, 'each coverage round includes every eligible meaning');
                    rounds.push(ids);
                }
                return rounds;
            };
            const rounds = record();
            assert.ok(rounds.slice(1).some(round => round.join(',') !== rounds[0].join(',')),
                'coverage rounds vary instead of replaying an oldest-first script');
            assert.deepStrictEqual(record(), rounds, 'the same scene seed and admitted history reproduce dialogue');
        });
    });


});
