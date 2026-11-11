"""Offline adapter tests using the already tested sustained lifecycle fake."""
import asyncio
import contextlib
import copy
import io
import json
import pathlib
import tempfile
import types
import unittest
from unittest import mock

import test_safari_runner as fixtures
import safari_owned_run as adapter
from test_support import settings


def focus_receipts(configured, *, legacy=False):
    saved = {'page': 149, 'scale': 0.6, 'scaleValue': '0.6', 'rotation': 0, 'scrollMode': 0,
             'spreadMode': 0, 'sidebar': 0, 'top': 85050, 'left': 0, 'robots': True, 'lab': False}
    state = {**saved, 'focus': {'kind': 'page-text', 'pageNumber': 149}, 'panel': None,
             'url': configured.document.page_url + '#page=148&zoom=60,-2,236', 'visualScale': 1}
    expected = {'url': configured.document.entry_url, 'sha256': configured.entry.sha256, 'bytes': configured.entry.bytes}
    result = {'saved': saved, 'readingState': dict(saved), 'restored': True, 'focusRestored': False,
              'interrupted': False, 'observersRemoved': True}
    if not legacy:
        result['focusRecovery'] = state
    prior = {'document': configured.document.browser(), 'releaseCheck': {'expected': expected}, 'status': 'failed',
             'operation': 'run', 'run': {'scenario': 'short', 'status': 'failed', 'probeRemoved': True,
             'cleanupErrors': [], 'result': result}}
    activation = {'document': configured.document.browser(), 'operation': 'activate', 'status': 'passed',
                  'releaseCheck': {'expected': expected, 'preserved': state,
                  'restored': {'exact': True, 'state': copy.deepcopy(state)},
                  'verified': {'exact': True, 'state': copy.deepcopy(state)}}}
    for name, value in [('failed-short', prior), ('original-activation', activation)]:
        (configured.work / (name + '-result.json')).write_text(json.dumps(value))
    return state, prior, activation


class FocusReceiptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.settings = settings(pathlib.Path(directory.name))

    def test_current_short_uses_its_original_descriptor_and_refuses_a_second_baseline(self):
        state, _, _ = focus_receipts(self.settings)
        self.assertEqual(adapter.focus_recovery_state(self.settings, 'failed-short'), state)
        with self.assertRaisesRegex(ValueError, 'second baseline'):
            adapter.focus_recovery_state(self.settings, 'failed-short', 'original-activation')

    def test_legacy_short_requires_its_exact_verified_activation_state(self):
        state, _, _ = focus_receipts(self.settings, legacy=True)
        with self.assertRaisesRegex(ValueError, 'explicit original activation'):
            adapter.focus_recovery_state(self.settings, 'failed-short')
        self.assertEqual(adapter.focus_recovery_state(self.settings, 'failed-short', 'original-activation'), state)
        for field, value in [('top', 85051), ('page', 150), ('scaleValue', '1.0')]:
            _, _, activation = focus_receipts(self.settings, legacy=True)
            for key in ['preserved', 'restored', 'verified']:
                target = activation['releaseCheck'][key]
                (target if key == 'preserved' else target['state'])[field] = value
            (self.settings.work / 'original-activation-result.json').write_text(json.dumps(activation))
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'saved reader state'):
                adapter.focus_recovery_state(self.settings, 'failed-short', 'original-activation')

    def test_foreign_source_active_probe_and_unrestored_reader_receipts_are_rejected(self):
        changes = [
            lambda p: p['document'].update(sha256='f' * 64),
            lambda p: p['releaseCheck']['expected'].update(bytes=self.settings.entry.bytes + 1),
            lambda p: p['run'].update(probeRemoved=False),
            lambda p: p['run']['result'].update(interrupted=True),
            lambda p: p['run']['result']['readingState'].update(top=1),
            lambda p: p['run']['result'].update(restored=False),
            lambda p: p['run']['result']['focusRecovery'].update(focus={'kind': 'page-text', 'pageNumber': True}),
        ]
        for change in changes:
            _, prior, _ = focus_receipts(self.settings); change(prior)
            (self.settings.work / 'failed-short-result.json').write_text(json.dumps(prior))
            with self.subTest(change=changes.index(change)), self.assertRaises(ValueError):
                adapter.focus_recovery_state(self.settings, 'failed-short')


class OwnedWire(fixtures.FakeWire):
    def __init__(self, clock, recorder, stop, work, started):
        super().__init__(clock, recorder, stop, duration=2)
        self.work, self.started_event = work, started
        self.inspector = self.previous_trace = self.trace_callback = None

    def install_trace(self, inspector):
        self.inspector, self.previous_trace = inspector, inspector.trace
        self.trace_callback = lambda *_: None
        inspector.trace = self.trace_callback

    def restore_trace(self):
        if self.inspector and self.inspector.trace is self.trace_callback:
            self.inspector.trace = self.previous_trace

    def snapshot(self):
        return {'count': len(self.commands)}

    async def invoke_initializer(self, handle, config):
        result = await super().invoke_initializer(handle, config)
        self.started_event.set()
        return result

    async def command(self, method, timeout=3, **params):
        value = await super().command(method, timeout, **params)
        if method == 'Page.snapshotRect':
            return {'dataURL': 'data:image/png;base64,b3duZWQ='}
        return value

    async def evaluate(self, source, timeout=3):
        if 'a.status(' in source:
            return self.status()
        if source.startswith('({x:scrollX'):
            return {'x': 0, 'y': 0, 'width': 320, 'height': 480}
        if 'api["dispose"]' in source:
            saved = json.loads((self.work / 'owned-result.json').read_text())
            self.result_persisted = 'result' in saved.get('run', {})
        return await super().evaluate(source, timeout)


class OwnedAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = pathlib.Path(self.directory.name)
        self.settings = settings(self.work)

        self.clock = fixtures.Clock()
        self.stop, self.started = asyncio.Event(), asyncio.Event()
        self.previous_handler, self.previous_trace = mock.Mock(), mock.Mock()
        self.handlers = {'Memory.trackingUpdate': self.previous_handler}
        self.session = types.SimpleNamespace(response_methods=self.handlers,
            _receive_task=types.SimpleNamespace(done=lambda: False))
        self.inspector = types.SimpleNamespace(trace=self.previous_trace, is_connected=True,
            teardown_inspector_socket=mock.AsyncMock(), close=mock.AsyncMock())
        self.wires, self.recorders = [], []
        budget_type, recorder_type = adapter.core.Budget, adapter.core.Recorder
        recorded = adapter.core.run_recorded
        def recorder(now, **kwargs):
            value = recorder_type(now, **kwargs)
            self.recorders.append(value)
            return value
        def wire(*_, **__):
            value = OwnedWire(self.clock, self.recorders[-1], self.stop, self.work, self.started)
            self.wires.append(value)
            return value
        async def run_recorded(*args, **kwargs):
            return await recorded(*args, **kwargs, sleep=self.clock.sleep)
        self.source_check = mock.AsyncMock(return_value={'status': 'current'})
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for patch in (
            mock.patch.object(adapter, 'load_browser_source', return_value=fixtures.JS),
            mock.patch.object(adapter.core, 'Budget', lambda seconds, **kwargs: budget_type(seconds, self.clock.now, **kwargs)),
            mock.patch.object(adapter.core, 'Recorder', recorder),
            mock.patch.object(adapter.core, 'Wire', wire),
            mock.patch.object(adapter.core, 'run_recorded', run_recorded),
            mock.patch.object(adapter, 'release_check', self.source_check),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.stack.enter_context(patch)

    def assert_owner_retained(self, result):
        self.assertTrue(result['attached'] and result['retainedByOwner'])
        self.assertNotIn('detached', result)
        self.assertEqual(self.handlers, {'Memory.trackingUpdate': self.previous_handler})
        self.assertIs(self.inspector.trace, self.previous_trace)
        self.inspector.close.assert_not_called()
        self.inspector.teardown_inspector_socket.assert_not_called()
        self.assertFalse(self.session._receive_task.done())
        self.assertNotIn(id(self.session), adapter._active)
        self.assertEqual(self.wires[0].commands.count('Runtime.releaseObjectGroup'), 1)

    async def test_success_records_restores_captures_disposes_and_keeps_the_same_session(self):
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop)
        self.assertEqual(result['status'], 'passed')
        self.assertTrue(result['run']['recordingCoverage']['complete'])
        self.assertTrue(result['run']['result']['restorationExact'])
        self.assertEqual(self.wires[0].starts, 1)
        self.assertTrue(self.wires[0].disposed)
        self.assertFalse(self.wires[0].enabled)
        self.assertTrue((self.work / 'owned-shot-4.png').exists())
        self.assertTrue(self.source_check.call_args.kwargs['source_only'])
        self.assertEqual(self.source_check.call_args.kwargs['expected_sha'], self.settings.entry.sha256)
        self.assertEqual(self.source_check.call_args.kwargs['expected_bytes'], self.settings.entry.bytes)
        self.assert_owner_retained(result)

    async def test_focus_recovery_dispatches_only_the_original_receipt_and_keeps_it_unchanged(self):
        state, _, _ = focus_receipts(self.settings, legacy=True)
        original = (self.work / 'failed-short-result.json').read_bytes()
        self.source_check.return_value = {'status': 'focus-restored'}
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop,
            operation='restore-focus', receipt_prefix='failed-short', focus_receipt_prefix='original-activation')
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(self.source_check.call_args.kwargs['focus_restore'], state)
        self.assertTrue(self.source_check.call_args.kwargs['source_only'])
        self.assertEqual(self.wires[0].starts, 0)
        self.assertEqual((self.work / 'failed-short-result.json').read_bytes(), original)
        self.assertFalse(list(self.work.glob('*.png')))
        self.assert_owner_retained(result)

    async def test_invalid_focus_receipt_never_installs_a_guard_or_starts_a_workload(self):
        _, prior, _ = focus_receipts(self.settings)
        prior['run']['result']['readingState']['top'] += 1
        (self.work / 'failed-short-result.json').write_text(json.dumps(prior))
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop,
            operation='restore-focus', receipt_prefix='failed-short')
        self.assertEqual(result['status'], 'failed')
        self.source_check.assert_not_awaited()
        self.assertEqual(self.wires[0].starts, 0)
        self.assert_owner_retained(result)

    async def test_inert_preparation_failure_releases_group_and_domains_but_retains_owner(self):
        old_wire = adapter.core.Wire
        def fail_prepare(*args, **kwargs):
            value = old_wire(*args, **kwargs)
            value.prepare_failure = True
            return value
        with mock.patch.object(adapter.core, 'Wire', fail_prepare):
            result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.wires[0].starts, 0)
        self.assertFalse(self.wires[0].enabled)
        self.assertNotIn('initializationAttemptedHostMs', result['run'])
        self.assert_owner_retained(result)

    async def test_source_mismatch_never_initializes_or_closes_the_owner(self):
        self.source_check.return_value = {'status': 'stale'}
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(self.wires[0].starts, 0)
        self.assertFalse(self.wires[0].enabled)
        self.assert_owner_retained(result)

    async def test_coroutine_cancellation_requests_restore_and_preserves_attached_owner(self):
        task = asyncio.create_task(adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop))
        await self.started.wait()
        task.cancel()
        result = await task
        self.assertTrue(result['ownerCancellationRequested'])
        self.assertEqual(result['status'], 'interrupted')
        self.assertTrue(result['run']['result']['restorationExact'])
        self.assertTrue(self.wires[0].disposed)
        self.assertFalse(self.wires[0].enabled)
        self.assert_owner_retained(result)

    async def test_second_run_cannot_share_the_current_owned_job(self):
        task = asyncio.create_task(adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop))
        await self.started.wait()
        with self.assertRaisesRegex(RuntimeError, 'already has an owned operation'):
            await adapter.run_owned(self.session, self.inspector, self.settings, 'other', self.stop)
        self.stop.set()
        result = await task
        self.assert_owner_retained(result)

    async def test_receipt_prefix_cannot_be_reused(self):
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop)
        with self.assertRaises(FileExistsError):
            await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop)
        self.assert_owner_retained(result)

    async def test_short_page_pair_reaches_runner_and_retains_the_same_owner(self):
        import safari_short_run
        run_short = mock.AsyncMock(return_value={'status': 'passed'})
        with mock.patch.object(safari_short_run, 'run_short', run_short):
            result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop,
                                            scenario='short', pages=[101, 102])
        run_short.assert_awaited_once()
        self.assertEqual(run_short.call_args.kwargs['pages'], [101, 102])
        self.assertIs(run_short.call_args.args[0], self.wires[0])
        self.assertIs(run_short.call_args.args[2], self.settings)
        self.assert_owner_retained(result)

    async def test_invalid_short_pages_fail_before_source_inspection_or_work_files(self):
        for options in ({'scenario': 'short', 'pages': [1, self.settings.document.pages + 1]},
                        {'scenario': 'short', 'pages': [True, 2]},
                        {'scenario': 'short', 'pages': ['1', 2]},
                        {'scenario': 'short', 'pages': [1, 1]},
                        {'scenario': 'sustained', 'pages': [101, 102]},
                        {'scenario': 'manual', 'pages': [101, 102]},
                        {'operation': 'activate', 'scenario': 'short', 'pages': [101, 102]}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, **options)
        self.source_check.assert_not_awaited()
        self.assertEqual(self.wires, [])
        self.assertEqual(list(self.work.iterdir()), [])
        self.assertNotIn(id(self.session), adapter._active)


class RecoveryWire(OwnedWire):
    def __init__(self, *args):
        super().__init__(*args)
        self.token = 'original-probe-token'
        self.started = self.clock.at - 700
        self.duration = 600
        self.enabled = {'Network.enable', 'CPUProfiler.startTracking', 'Memory.enable', 'Memory.startTracking'}
        self.wrong_document = False

    async def command(self, method, timeout=3, **params):
        value = await super().command(method, timeout, **params)
        if method == 'Memory.disable' and getattr(self, 'memory_error', None):
            error = RuntimeError('Memory.disable protocol error: -32000')
            error.code, error.message = -32000, self.memory_error
            raise error
        return value

    async def evaluate(self, source, timeout=3):
        if 'owned-recovery' not in source:
            return await super().evaluate(source, timeout)
        if self.wrong_document:
            return {'wrongDocument': True}
        value = await super().evaluate(source, timeout)
        if 'api["result"]' in source:
            value.update(finished=True, state=self.status()['state'])
        return {'value': value, 'timeOrigin': 2}


class RecoveryAdapterTests(unittest.IsolatedAsyncioTestCase):
    assert_owner_retained = OwnedAdapterTests.assert_owner_retained

    def setUp(self):
        OwnedAdapterTests.setUp(self)
        self.recovery_options = {}
        def wire(*_, **__):
            value = RecoveryWire(self.clock, self.recorders[-1], self.stop, self.work, self.started)
            for key, item in self.recovery_options.items():
                setattr(value, key, item)
            self.wires.append(value)
            return value
        recover = adapter.recover_recorded
        async def recovery(*args, **kwargs):
            return await recover(*args, **kwargs, sleep=self.clock.sleep)
        self.stack.enter_context(mock.patch.object(adapter.core, 'Wire', wire))
        self.stack.enter_context(mock.patch.object(adapter, 'recover_recorded', recovery))
        self.prior = {'run': {'token': 'original-probe-token', 'calibration': {'origin': 1}},
                      'releaseCheck': {'expected': {'sha256': self.settings.entry.sha256, 'bytes': self.settings.entry.bytes}}}
        (self.work / 'prior-result.json').write_text(json.dumps(self.prior))

    async def test_existing_terminal_result_is_persisted_before_disposal_without_initialization(self):
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'recovered')
        self.assertEqual(result['run']['result']['saved'], {'page': 46})
        self.assertTrue(result['run']['result']['restorationExact'])
        self.assertEqual(result['run']['observedTimeOrigin'], 2)
        self.assertFalse(result['run']['recordingContinuity'])
        self.assertEqual(self.wires[0].prepares, 0)
        self.assertEqual(self.wires[0].starts, 0)
        self.assertTrue(self.wires[0].disposed and self.wires[0].result_persisted)
        self.assertFalse(self.wires[0].enabled)
        self.assertEqual(json.loads((self.work / 'prior-result.json').read_text()), self.prior)
        self.assert_owner_retained(result)

    async def test_invalid_operation_cannot_fall_back_to_a_new_workload(self):
        with self.assertRaisesRegex(ValueError, 'Unknown owned operation'):
            await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='invalid')
        self.assertFalse(self.wires)

    async def test_exact_already_disabled_memory_error_is_idempotent_after_reconnection(self):
        self.recovery_options['memory_error'] = 'Memory domain already disabled'
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'recovered')
        self.assertFalse(result['run']['cleanupErrors'])
        event = next(row for row in self.recorders[0].domain_events if row['method'] == 'Memory.disable')
        self.assertTrue(event['alreadyDisabled'])
        self.assert_owner_retained(result)

    async def test_other_memory_protocol_error_remains_a_cleanup_failure(self):
        self.recovery_options['memory_error'] = 'Memory backend unavailable'
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(result['run']['cleanupErrors']), 1)
        self.assertTrue(result['run']['probeDisposed'])
        self.assert_owner_retained(result)

    async def test_running_probe_gets_one_stop_and_lease_neutral_poll_after_lost_ack(self):
        self.recovery_options.update(started=self.clock.at, lose_stop='after')
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'recovered')
        self.assertEqual(result['run']['stopAcknowledgementError']['type'], 'TimeoutError')
        calls = [name for name, _ in self.wires[0].calls]
        self.assertEqual(calls.count('stop'), 1)
        self.assertNotIn('heartbeat', calls)
        self.assertTrue(result['run']['result']['restorationExact'])
        self.assert_owner_retained(result)

    async def test_wrong_document_does_not_stop_or_dispose_a_probe_or_disable_domains(self):
        self.recovery_options['wrong_document'] = True
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'failed')
        self.assertIn('original owned page', result['run']['error']['message'])
        self.assertFalse(self.wires[0].disposed)
        self.assertEqual(len(self.wires[0].enabled), 4)
        self.assertFalse(result['run']['cleanupErrors'])
        self.assert_owner_retained(result)

    async def test_failed_terminal_persistence_preserves_the_page_report(self):
        atomic_json = adapter.core.atomic_json
        failed = False
        def persist(path, value):
            nonlocal failed
            if path.name == 'owned-result.json' and value.get('run', {}).get('result') and not failed:
                failed = True
                raise OSError('receipt write failed')
            return atomic_json(path, value)
        self.stack.enter_context(mock.patch.object(adapter.core, 'atomic_json', persist))
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['run']['error']['type'], 'OSError')
        self.assertFalse(self.wires[0].disposed)
        self.assertFalse(self.wires[0].enabled)
        self.assert_owner_retained(result)

    async def test_nonterminal_probe_has_bounded_recovery_without_reinitialization(self):
        self.recovery_options.update(started=self.clock.at, never_finish=True)
        result = await adapter.run_owned(self.session, self.inspector, self.settings, 'owned', self.stop, operation='recover', receipt_prefix='prior')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['run']['error']['type'], 'TimeoutError')
        self.assertLessEqual(result['elapsedSeconds'], 60)
        self.assertEqual(self.wires[0].starts, 0)
        self.assertFalse(self.wires[0].disposed)
        self.assertFalse(self.wires[0].enabled)
        self.assert_owner_retained(result)


if __name__ == '__main__':
    unittest.main()
