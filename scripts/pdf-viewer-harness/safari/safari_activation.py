"""Source verification and guarded activation on an already owned Safari session."""
import asyncio
import hashlib
import json
import secrets
import time

from safari_settings import load_browser_source
from safari_runner import OBJECT_GROUP

GUARD_NAME = '__spomenarReleaseGuard'


def error_message(error):
    return str(getattr(error, 'message', str(error)))


async def guard_evaluate(wire, source, timeout=8):
    """Synchronous controls use one reply; install/restore invoke a prepared function once."""
    import re
    marker = re.match(r'/\*release:([a-z]+)\*/', source)
    stage = marker.group(1) if marker else 'control'
    prepared = stage in ('install', 'restore')
    deadline = wire.budget.now() + timeout
    expression = '(() => (' + source + '))' if prepared else '(' + source + ')'
    result = await wire.command('Runtime.evaluate', timeout=timeout, expression=expression,
        returnByValue=not prepared, emulateUserGesture=False, flush_after_send=stage == 'install',
        objectGroup=OBJECT_GROUP, purpose='release-' + stage)
    wire.value(result, 'release ' + stage)
    if prepared:
        function = result.get('result', {})
        if function.get('type') != 'function' or not function.get('objectId'):
            raise RuntimeError('Release preparation did not return a function handle')
        remaining = deadline - wire.budget.now()
        if remaining <= 0:
            raise TimeoutError('Release deadline expired before its one invocation')
        result = await wire.command('Runtime.callFunctionOn', timeout=remaining,
            objectId=function['objectId'], functionDeclaration='function () { return this(); }',
            returnByValue=True, awaitPromise=stage == 'restore', emulateUserGesture=False,
            purpose='release-' + stage)
    return {'value': wire.value(result, 'release ' + stage)}


class Budget:
    def __init__(self, seconds=60, now=time.monotonic, sleep=asyncio.sleep):
        self.now, self.sleep = now, sleep
        self.started = now()
        self.deadline = self.started + seconds
        if seconds <= 15:
            raise ValueError('Activation needs its separate fifteen-second recovery and cleanup reserve')
        # The final reserve cannot be borrowed by reader recovery: five seconds each
        # for recovery, bootstrap/guard cleanup, and the runner's owned detach.
        self.deadlines = {'work': self.deadline - 15, 'recovery': self.deadline - 10,
                          'cleanup': self.deadline - 5, 'detach': self.deadline}

    def remaining(self, phase='work'):
        return max(0, self.deadlines[phase] - self.now())

    async def pause(self, seconds, phase='work'):
        remaining = self.remaining(phase)
        if remaining <= 0:
            raise TimeoutError('Release activation deadline expired')
        await self.sleep(min(seconds, remaining))


class Activation:
    def __init__(self, command, evaluate, response_methods, budget, document, expected_sha, expected_bytes):
        self.command, self.evaluate, self.responses = command, evaluate, response_methods
        self.budget, self.document = budget, document
        self.expected_sha, self.expected_bytes = expected_sha, expected_bytes

    async def cmd(self, method, phase='work', cap=8, **params):
        limit = min(cap, self.budget.remaining(phase))
        if limit <= 0:
            raise TimeoutError('Release activation deadline expired before ' + method)
        async with asyncio.timeout(limit):
            return await self.command(method, timeout=limit, **params)

    async def value(self, source, phase='work', cap=8):
        limit = min(cap, self.budget.remaining(phase))
        if limit <= 0:
            raise TimeoutError('Release activation deadline expired before evaluation')
        async with asyncio.timeout(limit):
            result = await self.evaluate(source, timeout=limit)
        return result.get('value')

    async def loaded_source(self):
        """Read code already parsed in the owned page, then retire all owned debugger state."""
        contexts, scripts = [], []
        handlers, enabled = {}, []
        result = {'url': self.document.entry_url, 'matched': False, 'cleanupErrors': []}
        def listen(name, target, field):
            previous = self.responses.get(name)
            def callback(message):
                target.append(message['params'][field] if field else message['params'])
                if previous:
                    previous(message)
            handlers[name] = (previous, callback)
            self.responses[name] = callback
        listen('Runtime.executionContextCreated', contexts, 'context')
        listen('Debugger.scriptParsed', scripts, None)
        try:
            for domain in ['Page', 'Runtime']:
                enabled.append(domain)  # Cleanup owns ambiguous enable acknowledgements too.
                await self.cmd(domain + '.enable')
            tree = (await self.cmd('Page.getResourceTree'))['frameTree']
            if not self.document.owns_page(tree['frame'].get('url', '')):
                raise RuntimeError('The selected main frame is not the owned Spomenar URL')
            resources = [r for r in tree.get('resources', []) if r.get('url') == self.document.entry_url]
            if len(resources) != 1:
                raise RuntimeError('The main frame does not have one exact release entry resource')
            enabled.append('Debugger')
            await self.cmd('Debugger.enable')
            end = min(self.budget.now() + 2, self.budget.deadlines['work'])
            while not any(s.get('url') == self.document.entry_url for s in scripts) and self.budget.now() < end:
                await self.budget.pause(0.025)
            candidates = {str(s['scriptId']): s for s in scripts if s.get('url') == self.document.entry_url and not s.get('isContentScript', False)}
            main_contexts = {c['id'] for c in contexts if c.get('frameId') == tree['frame']['id'] and c.get('type') == 'normal'}
            if candidates and main_contexts and all('executionContextId' in s for s in candidates.values()):
                candidates = {key: s for key, s in candidates.items() if s['executionContextId'] in main_contexts}
                result['binding'] = 'native-main-frame-context'
            else:
                if tree.get('childFrames'):
                    raise RuntimeError('Native context relation is absent and the page has child frames')
                result['binding'] = 'single-main-frame-unique-entry'
            if len(candidates) != 1:
                raise RuntimeError('The exact loaded entry script is missing or ambiguous')
            script = next(iter(candidates.values()))
            source = (await self.cmd('Debugger.getScriptSource', scriptId=script['scriptId']))['scriptSource']
            raw = source.encode('utf-8')
            if len(raw) > 1024 * 1024:
                raise RuntimeError('The loaded entry exceeds the inspection limit')
            result.update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            result['matched'] = result['bytes'] == self.expected_bytes and result['sha256'] == self.expected_sha
        except Exception as error:
            result['error'] = str(error)
        finally:
            for domain in reversed(enabled):
                try:
                    await self.cmd(domain + '.disable', phase='cleanup', cap=2)
                except Exception as error:
                    result['cleanupErrors'].append(domain + ': ' + str(error))
            for name, (previous, ours) in handlers.items():
                if self.responses.get(name) is ours:
                    if previous is None:
                        self.responses.pop(name, None)
                    else:
                        self.responses[name] = previous
        result['ok'] = not result.get('error') and not result['cleanupErrors']
        return result


async def release_check(command, evaluate, response_methods, *, document, expected_sha, expected_bytes, source_only=False,
                        budget=None, token=None, stop_event=None):
    budget = budget or Budget()
    run = Activation(command, evaluate, response_methods, budget, document, expected_sha, expected_bytes)
    token = token or secrets.token_hex(12)
    receipt = {'status': 'failed', 'expected': {'url': document.entry_url, 'sha256': expected_sha, 'bytes': expected_bytes},
               'sourceOnly': source_only, 'navigationAttempted': False, 'navigationRequested': False, 'cleanupErrors': [],
               'phaseDeadlinesMs': {phase: round((end - budget.started) * 1000) for phase, end in budget.deadlines.items()}}
    guard_intent = bootstrap_intent = page_intent = False
    saved = original_origin = None
    name = json.dumps(GUARD_NAME)
    async def state(phase='work'):
        if phase == 'work' and stop_event and stop_event.is_set():
            raise RuntimeError('Owner requested activation stop')
        return await run.value('''/*release:status*/ (() => window[''' + name + ''']?.status() ?? {
            missing: true, ownedLocation: location.href.split('#')[0] === ''' + json.dumps(document.page_url) + ''',
            transientBlank: location.href === 'about:blank'
        })()''', phase=phase, cap=2)
    async def restore(phase='work'):
        value = await run.value('/*release:restore*/ window[' + name + '].restore(' + json.dumps(saved) + ')', phase=phase)
        if not value or value.get('exact') is not True:
            raise RuntimeError('The original reading state was not restored exactly')
        return value
    async def wait_ready(previous_origin=None, phase='work'):
        end = budget.deadlines[phase]
        last = None
        while budget.now() < end:
            try:
                last = await state(phase)
            except Exception as error:
                if 'Missing injected script' not in error_message(error) and 'Execution context' not in error_message(error):
                    raise
            if last and last.get('missing') and not last.get('ownedLocation') and not last.get('transientBlank'):
                receipt['interruption'] = 'navigated-away'
                raise RuntimeError('The user navigated away from the owned page')
            if last and last.get('token') == token:
                if last.get('interrupted'):
                    receipt['interruption'] = last.get('reason')
                    raise RuntimeError('User interruption: ' + str(last.get('reason')))
                is_new = previous_origin is None or last.get('origin') != previous_origin
                if is_new:
                    if last.get('visible') is not True:
                        receipt['interruption'] = 'hidden'
                        raise RuntimeError('The owned tab is no longer visible')
                    if abs(last.get('visualScale', 1) - 1) > 1e-6:
                        receipt['interruption'] = 'native-pinch'
                        raise RuntimeError('Native pinch changed during activation')
                    if last.get('pdfPath') not in (None, '', document.pdf_path):
                        receipt['interruption'] = 'document-changed'
                        raise RuntimeError('The owned document changed during activation')
                    if last.get('ready'):
                        return last
            await budget.pause(0.05, phase)
        receipt['lastGuard'] = last
        raise TimeoutError('The exact initial view did not settle within the activation deadline')
    try:
        receipt['before'] = await run.loaded_source()
        if not receipt['before']['ok']:
            raise RuntimeError('Loaded-source inspection failed')
        if receipt['before']['matched']:
            receipt['status'] = 'current'
            return receipt
        if source_only:
            receipt['status'] = 'stale'
            return receipt
        if stop_event and stop_event.is_set():
            raise RuntimeError('Owner requested stop before activation')
        guard_source = load_browser_source('release-guard.js')
        config = {'token': token, 'document': document.browser(),
                  'durationMs': int(budget.remaining('detach') * 1000), 'bootstrap': False}
        guard_intent = True
        installed = await run.value('/*release:install*/ (' + guard_source + ')(' + json.dumps(config) + ')')
        if not installed or installed.get('token') != token:
            raise RuntimeError('The current-document release guard was not installed')
        config['expiresAt'] = installed['expiresAt']
        config['bootstrap'] = True
        receipt['guardExpiresAt'] = installed['expiresAt']
        original_origin = installed['origin']
        await wait_ready()
        # A fresh quiet window belongs to this operation, not an old manual-event log.
        await budget.pause(0.3)
        saved = await run.value('/*release:capture*/ window[' + name + '].capture(true)')
        receipt['preserved'] = saved
        if stop_event and stop_event.is_set():
            raise RuntimeError('Owner requested stop before navigation')
        # WebKit stores bootstrap source while Page is disabled, but dispatches
        # it on new globals only through the enabled Page agent. Source inspection
        # has already released its own Page enablement, so activation owns this one.
        page_intent = True
        await run.cmd('Page.enable')
        bootstrap_intent = True
        await run.cmd('Page.setBootstrapScript', source='void (' + guard_source + ')(' + json.dumps(config) + ');', flush_after_send=True)
        receipt['navigationAttempted'] = True
        try:
            requested = await run.value('/*release:reload*/ window[' + name + '].reload(' + json.dumps(saved) + ')')
            if not requested or requested.get('token') != token or requested.get('navigationRequested') is not True:
                raise RuntimeError('The guarded same-tab reload was not acknowledged')
            receipt['navigationRequested'] = True
        except Exception as error:
            if not any(fragment in error_message(error).lower() for fragment in ['missing injected script', 'execution context']):
                raise
            receipt['navigationAcknowledgement'] = 'context-lost'
        settled = await wait_ready(original_origin)
        receipt['navigationRequested'] = receipt['navigationObserved'] = True
        receipt['newGuard'] = settled
        await run.cmd('Page.setBootstrapScript')
        bootstrap_intent = False
        receipt['bootstrapCleared'] = True
        await run.cmd('Page.disable')
        page_intent = False
        receipt['pageReleased'] = True
        receipt['restored'] = await restore()
        receipt['after'] = await run.loaded_source()
        if not receipt['after']['ok'] or not receipt['after']['matched']:
            raise RuntimeError('The refreshed document did not execute the expected release entry')
        receipt['verified'] = await run.value('/*release:verify*/ window[' + name + '].verify(' + json.dumps(saved) + ')')
        if not receipt['verified'] or not receipt['verified'].get('exact'):
            raise RuntimeError('Reading state changed after release verification')
        receipt['status'] = 'activated'
    except Exception as error:
        receipt['error'] = str(error)
        if guard_intent:
            try:
                current = await state('recovery')
                receipt['lastGuard'] = current
                if current and current.get('interrupted'):
                    receipt['interruption'] = current.get('reason')
                if saved and receipt['navigationAttempted'] and not receipt.get('interruption'):
                    await wait_ready(original_origin, phase='recovery')
                    receipt['navigationRequested'] = receipt['navigationObserved'] = True
                    receipt['recovery'] = await restore('recovery')
            except Exception as recovery_error:
                receipt['recoveryError'] = str(recovery_error)
    finally:
        if bootstrap_intent:
            try:
                await run.cmd('Page.setBootstrapScript', phase='cleanup', cap=2)
                receipt['bootstrapCleared'] = True
            except Exception as error:
                receipt['bootstrapCleared'] = False
                receipt['cleanupErrors'].append('bootstrap: ' + str(error))
        if page_intent:
            try:
                await run.cmd('Page.disable', phase='cleanup', cap=2)
                receipt['pageReleased'] = True
            except Exception as error:
                receipt['pageReleased'] = False
                receipt['cleanupErrors'].append('page: ' + str(error))
        if guard_intent:
            try:
                cleanup = await run.value('''/*release:cleanup*/ (() => {
                    if (location.origin !== ''' + json.dumps(document.origin) + ''') return { sameOrigin: false, removed: false };
                    const name = ''' + name + ''', token = ''' + json.dumps(token) + ''';
                    const guard = window[name];
                    if (guard?.token === token) guard.dispose();
                    const key = name + ':' + token, saved = JSON.parse(sessionStorage.getItem(key) || 'null');
                    if (saved?.token === token) sessionStorage.removeItem(key);
                    return { sameOrigin: true, removed: !window[name] && sessionStorage.getItem(key) === null };
                })()''', phase='cleanup', cap=2)
                receipt['guardCleanup'] = cleanup
                if not cleanup or not cleanup.get('removed'):
                    receipt['cleanupErrors'].append('The owned guard token could not be cleared at the current origin')
            except Exception as error:
                receipt['cleanupErrors'].append('guard: ' + str(error))
        receipt['elapsedMs'] = round((budget.now() - budget.started) * 1000, 1)
        receipt['remainingDetachMs'] = round(budget.remaining('detach') * 1000, 1)
        if receipt['cleanupErrors']:
            receipt['status'] = 'failed'
            receipt.setdefault('error', 'Required activation cleanup failed')
    return receipt
