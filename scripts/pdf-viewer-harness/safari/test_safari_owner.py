"""Offline command ownership, retained connection and explicit setup boundaries."""
import asyncio
import contextlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

import safari_owner as owner_module
from test_support import DOCUMENT, settings


class OwnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings = settings(pathlib.Path(self.directory.name))
        self.receiver = asyncio.create_task(asyncio.sleep(3600))
        self.session = types.SimpleNamespace(target_id='owned-target', _receive_task=self.receiver,
            protocol=types.SimpleNamespace(id_='session', app=types.SimpleNamespace(id_='app'), page=types.SimpleNamespace(id_='page')))
        self.inspector = types.SimpleNamespace(open_app=mock.AsyncMock(), close=mock.AsyncMock(),
            teardown_inspector_socket=mock.AsyncMock(), application_pages={}, connected_application={})
        self.started = asyncio.Event()
        self.calls = []
        async def operation(session, inspector, configured, prefix, stop, **options):
            self.calls.append((session, inspector, configured, prefix, options))
            self.assertTrue((self.owner.control / 'run-one-accepted.json').exists())
            self.started.set()
            await stop.wait()
            return {'status': 'interrupted', 'attached': True}
        self.owner = owner_module.Owner(self.settings, self.inspector, session=self.session, operation=operation)
        self.stdout = contextlib.redirect_stdout(io.StringIO())
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    async def asyncTearDown(self):
        self.owner.stop_event.set()
        if self.owner.job:
            await self.owner.job
        self.receiver.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.receiver

    async def start(self):
        self.owner.publish()
        owner_module.submit(self.settings.work, {'id': 'run-one', 'action': 'run', 'prefix': 'recording'})
        request = self.owner.consume()
        self.assertFalse((self.owner.control / 'request.json').exists())
        await self.owner.handle(request)
        await self.started.wait()

    async def test_command_is_consumed_before_one_invocation_and_cannot_be_resubmitted(self):
        await self.start()
        with self.assertRaises(FileExistsError):
            owner_module.submit(self.settings.work, {'id': 'run-one', 'action': 'run', 'prefix': 'other'})
        self.assertEqual(len(self.calls), 1)

    async def test_running_status_is_cached_and_stop_does_not_issue_competing_native_calls(self):
        await self.start()
        with mock.patch.object(self.owner, 'readiness', new_callable=mock.AsyncMock) as readiness:
            await self.owner.handle({'id': 'status-one', 'action': 'status'})
            await self.owner.handle({'id': 'stop-one', 'action': 'stop'})
            readiness.assert_not_awaited()
        self.assertTrue(self.owner.stop_event.is_set())
        self.assertFalse(self.owner.closing.is_set())
        self.inspector.open_app.assert_not_awaited()

    async def test_busy_owner_rejects_resume_or_second_operation_without_replacing_job(self):
        await self.start()
        job = self.owner.job
        for request in ({'id': 'resume-one', 'action': 'resume'},
                        {'id': 'another', 'action': 'run', 'prefix': 'other'}):
            with self.assertRaisesRegex(RuntimeError, 'already owns native RPCs'):
                await self.owner.handle(request)
        self.assertIs(self.owner.job, job)
        self.inspector.open_app.assert_not_awaited()

    async def test_close_drains_work_but_owner_class_retains_supplied_connection(self):
        await self.start()
        await self.owner.handle({'id': 'close-one', 'action': 'close'})
        await self.owner.job
        with mock.patch.object(self.owner, 'readiness', new_callable=mock.AsyncMock, return_value={'available': True}):
            await self.owner.serve(asyncio.Queue())
        self.assertIsNone(self.owner.job)
        self.assertFalse(self.receiver.done())
        self.inspector.close.assert_not_awaited()
        self.inspector.teardown_inspector_socket.assert_not_awaited()

    async def test_post_run_readiness_timeout_retains_service_and_records_the_failure(self):
        await self.start()
        self.owner.stop_event.set()
        await self.owner.job
        wire = types.SimpleNamespace(evaluate=mock.AsyncMock(side_effect=TimeoutError('suspended page')))
        with mock.patch.object(owner_module.core, 'Wire', return_value=wire):
            await self.owner.finish_job()
        self.assertFalse(self.owner.state['reader']['available'])
        self.assertTrue(self.owner.state['attached'])
        self.assertFalse(self.receiver.done())
        self.inspector.close.assert_not_awaited()

    async def test_resume_uses_same_service_and_reports_changed_target(self):
        async def resume(bundle, timeout):
            self.assertEqual((bundle, timeout), (owner_module.SAFARI, 5))
            self.session.target_id = 'resumed-target'
        self.inspector.open_app.side_effect = resume
        with mock.patch.object(self.owner, 'readiness', new_callable=mock.AsyncMock, return_value={'available': True}):
            await self.owner.handle({'id': 'resume-one', 'action': 'resume'})
        self.inspector.open_app.assert_awaited_once()
        self.assertTrue(self.owner.state['resumeTargetChanged'])
        self.assertIs(self.owner.session, self.session)

    async def test_attach_requires_unique_exact_free_existing_reader(self):
        app = types.SimpleNamespace(bundle=owner_module.SAFARI)
        page = types.SimpleNamespace(web_url=DOCUMENT.page_url + '#page=46', web_connection_id=None)
        self.inspector.connected_application = {'app': app}
        self.inspector.application_pages = {'app': {'one': page, 'two': page}}
        self.inspector.inspector_session = mock.AsyncMock(return_value=self.session)
        self.assertFalse(await self.owner.attach_existing())
        self.inspector.application_pages['app'].pop('two')
        page.web_connection_id = 'another-inspector'
        self.assertFalse(await self.owner.attach_existing())
        self.inspector.inspector_session.assert_not_awaited()
        page.web_connection_id = None
        with mock.patch.object(self.owner, 'readiness', new_callable=mock.AsyncMock, return_value={'available': True}):
            self.assertTrue(await self.owner.attach_existing())
        self.inspector.inspector_session.assert_awaited_once_with(app, page)

    async def test_invalid_request_is_consumed_as_rejected_without_closing_owner(self):
        (self.owner.control / 'request.json').write_text('{"id":"bad","action":"run","prefix":"../outside"}')
        self.assertIsNone(self.owner.consume())
        self.assertFalse((self.owner.control / 'request.json').exists())
        self.assertEqual(len(list(self.owner.control.glob('rejected-*.json'))), 1)
        self.assertFalse(self.owner.closing.is_set())

    async def test_explicit_socket_cleanup_joins_receiver_once(self):
        errors = await owner_module.close_session(self.inspector, self.session)
        self.assertFalse(errors)
        self.assertTrue(self.receiver.done())
        self.inspector.teardown_inspector_socket.assert_awaited_once_with('session', 'app', 'page')

    async def test_borrowed_owner_keeps_original_session_when_its_receiver_ends(self):
        borrowed = owner_module.Owner(self.settings, self.inspector, session=self.session, allow_reattach=False)
        self.receiver.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.receiver
        async def end_iteration():
            borrowed.closing.set()
            return None
        await borrowed.serve(types.SimpleNamespace(get=end_iteration))
        self.assertIs(borrowed.session, self.session)
        self.assertEqual(borrowed.state['status'], 'borrowed-session-unavailable')
        self.assertFalse(borrowed.state['attached'])
        self.inspector.teardown_inspector_socket.assert_not_awaited()


class OwnerCliTests(unittest.TestCase):
    def test_no_argument_invocation_is_inert_without_runtime_or_settings(self):
        result = subprocess.run([sys.executable, '-B', owner_module.__file__], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)['status'], 'inert')
        self.assertNotIn('pymobiledevice3', sys.modules)

    def test_command_schema_does_not_silently_downgrade_invalid_live_requests(self):
        for value in ({'id': 'one', 'action': 'run', 'prefix': 'run', 'seconds': 601},
                      {'id': 'one', 'action': 'status', 'prefix': 'unexpected'},
                      {'id': 'one', 'action': 'recover', 'prefix': 'run'},
                      {'id': 'one', 'action': 'run', 'prefix': 'run', 'scenario': 'manual', 'seconds': 600},
                      {'id': 'one', 'action': 'run', 'prefix': 'run', 'scenario': 'short', 'startMode': 'tap'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                owner_module.command_request(value)

    def test_each_scenario_uses_its_explicit_supported_default_duration(self):
        for scenario, seconds in [('sustained', 600), ('traverse', 60), ('short', 60), ('manual', 120)]:
            value = owner_module.command_request({'id': 'one', 'action': 'run', 'prefix': 'run', 'scenario': scenario})
            self.assertEqual(value['seconds'], seconds)
