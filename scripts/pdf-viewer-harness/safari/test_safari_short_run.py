"""Short delivery/finish and passive observation use one retained recording span."""
import asyncio
import copy
import pathlib
import tempfile
import unittest
from unittest import mock

import safari_runner as core
import safari_short_run as short
from test_safari_runner import Clock, cpu, memory
from test_support import settings


class Wire:
    value = staticmethod(core.Wire.value)

    def __init__(self, clock, recorder, stop):
        self.clock, self.recorder, self.stop = clock, recorder, stop
        self.calls, self.domains = [], set()
        self.fail_finish = self.stop_active = False
        self.owner, self.token, self.aborts = False, None, 0
        self.finish_seconds = 1
        self.async_abort_required = self.lose_finish_ack = False
        self.result_failure = self.result_cleanup_error = None
        self.frontend_errors = []
        self.idle_deadline_expired = False
        self.invocations = []

    async def prepare_initializer(self, source):
        self.calls.append('prepare-' + source)
        return 'abort' if 'p.abort(' in source else source

    async def command(self, method, **params):
        self.calls.append(method)
        if method.endswith('.enable') or method.endswith('startTracking'):
            self.domains.add(method)
        elif method.endswith('.disable') or method.endswith('stopTracking'):
            self.domains.discard({'Network.disable': 'Network.enable', 'Memory.disable': 'Memory.enable',
                'Memory.stopTracking': 'Memory.startTracking', 'CPUProfiler.stopTracking': 'CPUProfiler.startTracking'}[method])
        elif method == 'Runtime.callFunctionOn':
            self.assert_recording()
            options = params['arguments'][0]['value']
            self.invocations.append(copy.deepcopy(params))
            if params['objectId'] == 'active':
                self.owner, self.token = True, options['token']
                if self.stop_active:
                    self.stop.set()
                    await asyncio.Future()
                value = {'token': self.token, 'active': {'page': 99}, 'errors': []}
            elif params['objectId'] == 'abort':
                if params.get('awaitPromise') is not True:
                    raise AssertionError('Asynchronous panel recovery must be awaited')
                if not self.owner:
                    return {'result': {'type': 'object', 'value': {'missing': True}}}
                self.aborts += 1
                self.owner = False
                return {'result': {'type': 'object', 'value': {'ok': True, 'result': {
                    'token': self.token, 'interrupted': True, 'observersRemoved': True}}}}
            else:
                if self.fail_finish:
                    raise RuntimeError('finish failed before restoration')
                if self.finish_seconds > params['timeout']:
                    self.clock.at += params['timeout']
                    raise TimeoutError('The finish reply exceeded the host RPC allowance')
                self.clock.at += self.finish_seconds - 1
                self.owner = False
                if self.lose_finish_ack:
                    raise TimeoutError('The finish acted but its acknowledgement was lost')
                value = {'token': self.token, 'active': {'page': 99}, 'panel': {'trials': [{}] * 5},
                    'restorationExact': True, 'focusRestored': True, 'observersRemoved': True, 'errors': self.frontend_errors,
                    'failure': self.result_failure, 'cleanupError': self.result_cleanup_error,
                    'restoredViewport': {'visible': True, 'focused': False, 'displayed': True, 'missingPages': []},
                    'idle': {'awake': not self.idle_deadline_expired,
                        'observedMs': 0 if self.idle_deadline_expired else 1500,
                        'quiet': not self.idle_deadline_expired, 'framesAdded': 0,
                        'deadlineExpired': self.idle_deadline_expired}}
            self.clock.at += 1
            memory(self.recorder, 100, self.clock.at)
            cpu(self.recorder, 10, self.clock.at)
            return {'result': {'type': 'object', 'value': value}}
        elif method == 'Page.snapshotRect':
            self.assert_recording()
            return {'dataURL': 'data:image/png;base64,b3duZWQ='}
        return {}

    def assert_recording(self):
        if len(self.domains) != 4:
            raise AssertionError('Recording must cover active, screenshot and restoration')

    async def evaluate(self, source, **kwargs):
        if 'p.abort(' in source:
            if self.async_abort_required:
                raise RuntimeError('Synchronous evaluate cannot await panel restoration')
            self.aborts += 1
            self.owner = False
            return {'ok': True, 'result': {'token': self.token, 'interrupted': True, 'observersRemoved': True}}
        return {'owned': self.owner, 'x': 0, 'y': 0, 'width': 320, 'height': 480}


class ShortTests(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, *, run_options=None, **options):
        with tempfile.TemporaryDirectory() as directory:
            configured = settings(pathlib.Path(directory))
            clock, stop = Clock(), asyncio.Event()
            budget = core.Budget(60, clock.now)
            recorder = core.Recorder(clock.now, document=configured.document)
            wire = Wire(clock, recorder, stop)
            for key, value in options.items():
                setattr(wire, key, value)
            checkpoints = []
            def checkpoint(receipt, current):
                checkpoints.append((copy.deepcopy(receipt), len(wire.domains)))
            bounded = core.bounded
            async def clock_bounded(awaitable, phase_budget, phase, cap=core.RPC_SECONDS, label='operation'):
                deadline = clock.now() + min(cap, phase_budget.remaining(phase))
                value = await bounded(awaitable, phase_budget, phase, cap, label)
                # Fixture replies advance the simulated clock instead of sleeping.
                # Check the outer phase timer as well as the wire's RPC timeout.
                if clock.now() > deadline:
                    raise TimeoutError(label + ' exceeded the host ' + phase + ' deadline')
                return value
            with mock.patch.object(short, 'load_browser_source', side_effect=lambda name: 'active' if name == 'sidecar-active.js' else 'finish'), \
                    mock.patch.object(core, 'bounded', side_effect=clock_bounded):
                result = await short.run_short(wire, recorder, configured, budget, stop, checkpoint, **(run_options or {}))
            return result, wire, checkpoints

    async def test_one_recording_spans_active_capture_finish_and_terminal_persistence(self):
        result, wire, checkpoints = await self.run_case()
        self.assertEqual(result['status'], 'passed')
        self.assertTrue(result['recordingCoverage']['complete'])
        self.assertEqual(wire.calls.count('Runtime.callFunctionOn'), 2)
        self.assertEqual(wire.calls.count('Network.enable'), 1)
        self.assertEqual(wire.calls.count('Network.disable'), 1)
        self.assertTrue(any('result' in value and domains == 4 for value, domains in checkpoints))
        self.assertFalse(wire.domains or wire.owner)
        self.assertNotIn('pages', wire.invocations[0]['arguments'][0]['value'])

    async def test_explicit_pages_reach_the_browser_and_are_recorded(self):
        result, wire, _ = await self.run_case(run_options={'pages': [101, 102]})
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['pages'], [101, 102])
        active = next(value for value in wire.invocations if value['objectId'] == 'active')
        self.assertEqual(active['arguments'][0]['value']['pages'], [101, 102])
        self.assertFalse(wire.domains or wire.owner)

    async def test_invalid_page_pair_cannot_start_recording_or_browser_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            configured = settings(pathlib.Path(directory))
            clock, stop = Clock(), asyncio.Event()
            budget = core.Budget(60, clock.now)
            recorder = core.Recorder(clock.now, document=configured.document)
            wire = Wire(clock, recorder, stop)
            for pages in ([1, configured.document.pages + 1], [1, 1], [True, 2], ['1', 2], [1, 2, 3]):
                with self.subTest(pages=pages), self.assertRaises(ValueError):
                    await short.run_short(wire, recorder, configured, budget, stop, mock.Mock(), pages=pages)
            self.assertEqual(wire.calls, [])
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [])

    async def test_probe_and_cleanup_failures_are_distinct_from_frontend_exceptions(self):
        for options, expected in (
            ({'result_failure': 'The restored reader did not reach awake idle'}, ['probe-failure']),
            ({'result_cleanup_error': 'Panel restoration failed'}, ['probe-cleanup']),
            ({'frontend_errors': ['Unhandled rendering exception']}, ['frontend-errors']),
            ({'result_failure': 'Probe failed', 'result_cleanup_error': 'Cleanup failed',
              'frontend_errors': ['Unhandled rendering exception']}, ['probe-failure', 'probe-cleanup', 'frontend-errors']),
        ):
            with self.subTest(options=options):
                result, wire, _ = await self.run_case(**options)
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['validationFailures'], expected)
                self.assertFalse(wire.domains or wire.owner)

    async def test_failed_finish_aborts_only_the_owned_probe_before_stopping_recorders(self):
        result, wire, _ = await self.run_case(fail_finish=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.aborts, 1)
        self.assertTrue(result['probeRemoved'])
        self.assertTrue(result['result']['observersRemoved'])
        self.assertFalse(wire.domains or wire.owner)

    async def test_host_stop_cancels_the_pending_reply_then_restores_without_reinvocation(self):
        result, wire, _ = await self.run_case(stop_active=True)
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(sum(value['objectId'] == 'active' for value in wire.invocations), 1)
        self.assertEqual(wire.aborts, 1)
        self.assertFalse(wire.domains or wire.owner)

    async def test_finite_panel_choreography_keeps_browser_limits_with_host_collection_time(self):
        result, wire, _ = await self.run_case(finish_seconds=40)
        self.assertEqual(result['status'], 'passed')
        active, finish = [value for value in wire.invocations if value['objectId'] != 'abort']
        limits = active['arguments'][0]['value']['budget']
        self.assertEqual(limits['activeMs'], active['timeout'] * 1000)
        self.assertLess(limits['finishMs'], finish['timeout'] * 1000)
        self.assertEqual(limits['workMs'], limits['activeMs'] + limits['captureMs'] + limits['finishMs'])
        self.assertGreaterEqual(limits['restoreMs'], 15000)
        self.assertFalse(wire.domains or wire.owner)

    async def test_finish_reply_after_browser_limit_retains_success_or_deadline_receipt(self):
        for expired in (False, True):
            with self.subTest(deadline_expired=expired):
                failure = 'Continuous awake idle was not reached before the observation deadline' if expired else None
                result, wire, checkpoints = await self.run_case(
                    finish_seconds=short.SHORT_BUDGET_MS['finishMs'] / 1000 + .25,
                    idle_deadline_expired=expired, result_failure=failure)
                self.assertEqual(result['status'], 'failed' if expired else 'passed')
                self.assertEqual(result['validationFailures'],
                    ['displayed-awake-idle', 'probe-failure'] if expired else [])
                self.assertEqual(result['result']['idle']['deadlineExpired'], expired)
                self.assertTrue(result['recordingCoverage']['complete'])
                self.assertTrue(any('result' in value and domains == 4 for value, domains in checkpoints))
                self.assertEqual(wire.aborts, 0)
                self.assertEqual(result['cleanupErrors'], [])
                self.assertFalse(wire.domains or wire.owner)

    async def test_finish_collection_keeps_the_host_work_deadline_and_recovery_reserve(self):
        work_seconds = core.Budget(60, lambda: 0).ends['work']
        result, wire, _ = await self.run_case(finish_seconds=work_seconds)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error']['type'], 'TimeoutError')
        self.assertEqual(result['elapsedSeconds'], work_seconds)
        self.assertEqual(wire.aborts, 1)
        self.assertTrue(result['probeRemoved'])
        self.assertEqual(result['cleanupErrors'], [])
        self.assertFalse(wire.domains or wire.owner)

    async def test_failed_finish_awaits_panel_abort_with_recording_still_active(self):
        result, wire, _ = await self.run_case(fail_finish=True, async_abort_required=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.aborts, 1)
        self.assertEqual(result['cleanupErrors'], [])
        self.assertTrue(result['probeRemoved'])
        self.assertEqual(sum(value['objectId'] == 'abort' for value in wire.invocations), 1)
        self.assertFalse(wire.domains or wire.owner)

    async def test_lost_finish_ack_does_not_repeat_an_acted_operation(self):
        result, wire, _ = await self.run_case(lose_finish_ack=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error']['type'], 'TimeoutError')
        self.assertEqual(sum(value['objectId'] == 'active' for value in wire.invocations), 1)
        self.assertEqual(sum(value['objectId'] == 'finish' for value in wire.invocations), 1)
        self.assertTrue(result['probeRemoved'])
        self.assertFalse(wire.domains or wire.owner)

    async def test_manual_uses_the_same_recorder_with_its_own_passive_api_and_duration(self):
        configured = settings(pathlib.Path('/tmp/offline-only'))
        recorded = mock.AsyncMock(return_value={'status': 'observed'})
        with mock.patch.object(short.core, 'run_recorded', recorded), \
                mock.patch.object(short, 'load_browser_source', return_value='inert-manual'):
            result = await short.run_manual(None, None, configured, 120, None, None, None)
        self.assertEqual(result['status'], 'observed')
        self.assertEqual(recorded.call_args.kwargs['probe_api'], '__spomenarManualProbe')
        self.assertEqual(recorded.call_args.kwargs['options']['durationMs'], 120000)
        self.assertTrue(recorded.call_args.kwargs['manual'])
