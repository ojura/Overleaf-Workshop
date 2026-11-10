#!/usr/bin/env python3
"""Native WebKit transport, recording and bounded sustained-workload control.

The retained owner supplies the session and explicit document settings.
Importing this module and its inert CLI do not access a device.
"""
import argparse
import asyncio
import contextlib
import hashlib
import json
import math
import re
import time
from collections import Counter, defaultdict, deque
from urllib.parse import urlparse

API = '__spomenarSustainedProbe'
OBJECT_GROUP = 'spomenar-sustained-validation'
SOURCES = {'network', 'memory-cache', 'disk-cache', 'service-worker', 'inspector-override'}
RAW_LIMITS = {'memory': 512, 'cpu': 512, 'pressure': 32, 'requests': 1024, 'errors': 64}
PENDING_LIMIT = 2048
HEARTBEAT_SECONDS = 5
CHECKPOINT_SECONDS = 10
RPC_SECONDS = 3
INITIALIZER_PREPARE_SECONDS = 12


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def headers(value):
    return {str(key).lower(): str(item) for key, item in (value or {}).items()}


def owned_kind(url, document):
    return document.network_kind(url)


def atomic_json(filename, value):
    temporary = filename.with_suffix(filename.suffix + '.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':'), allow_nan=False))
    temporary.replace(filename)


class Budget:
    def __init__(self, seconds=600, now=time.monotonic, *, start_wait_ms=0):
        self.now = now
        self.started = now()
        wait_seconds = start_wait_ms / 1000
        # Setup, JS preparation and intentional dwells have explicit allowances.
        self.ends = {'setup': self.started + 45, 'work': self.started + seconds + wait_seconds + 90,
                     'restore': self.started + seconds + wait_seconds + 120,
                     'recorders': self.started + seconds + wait_seconds + 130,
                     'detach': self.started + seconds + wait_seconds + 140}

    def remaining(self, phase):
        return max(0, self.ends[phase] - self.now())


class Recorder:
    """Raw rings are bounded; counters, peaks and timing spans cover every event."""
    def __init__(self, now=time.monotonic, limits=None, pending_limit=PENDING_LIMIT, *, document):
        self.now, self.document = now, document
        self.limits = {**RAW_LIMITS, **(limits or {})}
        self.raw = {key: deque(maxlen=value) for key, value in self.limits.items()}
        self.counts = Counter()
        self.memory = {'samples': 0, 'peakBytes': 0, 'categoryPeaks': {}, 'first': None, 'last': None,
                       'maxHostGapMs': 0, 'maxNativeGapMs': 0}
        self.cpu = {'samples': 0, 'peakPercent': 0, 'sumPercent': 0,
                    'sampleWeightedCpuSeconds': 0, 'sampleSpanSeconds': 0,
                    'maxHostGapMs': 0, 'maxNativeGapMs': 0, 'first': None, 'last': None,
                    'threadTypePeakPercent': {}}
        self.net = Counter()
        self.by_kind = defaultdict(Counter)
        self.by_source = defaultdict(Counter)
        self.statuses = Counter()
        self.inflight = {}
        self.pending_limit = pending_limit
        self.domain_events = []
        self.previous_handlers = {}
        self.handlers = {}
        self.capabilities = {}

    def append(self, kind, value):
        self.counts[kind] += 1
        self.raw[kind].append(value)

    def error(self, label, error):
        self.append('errors', {'atHostMs': self.now() * 1000, 'label': label, 'error': str(error)[:500]})

    def timing(self, summary, point):
        previous = summary['last']
        if previous:
            summary['maxHostGapMs'] = max(summary['maxHostGapMs'], point['hostMs'] - previous['hostMs'])
            if number(point.get('timestamp')) and number(previous.get('timestamp')):
                summary['maxNativeGapMs'] = max(summary['maxNativeGapMs'],
                                               (point['timestamp'] - previous['timestamp']) * 1000)
        summary['first'] = summary['first'] or point
        summary['last'] = point
        summary['samples'] += 1
        return previous

    def memory_update(self, message):
        event = message['params']['event']
        sizes = {item['type']: item['size'] for item in event['categories']}
        if any(not number(value) or value < 0 for value in sizes.values()):
            raise ValueError('Invalid native memory category size')
        point = {'hostMs': self.now() * 1000, 'timestamp': event['timestamp'],
                 'bytes': sizes, 'totalBytes': sum(sizes.values())}
        self.timing(self.memory, point)
        if point['totalBytes'] >= self.memory['peakBytes']:
            self.memory.update(peakBytes=point['totalBytes'], peakAtHostMs=point['hostMs'],
                               peakCategories=dict(sizes))
        for key, value in sizes.items():
            self.memory['categoryPeaks'][key] = max(self.memory['categoryPeaks'].get(key, 0), value)
        self.append('memory', point)

    def cpu_update(self, message):
        event = message['params']['event']
        usage = event['usage']
        if not number(usage) or usage < 0:
            raise ValueError('Invalid native CPU usage')
        point = {'hostMs': self.now() * 1000, 'timestamp': event['timestamp'],
                 'usagePercent': usage, 'threads': event.get('threads', [])}
        previous = self.timing(self.cpu, point)
        self.cpu['sumPercent'] += usage
        self.cpu['peakPercent'] = max(self.cpu['peakPercent'], usage)
        if previous and number(event['timestamp']) and number(previous.get('timestamp')):
            elapsed = event['timestamp'] - previous['timestamp']
            if elapsed > 0:
                self.cpu['sampleWeightedCpuSeconds'] += usage / 100 * elapsed
                self.cpu['sampleSpanSeconds'] += elapsed
        groups = Counter()
        for thread in point['threads']:
            if number(thread.get('usage')) and thread['usage'] >= 0:
                kind = thread.get('type') if thread.get('type') in ('main', 'webkit') else 'other'
                groups[kind] += thread['usage']
        for key, value in groups.items():
            self.cpu['threadTypePeakPercent'][key] = max(self.cpu['threadTypePeakPercent'].get(key, 0), value)
        self.append('cpu', point)

    def add_net(self, key, value=1, entry=None, source=False):
        self.net[key] += value
        if entry:
            self.by_kind[entry['kind']][key] += value
            if source:
                self.by_source[entry.get('source', 'unknown')][key] += value

    def begin(self, event, request, observed=True):
        kind = owned_kind(request.get('url', ''), self.document)
        if kind is None:
            return None
        identifier = event['requestId']
        if identifier in self.inflight:
            self.finish(identifier, failed=True, reason='redirect-or-reused-request-id')
            self.add_net('redirects')
        if len(self.inflight) >= self.pending_limit:
            self.add_net('pendingOverflow')
            self.error('network', 'The bounded pending-request map filled')
            return None
        h = headers(request.get('headers'))
        entry = {'id': identifier, 'kind': kind, 'path': urlparse(request['url']).path,
                 'method': request.get('method'), 'range': h.get('range'), 'ifRange': h.get('if-range'),
                 'requestObserved': observed, 'startedHostMs': self.now() * 1000,
                 'source': 'unknown', 'dataEvents': 0, 'decodedDataBytes': 0,
                 'encodedDataBytes': 0, 'unknownEncodedEvents': 0, 'unknownDataLengthEvents': 0}
        self.inflight[identifier] = entry
        self.append('requests', entry)
        self.add_net('requests' if observed else 'requestsWithoutStart', entry=entry)
        self.net['peakPending'] = max(self.net['peakPending'], len(self.inflight))
        return entry

    def requested(self, message):
        event = message['params']
        self.begin(event, event['request'])

    def range_failure(self, entry, reason):
        entry.setdefault('rangeFailures', []).append(reason)
        self.add_net('rangeFailures', entry=entry, source=True)
        self.error('pdf-range', {'id': entry['id'], 'range': entry['range'],
                                 'contentRange': entry.get('contentRange'), 'reason': reason})

    def response(self, entry, response):
        h = headers(response.get('headers'))
        source = response.get('source')
        entry.update(status=response.get('status'), source=source if source in SOURCES else 'unknown',
                     contentRange=h.get('content-range'), contentLength=h.get('content-length'),
                     contentEncoding=h.get('content-encoding'), etag=h.get('etag'),
                     lastModified=h.get('last-modified'), responseHostMs=self.now() * 1000)
        self.add_net('responses', entry=entry, source=True)
        self.statuses[str(response.get('status'))] += 1
        length = h.get('content-length')
        if length and length.isdigit():
            self.add_net('advertisedBodyBytes', int(length), entry, source=True)
        if entry['kind'] != 'pdf' or entry['method'] == 'HEAD':
            return
        if not entry['requestObserved']:
            entry['rangeValidation'] = 'request-not-observed'
            self.add_net('rangeRequestUnobserved', entry=entry, source=True)
            return
        requested = re.fullmatch(r'bytes=(\d+)-(\d+)', entry['range'] or '')
        received = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', entry['contentRange'] or '')
        errors = []
        if requested is None:
            errors.append('Request is not a bounded byte range')
        if entry['status'] != 206:
            errors.append('Response status is not 206')
        if received is None:
            errors.append('Content-Range is missing or malformed')
        if requested and received:
            start, end = map(int, requested.groups())
            got_start, got_end, total = map(int, received.groups())
            if not (0 <= start <= end < self.document.bytes):
                errors.append('Requested range is outside this PDF')
            if (got_start, got_end, total) != (start, end, self.document.bytes):
                errors.append('Content-Range differs from the requested range or PDF size')
            entry['expectedBodyBytes'] = end - start + 1
            if length != str(end - start + 1):
                errors.append('Content-Length differs from the requested range length')
        if h.get('content-encoding', 'identity').strip().lower() not in ('', 'identity'):
            errors.append('PDF byte range has content encoding')
        if entry['ifRange'] and entry['ifRange'] not in (entry['etag'], entry['lastModified']):
            errors.append('If-Range validator differs from the response validator')
        entry['rangeValidation'] = 'failed' if errors else 'headers-valid'
        self.add_net('rangeResponsesChecked', entry=entry, source=True)
        for error in errors:
            self.range_failure(entry, error)

    def responded(self, message):
        event = message['params']
        entry = self.inflight.get(event['requestId'])
        if entry is None:
            entry = self.begin(event, {'url': event['response'].get('url', '')}, observed=False)
        if entry:
            self.response(entry, event['response'])

    def data_received(self, message):
        event = message['params']
        entry = self.inflight.get(event['requestId'])
        if not entry:
            self.net['unattributedDataEvents'] += 1
            return
        entry['dataEvents'] += 1
        self.add_net('dataEvents', entry=entry, source=True)
        for field, target in (('dataLength', 'decodedDataBytes'), ('encodedDataLength', 'encodedDataBytes')):
            value = event.get(field)
            if number(value) and value >= 0:
                entry[target] += value
                self.add_net(target, value, entry, source=True)
            else:
                self.add_net('unknown' + field[0].upper() + field[1:] + 'Events', entry=entry, source=True)
                if field == 'encodedDataLength':
                    entry['unknownEncodedEvents'] += 1
                else:
                    entry['unknownDataLengthEvents'] += 1

    def finish(self, identifier, failed=False, canceled=False, reason=None, metrics=None):
        entry = self.inflight.pop(identifier, None)
        if entry is None:
            return
        entry.update(finishedHostMs=self.now() * 1000, failed=failed, canceled=canceled)
        if reason:
            entry['failureReason'] = str(reason)[:300]
        self.add_net('failed' if failed else 'completed', entry=entry, source=True)
        if canceled:
            self.add_net('canceled', entry=entry, source=True)
        for field in ('responseBodyBytesReceived', 'responseBodyDecodedSize', 'responseHeaderBytesReceived'):
            value = (metrics or {}).get(field)
            if number(value) and value >= 0:
                entry.setdefault('metrics', {})[field] = value
                self.add_net('metrics.' + field, value, entry, source=True)
                self.add_net('metrics.' + field + '.requests', entry=entry, source=True)
        if not failed and entry['kind'] == 'pdf' and entry['requestObserved'] and 'status' not in entry:
            self.add_net('pdfResponsesMissing', entry=entry)
            self.range_failure(entry, 'Completed PDF request has no observed response headers')
        expected = entry.get('expectedBodyBytes')
        if not failed and entry.get('rangeValidation') == 'headers-valid' and expected is not None:
            # This WebKit version can double its completion decoded-size metric.
            # Validate the delivered body only from complete dataReceived evidence;
            # retain the independent summary counter and any disagreement unchanged.
            measured = entry['decodedDataBytes'] if entry['dataEvents'] and not entry['unknownDataLengthEvents'] else None
            entry['bodyValidationSource'] = 'dataReceived' if measured is not None else 'headers-only'
            self.add_net('rangeBodiesChecked' if measured is not None else 'rangeBodiesUnobserved', entry=entry, source=True)
            reported = entry.get('metrics', {}).get('responseBodyDecodedSize')
            if reported is not None and (reported != expected or measured is not None and reported != measured):
                entry['decodedMetricDiscrepancy'] = {
                    'reportedBytes': reported, 'expectedBytes': expected, 'dataReceivedBytes': measured}
                self.add_net('decodedMetricDiscrepancies', entry=entry, source=True)
            if measured is not None:
                entry['rangeValidation'] = 'body-valid' if measured == expected else 'failed'
                if measured != expected:
                    self.range_failure(entry, 'Delivered dataReceived body length differs from the requested range')

    def finished(self, message):
        event = message['params']
        self.finish(event['requestId'], failed=message['method'] == 'Network.loadingFailed',
                    canceled=event.get('canceled', False), reason=event.get('errorText'), metrics=event.get('metrics'))

    def memory_cached(self, message):
        event = message['params']
        resource = event['resource']
        entry = self.inflight.get(event['requestId'])
        if entry is None:
            entry = self.begin(event, {'url': resource.get('url', '')}, observed=False)
        if entry:
            self.response(entry, {**resource.get('response', {}), 'source': 'memory-cache'})
            size = resource.get('bodySize')
            if number(size) and size >= 0:
                entry['cachedBodyBytes'] = size
                self.add_net('cachedBodyBytes', size, entry, source=True)
            self.finish(entry['id'])

    def install(self, responses, protocol):
        callbacks = {
            'Memory.trackingStart': lambda _: None, 'Memory.trackingComplete': lambda _: None,
            'Memory.trackingUpdate': self.memory_update,
            'Memory.memoryPressure': lambda m: self.append('pressure', {'hostMs': self.now() * 1000, **m['params']}),
            'CPUProfiler.trackingStart': lambda _: None, 'CPUProfiler.trackingComplete': lambda _: None,
            'CPUProfiler.trackingUpdate': self.cpu_update,
        }
        events = {event['name'] for event in protocol['events']}
        self.capabilities = {'dataReceivedAdvertised': 'dataReceived' in events,
                             'memoryCacheEventAdvertised': 'requestServedFromMemoryCache' in events}
        callbacks.update({'Network.' + name: lambda _: None for name in events})
        callbacks.update({'Network.requestWillBeSent': self.requested,
                          'Network.responseReceived': self.responded,
                          'Network.loadingFinished': self.finished, 'Network.loadingFailed': self.finished,
                          'Network.requestServedFromMemoryCache': self.memory_cached})
        if 'dataReceived' in events:
            callbacks['Network.dataReceived'] = self.data_received
        for key, callback in callbacks.items():
            self.previous_handlers[key] = (key in responses, responses.get(key))
            def guarded(message, fn=callback, label=key):
                try:
                    fn(message)
                except Exception as error:
                    self.error(label, error)
            self.handlers[key] = guarded
            responses[key] = guarded

    def uninstall(self, responses):
        for key, callback in self.handlers.items():
            if responses.get(key) is callback:
                existed, previous = self.previous_handlers[key]
                if existed:
                    responses[key] = previous
                else:
                    responses.pop(key, None)
        self.handlers.clear()

    def snapshot(self):
        return {'rawLimits': self.limits, 'rawCounts': dict(self.counts),
                'rawDropped': {key: max(0, self.counts[key] - len(value)) for key, value in self.raw.items()},
                'memory': self.memory, 'cpu': self.cpu,
                'network': {**self.net, 'byKind': dict(self.by_kind), 'bySource': dict(self.by_source),
                            'statuses': dict(self.statuses), 'activeRequests': len(self.inflight),
                            'pending': list(self.inflight.values())[:32], 'capabilities': self.capabilities},
                'domains': self.domain_events, 'raw': {key: list(value) for key, value in self.raw.items()},
                'units': {'cpu': 'Native CPUProfiler percent; weighted CPU seconds use the later sample over its preceding timestamp interval.',
                          'network': 'dataReceived byte sums, completion metrics and advertised Content-Length are separate; do not add them together. Body validation uses complete dataReceived lengths; completion metric discrepancies remain separate observations.'}}


class NativeProtocolError(RuntimeError):
    """Preserve native fields for exact cleanup decisions; log the code only."""
    def __init__(self, method, error):
        self.code = error.get('code', 'unknown')
        self.message = error.get('message', '')
        super().__init__(method + ' protocol error: ' + str(self.code))


class Wire:
    def __init__(self, session, budget, *, allow_navigation=False):
        self.allow_navigation = allow_navigation
        self.session, self.budget = session, budget
        self.target = session.target_id
        self.initial_target = self.target
        self.target_changes = 0
        self.operations = deque(maxlen=256)
        self.initial_operations = []
        self.failed_operations = deque(maxlen=32)
        self.operation_counts = Counter()
        self.max_elapsed_ms = {}
        self.sequence = 0
        self.id_rows = {}
        self.current_operation = None
        self.trace_owner = self.trace_callback = self.previous_trace = None
        self.trace_errors = 0

    def install_trace(self, inspector):
        self.trace_owner = inspector
        self.previous_trace = getattr(inspector, 'trace', None)
        session_id = self.session.protocol.id_

        def observe(direction, observed_session, message):
            if self.previous_trace:
                self.previous_trace(direction, observed_session, message)
            if observed_session != session_id:
                return
            try:
                inner = message
                if self.target is not None:
                    expected = 'Target.sendMessageToTarget' if direction == 'bridge->device' else 'Target.dispatchMessageFromTarget'
                    if message.get('method') != expected:
                        return
                    if not self.allow_navigation and message['params'].get('targetId', self.target) != self.target:
                        return
                    inner = json.loads(message['params']['message'])
                identifier = inner.get('id')
                if not isinstance(identifier, int):
                    return
                row = self.id_rows.get(identifier)
                if direction == 'bridge->device' and row is None and self.current_operation:
                    row = self.current_operation
                    self.id_rows[identifier] = row
                if row is None:
                    return
                if direction == 'bridge->device':
                    row['forwardedHostMs'] = self.budget.now() * 1000
                elif direction == 'device->bridge':
                    row['replyReceivedHostMs'] = self.budget.now() * 1000
                    row['replyIsError'] = 'error' in inner
                while len(self.id_rows) > 256:
                    self.id_rows.pop(next(iter(self.id_rows)))
            except Exception:
                self.trace_errors += 1
        self.trace_callback = observe
        inspector.trace = observe

    def restore_trace(self):
        if self.trace_owner and getattr(self.trace_owner, 'trace', None) is self.trace_callback:
            self.trace_owner.trace = self.previous_trace

    def snapshot(self):
        return {'targetUnchanged': self.session.target_id == self.initial_target,
                'targetChanges': self.target_changes,
                'count': self.sequence, 'countsByMethod': dict(self.operation_counts),
                'maxElapsedMsByMethod': self.max_elapsed_ms, 'traceErrors': self.trace_errors,
                'initial': self.initial_operations, 'errors': list(self.failed_operations),
                'recent': list(self.operations), 'recentLimit': 256}

    async def command(self, method, timeout=RPC_SECONDS, *, flush_after_send=False, purpose=None, _sent=None, _owned_release=None, **params):
        limit = min(timeout, self.budget.remaining('detach'))
        if limit <= 0:
            raise TimeoutError('Host deadline expired before ' + method)
        if self.session.target_id != self.target:
            if not self.allow_navigation:
                raise RuntimeError('The bound inspector target changed')
            self.target = self.session.target_id
            self.target_changes += 1
        if flush_after_send and self.target is None:
            raise RuntimeError('Source flushing requires the owned native target')
        deadline = self.budget.now() + limit
        flush_task = None
        flush_release = asyncio.Event()
        self.sequence += 1
        row = {'sequence': self.sequence, 'method': method, 'startedHostMs': self.budget.now() * 1000,
               'timeoutSeconds': limit, 'payloadBytes': len(json.dumps(params).encode()),
               'phase': 'sending', 'outcome': 'pending'}
        if purpose:
            row['purpose'] = purpose
        if flush_after_send:
            row['flushAfterSend'] = True
        self.operations.append(row)
        if len(self.initial_operations) < 32:
            self.initial_operations.append(row)
        self.operation_counts[method] += 1
        self.current_operation = row
        try:
            async with asyncio.timeout(limit):
                if self.target is not None:
                    # Same public methods used by InspectorSession.send_and_receive,
                    # separated here so a timeout identifies delivery versus reply.
                    self.id_rows[self.session.message_id] = row
                    while len(self.id_rows) > 256:
                        self.id_rows.pop(next(iter(self.id_rows)))
                    identifier = await self.session.send_message_to_target({'method': method, 'params': params})
                    row['sendCompletedHostMs'] = self.budget.now() * 1000
                    if _sent is not None:
                        _sent.set()
                    row['phase'] = 'waiting-reply'
                    self.id_rows[identifier] = row
                    if flush_after_send:
                        # This device buffers large outgoing source until another
                        # command arrives. One inert no-op releases that delivery.
                        # The send must finish; its auxiliary reply is not a completion barrier.
                        flush_sent = asyncio.Event()
                        flush_task = asyncio.create_task(self.command('Runtime.evaluate',
                            timeout=max(0, deadline - self.budget.now()), purpose='large-source-flush', _sent=flush_sent, _owned_release=flush_release,
                            expression='void 0', returnByValue=True,
                            emulateUserGesture=False, objectGroup=OBJECT_GROUP))
                        sent_waiter = asyncio.create_task(flush_sent.wait())
                        try:
                            await asyncio.wait({sent_waiter, flush_task}, return_when=asyncio.FIRST_COMPLETED)
                            if flush_task.done():
                                await flush_task
                        finally:
                            if not sent_waiter.done(): sent_waiter.cancel()
                            with contextlib.suppress(asyncio.CancelledError): await sent_waiter
                    response = await self.session.receive_response_by_id(identifier)
                    response = json.loads(response['params']['message'])
                else:
                    row['phase'] = 'sending-or-waiting-reply'
                    response = await self.session.send_command(method, **params)
            if response.get('error'):
                raise NativeProtocolError(method, response['error'])
            row['outcome'] = 'ok'
            return response.get('result', response)
        except asyncio.CancelledError:
            if _owned_release is not None and _owned_release.is_set():
                row.update(outcome='owned-release')
            else:
                row.update(outcome='cancelled', errorType='CancelledError')
                self.failed_operations.append(row)
            raise
        except Exception as error:
            row.update(outcome='timeout' if isinstance(error, TimeoutError) else 'error',
                       errorType=type(error).__name__)
            self.failed_operations.append(row)
            if isinstance(error, TimeoutError):
                raise TimeoutError(method + ' timed out during ' + row['phase']) from error
            raise
        finally:
            if flush_task:
                flush_release.set()
                if not flush_task.done():
                    flush_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await flush_task
            row['completedHostMs'] = self.budget.now() * 1000
            row['elapsedMs'] = row['completedHostMs'] - row['startedHostMs']
            self.max_elapsed_ms[method] = max(self.max_elapsed_ms.get(method, 0), row['elapsedMs'])
            if self.current_operation is row:
                self.current_operation = None

    @staticmethod
    def value(result, method):
        if result.get('wasThrown'):
            message = str(result.get('result', {}).get('description', 'JavaScript exception')).split('\n', 1)[0][:300]
            raise RuntimeError(method + ': ' + message)
        return result.get('result', {}).get('value')

    async def evaluate(self, source, timeout=RPC_SECONDS):
        # Every control expression is synchronous. It needs one by-value reply.
        result = await self.command('Runtime.evaluate', timeout=timeout,
            expression='(' + source + ')', returnByValue=True,
            emulateUserGesture=False, objectGroup=OBJECT_GROUP)
        return self.value(result, 'Runtime.evaluate')

    async def prepare_initializer(self, source):
        # Function creation cannot run the workload, even if delivery finishes late.
        result = await self.command('Runtime.evaluate', timeout=INITIALIZER_PREPARE_SECONDS, flush_after_send=True,
            expression='(' + source + ')', returnByValue=False,
            emulateUserGesture=False, objectGroup=OBJECT_GROUP)
        self.value(result, 'Runtime.evaluate initializer preparation')
        remote = result.get('result', {})
        if remote.get('type') != 'function' or not remote.get('objectId'):
            raise RuntimeError('Initializer preparation did not return a function handle')
        return remote['objectId']

    async def invoke_initializer(self, handle, options):
        result = await self.command('Runtime.callFunctionOn', objectId=handle,
            functionDeclaration='function (options) { return this(options); }',
            arguments=[{'value': options}], returnByValue=True, awaitPromise=True, emulateUserGesture=False)
        return self.value(result, 'Runtime.callFunctionOn initializer')


async def bounded(awaitable, budget, phase, cap=RPC_SECONDS, label='operation'):
    limit = min(cap, budget.remaining(phase))
    if limit <= 0:
        if hasattr(awaitable, 'close'):
            awaitable.close()
        raise TimeoutError('Host ' + phase + ' deadline expired before ' + label)
    began = budget.now()
    try:
        async with asyncio.timeout(limit):
            return await awaitable
    except TimeoutError as error:
        detail = ': ' + str(error) if str(error) else ''
        raise TimeoutError(label + ' timed out after ' + format(budget.now() - began, '.3f') +
                           ' s in ' + phase + detail) from error


async def api_call(wire, method, token, budget, phase='work', argument=None, *, api=API):
    arguments = [token] if argument is None else [token, argument]
    source = '(() => { const api=window[' + json.dumps(api) + ']; return api ? api[' + json.dumps(method) + '](...' + json.dumps(arguments) + ') : {missing:true}; })()'
    value = await bounded(wire.evaluate(source), budget, phase, label='probe.' + method + ' Runtime.evaluate')
    if not isinstance(value, dict) or value.get('missing'):
        raise RuntimeError('The owned probe API is missing')
    if value.get('token', token) != token:
        raise RuntimeError('The probe acknowledgement has a different token')
    if value.get('ok') is False:
        raise RuntimeError('The token-owned API rejected ' + method)
    return value


async def stop_recorders(wire, recorder, budget, methods):
    errors = []
    for method in methods:
        event = {'method': method, 'intentHostMs': budget.now() * 1000}
        recorder.domain_events.append(event)
        try:
            await bounded(wire.command(method, timeout=2), budget, 'recorders', 2, label=method)
            event['ackHostMs'] = budget.now() * 1000
        except Exception as error:
            if method == 'Memory.disable' and getattr(error, 'code', None) == -32000 \
                    and getattr(error, 'message', None) == 'Memory domain already disabled':
                event['alreadyDisabled'] = True
            else:
                errors.append(method + ': ' + str(error))
    return errors


def restored_ready(value):
    viewport, idle = value.get('restoredViewport', {}), value.get('idle', {})
    return viewport.get('visible') is True and viewport.get('displayed') is True \
        and viewport.get('missingPages') == [] and idle.get('awake') is True \
        and number(idle.get('observedMs')) and idle['observedMs'] >= 1500 \
        and idle.get('quiet') is True and idle.get('framesAdded') == 0


def validate_sustained(value, latest, seconds, scenario):
    expected_stages = 2 if scenario == 'traverse' else 12
    expected_dwell = 0 if scenario == 'traverse' else 12000
    stages = value.get('stages', [])
    duration_ok = value.get('scenario') == scenario and value.get('requestedScrollMs') == seconds * 1000 \
        and number(value.get('scrollMs')) and value['scrollMs'] >= seconds * 1000 \
        and number(value.get('dwellMs')) and value['dwellMs'] >= expected_dwell \
        and value.get('expectedStages') == expected_stages and len(stages) == expected_stages \
        and all(number(stage.get('endedAt')) for stage in stages)
    if scenario == 'traverse':
        idle = value.get('naturalIdle', [])
        duration_ok = duration_ok and len(idle) == 2 and all(
            part.get('robots') is enabled and part.get('quiet') is True and part.get('framesAdded') == 0
            and number(part.get('durationMs')) and part['durationMs'] >= duration
            for part, enabled, duration in zip(idle, (True, False), (8000, 4000)))
    return [label for label, failed in (
        ('completion', latest.get('state') != 'completed' or value.get('finished') is not True),
        ('planned-workload', not duration_ok),
        ('restoration', value.get('restored') is not True or value.get('restorationExact') is not True
         or value.get('focusRestored') is not True),
        ('displayed-awake-idle', not restored_ready(value)),
        ('observer-cleanup', value.get('observersRemoved') is not True),
        ('frontend-errors', bool(value.get('errors')) or bool(value.get('failure')) or bool(value.get('cleanupErrors'))),
    ) if failed]


def validate_manual(value, latest, seconds):
    return [label for label, failed in (
        ('completion', latest.get('state') != 'completed' or value.get('finished') is not True),
        ('observation-duration', value.get('durationMs') != seconds * 1000 or not number(value.get('startedAt'))
         or not number(value.get('finishedAt')) or value['finishedAt'] - value['startedAt'] < seconds * 1000),
        ('passive-observation', value.get('mutatedReader') is not False),
        ('observer-cleanup', value.get('observersRemoved') is not True),
        ('frontend-errors', bool(value.get('errors')) or bool(value.get('failure'))),
    ) if failed]


async def run_recorded(wire, recorder, source, token, seconds, budget, stop_event,
                       checkpoint, screenshot=None, sleep=asyncio.sleep, *, options=None, probe_api=API, manual=False):
    receipt = {'status': 'running', 'token': token, 'workloadSeconds': seconds,
               'heartbeatSeconds': HEARTBEAT_SECONDS, 'leaseSeconds': 20,
               'phaseDeadlinesSeconds': {k: v - budget.started for k, v in budget.ends.items()},
               'cleanupErrors': [], 'screenshots': []}
    options = dict(options or {})
    receipt['startMode'] = options.get('startMode', 'immediate')
    receipt['startWaitMs'] = options.get('startWaitMs', 0)
    receipt['scenario'] = options.get('scenario', 'endurance')
    active = []
    installed = False
    latest = None
    stop_sent = False
    stop_attempts = 0
    next_heartbeat = budget.now()
    next_checkpoint = budget.now()
    shot_times = [seconds / 3, seconds * 2 / 3]
    if receipt['scenario'] != 'traverse' and seconds > 20:
        shot_times.append(20)
    shots = deque(sorted(set(shot_times))) if screenshot else deque()
    shot_index = 0

    async def control(method, owned_token, owned_budget, phase='work', argument=None):
        return await api_call(wire, method, owned_token, owned_budget, phase, argument, api=probe_api)

    async def publish(force=False):
        nonlocal next_checkpoint
        if force or budget.now() >= next_checkpoint:
            receipt['lastStatus'] = latest
            checkpoint(receipt, recorder)
            next_checkpoint = budget.now() + CHECKPOINT_SECONDS

    async def stop(reason):
        nonlocal stop_sent, stop_attempts
        if stop_sent:
            return
        if stop_attempts >= 2:
            raise RuntimeError('The token-owned stop could not be acknowledged')
        if stop_attempts == 0:
            # An early signal also gets a bounded recovery interval.
            budget.ends['restore'] = min(budget.ends['restore'], budget.now() + 40)
            receipt['stopRestoreDeadlineSeconds'] = budget.ends['restore'] - budget.started
        stop_attempts += 1
        receipt['stopAttempts'] = stop_attempts
        receipt.setdefault('stopReason', reason)
        receipt['stopAcknowledgement'] = await control('stop', token, budget, 'restore', receipt['stopReason'])
        stop_sent = True

    async def collect_terminal():
        value = await control('result', token, budget, 'restore')
        receipt['result'] = value
        receipt['terminalCollectedHostMs'] = budget.now() * 1000
        # Persist the result before releasing the page's retained terminal report.
        await publish(True)
        if screenshot and value.get('restorationExact') is True and value.get('restored') is True:
            try:
                receipt['screenshots'].append(await screenshot(4, receipt['terminalStatus']))
            except Exception as error:
                receipt.setdefault('screenshotErrors', []).append(str(error))
        disposed = await control('dispose', token, budget, 'restore')
        if disposed.get('disposed') is not True:
            raise RuntimeError('The terminal probe report was not released')
        receipt['probeDisposed'] = True

    try:
        for begin, end in (('Network.enable', 'Network.disable'),
                           ('CPUProfiler.startTracking', 'CPUProfiler.stopTracking'),
                           ('Memory.enable', 'Memory.disable'),
                           ('Memory.startTracking', 'Memory.stopTracking')):
            if stop_event.is_set():
                receipt['stopReason'] = 'host-signal-before-initialization'
                raise RuntimeError('Host signal arrived before workload initialization')
            active.append((begin, end))
            recorder.domain_events.append({'method': begin, 'intentHostMs': budget.now() * 1000})
            await bounded(wire.command(begin), budget, 'setup')
            recorder.domain_events[-1]['ackHostMs'] = budget.now() * 1000
        receipt['recordingReadyHostMs'] = budget.now() * 1000
        receipt['initializerPreparationStartedHostMs'] = budget.now() * 1000
        receipt['initializerPreparationLimitSeconds'] = INITIALIZER_PREPARE_SECONDS
        handle = await bounded(wire.prepare_initializer(source), budget, 'setup',
                               INITIALIZER_PREPARE_SECONDS, 'prepare inert initializer Runtime.evaluate')
        receipt['initializerPreparedHostMs'] = budget.now() * 1000
        receipt['calibration'] = await bounded(wire.evaluate('({at:performance.now(),origin:performance.timeOrigin})'),
                                              budget, 'setup', label='calibration Runtime.evaluate')
        if stop_event.is_set():
            receipt['stopReason'] = 'host-signal-before-initialization'
            raise RuntimeError('Host signal arrived before workload initialization')
        if budget.remaining('setup') <= 0:
            raise TimeoutError('Setup deadline expired before initializer invocation')
        config = {**options, 'document': recorder.document.browser(), 'token': token,
                  'workloadMs': round(seconds * 1000), 'leaseMs': 20000}
        receipt['probe'] = {'script': 'manual-observe.js' if manual else 'sustained.js', 'sha256': hashlib.sha256(source.encode()).hexdigest()}
        installed = True
        receipt['initializationAttemptedHostMs'] = budget.now() * 1000
        try:
            latest = await bounded(wire.invoke_initializer(handle, config), budget, 'setup',
                                   label='invoke initializer Runtime.callFunctionOn')
        except Exception as error:
            receipt['initializationAcknowledgementError'] = {
                'type': type(error).__name__, 'message': str(error), 'stage': 'initializer-invocation'}
            latest = await control('status', token, budget, 'work')
        if not isinstance(latest, dict) or latest.get('token') != token:
            raise RuntimeError('Initialization did not acknowledge the owned token')
        next_heartbeat = budget.now()
        receipt['initializationAcknowledgedHostMs'] = next_heartbeat * 1000
        await publish(True)
        while True:
            now = budget.now()
            if latest and latest.get('finished'):
                receipt['terminalStatus'] = latest
                await collect_terminal()
                break
            if stop_event.is_set() and not stop_sent:
                await stop('host-signal')
            if recorder.counts['errors'] and not stop_sent:
                await stop('recording-validation-failure')
            if budget.remaining('work') <= 0 and not stop_sent:
                await stop('host-work-deadline')
            phase = 'restore' if stop_sent else 'work'
            if budget.remaining(phase) <= 0:
                raise TimeoutError('The probe did not finish before the ' + phase + ' deadline')
            if now >= next_heartbeat:
                latest = await control('heartbeat', token, budget, phase)
                next_heartbeat = budget.now() + HEARTBEAT_SECONDS
                await publish(True)
                if latest.get('finished'):
                    continue
                # Use reported motion, so tap waiting and traverse's natural idle
                # cannot consume workload captures. The restored capture follows
                # the separately measured awake idle interval in collect_terminal.
                progress_ms = latest.get('elapsedMs' if manual else 'scrollMs')
                capture_active = latest.get('state') == ('observing' if manual else 'running')
                if (shots and not stop_sent and capture_active and number(progress_ms)
                        and shots[0] <= progress_ms / 1000 < seconds):
                    # One fresh heartbeat may cross multiple thresholds; capture
                    # once rather than replaying missed shots against one frame.
                    while shots and shots[0] <= progress_ms / 1000:
                        shots.popleft()
                    shot_index += 1
                    try:
                        picture = await screenshot(shot_index, latest)
                        receipt['screenshots'].append(picture)
                    except Exception as error:
                        receipt.setdefault('screenshotErrors', []).append(str(error))
            await sleep(min(0.25, max(0, next_heartbeat - budget.now()), budget.remaining(phase)))
        value = receipt['result']
        exact = value.get('restorationExact') is True and value.get('restored') is True
        clean = (value.get('observersRemoved') is True and not recorder.counts['errors']
                 and not value.get('errors') and not value.get('cleanupErrors'))
        receipt['validationFailures'] = validate_manual(value, receipt['terminalStatus'], seconds) if manual else \
            validate_sustained(value, receipt['terminalStatus'], seconds, receipt['scenario'])
        if recorder.counts['errors']:
            receipt['validationFailures'].append('native-recording')
        receipt['status'] = ('observed' if manual else 'passed') if not receipt['validationFailures'] else 'failed'
        if (exact or manual and value.get('mutatedReader') is False) and clean and (
                receipt['terminalStatus'].get('state') == 'interrupted' or manual and value.get('reason') == 'host-stop'):
            receipt['status'] = 'interrupted'
    except Exception as error:
        receipt.update(status='failed', error={'type': type(error).__name__, 'message': str(error)})
        if installed and not receipt.get('probeDisposed'):
            try:
                await stop('host-error')
                while budget.remaining('restore') > 0:
                    latest = await control('heartbeat', token, budget, 'restore')
                    await publish(True)
                    if latest.get('finished'):
                        receipt['terminalStatus'] = latest
                        await collect_terminal()
                        break
                    await sleep(min(HEARTBEAT_SECONDS, budget.remaining('restore')))
            except Exception as recovery_error:
                receipt['recoveryError'] = {'type': type(recovery_error).__name__, 'message': str(recovery_error)}
    finally:
        receipt['recordingStopRequestedHostMs'] = budget.now() * 1000
        receipt['cleanupErrors'].extend(await stop_recorders(wire, recorder, budget,
            [end for _, end in reversed(active)]))
        receipt['recordingStoppedHostMs'] = budget.now() * 1000
        receipt['elapsedSeconds'] = budget.now() - budget.started
        admitted = receipt.get('initializationAttemptedHostMs')
        terminal = receipt.get('terminalCollectedHostMs')
        covered = (admitted is not None and terminal is not None
                   and receipt['recordingReadyHostMs'] <= admitted <= terminal
                   and terminal <= receipt['recordingStopRequestedHostMs']
                   and receipt.get('terminalStatus', {}).get('finished') is True)
        receipt['recordingCoverage'] = {
            'initializationThroughTerminalResult': covered,
            'memorySamples': recorder.memory['samples'], 'cpuSamples': recorder.cpu['samples'],
            'complete': covered and recorder.memory['samples'] > 0 and recorder.cpu['samples'] > 0}
        if receipt['cleanupErrors']:
            receipt['status'] = 'failed'
        if receipt['status'] in {'passed', 'observed'} and not receipt['recordingCoverage']['complete']:
            receipt['status'] = 'failed'
            receipt['error'] = {'type': 'RecordingCoverageError',
                                'message': 'The workload does not have complete native recording coverage'}
        await publish(True)
    return receipt



def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Shared Safari recorder. Use safari_owner.py for live operations.')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--seconds', type=int, default=600)
    args = parser.parse_args(argv)
    if not 60 <= args.seconds <= 600:
        parser.error('--seconds must be between 60 and 600')
    return args


if __name__ == '__main__':
    arguments = parse_args()
    if arguments.execute:
        raise SystemExit('Use safari_owner.py --execute to retain the Safari session through testing and review')
    print(json.dumps({'status': 'inert', 'executeRequired': True, 'workloadSeconds': arguments.seconds,
                      'liveEntryPoint': 'safari_owner.py'}))
