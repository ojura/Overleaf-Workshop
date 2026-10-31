import * as assert from 'assert';
import { replicaModes } from '../scm/replicaModes';

describe('local replica: fetch and push modes', () => {
    it('uses native when nothing is set, without a notice', () => {
        assert.deepStrictEqual(replicaModes({}), { modes: { fetch: 'native', push: 'native' }, notices: [] });
    });
    it('keeps native when it is set', () => {
        assert.deepStrictEqual(replicaModes({ fetch: 'native', push: 'native' }).notices, []);
    });
    it('takes the mixed and bridge modes', () => {
        assert.deepStrictEqual(replicaModes({ fetch: 'mixed', push: 'bridge' }), { modes: { fetch: 'mixed', push: 'bridge' }, notices: [] });
        assert.deepStrictEqual(replicaModes({ fetch: 'bridge' }), { modes: { fetch: 'bridge', push: 'native' }, notices: [] });
    });
    it('falls back to native, with a notice, for an unknown value', () => {
        const { modes, notices } = replicaModes({ fetch: 'git', push: 42 });
        assert.deepStrictEqual(modes, { fetch: 'native', push: 'native' });
        assert.match(notices[0], /fetchMode is "git", which is not one of native, mixed, bridge/);
        assert.match(notices[1], /pushMode is "42", which is not one of native, bridge/);
    });
});
