"""Offline tests for the actual sustained host recorder; devices are never imported."""
import asyncio
import contextlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
from urllib.parse import urljoin

import safari_runner as runner
from test_support import DOCUMENT

FILE = pathlib.Path(runner.__file__)
BOOK = DOCUMENT.pdf_url
JS = 'async options => ({token:options.token,state:"preparing"})'


class Clock:
    def __init__(self):
        self.at = 100.0
        self.advance = None

    def now(self):
        return self.at

    async def sleep(self, seconds):
        self.at += seconds
        if self.advance:
            self.advance()
        await asyncio.sleep(0)


def memory(recorder, size, stamp):
    recorder.memory_update({'params': {'event': {'timestamp': stamp,
        'categories': [{'type': 'javascript', 'size': size}]}}})


def cpu(recorder, usage, stamp):
    recorder.cpu_update({'params': {'event': {'timestamp': stamp, 'usage': usage,
        'threads': [{'type': 'main', 'usage': usage / 2}, {'type': 'webkit', 'usage': usage / 4}]}}})


def request(recorder, identifier, start=0, end=9, url=BOOK):
    recorder.requested({'params': {'requestId': identifier, 'request': {
        'url': url, 'method': 'GET', 'headers': {'Range': f'bytes={start}-{end}', 'If-Range': '"edition"'}}}})


def response(recorder, identifier, start=0, end=9, source='network', **overrides):
    value = {'url': BOOK, 'status': 206, 'source': source, 'headers': {
        'Content-Range': f'bytes {start}-{end}/{DOCUMENT.bytes}',
        'Content-Length': str(end - start + 1), 'ETag': '"edition"'}}
    value.update(overrides)
    recorder.responded({'params': {'requestId': identifier, 'response': value}})


def data(recorder, identifier, decoded, encoded):
    recorder.data_received({'params': {'requestId': identifier, 'dataLength': decoded, 'encodedDataLength': encoded}})


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.recorder = runner.Recorder(self.clock.now, document=DOCUMENT, limits={'memory': 2, 'cpu': 2, 'requests': 1})

    def test_full_run_peaks_counts_and_gaps_survive_raw_rollover(self):
        for size, usage, delta in [(500, 99, 0), (100, 3, .5), (50, 4, 7)]:
            self.clock.at += delta
            memory(self.recorder, size, self.clock.at)
            cpu(self.recorder, usage, self.clock.at)
        result = self.recorder.snapshot()
        self.assertEqual([x['totalBytes'] for x in result['raw']['memory']], [100, 50])
        self.assertEqual(result['memory']['peakBytes'], 500)
        self.assertEqual(result['memory']['categoryPeaks']['javascript'], 500)
        self.assertEqual(result['cpu']['peakPercent'], 99)
        self.assertEqual(result['memory']['samples'], 3)
        self.assertEqual(result['rawDropped']['memory'], 1)
        self.assertEqual(result['memory']['maxHostGapMs'], 7000)
        self.assertEqual(result['cpu']['maxNativeGapMs'], 7000)
        self.assertAlmostEqual(result['cpu']['sampleWeightedCpuSeconds'], .5 * .03 + 7 * .04)

    def test_pending_request_survives_raw_rollover_and_completes(self):
        request(self.recorder, 'old')
        response(self.recorder, 'old')
        for name in ['second', 'third']:
            request(self.recorder, name)
            response(self.recorder, name)
            data(self.recorder, name, 10, 10)
            self.recorder.finish(name)
        self.assertIn('old', self.recorder.inflight)
        self.assertEqual(len(self.recorder.raw['requests']), 1)
        data(self.recorder, 'old', 10, 10)
        self.recorder.finish('old')
        self.assertEqual(self.recorder.net['completed'], 3)
        self.assertEqual(self.recorder.net['decodedDataBytes'], 30)
        self.assertEqual(self.recorder.net['encodedDataBytes'], 30)
        self.assertEqual(self.recorder.net['rangeResponsesChecked'], 3)
        self.assertEqual(self.recorder.net['rangeFailures'], 0)
        self.assertFalse(self.recorder.inflight)

    def test_unavailable_data_is_not_filled_from_content_length(self):
        request(self.recorder, 'one', 0, 131071)
        response(self.recorder, 'one', 0, 131071)
        self.recorder.finish('one')
        self.assertEqual(self.recorder.net['advertisedBodyBytes'], 131072)
        self.assertEqual(self.recorder.net['dataEvents'], 0)
        self.assertEqual(self.recorder.net['encodedDataBytes'], 0)
        self.assertEqual(self.recorder.raw['requests'][0]['rangeValidation'], 'headers-valid')

    def test_chunk_bytes_and_completion_metrics_are_separate(self):
        request(self.recorder, 'one')
        response(self.recorder, 'one')
        data(self.recorder, 'one', 10, 10)
        self.recorder.finish('one', metrics={'responseBodyBytesReceived': 10, 'responseBodyDecodedSize': 10})
        self.assertEqual(self.recorder.net['encodedDataBytes'], 10)
        self.assertEqual(self.recorder.net['metrics.responseBodyBytesReceived'], 10)
        self.assertEqual(self.recorder.net['advertisedBodyBytes'], 10)
        self.assertEqual(self.recorder.raw['requests'][0]['rangeValidation'], 'body-valid')

    def test_saved_one_mib_range_keeps_delivered_bytes_authoritative_over_doubled_metric(self):
        identifier, start, end = '0.38024', 114819072, 115867647
        request(self.recorder, identifier, start, end)
        response(self.recorder, identifier, start, end)
        data(self.recorder, identifier, 1048576, 1049728)
        self.recorder.finish(identifier, metrics={
            'responseBodyDecodedSize': 2097152, 'responseBodyBytesReceived': 1049728})
        entry = self.recorder.raw['requests'][0]
        self.assertEqual(entry['rangeValidation'], 'body-valid')
        self.assertEqual(entry['bodyValidationSource'], 'dataReceived')
        self.assertEqual(entry['decodedMetricDiscrepancy'], {
            'reportedBytes': 2097152, 'expectedBytes': 1048576, 'dataReceivedBytes': 1048576})
        self.assertEqual(entry['metrics']['responseBodyDecodedSize'], 2097152)
        self.assertEqual(self.recorder.net['decodedDataBytes'], 1048576)
        self.assertEqual(self.recorder.net['encodedDataBytes'], 1049728)
        self.assertEqual(self.recorder.counts['errors'], 0)
        self.assertEqual(self.recorder.net['rangeFailures'], 0)
        request(self.recorder, 'later')
        response(self.recorder, 'later')
        data(self.recorder, 'later', 10, 10)
        self.recorder.finish('later', metrics={'responseBodyDecodedSize': 10})
        self.assertEqual(self.recorder.net['decodedMetricDiscrepancies'], 1, 'full-span discrepancy survives raw rollover')
        self.assertEqual(self.recorder.raw['requests'][0]['id'], 'later')
        self.assertEqual(self.recorder.net['rangeBodiesChecked'], 2)
        self.assertEqual(self.recorder.net['rangeBodiesUnobserved'], 0)
        self.assertEqual(self.recorder.by_kind['pdf']['rangeBodiesChecked'], 2)
        self.assertEqual(self.recorder.by_source['network']['rangeBodiesChecked'], 2)

    def test_matching_metric_cannot_hide_a_short_delivered_body(self):
        request(self.recorder, 'short')
        response(self.recorder, 'short')
        data(self.recorder, 'short', 9, 10)
        self.recorder.finish('short', metrics={'responseBodyDecodedSize': 10})
        entry = self.recorder.raw['requests'][0]
        self.assertEqual(entry['rangeValidation'], 'failed')
        self.assertEqual(entry['bodyValidationSource'], 'dataReceived')
        self.assertEqual(self.recorder.net['rangeFailures'], 1)
        self.assertEqual(self.recorder.counts['errors'], 1)
        self.assertEqual(self.recorder.net['decodedMetricDiscrepancies'], 1)
        self.assertEqual(self.recorder.net['rangeBodiesChecked'], 1)

    def test_invalid_data_length_marks_this_request_incomplete_without_metric_substitution(self):
        request(self.recorder, 'incomplete')
        response(self.recorder, 'incomplete')
        data(self.recorder, 'incomplete', None, 0)
        data(self.recorder, 'incomplete', 10, 10)
        self.recorder.finish('incomplete', metrics={'responseBodyDecodedSize': 10})
        entry = self.recorder.raw['requests'][0]
        self.assertEqual(entry['unknownDataLengthEvents'], 1)
        self.assertEqual(entry['rangeValidation'], 'headers-valid')
        self.assertEqual(entry['bodyValidationSource'], 'headers-only')
        self.assertEqual(self.recorder.net['unknownDataLengthEvents'], 1)
        self.assertEqual(self.recorder.net['rangeBodiesChecked'], 0)
        self.assertEqual(self.recorder.net['rangeBodiesUnobserved'], 1)
        self.assertEqual(self.recorder.by_kind['pdf']['rangeBodiesUnobserved'], 1)
        self.assertEqual(self.recorder.by_source['network']['rangeBodiesUnobserved'], 1)

    def test_metric_only_request_retains_header_validation_and_summary_discrepancy(self):
        request(self.recorder, 'metric-only')
        response(self.recorder, 'metric-only')
        self.recorder.finish('metric-only', metrics={'responseBodyDecodedSize': 20})
        entry = self.recorder.raw['requests'][0]
        self.assertEqual(entry['rangeValidation'], 'headers-valid')
        self.assertEqual(entry['bodyValidationSource'], 'headers-only')
        self.assertEqual(entry['decodedMetricDiscrepancy']['dataReceivedBytes'], None)
        self.assertEqual(self.recorder.net['decodedMetricDiscrepancies'], 1)
        self.assertEqual(self.recorder.counts['errors'], 0)
        self.assertEqual(self.recorder.net['rangeBodiesChecked'], 0)
        self.assertEqual(self.recorder.net['rangeBodiesUnobserved'], 1)

    def test_memory_cache_and_unrelated_urls_keep_distinct_evidence(self):
        self.recorder.memory_cached({'params': {'requestId': 'cached', 'resource': {
            'url': BOOK, 'bodySize': 10, 'response': {'status': 206, 'headers': {'Content-Length': '10'}}}}})
        request(self.recorder, 'unrelated', url='https://example.com/private')
        data(self.recorder, 'unrelated', 123, 100)
        self.assertEqual(self.recorder.by_source['memory-cache']['cachedBodyBytes'], 10)
        self.assertEqual(self.recorder.net['rangeRequestUnobserved'], 1)
        self.assertEqual(self.recorder.net['unattributedDataEvents'], 1)
        self.assertEqual(self.recorder.net['encodedDataBytes'], 0)
        self.assertFalse(self.recorder.inflight)

    def test_pdf_mismatch_is_recorded_and_missing_response_is_not_validated(self):
        request(self.recorder, 'bad')
        response(self.recorder, 'bad', status=200, headers={'Content-Range': f'bytes 1-10/{DOCUMENT.bytes}',
            'Content-Length': '10', 'Content-Encoding': 'gzip', 'ETag': '"other"'})
        self.recorder.finish('bad')
        self.assertGreaterEqual(self.recorder.net['rangeFailures'], 4)
        request(self.recorder, 'missing')
        self.recorder.finish('missing')
        self.assertEqual(self.recorder.net['pdfResponsesMissing'], 1)
        self.assertGreater(self.recorder.counts['errors'], 0)

    def test_cancelled_partial_range_keeps_bytes_without_false_body_failure(self):
        request(self.recorder, 'partial')
        response(self.recorder, 'partial')
        data(self.recorder, 'partial', 4, 4)
        self.recorder.finish('partial', failed=True, canceled=True)
        self.assertEqual(self.recorder.net['canceled'], 1)
        self.assertEqual(self.recorder.net['decodedDataBytes'], 4)
        self.assertEqual(self.recorder.net['rangeFailures'], 0)

    def test_pending_overflow_preserves_the_owned_older_request(self):
        recorder = runner.Recorder(self.clock.now, document=DOCUMENT, pending_limit=1)
        request(recorder, 'first')
        request(recorder, 'second')
        self.assertEqual(list(recorder.inflight), ['first'])
        self.assertEqual(recorder.net['pendingOverflow'], 1)
        self.assertEqual(recorder.counts['errors'], 1)

    def test_callbacks_restore_previous_owners_and_contain_bad_events(self):
        old = lambda _: None
        handlers = {'CPUProfiler.trackingUpdate': old}
        self.recorder.install(handlers, {'events': [{'name': 'dataReceived'}]})
        handlers['Memory.trackingUpdate']({'params': {'event': {}}})
        self.assertEqual(self.recorder.counts['errors'], 1)
        self.assertTrue(self.recorder.capabilities['dataReceivedAdvertised'])
        self.recorder.uninstall(handlers)
        self.assertEqual(handlers, {'CPUProfiler.trackingUpdate': old})

    def test_inert_entry_does_not_import_the_device_runtime(self):
        result = subprocess.run([sys.executable, '-B', str(FILE)], capture_output=True, text=True, check=True)
        value = json.loads(result.stdout)
        self.assertEqual(value['status'], 'inert')
        self.assertEqual(value['liveEntryPoint'], 'safari_owner.py')
        self.assertNotIn('pymobiledevice3', sys.modules)

    def test_cli_duration_matches_the_workload_initializer(self):
        self.assertEqual(runner.parse_args(['--seconds', '600']).seconds, 600)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            runner.parse_args(['--seconds', '601'])

    def test_versioned_preview_manifest_and_assets_are_owned_preview_traffic(self):
        # Saved site config for the current 460-page source uses this relative URL.
        manifest = urljoin('https://cloud.larics.fer.hr/spomenar/',
            './previews/6abb3d0b13d2970bca0f613287a6ea5d30280be14435b5c681b8ca8bd61d24d0/manifest.json')
        self.assertEqual(runner.owned_kind(manifest, DOCUMENT), 'preview')
        self.assertEqual(runner.owned_kind(urljoin(manifest, 'assets/p00099-512-' + 'a' * 64 + '.jpg'), DOCUMENT), 'preview')
        self.assertEqual(runner.owned_kind(BOOK, DOCUMENT), 'pdf')
        self.assertIsNone(runner.owned_kind(manifest.replace('cloud.larics.fer.hr', 'example.com'), DOCUMENT))


class FakeWire:
    def __init__(self, clock, recorder, stop_event, *, duration=6, lose_initial=False,
                 never_finish=False, bad_restore=False, fail_begin=None, signal_at=None, silent_cpu=False,
                 lose_stop=None, frontend_error=False, prepare_failure=False,
                 stop_during_prepare=False, prepare_elapsed=0, fail_heartbeat_after=None):
        self.clock, self.recorder, self.stop_event = clock, recorder, stop_event
        self.duration, self.lose_initial, self.never_finish = duration, lose_initial, never_finish
        self.bad_restore, self.fail_begin, self.signal_at = bad_restore, fail_begin, signal_at
        self.silent_cpu = silent_cpu
        self.lose_stop, self.frontend_error = lose_stop, frontend_error
        self.prepare_failure = prepare_failure
        self.stop_during_prepare, self.prepare_elapsed = stop_during_prepare, prepare_elapsed
        self.fail_heartbeat_after, self.heartbeats, self.rpc_lost = fail_heartbeat_after, 0, False
        self.prepares = 0
        self.commands = []
        self.calls = []
        self.enabled = set()
        self.starts = 0
        self.token = None
        self.started = None
        self.stopped = None
        self.disposed = False
        self.result_persisted = False
        clock.advance = self.tick

    def status(self):
        elapsed = 0 if self.started is None else self.clock.at - self.started
        boundary = self.stopped if self.stopped is not None else (self.started or self.clock.at) + self.duration
        finished = not self.never_finish and self.clock.at >= boundary + 3
        restoring = self.clock.at >= boundary
        state = ('interrupted' if self.stopped is not None else 'completed') if finished else 'restoring' if restoring else 'running'
        return {'ok': True, 'token': self.token, 'state': state, 'phase': state, 'elapsedMs': elapsed * 1000,
                'scrollMs': min(elapsed, self.duration) * 1000, 'dwellMs': 0,
                'finished': finished, 'restored': finished and not self.bad_restore, 'observersRemoved': finished,
                'clientCheckpoint': {'sampleCount': round(elapsed * 2), 'frames': {'count': round(elapsed * 60)},
                    'peaks': {'previewBytes': 999}, 'current': {'page': 46}}}

    def tick(self):
        if self.signal_at is not None and self.started is not None and self.clock.at - self.started >= self.signal_at:
            self.stop_event.set()
        value = 700 if self.started is not None and self.status()['phase'] == 'restoring' else 100
        if 'Memory.startTracking' in self.enabled:
            memory(self.recorder, value, self.clock.at)
        if 'CPUProfiler.startTracking' in self.enabled and not self.silent_cpu:
            cpu(self.recorder, value / 10, self.clock.at)

    async def command(self, method, timeout=3, **params):
        self.commands.append(method)
        self.calls.append((method, self.clock.at))
        if method in ('Network.enable', 'CPUProfiler.startTracking', 'Memory.enable', 'Memory.startTracking'):
            self.enabled.add(method)
        else:
            begin = {'Network.disable': 'Network.enable', 'CPUProfiler.stopTracking': 'CPUProfiler.startTracking',
                     'Memory.disable': 'Memory.enable', 'Memory.stopTracking': 'Memory.startTracking'}.get(method)
            self.enabled.discard(begin)
        if self.fail_begin == method:
            self.fail_begin = None
            raise TimeoutError('Lost recording activation acknowledgement')
        return {}

    async def prepare_initializer(self, source):
        self.prepares += 1
        self.calls.append(('prepare', self.clock.at))
        if source != JS or len(self.enabled) != 4:
            raise AssertionError('Inert preparation must follow recording activation')
        await self.clock.sleep(self.prepare_elapsed)
        if self.stop_during_prepare:
            self.stop_event.set()
        if self.prepare_failure:
            raise TimeoutError('Inert function delivery timed out')
        return 'owned-function'

    async def invoke_initializer(self, handle, config):
        if handle != 'owned-function' or self.starts:
            raise AssertionError('Only the prepared function may be invoked once')
        self.starts += 1
        self.calls.append(('initialize', self.clock.at))
        if len(self.enabled) != 4:
            raise AssertionError('Workload admitted before all recording started')
        self.config = config
        self.token = config['token']
        self.started = self.clock.at
        if self.lose_initial:
            self.lose_initial = False
            raise TimeoutError('Initialization acknowledgement lost after it acted')
        return {**self.status(), 'state': 'preparing'}

    async def evaluate(self, source, timeout=3):
        if source.startswith('({at:performance.now()'):
            return {'at': self.clock.at * 1000, 'origin': 1}
        method = json.loads(re.search(r'api\[("[^"]+")\]', source).group(1))
        arguments = json.loads(re.search(r'\]\(\.\.\.(\[.*\])\)', source).group(1))
        if arguments[0] != self.token:
            return {'ok': False}
        self.calls.append((method, self.clock.at))
        if method == 'heartbeat':
            self.heartbeats += 1
            if self.fail_heartbeat_after is not None and self.heartbeats > self.fail_heartbeat_after:
                self.rpc_lost = True
        if self.rpc_lost:
            raise TimeoutError('WebContent stopped replying')
        if method == 'stop':
            lost = self.lose_stop
            self.lose_stop = None
            if lost == 'before':
                raise TimeoutError('Stop request failed before delivery')
            if self.stopped is None and not self.status()['finished']:
                self.stopped = self.clock.at
            if lost == 'after':
                raise TimeoutError('Stop acted but its acknowledgement was lost')
            return self.status()
        if method == 'result':
            if not self.status()['finished']:
                raise AssertionError('Result read before completion')
            if len(self.enabled) != 4:
                raise AssertionError('Recording stopped before restoration completed')
            config = getattr(self, 'config', {'workloadMs': self.duration * 1000})
            return {'token': self.token, 'finished': True, 'restored': not self.bad_restore, 'restorationExact': not self.bad_restore,
                    'focusRestored': True, 'scenario': 'endurance', 'requestedScrollMs': config['workloadMs'],
                    'scrollMs': config['workloadMs'], 'dwellMs': 12000, 'expectedStages': 12,
                    'stages': [{'endedAt': 1} for _ in range(12)],
                    'restoredViewport': {'visible': True, 'focused': False, 'displayed': True, 'missingPages': []},
                    'idle': {'awake': True, 'observedMs': 1500, 'quiet': True, 'framesAdded': 0},
                    'observersRemoved': True, 'saved': {'page': 46}, 'readingState': {'page': 46},
                    'errors': [{'message': 'Frontend exception'}] if self.frontend_error else []}
        if method == 'dispose':
            if not self.result_persisted:
                raise AssertionError('Terminal report disposed before persistence')
            self.disposed = True
            return {'ok': True, 'token': self.token, 'disposed': True}
        return self.status()


class NativeSession:
    """Only the public send/receive and trace boundary used by the installed library."""
    def __init__(self, inspector, clock):
        self.inspector, self.clock = inspector, clock
        self.target_id = 'owned-page-target'
        self.message_id = 1
        self.protocol = types.SimpleNamespace(id_='owned-session',
            app=types.SimpleNamespace(id_='owned-app'), page=types.SimpleNamespace(id_='owned-page'))
        self.response_methods = {}
        self.calls = []
        self.block_send = self.block_reply = self.fail_prepare = False
        self.prepared_type = 'function'
        self.token = None
        self.require_flush = False
        self.flushed = asyncio.Event()
        self.lose_prepare_reply = self.lose_flush_reply = False
        self.reply_waiters = set()
        self.consumed = []

    async def send_message_to_target(self, message):
        message = {**message, 'id': self.message_id}
        self.message_id += 1
        self.calls.append(message)
        self.clock.at += .001
        self.inspector.trace('bridge->device', self.protocol.id_, {
            'method': 'Target.sendMessageToTarget',
            'params': {'targetId': self.target_id, 'message': json.dumps(message)}})
        if self.block_send:
            await asyncio.Future()
        if self.fail_prepare and message['method'] == 'Runtime.evaluate' and not message['params']['returnByValue']:
            raise TimeoutError()
        if message['params'].get('expression') == 'void 0':
            self.flushed.set()
        self.clock.at += .002
        return message['id']

    def reply(self, identifier):
        call = next(value for value in self.calls if value['id'] == identifier)
        params = call['params']
        if call['method'] == 'Runtime.callFunctionOn':
            self.token = params['arguments'][0]['value']['token']
            value = {'result': {'type': 'object', 'value': {'ok': True, 'token': self.token, 'state': 'preparing'}}}
        elif call['method'] == 'Runtime.evaluate' and not params['returnByValue']:
            value = {'result': {'type': self.prepared_type, 'objectId': 'owned-function-handle'}}
        elif call['method'] == 'Runtime.evaluate':
            value = {'result': {'type': 'object', 'value': {'ok': True, 'token': self.token, 'state': 'running'}}}
        else:
            value = {}
        response = {'method': 'Target.dispatchMessageFromTarget',
            'params': {'targetId': self.target_id, 'message': json.dumps({'id': identifier, 'result': value})}}
        if getattr(self, 'protocol_error', None):
            response['params']['message'] = json.dumps({'id': identifier, 'error': self.protocol_error})
        self.clock.at += .003
        self.inspector.trace('device->bridge', self.protocol.id_, response)
        return response

    async def receive_response_by_id(self, identifier):
        # A wrapper acknowledgement with a colliding numeric ID is not the JS reply.
        self.inspector.trace('device->bridge', self.protocol.id_, {'id': identifier, 'result': {}})
        self.reply_waiters.add(identifier)
        try:
            call = next(value for value in self.calls if value['id'] == identifier)
            prepare = call['method'] == 'Runtime.evaluate' and not call['params']['returnByValue']
            flush = call['params'].get('expression') == 'void 0'
            if self.block_reply or prepare and self.lose_prepare_reply or flush and self.lose_flush_reply:
                await asyncio.Future()
            if prepare and self.require_flush:
                await self.flushed.wait()
            self.consumed.append(identifier)
            return self.reply(identifier)
        finally:
            self.reply_waiters.discard(identifier)


class WireTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()
        self.inspector = types.SimpleNamespace(trace=None)
        self.session = NativeSession(self.inspector, self.clock)
        self.budget = runner.Budget(now=self.clock.now)
        self.wire = runner.Wire(self.session, self.budget)
        self.wire.install_trace(self.inspector)

    async def test_native_protocol_error_preserves_code_message_but_keeps_trace_sanitized(self):
        self.session.protocol_error = {'code': -32000, 'message': 'Memory domain already disabled'}
        with self.assertRaises(RuntimeError) as raised:
            await self.wire.command('Memory.disable')
        self.assertEqual(getattr(raised.exception, 'code', None), -32000)
        self.assertEqual(getattr(raised.exception, 'message', None), 'Memory domain already disabled')
        self.assertEqual(str(raised.exception), 'Memory.disable protocol error: -32000')
        self.assertNotIn('Memory domain already disabled', json.dumps(self.wire.snapshot()))
        self.assertTrue(self.wire.snapshot()['errors'][0]['replyIsError'])

    def test_saved_native_webkit_protocol_supports_call_function_promise_awaiting(self):
        protocol = json.loads(FILE.parent.joinpath('protocol/Runtime.json').read_text())
        command = next(item for item in protocol['commands'] if item['name'] == 'callFunctionOn')
        parameter = next(item for item in command['parameters'] if item['name'] == 'awaitPromise')
        self.assertEqual(parameter['type'], 'boolean')
        self.assertTrue(command['async'])

    async def test_large_source_is_prepared_without_invocation_then_called_once_with_small_options(self):
        handle = await self.wire.prepare_initializer(JS)
        self.assertEqual(handle, 'owned-function-handle')
        self.assertEqual(len(self.session.calls), 2)
        prepare = self.session.calls[0]
        self.assertEqual(prepare['params']['expression'], '(' + JS + ')')
        self.assertFalse(prepare['params']['returnByValue'])
        self.assertEqual(prepare['params']['objectGroup'], runner.OBJECT_GROUP)
        self.assertEqual(self.session.calls[1]['params']['expression'], 'void 0')
        self.assertEqual(self.wire.snapshot()['initial'][1]['purpose'], 'large-source-flush')
        self.assertEqual(self.wire.snapshot()['initial'][0]['timeoutSeconds'], 12)
        options = {'token': 'owned-token', 'workloadMs': 600000, 'leaseMs': 20000}
        self.assertEqual((await self.wire.invoke_initializer(handle, options))['token'], 'owned-token')
        call = self.session.calls[2]
        self.assertEqual(call['method'], 'Runtime.callFunctionOn')
        self.assertEqual(call['params']['objectId'], handle)
        self.assertEqual(call['params']['functionDeclaration'], 'function (options) { return this(options); }')
        self.assertEqual(call['params']['arguments'], [{'value': options}])
        self.assertTrue(call['params']['awaitPromise'])
        self.assertTrue(call['params']['returnByValue'])
        status = await runner.api_call(self.wire, 'status', 'owned-token', self.budget)
        self.assertEqual(status['state'], 'running')
        self.assertEqual([item['method'] for item in self.session.calls],
            ['Runtime.evaluate', 'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.evaluate'])
        self.assertTrue(self.session.calls[3]['params']['returnByValue'])
        self.assertNotIn('async', self.session.calls[3]['params']['expression'])
        self.assertEqual(self.wire.snapshot()['initial'][2]['timeoutSeconds'], 3)

    async def test_target_change_rejects_invocation_of_prepared_handle(self):
        handle = await self.wire.prepare_initializer(JS)
        self.session.target_id = 'replacement-target'
        with self.assertRaisesRegex(RuntimeError, 'bound inspector target changed'):
            await self.wire.invoke_initializer(handle, {'token': 'owned-token'})
        self.assertEqual(len(self.session.calls), 2)
        self.assertFalse(self.wire.snapshot()['targetUnchanged'])

    async def test_send_timeout_has_method_stage_and_forward_boundary(self):
        self.session.block_send = True
        with self.assertRaisesRegex(TimeoutError, 'Runtime.evaluate timed out during sending'):
            await self.wire.command('Runtime.evaluate', timeout=.005, expression='private-source', returnByValue=True)
        row = self.wire.snapshot()['errors'][0]
        self.assertEqual(row['errorType'], 'TimeoutError')
        self.assertIn('forwardedHostMs', row)
        self.assertNotIn('sendCompletedHostMs', row)
        self.assertNotIn('replyReceivedHostMs', row)
        self.assertNotIn('private-source', json.dumps(self.wire.snapshot()))

    async def test_reply_timeout_ignores_wrapper_ack_and_records_a_late_inner_reply(self):
        self.session.block_reply = True
        with self.assertRaisesRegex(TimeoutError, 'Runtime.evaluate timed out during waiting-reply'):
            await self.wire.command('Runtime.evaluate', timeout=.005, expression='({private:"response"})', returnByValue=True)
        row = self.wire.snapshot()['errors'][0]
        self.assertIn('sendCompletedHostMs', row)
        self.assertNotIn('replyReceivedHostMs', row)
        self.session.reply(1)
        self.assertIn('replyReceivedHostMs', row)
        self.assertGreater(row['replyReceivedHostMs'], row['completedHostMs'])
        self.assertEqual(row['outcome'], 'timeout')
        self.assertNotIn('private', json.dumps(self.wire.snapshot()))

    async def test_outer_phase_deadline_retains_nonempty_method_and_inner_stage(self):
        self.session.block_reply = True
        with self.assertRaisesRegex(TimeoutError, 'probe.status Runtime.evaluate timed out'):
            await runner.bounded(self.wire.evaluate('({ok:true})'), self.budget, 'work', .005,
                                 'probe.status Runtime.evaluate')
        row = self.wire.snapshot()['errors'][0]
        self.assertEqual(row['phase'], 'waiting-reply')
        self.assertEqual(row['errorType'], 'CancelledError')

    async def test_trace_rings_are_bounded_with_full_counts_and_original_handler_restored(self):
        self.wire.restore_trace()
        previous = mock.Mock()
        self.inspector.trace = previous
        self.wire.install_trace(self.inspector)
        for _ in range(300):
            await self.wire.evaluate('({private:"not retained"})')
        value = self.wire.snapshot()
        self.assertEqual(value['count'], 300)
        self.assertEqual(value['countsByMethod'], {'Runtime.evaluate': 300})
        self.assertEqual(len(value['initial']), 32)
        self.assertEqual(len(value['recent']), 256)
        self.assertLessEqual(len(self.wire.id_rows), 256)
        self.assertNotIn('not retained', json.dumps(value))
        self.assertEqual(value['traceErrors'], 0)
        self.assertTrue(previous.called)
        self.wire.restore_trace()
        self.assertIs(self.inspector.trace, previous)

    async def test_unexpected_remote_type_is_rejected_before_invocation(self):
        self.session.prepared_type = 'object'
        with self.assertRaisesRegex(RuntimeError, 'function handle'):
            await self.wire.prepare_initializer(JS)
        self.assertEqual(len(self.session.calls), 2)

    async def test_preparation_sends_one_flush_and_consumes_both_replies_without_invocation(self):
        self.session.require_flush = True
        handle = await self.wire.prepare_initializer(JS)
        self.assertEqual(handle, 'owned-function-handle')
        self.assertEqual([call['method'] for call in self.session.calls], ['Runtime.evaluate', 'Runtime.evaluate'])
        self.assertEqual(sorted(self.session.consumed), [1, 2])
        self.assertEqual(self.session.reply_waiters, set())

    async def test_missing_prepare_reply_cancels_its_waiter_after_flush_reply_was_consumed(self):
        self.session.lose_prepare_reply = True
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(.01):
                await self.wire.prepare_initializer(JS)
        self.assertEqual(self.session.consumed, [2])
        self.assertEqual(self.session.reply_waiters, set())
        self.assertEqual(len(self.session.calls), 2)

    async def test_missing_flush_reply_cancels_its_waiter_after_prepare_reply_was_consumed(self):
        self.session.lose_flush_reply = True
        async with asyncio.timeout(.01):
            handle = await self.wire.prepare_initializer(JS)
        self.assertEqual(handle, 'owned-function-handle')
        self.assertEqual(self.session.consumed, [1])
        self.assertEqual(self.session.reply_waiters, set())
        self.assertEqual(len(self.session.calls), 2)

    async def test_authoritative_error_is_not_blocked_by_missing_auxiliary_reply(self):
        self.session.lose_flush_reply = True
        self.session.protocol_error = {'code': -32000, 'message': 'source rejected'}
        with self.assertRaises(runner.NativeProtocolError):
            async with asyncio.timeout(.01):
                await self.wire.prepare_initializer(JS)
        self.assertEqual(self.session.reply_waiters, set())

    async def test_next_command_remains_isolated_after_missing_flush_reply(self):
        self.session.lose_flush_reply = True
        self.assertEqual(await self.wire.prepare_initializer(JS), 'owned-function-handle')
        self.session.lose_flush_reply = False
        await self.wire.command('Memory.enable')
        self.assertEqual(self.session.reply_waiters, set())
        self.assertEqual(len(self.session.calls), 3)

    async def test_auxiliary_send_failure_propagates_without_waiting_for_deadline(self):
        original = self.session.send_message_to_target
        async def send(message):
            if message.get('params', {}).get('expression') == 'void 0':
                raise OSError('auxiliary send failed')
            return await original(message)
        self.session.send_message_to_target = send
        with self.assertRaisesRegex(OSError, 'auxiliary send failed'):
            async with asyncio.timeout(.03):
                await self.wire.prepare_initializer(JS)
        self.assertEqual(self.session.reply_waiters, set())

    async def test_expected_auxiliary_waiter_release_is_not_a_failed_rpc(self):
        self.session.lose_flush_reply = True
        await self.wire.prepare_initializer(JS)
        self.assertEqual(list(self.wire.failed_operations), [])
        self.assertEqual(self.wire.operations[-1]['outcome'], 'owned-release')



class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, *, seconds=6, end_work=None, stop_initially=False,
                       wire_type=FakeWire, probe_options=None, **options):
        clock = Clock()
        recorder = runner.Recorder(clock.now, document=DOCUMENT, limits={'memory': 4, 'cpu': 4})
        stop = asyncio.Event()
        if stop_initially:
            stop.set()
        wire = wire_type(clock, recorder, stop, duration=seconds, **options)
        budget = runner.Budget(seconds, clock.now)
        if end_work is not None:
            budget.ends.update(work=clock.at + end_work, restore=clock.at + end_work + 8,
                               recorders=clock.at + end_work + 12, detach=clock.at + end_work + 15)
        checkpoints, pictures = [], []
        def checkpoint(receipt, _):
            if 'result' in receipt:
                wire.result_persisted = True
            checkpoints.append({'at': clock.at, 'terminal': 'result' in receipt, 'lastStatus': json.loads(json.dumps(receipt.get('lastStatus')))})
        async def screenshot(index, status):
            self.assertFalse(wire.disposed)
            self.assertEqual(len(wire.enabled), 4)
            if index == 4:
                self.assertTrue(wire.result_persisted)
                self.assertTrue(status['finished'])
            pictures.append((index, clock.at))
            wire.calls.append(('screenshot-' + str(index), clock.at))
            return {'index': index, 'phase': status.get('phase')}
        result = await runner.run_recorded(wire, recorder, JS, 'owned', seconds, budget, stop,
                                           checkpoint, screenshot, clock.sleep, options=probe_options)
        return result, wire, recorder, checkpoints, pictures, clock

    async def test_one_recording_spans_workload_restoration_and_terminal_capture(self):
        result, wire, recorder, _, pictures, _ = await self.run_case()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(wire.starts, 1)
        self.assertTrue(result['recordingCoverage']['complete'])
        self.assertEqual(recorder.memory['peakBytes'], 700, 'restoration samples contribute to the full-span peak')
        self.assertGreater(recorder.counts['memory'], len(recorder.raw['memory']))
        self.assertIn(4, [item[0] for item in pictures])
        names = [name for name, _ in wire.calls]
        self.assertLess(names.index('result'), names.index('screenshot-4'))
        self.assertLess(names.index('screenshot-4'), names.index('dispose'))
        self.assertLess(names.index('dispose'), names.index('Memory.stopTracking'))
        for name in ['Network.enable', 'Network.disable', 'CPUProfiler.startTracking', 'CPUProfiler.stopTracking',
                     'Memory.enable', 'Memory.startTracking', 'Memory.stopTracking', 'Memory.disable']:
            self.assertEqual(wire.commands.count(name), 1, name)
        self.assertFalse(wire.enabled)

    async def test_traverse_captures_motion_and_restored_idle_without_delayed_duplicates(self):
        for tap_wait, heartbeat, phases in ((0, 5, ['stage-1', 'stage-2']),
                                            (30, 5, ['stage-1', 'stage-2']),
                                            (0, 10, ['stage-2'])):
            with self.subTest(tap_wait=tap_wait, heartbeat=heartbeat):
                class TraverseWire(FakeWire):
                    def __init__(self, *args, **kwargs):
                        super().__init__(*args, **kwargs)
                        self.duration = tap_wait + 11 + 8 + 4

                    def status(self):
                        value = super().status()
                        motion = value['elapsedMs'] / 1000 - tap_wait
                        value['scrollMs'] = max(0, min(motion, 11)) * 1000
                        if motion < 0:
                            value.update(state='armed', phase='armed')
                        elif motion < 5.5:
                            value['phase'] = 'stage-1'
                        elif motion < 11:
                            value['phase'] = 'stage-2'
                        elif motion < 19:
                            value['phase'] = 'robots-on-idle'
                        elif motion < 23:
                            value['phase'] = 'robots-off-idle'
                        elif value['finished']:
                            value['phase'] = 'finished'
                        return value

                    async def evaluate(self, source, timeout=3):
                        value = await super().evaluate(source, timeout)
                        if 'expectedStages' in value:
                            value.update(scenario='traverse', expectedStages=2, dwellMs=0,
                                stages=[{'endedAt': 1}, {'endedAt': 2}],
                                naturalIdle=[{'robots': enabled, 'quiet': True, 'framesAdded': 0,
                                              'durationMs': duration}
                                             for enabled, duration in ((True, 8000), (False, 4000))])
                        return value

                with mock.patch.object(runner, 'HEARTBEAT_SECONDS', heartbeat):
                    result, wire, _, _, pictures, _ = await self.run_case(
                        seconds=11, wire_type=TraverseWire,
                        probe_options={'scenario': 'traverse', 'startMode': 'tap' if tap_wait else 'immediate'})
                self.assertEqual(result['status'], 'passed')
                self.assertEqual([shot['phase'] for shot in result['screenshots']], phases + ['finished'])
                indices = [index for index, _ in pictures]
                self.assertEqual(len(indices), len(set(indices)), 'a missed threshold must not repeat a capture')
                self.assertEqual(indices[-1], 4)
                self.assertTrue(all(0 < at - wire.started - tap_wait < 11
                                    for index, at in pictures if index != 4))
                self.assertTrue(wire.disposed)
                self.assertFalse(wire.enabled)

    async def test_lost_initial_acknowledgement_uses_the_same_token_without_restarting(self):
        result, wire, *_ = await self.run_case(lose_initial=True)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(wire.starts, 1)
        self.assertEqual(wire.prepares, 1)
        self.assertIn('initializationAcknowledgementError', result)
        self.assertEqual(result['initializationAcknowledgementError']['type'], 'TimeoutError')
        self.assertEqual(result['initializationAcknowledgementError']['stage'], 'initializer-invocation')
        self.assertIn('status', [name for name, _ in wire.calls])

    async def test_prepare_failure_never_invokes_and_stops_recording(self):
        result, wire, *_ = await self.run_case(prepare_failure=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.prepares, 1)
        self.assertEqual(wire.starts, 0)
        self.assertNotIn('initializationAttemptedHostMs', result)
        self.assertIn('prepare inert initializer Runtime.evaluate', result['error']['message'])
        self.assertFalse(wire.enabled)

    async def test_signal_during_inert_preparation_prevents_invocation(self):
        result, wire, *_ = await self.run_case(stop_during_prepare=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.prepares, 1)
        self.assertEqual(wire.starts, 0)
        self.assertEqual(result['stopReason'], 'host-signal-before-initialization')
        self.assertFalse(wire.enabled)

    async def test_elapsed_setup_deadline_prevents_invocation(self):
        result, wire, *_ = await self.run_case(prepare_elapsed=46)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.prepares, 1)
        self.assertEqual(wire.starts, 0)
        self.assertEqual(result['error']['type'], 'TimeoutError')
        self.assertFalse(wire.enabled)

    async def test_signal_stops_once_and_preserves_the_restored_report(self):
        result, wire, recorder, *_ = await self.run_case(seconds=60, signal_at=2)
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(result['stopReason'], 'host-signal')
        self.assertTrue(result['result']['restorationExact'])
        self.assertEqual([name for name, _ in wire.calls].count('stop'), 1)
        self.assertEqual(recorder.memory['peakBytes'], 700)
        self.assertTrue(result['probeDisposed'])

    async def test_signal_during_setup_prevents_initialization(self):
        result, wire, *_ = await self.run_case(stop_initially=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.starts, 0)
        self.assertFalse(wire.enabled)
        self.assertEqual(result['stopReason'], 'host-signal-before-initialization')

    async def test_undelivered_stop_is_retried_without_reinitializing(self):
        result, wire, _, _, _, clock = await self.run_case(seconds=60, signal_at=2, lose_stop='before')
        self.assertEqual([name for name, _ in wire.calls].count('stop'), 2)
        self.assertEqual(wire.starts, 1)
        self.assertLess(clock.at - wire.started, 12)
        self.assertTrue(result['result']['restorationExact'])
        self.assertEqual(result['terminalStatus']['state'], 'interrupted')

    async def test_lost_ack_after_stop_retries_idempotently(self):
        result, wire, _, _, _, clock = await self.run_case(seconds=60, signal_at=2, lose_stop='after')
        self.assertEqual([name for name, _ in wire.calls].count('stop'), 2)
        self.assertEqual(wire.starts, 1)
        self.assertEqual(wire.stopped, wire.started + 2)
        self.assertLess(clock.at - wire.started, 12)
        self.assertTrue(result['result']['restorationExact'])

    async def test_recorded_frontend_exception_fails_validation_after_restoration(self):
        result, wire, *_ = await self.run_case(frontend_error=True)
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['result']['restorationExact'])
        self.assertTrue(wire.disposed)

    async def test_deadline_requests_restore_before_reserved_cleanup(self):
        result, wire, _, _, _, clock = await self.run_case(seconds=60, end_work=2)
        self.assertEqual(result['status'], 'interrupted')
        self.assertEqual(result['stopReason'], 'host-work-deadline')
        self.assertEqual([name for name, _ in wire.calls].count('stop'), 1)
        self.assertLess(clock.at, 110)
        self.assertTrue(result['result']['restorationExact'])

    async def test_unresponsive_restore_ends_before_cleanup_and_keeps_failure_report(self):
        result, wire, _, _, _, clock = await self.run_case(seconds=60, end_work=2, never_finish=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual([name for name, _ in wire.calls].count('stop'), 1)
        self.assertFalse(result['recordingCoverage']['complete'])
        self.assertEqual(clock.at, 110)
        self.assertFalse(wire.enabled)
        self.assertFalse(wire.disposed)

    async def test_restoration_mismatch_cannot_be_a_success(self):
        result, wire, *_ = await self.run_case(bad_restore=True)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['result']['restorationExact'])
        self.assertTrue(wire.result_persisted)
        self.assertTrue(wire.disposed)

    async def test_ambiguous_recorder_start_still_stops_its_domain(self):
        result, wire, *_ = await self.run_case(fail_begin='CPUProfiler.startTracking')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(wire.starts, 0)
        self.assertIn('CPUProfiler.stopTracking', wire.commands)
        self.assertIn('Network.disable', wire.commands)
        self.assertFalse(wire.enabled)

    async def test_missing_native_cpu_samples_fail_coverage(self):
        result, _, recorder, *_ = await self.run_case(silent_cpu=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(recorder.cpu['samples'], 0)
        self.assertEqual(result['error']['type'], 'RecordingCoverageError')

    async def test_each_heartbeat_persists_cached_client_evidence_and_terminal_report(self):
        result, _, _, checkpoints, _, _ = await self.run_case(seconds=31)
        self.assertEqual(result['status'], 'passed')
        periodic = sorted(set(entry['at'] for entry in checkpoints if not entry['terminal']))
        self.assertTrue(all(b - a == 5 for a, b in zip(periodic, periodic[1:])))
        self.assertGreaterEqual(len(periodic), 7)
        self.assertGreater(checkpoints[-2]['lastStatus']['clientCheckpoint']['sampleCount'], 50)
        self.assertTrue(checkpoints[-1]['terminal'])


    async def test_reply_loss_keeps_the_last_cached_client_peak_after_raw_samples_wrap(self):
        result, wire, recorder, checkpoints, _, _ = await self.run_case(seconds=60, fail_heartbeat_after=3)
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('result', result)
        saved = result['lastStatus']['clientCheckpoint']
        self.assertEqual(saved['peaks']['previewBytes'], 999)
        self.assertGreaterEqual(saved['sampleCount'], 20)
        self.assertGreater(recorder.counts['memory'], len(recorder.raw['memory']))
        self.assertEqual(checkpoints[-1]['lastStatus']['clientCheckpoint'], saved)
        self.assertEqual(wire.starts, 1)


class TerminalValidationTests(unittest.TestCase):
    def complete(self):
        return {'scenario': 'endurance', 'requestedScrollMs': 600000, 'scrollMs': 600000,
            'dwellMs': 12000, 'expectedStages': 12, 'stages': [{'endedAt': index + 1} for index in range(12)],
            'finished': True, 'restored': True, 'restorationExact': True, 'focusRestored': True,
            'restoredViewport': {'visible': True, 'focused': False, 'displayed': True, 'missingPages': []},
            'idle': {'awake': True, 'observedMs': 1500, 'quiet': True, 'framesAdded': 0}, 'observersRemoved': True}

    def failures(self, value):
        return runner.validate_sustained(value, {'state': 'completed'}, 600, 'endurance')

    def test_complete_visible_unfocused_document_can_pass(self):
        self.assertEqual(self.failures(self.complete()), [])

    def test_short_motion_or_missing_stage_cannot_pass_as_ten_minutes(self):
        for change in ({'scrollMs': 278608}, {'stages': [{'endedAt': 1}] * 11}, {'dwellMs': 11000}):
            with self.subTest(change=change):
                self.assertIn('planned-workload', self.failures({**self.complete(), **change}))

    def test_hidden_sleep_or_missing_pixels_cannot_certify_awake_restoration(self):
        for change in ({'idle': {'awake': False, 'observedMs': 308282, 'quiet': True, 'framesAdded': 0}},
                       {'idle': {'awake': True, 'observedMs': 1499, 'quiet': True, 'framesAdded': 0}},
                       {'restoredViewport': {'visible': False, 'displayed': False, 'missingPages': [46, 47]}}):
            with self.subTest(change=change):
                self.assertIn('displayed-awake-idle', self.failures({**self.complete(), **change}))

    def test_tap_wait_adds_host_budget_without_changing_motion_or_cleanup_reserve(self):
        clock = Clock()
        normal = runner.Budget(600, clock.now)
        armed = runner.Budget(600, clock.now, start_wait_ms=60000)
        self.assertEqual(armed.ends['work'] - normal.ends['work'], 60)
        self.assertEqual(armed.ends['setup'], normal.ends['setup'])
        self.assertEqual(armed.ends['detach'] - armed.ends['work'], normal.ends['detach'] - normal.ends['work'])
        self.assertIn('planned-workload', self.failures({**self.complete(), 'scrollMs': 540000}))

    def test_manual_early_stop_cannot_be_reported_as_full_requested_observation(self):
        value = {'durationMs': 120000, 'startedAt': 1, 'finishedAt': 1001, 'finished': True,
                 'mutatedReader': False, 'observersRemoved': True}
        self.assertIn('observation-duration', runner.validate_manual(value, {'state': 'completed'}, 120))

    def test_traverse_requires_both_real_robot_on_and_off_idle_phases(self):
        value = {**self.complete(), 'scenario': 'traverse', 'requestedScrollMs': 11000, 'scrollMs': 11000,
            'dwellMs': 0, 'expectedStages': 2, 'stages': [{'endedAt': 1}, {'endedAt': 2}],
            'naturalIdle': [{'robots': True, 'quiet': True, 'framesAdded': 0, 'durationMs': 8000},
                            {'robots': False, 'quiet': True, 'framesAdded': 0, 'durationMs': 4000}]}
        self.assertEqual(runner.validate_sustained(value, {'state': 'completed'}, 11, 'traverse'), [])
        value['naturalIdle'][1]['robots'] = True
        self.assertIn('planned-workload', runner.validate_sustained(value, {'state': 'completed'}, 11, 'traverse'))


if __name__ == '__main__':
    unittest.main()
