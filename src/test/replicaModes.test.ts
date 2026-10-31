import * as assert from 'assert';
import { replicaModes } from '../scm/replicaModes';

describe('local replica: fetch and push modes', () => {
    it('uses native when nothing is set, without a notice', () => {
        assert.deepStrictEqual(replicaModes({}), { modes: { fetch: 'native', push: 'native' }, notices: [] });
    });
    it('keeps native when it is set', () => {
        assert.deepStrictEqual(replicaModes({ fetch: 'native', push: 'native' }).notices, []);
    });
    it('falls back to native, with a notice, for the modes that are not available yet', () => {
        const { modes, notices } = replicaModes({ fetch: 'mixed', push: 'bridge' });
        assert.deepStrictEqual(modes, { fetch: 'native', push: 'native' });
        assert.strictEqual(notices.length, 2);
        assert.match(notices[0], /fetchMode is "mixed", which is not available yet; native is used/);
        assert.match(notices[1], /pushMode is "bridge", which is not available yet; native is used/);
        assert.match(replicaModes({ fetch: 'bridge' }).notices[0], /fetchMode is "bridge", which is not available yet/);
    });
    it('falls back to native, with a notice, for an unknown value', () => {
        const { modes, notices } = replicaModes({ fetch: 'git', push: 42 });
        assert.deepStrictEqual(modes, { fetch: 'native', push: 'native' });
        assert.match(notices[0], /fetchMode is "git", which is not one of native, mixed, bridge/);
        assert.match(notices[1], /pushMode is "42", which is not one of native, bridge/);
    });
});
