// A mocha test file for report-unhandled-rejections.test.mjs: a rejection that gets its handler 10 ms
// later, after Node has reported it as unhandled.
it('attaches its handler 10 ms later', async () => {
    const rejected = Promise.reject(new Error('handled 10 ms later'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    rejected.catch(() => {});
});
