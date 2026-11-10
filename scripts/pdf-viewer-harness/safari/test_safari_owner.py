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

    async def start(self, **options):
        self.owner.publish()
        owner_module.submit(self.settings.work, {'id': 'run-one', 'action': 'run', 'prefix': 'recording', **options})
        request = self.owner.consume()
        self.assertFalse((self.owner.control / 'request.json').exists())
        await self.owner.handle(request)
        await self.started.wait()

    async def test_command_is_consumed_before_one_invocation_and_cannot_be_resubmitted(self):
        await self.start()
        with self.assertRaises(FileExistsError):
            owner_module.submit(self.settings.work, {'id': 'run-one', 'action': 'run', 'prefix': 'other'})
        self.assertEqual(len(self.calls), 1)

    async def test_short_page_pair_reaches_the_owned_operation(self):
        await self.start(scenario='short', pages=[101, 102])
        self.assertEqual(len(self.calls), 1)
        self.assertIs(self.calls[0][0], self.session)
        self.assertEqual(self.calls[0][4]['pages'], [101, 102])

    async def test_page_pair_outside_the_document_is_rejected_before_a_job_starts(self):
        operation = self.owner.operation = mock.AsyncMock(return_value={'status': 'passed', 'attached': True})
        request = {'id': 'out-of-range', 'action': 'run', 'prefix': 'recording', 'scenario': 'short',
                   'pages': [1, self.settings.document.pages + 1]}
        with self.assertRaisesRegex(ValueError, 'page'):
            await self.owner.start_operation(request)
        operation.assert_not_called()
        self.assertIsNone(self.owner.job)
        self.inspector.open_app.assert_not_awaited()

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

    def test_explicit_short_pages_round_trip_from_cli_to_the_command_file(self):
        with tempfile.TemporaryDirectory() as directory:
            control = pathlib.Path(directory) / 'owner'
            control.mkdir()
            (control / 'state.json').write_text('{}')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(owner_module.main(['command', '--execute', '--work-dir', directory,
                    '--id', 'explicit-pages', 'run', '--prefix', 'recording', '--scenario', 'short',
                    '--pages', '101', '102']), 0)
            request = json.loads((control / 'request.json').read_text())
            self.assertEqual(request['pages'], [101, 102])
            self.assertEqual(request['scenario'], 'short')
            self.assertEqual(request['seconds'], 60)

    def test_page_pairs_are_strict_and_belong_only_to_short_runs(self):
        request = {'id': 'one', 'action': 'run', 'prefix': 'run', 'scenario': 'short', 'pages': [101, 102]}
        accepted = owner_module.command_request(request)
        self.assertEqual(accepted['pages'], request['pages'])
        self.assertIsNot(accepted['pages'], request['pages'])
        for pages in (None, [], [1], [1, 2, 3], [1, 1], [0, 2], [-1, 2], [True, 2],
                      [1.0, 2], ['1', 2], [1, 2 ** 53], '1,2', (1, 2), {'first': 1, 'second': 2}):
            with self.subTest(pages=pages), self.assertRaises(ValueError):
                owner_module.command_request({**request, 'pages': pages})
        for scenario in ('sustained', 'traverse', 'manual'):
            with self.subTest(scenario=scenario), self.assertRaises(ValueError):
                owner_module.command_request({**request, 'scenario': scenario})


class ProbeReadinessTests(unittest.TestCase):
    def test_actual_readiness_reports_each_probe_and_aggregate(self):
        script = """const vm=require('node:vm');const source=JSON.parse(process.argv[1]);
const names=['__spomenarSustainedProbe','__spomenarManualProbe','__spomenarSidecarProbe'];
const results=[null,...names].map(name=>{const window={};if(name)window[name]={};return vm.runInNewContext(source,{window,document:{activeElement:null,visibilityState:'visible',hasFocus:()=>false},getSelection:()=>null,location:{href:'https://example.test/'},navigator:{}});});process.stdout.write(JSON.stringify(results));"""
        result = subprocess.run(['node', '-e', script, json.dumps(owner_module.READINESS)], check=True, capture_output=True, text=True)
        values = json.loads(result.stdout)
        self.assertFalse(values[0]['probePresent'])
        for index, name in enumerate(['sustained', 'manual', 'short'], 1):
            self.assertTrue(values[index]['probePresent'])
            self.assertEqual(values[index]['probes'], {key: key == name for key in ['sustained', 'manual', 'short']})
