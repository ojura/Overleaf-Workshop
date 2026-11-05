// A mocha test file for report-unhandled-rejections.test.mjs: a rejection in a "before all" hook, a
// "before each" hook that fails, so that its test does not run, and then a test with a rejection.
describe('a suite whose before-all hook leaves a rejection', () => {
    before(() => { Promise.reject(new Error('left by a before-all hook')); });
    it('passes', () => {});
});
describe('a suite whose before-each hook fails', () => {
    beforeEach(() => { throw new Error('the hook fails'); });
    it('does not run', () => {});
});
describe('after them', () => {
    it('leaves a rejection', () => { Promise.reject(new Error('left by a test')); });
});
