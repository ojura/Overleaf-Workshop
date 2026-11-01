// A mocha test file for report-unhandled-rejections.test.mjs: a test that passes and leaves a
// rejected promise behind that nothing handles, during the run.
it('passes and leaves a rejection behind', () => { Promise.reject(new Error('left behind during the run')); });
it('passes after it', () => {});
