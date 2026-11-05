// A mocha test file for report-unhandled-rejections.test.mjs: a rejection without a handler while
// the file loads, before any test runs.
Promise.reject(new Error('rejected while the test file loads'));
it('passes', () => {});
