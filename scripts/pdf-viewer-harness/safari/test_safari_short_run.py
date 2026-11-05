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

    async def prepare_initializer(self, source):
        self.calls.append('prepare-' + source)
        return source

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
            if params['objectId'] == 'active':
                self.owner, self.token = True, options['token']
                if self.stop_active:
                    self.stop.set()
                    await asyncio.Future()
                value = {'token': self.token, 'active': {'page': 99}, 'errors': []}
            else:
                if self.fail_finish:
                    raise RuntimeError('finish failed before restoration')
                self.owner = False
                value = {'token': self.token, 'active': {'page': 99}, 'panel': {'trials': [{}] * 5},
                    'restorationExact': True, 'focusRestored': True, 'observersRemoved': True, 'errors': [],
                    'restoredViewport': {'visible': True, 'focused': False, 'displayed': True, 'missingPages': []},
                    'idle': {'awake': True, 'observedMs': 1500, 'quiet': True, 'framesAdded': 0}}
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
            self.aborts += 1
            self.owner = False
            return {'ok': True, 'result': {'token': self.token, 'interrupted': True, 'observersRemoved': True}}
        return {'owned': self.owner, 'x': 0, 'y': 0, 'width': 320, 'height': 480}


class ShortTests(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, **options):
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
            with mock.patch.object(short, 'load_browser_source', side_effect=lambda name: 'active' if name == 'sidecar-active.js' else 'finish'):
                result = await short.run_short(wire, recorder, configured, budget, stop, checkpoint)
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
        self.assertEqual(wire.calls.count('Runtime.callFunctionOn'), 1)
        self.assertEqual(wire.aborts, 1)
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
