// The DevTools part of scripts/hidden-ide.sh, which runs it with the instance's folder HOME:
//   ready HOME PID                    wait until the IDE (process PID) has opened its window, and
//                                     add its two DevTools endpoints to HOME/instance.json
//   evaluate HOME page EXPRESSION     the value of EXPRESSION in the window's page
//   evaluate HOME main STATEMENTS     what STATEMENTS return in the IDE's main process, with w set
//                                     to the window (inMainProcess in scripts/lib/test-instance.mjs)
//   page-command HOME METHOD PARAMS   one DevTools command, with PARAMS as JSON, to the window's page
//   screenshot HOME FILE [WIDTH HEIGHT]
// Every connection goes to an endpoint that start recorded, and checks that the instance's IDE
// answers there (scripts/lib/test-instance.mjs). evaluate prints the value as JSON, or
// {"error": ...} and exits with 1; it exits with 2 when the page has not answered within
// PAGE_ANSWER_LIMIT_MS.
import fs from 'node:fs';
import {
    connectMainProcess, connectWindow, evaluate, inMainProcess, readInstance, waitForInstance, workbenchTarget, writeInstance,
} from './lib/test-instance.mjs';

/** The last resort for an IDE that runs but never opens its window. */
const START_LIMIT_MS = 60000;
/**
 * The last resort for a page that does not answer: a frozen page runs no scripts, so an evaluation
 * there waits until this limit, and exit status 2 reports it.
 */
const PAGE_ANSWER_LIMIT_MS = 15000;

/**
 * Run `work` with a session on the instance's workbench page, within PAGE_ANSWER_LIMIT_MS; `what`
 * names the work in the error. Closing the connection afterwards also ends a command that the page
 * has not answered.
 */
async function withPage(instance, what, work) {
    const browser = await connectWindow(instance);
    let timer;
    try {
        const page = await browser.attach((await workbenchTarget(browser)).targetId);
        const limit = new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error(`${what}: the page did not answer within ${PAGE_ANSWER_LIMIT_MS / 1000} s`), { status: 2 })), PAGE_ANSWER_LIMIT_MS);
        });
        return await Promise.race([work(page), limit]);
    } finally {
        clearTimeout(timer);
        browser.close();
    }
}

const commands = {
    async ready(home, pid) {
        const endpoints = await waitForInstance(home, Number(pid), START_LIMIT_MS);
        writeInstance(home, { ...readInstance(home), ...endpoints });
    },
    async evaluate(home, where, code) {
        const instance = readInstance(home);
        let value;
        try {
            if (where === 'page') {
                value = await withPage(instance, 'Runtime.evaluate', (page) => evaluate(page, code));
            } else if (where === 'main') {
                const main = await connectMainProcess(instance);
                try {
                    value = await inMainProcess(main, code);
                } finally {
                    main.close();
                }
            } else {
                throw Object.assign(new Error(`evaluate takes page or main, not ${where}`), { status: 64 });
            }
        } catch (error) {
            console.log(JSON.stringify({ error: error.message }));
            return error.status ?? 1;
        }
        console.log(JSON.stringify(value));
    },
    async 'page-command'(home, method, params) {
        await withPage(readInstance(home), method, (page) => page.send(method, JSON.parse(params)));
        console.log(`${method}: done`);
    },
    async screenshot(home, file, width, height) {
        await withPage(readInstance(home), 'screenshot', async (page) => {
            // the page's size is set in the same session as the capture: the override ends with the session
            if (width && height) {
                await page.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
                await new Promise(r => setTimeout(r, 800)); // let the workbench lay itself out at the new size
            }
            const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
            if (width && height) { await page.send('Emulation.clearDeviceMetricsOverride'); }
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
        });
        console.log(`saved ${file}`);
    },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
    console.error(`hidden-ide.mjs: unknown command ${command}; scripts/hidden-ide.sh runs this file`);
    process.exit(64);
}
try {
    process.exitCode = (await commands[command](...args)) ?? 0;
} catch (error) {
    console.error(`hidden-ide: ${error.message}`);
    process.exitCode = error.status ?? 1;
}
