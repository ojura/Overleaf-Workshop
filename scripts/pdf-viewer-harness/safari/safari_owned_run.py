"""Sustained recording on a supplied, exclusively owned InspectorSession.

The caller keeps the session/inspector/lockdown alive and serializes commands while
this function runs. Recording domains and the sustained object group are reserved
for this call. Stop via the supplied event; cancellation also requests restoration.
Importing this adapter does not discover, attach to, or contact a device.
"""
import asyncio
import base64
import json
import secrets

import safari_runner as core
from safari_activation import Budget as SourceBudget, guard_evaluate, release_check
from safari_settings import ASSETS, load_browser_source, prefix as validate_prefix, short_page_pair

_active = set()


async def recover_recorded(wire, recorder, settings, prior_prefix, budget, checkpoint, sleep=asyncio.sleep):
    prior = json.loads((settings.work / (prior_prefix + '-result.json')).read_text())
    token = prior.get('run', {}).get('token')
    expected = prior.get('releaseCheck', {}).get('expected', {})
    if not isinstance(token, str) or not 16 <= len(token) <= 128:
        raise ValueError('The prior receipt has no valid probe token')
    if expected.get('sha256') != settings.entry.sha256 or expected.get('bytes') != settings.entry.bytes:
        raise ValueError('The prior receipt belongs to a different entry release')
    receipt = {'operation': 'recover', 'receiptPrefix': prior_prefix, 'token': token,
               'status': 'recovering', 'cleanupErrors': [], 'recordingContinuity': False}
    authorized = False

    async def call(method, argument=None):
        arguments = [token] if argument is None else [token, argument]
        # The original, unguessable token object survives only in its owning document.
        # Cross-attachment performance.timeOrigin can differ by 1 ms on this device.
        expression = '(() => { /* owned-recovery */ const api=window[' + json.dumps(core.API) + '];' + \
            'if(location.href.split("#")[0]!==' + json.dumps(settings.document.page_url) + '||!api)' + \
            'return {wrongDocument:true};return {value:api[' + json.dumps(method) + '](...' + json.dumps(arguments) + \
            '),timeOrigin:performance.timeOrigin};})()'
        wrapper = await core.bounded(wire.evaluate(expression), budget, 'restore',
                                     label='recover.' + method + ' Runtime.evaluate')
        if not isinstance(wrapper, dict) or wrapper.get('wrongDocument'):
            raise RuntimeError('The original owned page is not current')
        value = wrapper.get('value')
        if not isinstance(value, dict) or value.get('ok') is False or \
                (value.get('token') != token if method != 'dispose' else value.get('token', token) != token):
            raise RuntimeError('The original probe rejected recovery ' + method)
        receipt['observedTimeOrigin'] = wrapper.get('timeOrigin')
        return value

    try:
        latest = await call('status')
        authorized = True
        receipt['lastStatus'] = latest
        checkpoint(receipt, recorder)
        if not latest.get('finished'):
            try:
                receipt['stopAcknowledgement'] = await call('stop', 'owned-session-recovery')
            except Exception as error:
                receipt['stopAcknowledgementError'] = {'type': type(error).__name__, 'message': str(error)}
            # Status is lease-neutral: a lost stop reply cannot keep work alive.
            while not latest.get('finished'):
                if budget.remaining('restore') <= 0:
                    raise TimeoutError('Recovery restoration deadline expired')
                latest = await call('status')
                receipt['lastStatus'] = latest
                if not latest.get('finished'):
                    await sleep(min(1, budget.remaining('restore')))
        receipt['terminalStatus'] = latest
        value = await call('result')
        if value.get('finished') is not True:
            raise RuntimeError('Recovered probe result is not terminal')
        receipt['result'] = value
        receipt['terminalCollectedHostMs'] = budget.now() * 1000
        checkpoint(receipt, recorder)
        disposed = await call('dispose')
        if disposed.get('disposed') is not True:
            raise RuntimeError('The recovered terminal report was not released')
        receipt['probeDisposed'] = True
        receipt['status'] = 'recovered' if value.get('restored') is True and \
            value.get('restorationExact') is True and value.get('observersRemoved') is True else 'failed'
    except Exception as error:
        receipt.update(status='failed', error={'type': type(error).__name__, 'message': str(error)})
    finally:
        if authorized:
            receipt['cleanupErrors'].extend(await core.stop_recorders(wire, recorder, budget,
                ['Memory.stopTracking', 'Memory.disable', 'CPUProfiler.stopTracking', 'Network.disable']))
        if receipt['cleanupErrors']:
            receipt['status'] = 'failed'
        checkpoint(receipt, recorder)
    return receipt


def focus_recovery_state(settings, receipt_prefix, focus_receipt_prefix=None):
    """Read the original baseline; a current capture can never replace it."""
    def receipt(name):
        validate_prefix(name)
        value = json.loads((settings.work / (name + '-result.json')).read_text())
        expected = value.get('releaseCheck', {}).get('expected', {})
        if value.get('document') != settings.document.browser() or expected != {
                'url': settings.document.entry_url, 'sha256': settings.entry.sha256, 'bytes': settings.entry.bytes}:
            raise ValueError('The focus receipt belongs to a different document or entry release')
        return value

    prior = receipt(receipt_prefix)
    run = prior.get('run', {})
    result = run.get('result', {})
    saved = result.get('saved')
    keys = ('page', 'scale', 'scaleValue', 'rotation', 'scrollMode', 'spreadMode', 'sidebar',
            'top', 'left', 'robots', 'lab')
    if prior.get('operation') != 'run' or prior.get('status') != 'failed' or run.get('status') != 'failed' \
            or run.get('scenario') != 'short' or not isinstance(saved, dict) \
            or any(key not in saved for key in keys) or result.get('readingState') != saved \
            or result.get('restored') is not True or result.get('focusRestored') is not False \
            or result.get('interrupted') is not False or result.get('observersRemoved') is not True \
            or run.get('probeRemoved') is not True or run.get('cleanupErrors'):
        raise ValueError('Focus recovery requires the original short result with restored reader state and released probes')
    state = result.get('focusRecovery')
    if state is None:
        if focus_receipt_prefix is None:
            raise ValueError('This older short receipt requires its explicit original activation receipt')
        activation = receipt(focus_receipt_prefix)
        check = activation.get('releaseCheck', {})
        state = check.get('preserved')
        if activation.get('operation') != 'activate' or activation.get('status') != 'passed' \
                or not isinstance(state, dict) or check.get('restored', {}).get('exact') is not True \
                or check.get('verified', {}).get('exact') is not True \
                or check.get('restored', {}).get('state') != state or check.get('verified', {}).get('state') != state:
            raise ValueError('The activation receipt does not preserve and verify one original focus baseline')
    elif focus_receipt_prefix is not None:
        raise ValueError('Use the short receipt original focus; a second baseline cannot replace it')
    if not isinstance(state, dict) or any(state.get(key) != saved[key] for key in keys) \
            or not settings.document.owns_page(state.get('url')) or state.get('visualScale') != 1 \
            or not isinstance(state.get('focus'), dict):
        raise ValueError('The original focus baseline does not match the short saved reader state')
    focus = state['focus']
    kind = focus.get('kind')
    valid_focus = kind in {'body', 'html', 'viewer'} and set(focus) == {'kind'} \
        or kind == 'page-text' and set(focus) == {'kind', 'pageNumber'} \
        and type(focus.get('pageNumber')) is int and 1 <= focus['pageNumber'] <= settings.document.pages \
        or kind == 'id' and set(focus) == {'kind', 'id'} and isinstance(focus.get('id'), str) and bool(focus['id']) \
        or kind == 'panel' and set(focus) == {'kind', 'selector'} and isinstance(focus.get('selector'), str)
    if not valid_focus or state.get('lab') and not isinstance(state.get('panel'), dict):
        raise ValueError('The original focus descriptor is invalid')
    return state


async def run_owned(session, inspector, settings, prefix, stop_event, *, operation='run',
                    receipt_prefix=None, focus_receipt_prefix=None, seconds=600, start_mode='immediate', start_wait_ms=60000,
                    source_only=False, scenario='sustained', pages=None):
    """Perform one command while the caller retains the native connection."""
    validate_prefix(prefix)
    if operation not in {'run', 'recover', 'activate', 'transport-check', 'restore-focus'}:
        raise ValueError('Unknown owned operation')
    if operation in {'recover', 'restore-focus'}:
        validate_prefix(receipt_prefix)
    if focus_receipt_prefix is not None:
        if operation != 'restore-focus':
            raise ValueError('An original focus receipt is supported only by restore-focus')
        validate_prefix(focus_receipt_prefix)
    if not 60 <= seconds <= 600 or start_mode not in {'immediate', 'tap'} \
            or type(start_wait_ms) is not int or not 1000 <= start_wait_ms <= 300000:
        raise ValueError('Invalid workload or start-wait settings')
    if scenario not in {'sustained', 'traverse', 'short', 'manual'}:
        raise ValueError('Unknown maintained scenario')
    if scenario == 'manual' and seconds > 300:
        raise ValueError('Manual observation is bounded to 300 seconds')
    if pages is not None:
        if operation != 'run' or scenario != 'short':
            raise ValueError('Page selection is supported only for the short scenario')
        pages = short_page_pair(pages, page_count=settings.document.pages)
    if id(session) in _active:
        raise RuntimeError('This inspector session already has an owned operation')
    settings.prepare_work()
    filename = settings.work / (prefix + '-result.json')
    recording_filename = settings.work / (prefix + '-recording.json')
    if filename.exists() or recording_filename.exists():
        raise FileExistsError('Choose a new receipt prefix')
    wait_ms = start_wait_ms if start_mode == 'tap' else 0
    budget = core.Budget(seconds if scenario in {'sustained', 'manual'} else 60, start_wait_ms=wait_ms)
    if operation != 'run':
        duration = 40 if operation == 'transport-check' else 60
        budget.ends = {phase: budget.started + end for phase, end in
                       {'setup': 30, 'work': duration - 15, 'restore': duration - 15,
                        'recorders': duration - 5, 'detach': duration}.items()}
    recorder = core.Recorder(budget.now, document=settings.document)
    wire = core.Wire(session, budget, allow_navigation=operation == 'activate' and not source_only)
    output = {'transport': 'retained-web-inspector', 'status': 'failed', 'operation': operation,
              'attached': True, 'retainedByOwner': True, 'document': settings.document.browser()}
    work_task = None

    def checkpoint(receipt, current):
        output['run'] = receipt
        output['rpc'] = wire.snapshot()
        core.atomic_json(recording_filename, current.snapshot())
        core.atomic_json(filename, output)
        status = receipt.get('lastStatus') or {}
        print(json.dumps({'status': receipt['status'], 'phase': status.get('phase'),
            'state': status.get('state'), 'elapsedMs': status.get('elapsedMs'),
            'scrollMs': status.get('scrollMs'), 'dwellMs': status.get('dwellMs'),
            'memorySamples': current.memory['samples'], 'peakMemoryBytes': current.memory['peakBytes'],
            'cpuSamples': current.cpu['samples'], 'peakCpuPercent': current.cpu['peakPercent'],
            'pdfRequests': current.by_kind.get('pdf', {}).get('requests', 0),
            'encodedDataBytes': current.net['encodedDataBytes'],
            'rangeFailures': current.net['rangeFailures']}), flush=True)

    async def screenshot(index, status):
        expression = '(() => {const a=window[' + json.dumps(core.API) + '];return location.href.split("#")[0]===' + \
            json.dumps(settings.document.page_url) + '&&a?a.status(' + json.dumps(output['run']['token']) + '):null;})()'
        def eligible(value):
            if not value or value.get('interruption'):
                return False
            return (value.get('finished') is True and value.get('restored') is True
                    if index == 4 else not value.get('finished'))
        if not eligible(await wire.evaluate(expression)):
            return {'index': index, 'skipped': 'probe no longer eligible for this capture'}
        viewport = await wire.evaluate('({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight})')
        began = budget.now()
        picture = await wire.command('Page.snapshotRect', timeout=3,
            **{key: int(value) for key, value in viewport.items()}, coordinateSystem='Page')
        if not eligible(await wire.evaluate(expression)):
            return {'index': index, 'skipped': 'probe changed during capture'}
        data = base64.b64decode(picture['dataURL'].split('base64,', 1)[1], validate=True)
        if len(data) > 12 * 1024 * 1024:
            raise RuntimeError('Unexpectedly large screenshot')
        picture_file = settings.work / (prefix + '-shot-' + str(index) + '.png')
        picture_file.write_bytes(data)
        return {'index': index, 'file': picture_file.name, 'bytes': len(data),
                'startedHostMs': began * 1000, 'finishedHostMs': budget.now() * 1000,
                'phase': status.get('phase')}

    async def perform():
        if stop_event.is_set():
            raise RuntimeError('Owner requested stop before the operation')
        if settings.worker and operation != 'recover':
            from safari_worker_artifact import verify_worker
            output['workerArtifact'] = await core.bounded(asyncio.to_thread(verify_worker, settings.worker),
                budget, 'setup', 10, label='public worker artifact verification')
            if not output['workerArtifact']['matched']:
                raise RuntimeError('The public worker artifact does not match the expected release')
            if stop_event.is_set():
                raise RuntimeError('Owner requested stop before source inspection')
        async def evaluate(expression, timeout=3):
            return await guard_evaluate(wire, expression, timeout)
        activation = operation == 'activate'
        focus_state = focus_recovery_state(settings, receipt_prefix, focus_receipt_prefix) \
            if operation == 'restore-focus' else None
        output['releaseCheck'] = await core.bounded(release_check(
            wire.command, evaluate, session.response_methods, document=settings.document,
            source_only=source_only if activation else True,
            expected_sha=settings.entry.sha256, expected_bytes=settings.entry.bytes,
            budget=SourceBudget(seconds=min(60 if activation else 30, budget.remaining('detach'))),
            stop_event=stop_event, focus_restore=focus_state), budget, 'detach' if activation else 'setup', 60 if activation else 30,
            label='owned activation' if activation else 'owned source-only verification')
        if activation:
            return {'status': 'passed' if output['releaseCheck']['status'] in {'current', 'activated'} else 'failed',
                    'operation': 'activate'}
        if operation == 'restore-focus':
            return {'status': 'passed' if output['releaseCheck']['status'] == 'focus-restored' else 'failed',
                    'operation': operation, 'receiptPrefix': receipt_prefix, 'focusReceiptPrefix': focus_receipt_prefix}
        if output['releaseCheck']['status'] != 'current':
            raise RuntimeError('The loaded entry does not match the expected release')
        if stop_event.is_set():
            raise RuntimeError('Owner requested stop before the workload')
        if operation == 'recover':
            return await recover_recorded(wire, recorder, settings, receipt_prefix, budget, checkpoint)
        if operation == 'transport-check':
            from safari_transport_diagnostic import run_diagnostic
            return await run_diagnostic(wire, session, budget, stop_event, checkpoint, recorder)
        if scenario == 'short':
            from safari_short_run import run_short
            return await run_short(wire, recorder, settings, budget, stop_event, checkpoint, pages=pages)
        if scenario == 'manual':
            from safari_short_run import run_manual
            return await run_manual(wire, recorder, settings, seconds, budget, stop_event, checkpoint)
        source = load_browser_source('sustained.js')
        return await core.run_recorded(wire, recorder, source, secrets.token_hex(12), 11 if scenario == 'traverse' else seconds,
            budget, stop_event, checkpoint, screenshot,
            options={'startMode': start_mode, 'startWaitMs': start_wait_ms,
                     'scenario': 'traverse' if scenario == 'traverse' else 'endurance'})

    _active.add(id(session))
    try:
        protocol = json.loads((ASSETS / 'protocol/Network.json').read_text())
        wire.install_trace(inspector)
        recorder.install(session.response_methods, protocol)
        work_task = asyncio.create_task(perform())
        output['run'] = await asyncio.shield(work_task)
        output['status'] = output['run']['status']
    except asyncio.CancelledError:
        stop_event.set()
        output['ownerCancellationRequested'] = True
        if work_task:
            while True:
                try:
                    output['run'] = await asyncio.shield(work_task)
                    output['status'] = output['run']['status']
                    break
                except asyncio.CancelledError:
                    if work_task.done():
                        output['error'] = {'type': 'CancelledError', 'message': 'Owned operation was externally cancelled'}
                        break
                except Exception as error:
                    output['error'] = {'type': type(error).__name__, 'message': str(error)}
                    break
    except Exception as error:
        output['error'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        try:
            await core.bounded(wire.command('Runtime.releaseObjectGroup', objectGroup=core.OBJECT_GROUP, timeout=1),
                               budget, 'detach', 1, label='owned object-group release')
        except Exception as error:
            output.setdefault('cleanupErrors', []).append({'type': type(error).__name__, 'message': str(error)})
        recorder.uninstall(session.response_methods)
        wire.restore_trace()
        output['rpc'] = wire.snapshot()
        output['attached'] = bool(getattr(inspector, 'is_connected', True)) and not session._receive_task.done()
        output['elapsedSeconds'] = budget.now() - budget.started
        if output.get('error') or output.get('cleanupErrors') or not output['attached']:
            output['status'] = 'failed'
        _active.discard(id(session))
        core.atomic_json(recording_filename, recorder.snapshot())
        core.atomic_json(filename, output)
        print(json.dumps({'status': output['status'], 'attached': output['attached'],
                          'retainedByOwner': True, 'elapsedSeconds': output['elapsedSeconds'],
                          'result': filename.name, 'recording': recording_filename.name}), flush=True)
    return output
