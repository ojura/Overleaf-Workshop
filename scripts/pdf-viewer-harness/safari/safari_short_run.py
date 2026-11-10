"""Continuous native recording for the retained delivery and manual observations."""
import asyncio
import base64
import contextlib
import json
import secrets

import safari_runner as core
from safari_settings import load_browser_source, short_page_pair

SIDECAR_API = '__spomenarSidecarProbe'
# Nine finite panel/column settles can take about 33.3 seconds, followed by
# the existing delivery/reader settling and awake proof. These are failure
# limits, not delays: the browser finishes each action from observed state.
SHORT_BUDGET_MS = {'activeMs': 35000, 'captureMs': 5000, 'finishMs': 60000, 'restoreMs': 15000,
                   'settleMs': 6000}
SHORT_BUDGET_MS['workMs'] = sum(SHORT_BUDGET_MS[key] for key in ('activeMs', 'captureMs', 'finishMs'))


async def run_manual(wire, recorder, settings, seconds, budget, stop_event, checkpoint):
    return await core.run_recorded(wire, recorder, load_browser_source('manual-observe.js'),
        secrets.token_hex(12), seconds, budget, stop_event, checkpoint,
        options={'durationMs': seconds * 1000, 'scenario': 'manual'},
        probe_api='__spomenarManualProbe', manual=True)


async def invoke(wire, source, options, budget, stop_event, cap, *, phase='work'):
    handle = await core.bounded(wire.prepare_initializer(source), budget, phase,
                                core.INITIALIZER_PREPARE_SECONDS, 'prepare inert short observation')
    if stop_event is not None and stop_event.is_set():
        raise RuntimeError('Host stop arrived before the short observation invocation')
    operation = asyncio.create_task(core.bounded(wire.command('Runtime.callFunctionOn', timeout=cap,
        objectId=handle, functionDeclaration='function (options) { return this(options); }',
        arguments=[{'value': options}], returnByValue=True, awaitPromise=True, emulateUserGesture=False),
        budget, phase, cap, 'short observation Runtime.callFunctionOn'))
    stopped = asyncio.create_task(stop_event.wait()) if stop_event is not None else None
    try:
        if stopped is None:
            return wire.value(await operation, 'short observation')
        done, _ = await asyncio.wait((operation, stopped), return_when=asyncio.FIRST_COMPLETED)
        if operation not in done:
            raise RuntimeError('Host stop requested during the short observation')
        return wire.value(await operation, 'short observation')
    finally:
        for task in (operation, stopped):
            if task is None:
                continue
            if not task.done():
                task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task


async def run_short(wire, recorder, settings, budget, stop_event, checkpoint, *, pages=None):
    if pages is not None:
        pages = short_page_pair(pages, page_count=settings.document.pages)
    token = secrets.token_hex(12)
    receipt = {'status': 'running', 'scenario': 'short', 'token': token,
               'budgetMs': dict(SHORT_BUDGET_MS), 'cleanupErrors': [], 'screenshots': []}
    options = {'token': token, 'document': settings.document.browser(), 'budget': dict(SHORT_BUDGET_MS)}
    if pages is not None:
        receipt['pages'] = options['pages'] = pages
    domains = []
    attempted = False

    def persist():
        checkpoint(receipt, recorder)

    async def snapshot():
        expression = '(() => {const p=window[' + json.dumps(SIDECAR_API) + '];return {owned:!!p&&p.token===' + \
            json.dumps(token) + '&&!p.result.interrupted&&location.href.split("#")[0]===' + \
            json.dumps(settings.document.page_url) + ',x:scrollX,y:scrollY,width:innerWidth,height:innerHeight};})()'
        viewport = await wire.evaluate(expression)
        if not viewport.get('owned'):
            return {'skipped': 'The short observation no longer owns this document'}
        picture = await wire.command('Page.snapshotRect', timeout=3, coordinateSystem='Page',
            **{key: int(viewport[key]) for key in ('x', 'y', 'width', 'height')})
        if not (await wire.evaluate(expression)).get('owned'):
            return {'skipped': 'The short observation changed during capture'}
        data = base64.b64decode(picture['dataURL'].split('base64,', 1)[1], validate=True)
        if len(data) > 12 * 1024 * 1024:
            raise RuntimeError('Unexpectedly large screenshot')
        filename = settings.work / ('short-' + token + '.png')
        filename.write_bytes(data)
        return {'file': filename.name, 'bytes': len(data)}

    async def abort():
        source = '(options => { const p=window[' + json.dumps(SIDECAR_API) + '];if(!p)return {missing:true};' + \
            'if(p.token!==options.token)return {wrongOwner:true};return p.abort(options.token,"host-cleanup");})'
        value = await invoke(wire, source, {'token': token}, budget, None,
                             SHORT_BUDGET_MS['restoreMs'] / 1000, phase='restore')
        if value.get('wrongOwner') or value.get('ok') is False:
            raise RuntimeError('The short observation token changed')
        if value.get('result'):
            receipt['result'] = value['result']
        receipt['probeRemoved'] = True

    try:
        for begin, end in (('Network.enable', 'Network.disable'),
                           ('CPUProfiler.startTracking', 'CPUProfiler.stopTracking'),
                           ('Memory.enable', 'Memory.disable'), ('Memory.startTracking', 'Memory.stopTracking')):
            if stop_event.is_set():
                raise RuntimeError('Host stop requested before recording')
            domains.append(end)
            event = {'method': begin, 'intentHostMs': budget.now() * 1000}
            recorder.domain_events.append(event)
            await core.bounded(wire.command(begin), budget, 'setup', label=begin)
            event['ackHostMs'] = budget.now() * 1000
        receipt['recordingReadyHostMs'] = budget.now() * 1000
        attempted = True
        receipt['initializationAttemptedHostMs'] = budget.now() * 1000
        value = await invoke(wire, load_browser_source('sidecar-active.js'), options,
            budget, stop_event, SHORT_BUDGET_MS['activeMs'] / 1000)
        if not isinstance(value, dict) or value.get('token') != token:
            raise RuntimeError('Short observation did not acknowledge its token')
        receipt['active'] = value
        persist()
        if value.get('failure') or value.get('interrupted'):
            raise RuntimeError('Short observation stopped before its delivery sample')
        receipt['screenshots'].append(await core.bounded(snapshot(), budget, 'work',
            SHORT_BUDGET_MS['captureMs'] / 1000, 'short delivery capture'))
        # The browser owns its finish limit. Collect its terminal reply within
        # the host work deadline, preserving the separate recovery allowance.
        value = await invoke(wire, load_browser_source('sidecar-finish.js'), {'token': token},
                             budget, stop_event, budget.remaining('work'))
        if not isinstance(value, dict) or value.get('token') != token:
            raise RuntimeError('Short finish did not acknowledge its token')
        receipt['result'] = value
        receipt['terminalCollectedHostMs'] = budget.now() * 1000
        receipt['probeRemoved'] = True
        persist()
        receipt['validationFailures'] = [label for label, failed in (
            ('delivery-observed', not value.get('active')),
            ('panel-trials', len(value.get('panel', {}).get('trials', [])) != 5),
            ('restoration', value.get('restorationExact') is not True or value.get('focusRestored') is not True),
            ('displayed-awake-idle', not core.restored_ready(value)),
            ('observer-cleanup', value.get('observersRemoved') is not True),
            ('probe-failure', bool(value.get('failure'))),
            ('probe-cleanup', bool(value.get('cleanupError'))),
            ('frontend-errors', bool(value.get('errors'))),
            ('native-recording', bool(recorder.counts['errors'])),
        ) if failed]
        receipt['status'] = 'passed' if not receipt['validationFailures'] else 'failed'
        if value.get('interrupted'):
            receipt['status'] = 'interrupted'
    except Exception as error:
        receipt.update(status='interrupted' if stop_event.is_set() else 'failed',
                       error={'type': type(error).__name__, 'message': str(error)})
    finally:
        if attempted and not receipt.get('probeRemoved'):
            try:
                await abort()
                persist()
            except Exception as error:
                receipt['cleanupErrors'].append('short owner: ' + str(error))
        receipt['recordingStopRequestedHostMs'] = budget.now() * 1000
        receipt['cleanupErrors'].extend(await core.stop_recorders(wire, recorder, budget, list(reversed(domains))))
        receipt['recordingCoverage'] = {'initializationThroughTerminalResult':
            receipt.get('recordingReadyHostMs', float('inf')) <= receipt.get('initializationAttemptedHostMs', -1)
            <= receipt.get('terminalCollectedHostMs', -1) <= receipt['recordingStopRequestedHostMs'],
            'memorySamples': recorder.memory['samples'], 'cpuSamples': recorder.cpu['samples']}
        receipt['recordingCoverage']['complete'] = receipt['recordingCoverage']['initializationThroughTerminalResult'] \
            and recorder.memory['samples'] > 0 and recorder.cpu['samples'] > 0
        if receipt['cleanupErrors'] or receipt['status'] == 'passed' and not receipt['recordingCoverage']['complete']:
            receipt['status'] = 'failed'
        receipt['elapsedSeconds'] = budget.now() - budget.started
        persist()
    return receipt
