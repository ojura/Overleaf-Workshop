// A mocha test file for report-unhandled-rejections.test.mjs: an ES module that leaves a rejection
// without a handler and then waits at its top level, while mocha loads it.
Promise.reject(new Error('rejected before a top-level wait'));
await new Promise((resolve) => setTimeout(resolve, 20));
it('passes', () => {});
