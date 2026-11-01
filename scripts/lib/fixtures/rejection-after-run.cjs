// A mocha test file for report-unhandled-rejections.test.mjs: a root "after all" hook of the file
// leaves a rejected promise behind that nothing handles. Mocha runs the file's root hooks after
// those of the files that --require loads, so the rejection comes after the logger's own.
it('passes', () => {});
after(() => { Promise.reject(new Error('left behind after the run')); });
