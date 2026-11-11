"""One retained connection to an existing Safari reader; explicit serialized commands."""
import argparse
import asyncio
import contextlib
import dataclasses
import fcntl
import json
import os
import pathlib
import plistlib
import signal
import tempfile
import time

import safari_runner as core
from safari_owned_run import run_owned
from safari_settings import Entry, REPOSITORY, Settings, Worker, add_arguments, add_worker_arguments, prefix, read_json, short_page_pair

SAFARI = 'com.apple.mobilesafari'
READINESS = '''(() => {
  let active=document.activeElement;
  while(active?.shadowRoot?.activeElement) active=active.shadowRoot.activeElement;
  const selection=getSelection(), app=window.PDFViewerApplication;
  const viewer=app?.pdfViewer, container=viewer?.container;
  return {url:location.href,visible:document.visibilityState,focused:document.hasFocus(),
    selectionCollapsed:selection?.isCollapsed ?? null,
    activeTag:active?.tagName ?? null,activeId:active?.id ?? null,
    editable:!!active?.matches('input,textarea,[contenteditable="true"]'),
    page:viewer?.currentPageNumber,scale:viewer?.currentScaleValue,
    top:container?.scrollTop,left:container?.scrollLeft,pages:app?.pdfDocument?.numPages,
    probePresent:!!(window.__spomenarSustainedProbe || window.__spomenarManualProbe || window.__spomenarSidecarProbe),
    probes:{sustained:!!window.__spomenarSustainedProbe,manual:!!window.__spomenarManualProbe,short:!!window.__spomenarSidecarProbe},
    screenWakeLockAvailable:!!navigator.wakeLock?.request};
})()'''


def command_request(value):
    if not isinstance(value, dict):
        raise ValueError('An owner command must be an object')
    identifier = prefix(value.get('id'))
    action = value.get('action')
    fields = {
        'status': set(), 'stop': set(), 'close': set(), 'resume': set(),
        'run': {'prefix', 'seconds', 'startMode', 'startWaitMs', 'scenario', 'pages'},
        'activate': {'prefix', 'sourceOnly', 'entrySha', 'entryBytes', 'workerUrl', 'workerSha', 'workerBytes'},
        'recover': {'prefix', 'receiptPrefix'}, 'transport-check': {'prefix'},
        'restore-focus': {'prefix', 'receiptPrefix', 'focusReceiptPrefix'},
    }
    if action not in fields or set(value) - {'id', 'action'} - fields[action]:
        raise ValueError('Unknown owner action or command fields')
    result = {'id': identifier, 'action': action}
    if action in {'run', 'activate', 'recover', 'transport-check', 'restore-focus'}:
        result['prefix'] = prefix(value.get('prefix'))
    if action in {'recover', 'restore-focus'}:
        result['receiptPrefix'] = prefix(value.get('receiptPrefix'))
    if action == 'restore-focus' and 'focusReceiptPrefix' in value:
        result['focusReceiptPrefix'] = prefix(value['focusReceiptPrefix'])
    if action == 'run':
        scenario = value.get('scenario', 'sustained')
        seconds = value.get('seconds', {'short': 60, 'traverse': 60, 'manual': 120}.get(scenario, 600))
        wait = value.get('startWaitMs', 60000)
        mode = value.get('startMode', 'immediate')
        if type(seconds) is not int or not 60 <= seconds <= 600 or \
                type(wait) is not int or not 1000 <= wait <= 300000 or \
                mode not in {'immediate', 'tap'} or scenario not in {'sustained', 'traverse', 'short', 'manual'}:
            raise ValueError('Invalid run duration, start mode or scenario')
        if mode == 'tap' and scenario not in {'sustained', 'traverse'}:
            raise ValueError('Tap start is available for sustained and traverse scenarios')
        if scenario == 'manual' and seconds > 300:
            raise ValueError('Manual observation is bounded to 300 seconds')
        if 'pages' in value:
            if scenario != 'short':
                raise ValueError('Page selection is supported only for the short scenario')
            result['pages'] = short_page_pair(value['pages'])
        result.update(seconds=seconds, startMode=mode, startWaitMs=wait, scenario=scenario)
    if action == 'activate':
        if type(value.get('sourceOnly', False)) is not bool:
            raise ValueError('sourceOnly must be a boolean')
        result['sourceOnly'] = value.get('sourceOnly', False)
        if 'entrySha' in value or 'entryBytes' in value:
            expected = Entry.expected(sha256=value.get('entrySha'), byte_count=value.get('entryBytes'))
            result.update(entrySha=expected.sha256, entryBytes=expected.bytes)
        if any(key in value for key in ('workerUrl', 'workerSha', 'workerBytes')):
            worker = Worker.expected(value.get('workerUrl'), sha256=value.get('workerSha'), byte_count=value.get('workerBytes'))
            result.update(workerUrl=worker.url, workerSha=worker.entry.sha256, workerBytes=worker.entry.bytes)
    return result


def control_directory(work):
    work = pathlib.Path(work).expanduser().resolve()
    if work == REPOSITORY or work.is_relative_to(REPOSITORY):
        raise ValueError('Runtime owner commands must remain outside the repository')
    return work / 'owner'


def submit(work, request):
    request = command_request(request)
    control = control_directory(work)
    if not (control / 'state.json').exists():
        raise RuntimeError('Start the retained owner before submitting a command')
    accepted = control / (request['id'] + '-accepted.json')
    if accepted.exists():
        raise FileExistsError('This command id was already consumed')
    with tempfile.NamedTemporaryFile(mode='w', dir=control, prefix='.command-', delete=False) as temporary:
        path = pathlib.Path(temporary.name)
        json.dump(request, temporary)
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        # Link a complete file only if no command is awaiting consumption.
        os.link(path, control / 'request.json')
    finally:
        path.unlink(missing_ok=True)
    return {'submitted': request['id'], 'action': request['action']}


class Owner:
    def __init__(self, settings, inspector, *, session=None, operation=run_owned, allow_reattach=True):
        self.settings = settings
        self.inspector = inspector
        self.session = session
        self.operation = operation
        self.allow_reattach = allow_reattach
        if not allow_reattach and session is None:
            raise ValueError('A borrowed owner requires the existing session')
        self.control = control_directory(settings.work)
        self.control.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.closing = asyncio.Event()
        self.stop_event = asyncio.Event()
        self.job = None
        self.job_request = None
        self.started = time.monotonic()
        self.state = {'pid': os.getpid(), 'status': 'attached' if session else 'awaiting-existing-book',
                      'attached': session is not None, 'retainedByOwner': True, 'startedAt': time.time()}

    def publish(self, **updates):
        self.state.update(updates, elapsedSeconds=round(time.monotonic() - self.started, 3))
        core.atomic_json(self.control / 'state.json', self.state)
        print(json.dumps(self.state), flush=True)

    async def readiness(self):
        if self.session is None:
            return {'available': False, 'error': 'The existing reader is not attached'}
        try:
            value = await core.Wire(self.session, core.Budget()).evaluate(READINESS)
            if not isinstance(value, dict) or not self.settings.document.owns_page(value.get('url')):
                raise RuntimeError('The retained target is no longer the selected reader')
            value.pop('url', None)
            return dict(value, available=True)
        except Exception as error:
            # A suspended page can stop answering while the connection remains owned.
            return {'available': False, 'error': {'type': type(error).__name__, 'message': str(error)}}

    def consume(self):
        request_path = self.control / 'request.json'
        if not request_path.exists():
            return None
        try:
            request = command_request(read_json(request_path, 4096))
            accepted = self.control / (request['id'] + '-accepted.json')
            if accepted.exists():
                raise ValueError('This command id was already consumed')
            # Persist consumption before any operation that can alter the reader.
            request_path.replace(accepted)
            return request
        except Exception as error:
            request_path.replace(self.control / ('rejected-' + str(time.time_ns()) + '.json'))
            self.publish(commandError={'type': type(error).__name__, 'message': str(error)})
            return None

    async def attach_existing(self):
        matches = []
        for app_id, pages in self.inspector.application_pages.items():
            app = self.inspector.connected_application.get(app_id)
            if not app or app.bundle != SAFARI:
                continue
            for page in pages.values():
                if self.settings.document.owns_page(page.web_url):
                    matches.append((app, page))
        if len(matches) != 1 or matches[0][1].web_connection_id:
            self.state['matchingPages'] = len(matches)
            return False
        async with asyncio.timeout(10):
            self.session = await self.inspector.inspector_session(*matches[0])
        self.publish(status='attached', attached=True, reader=await self.readiness())
        return True

    async def start_operation(self, request):
        if self.session is None or self.session._receive_task.done():
            raise RuntimeError('The selected existing reader is not attached')
        settings = self.settings
        if request['action'] == 'activate' and 'entrySha' in request:
            settings = dataclasses.replace(settings, entry=Entry.expected(
                sha256=request['entrySha'], byte_count=request['entryBytes']))
        if request['action'] == 'activate' and 'workerUrl' in request:
            worker = Worker.expected(request['workerUrl'], sha256=request['workerSha'], byte_count=request['workerBytes'])
            if not worker.url.startswith(settings.document.origin + '/'):
                raise ValueError('The worker artifact must belong to the selected page origin')
            settings = dataclasses.replace(settings, worker=worker)
        pages = None
        if 'pages' in request:
            if request['action'] != 'run' or request.get('scenario') != 'short':
                raise ValueError('Page selection is supported only for the short scenario')
            pages = short_page_pair(request['pages'], page_count=settings.document.pages)
        self.stop_event = asyncio.Event()
        self.job_request = request
        self.job = asyncio.create_task(self.operation(self.session, self.inspector, settings,
            request['prefix'], self.stop_event, operation=request['action'],
            receipt_prefix=request.get('receiptPrefix'), focus_receipt_prefix=request.get('focusReceiptPrefix'), seconds=request.get('seconds', 600),
            start_mode=request.get('startMode', 'immediate'), start_wait_ms=request.get('startWaitMs', 60000),
            source_only=request.get('sourceOnly', False), scenario=request.get('scenario', 'sustained'), pages=pages))
        self.publish(status='running', command=request['id'], action=request['action'], prefix=request['prefix'])

    async def handle(self, request):
        action = request['action']
        self.state.pop('commandError', None)
        if action in {'stop', 'close'}:
            self.stop_event.set()
            if action == 'close':
                self.closing.set()
            self.publish(command=request['id'], stopRequested=self.job is not None,
                         status='closing' if action == 'close' else self.state['status'])
            return
        if action == 'status':
            if self.job is None:
                self.state['reader'] = await self.readiness()
            self.publish(command=request['id'])
            return
        if self.job is not None:
            raise RuntimeError('An operation already owns native RPCs; use status or stop')
        if action == 'resume':
            before = getattr(self.session, 'target_id', None)
            # Existing Safari only: reuse this service, with no new browsing context.
            await self.inspector.open_app(SAFARI, timeout=5)
            if self.session is None:
                await self.attach_existing()
            after = getattr(self.session, 'target_id', None)
            self.publish(command=request['id'], resumeTargetChanged=before != after,
                         reader=await self.readiness())
            return
        await self.start_operation(request)

    async def finish_job(self):
        if self.job is None or not self.job.done():
            return
        request = self.job_request
        try:
            result = self.job.result()
            if request['action'] == 'activate' and result.get('status') == 'passed' and 'entrySha' in request:
                self.settings = dataclasses.replace(self.settings, entry=Entry.expected(
                    sha256=request['entrySha'], byte_count=request['entryBytes']))
            if request['action'] == 'activate' and result.get('status') == 'passed' and 'workerUrl' in request:
                self.settings = dataclasses.replace(self.settings, worker=Worker.expected(
                    request['workerUrl'], sha256=request['workerSha'], byte_count=request['workerBytes']))
            self.publish(status='attached', attached=result.get('attached', False),
                         runStatus=result['status'], result=request['prefix'] + '-result.json')
        except Exception as error:
            self.publish(status='attached-operation-error',
                         commandError={'type': type(error).__name__, 'message': str(error)})
        finally:
            self.job = None
            self.job_request = None
        # Failure here updates evidence; it never closes the retained service.
        self.publish(reader=await self.readiness())

    async def serve(self, listing_queue):
        self.publish()
        next_status = time.monotonic() + 30
        while not self.closing.is_set() or self.job is not None:
            await self.finish_job()
            if self.closing.is_set() and self.job is None:
                break
            request = self.consume()
            if request:
                try:
                    await self.handle(request)
                except Exception as error:
                    self.publish(command=request['id'],
                                 commandError={'type': type(error).__name__, 'message': str(error)})
            if self.job is None and not self.closing.is_set():
                if self.session is not None and self.session._receive_task.done():
                    if self.allow_reattach:
                        await close_session(self.inspector, self.session)
                        self.session = None
                        self.publish(status='awaiting-existing-book', attached=False)
                    elif self.state['status'] != 'borrowed-session-unavailable':
                        self.publish(status='borrowed-session-unavailable', attached=False,
                            reader={'available': False, 'error': 'The borrowed receiver ended; its original session is retained'})
                if self.session is None:
                    await self.attach_existing()
                elif not self.session._receive_task.done() and time.monotonic() >= next_status:
                    self.publish(reader=await self.readiness())
                    next_status = time.monotonic() + 30
            try:
                await asyncio.wait_for(listing_queue.get(), timeout=0.25)
            except TimeoutError:
                pass


async def close_session(inspector, session):
    errors = []
    try:
        async with asyncio.timeout(2):
            await inspector.teardown_inspector_socket(session.protocol.id_, session.protocol.app.id_, session.protocol.page.id_)
    except Exception as error:
        errors.append('inspector-socket: ' + type(error).__name__)
    session._receive_task.cancel()
    try:
        async with asyncio.timeout(2):
            await session._receive_task
    except asyncio.CancelledError:
        pass
    except Exception as error:
        errors.append('receiver: ' + type(error).__name__)
    return errors


async def serve(settings):
    # These optional live dependencies are never imported by offline commands/tests.
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.webinspector import WebinspectorService
    if settings.device_config is None:
        raise ValueError('The retained owner requires --device-config')
    settings.prepare_work()
    control = control_directory(settings.work)
    control.mkdir(exist_ok=True, mode=0o700)
    lock = (control / 'owner.lock').open('a+')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    inspector = lockdown = owner = queue = None
    loop = asyncio.get_running_loop()
    closing = asyncio.Event()

    def stop():
        closing.set()
        if owner:
            owner.closing.set()
            owner.stop_event.set()

    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop)
    try:
        device = read_json(settings.device_config)
        if not isinstance(device, dict) or set(device) != {'udid', 'pair_record'}:
            raise ValueError('Device settings require udid and pair_record')
        if not isinstance(device['udid'], str) or not 1 <= len(device['udid']) <= 256:
            raise ValueError('Device settings require one explicit paired device identifier')
        pair_path = pathlib.Path(device['pair_record']).expanduser().resolve()
        if pair_path == REPOSITORY or pair_path.is_relative_to(REPOSITORY):
            raise ValueError('Pairing records must remain outside the repository')
        pair_record = plistlib.loads(pair_path.read_bytes())
        async with asyncio.timeout(20):
            lockdown = await create_using_usbmux(serial=device['udid'], autopair=False,
                pair_record=pair_record, pairing_records_cache_folder=settings.work / 'pair-cache')
            inspector = WebinspectorService(lockdown)
            await inspector.connect()
            queue = inspector.subscribe_listings()
            await inspector.get_open_application_pages(timeout=1)
        owner = Owner(settings, inspector)
        if closing.is_set():
            owner.closing.set()
        await owner.serve(queue)
    finally:
        errors = []
        if owner and owner.job is not None:
            owner.stop_event.set()
            try:
                async with asyncio.timeout(55):
                    await asyncio.shield(owner.job)
            except Exception as error:
                errors.append('operation-cleanup: ' + type(error).__name__)
        if inspector and queue is not None:
            inspector.unsubscribe_listings(queue)
        if owner and owner.session:
            errors.extend(await close_session(inspector, owner.session))
        for label, resource in (('inspector', inspector), ('lockdown', lockdown)):
            if resource:
                try:
                    async with asyncio.timeout(2):
                        await resource.close()
                except Exception as error:
                    errors.append(label + ': ' + type(error).__name__)
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(signum)
        if owner:
            owner.publish(status='closed', attached=False, closeErrors=errors)
        lock.close()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode')
    live = sub.add_parser('serve', help='Retain the one existing paired Safari reader')
    add_arguments(live)
    command = sub.add_parser('command', help='Submit one consumed, explicit owner command')
    command.add_argument('--execute', action='store_true')
    command.add_argument('--work-dir')
    command.add_argument('--id')
    command.add_argument('action', choices=['status', 'run', 'activate', 'recover', 'resume', 'stop', 'close', 'transport-check', 'restore-focus'])
    command.add_argument('--prefix')
    command.add_argument('--receipt-prefix')
    command.add_argument('--focus-receipt-prefix', help='Original activation receipt, only for older short results without saved focus')
    command.add_argument('--seconds', type=int)
    command.add_argument('--start-mode', choices=['immediate', 'tap'])
    command.add_argument('--start-wait-ms', type=int)
    command.add_argument('--scenario', choices=['sustained', 'traverse', 'short', 'manual'])
    command.add_argument('--pages', nargs=2, type=int, metavar=('FIRST', 'SECOND'),
                         help='Two distinct PDF page numbers for the short scenario')
    command.add_argument('--source-only', action='store_true', default=None)
    command.add_argument('--entry-file')
    command.add_argument('--entry-sha')
    command.add_argument('--entry-bytes', type=int)
    add_worker_arguments(command)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if not getattr(args, 'execute', False):
        print(json.dumps({'status': 'inert', 'hint': 'Use serve or command with --execute for a live operation'}))
        return 0
    if args.mode == 'serve':
        asyncio.run(serve(Settings.from_args(args)))
        return 0
    if not args.work_dir:
        raise ValueError('An owner command requires --work-dir')
    request = {'id': args.id, 'action': args.action}
    for argument, field in [('prefix', 'prefix'), ('receipt_prefix', 'receiptPrefix'), ('focus_receipt_prefix', 'focusReceiptPrefix'), ('seconds', 'seconds'),
            ('start_mode', 'startMode'), ('start_wait_ms', 'startWaitMs'), ('scenario', 'scenario'),
            ('source_only', 'sourceOnly'), ('pages', 'pages')]:
        value = getattr(args, argument)
        if value is not None:
            request[field] = value
    if args.entry_file is not None or args.entry_sha is not None or args.entry_bytes is not None:
        expected = Entry.expected(filename=args.entry_file, sha256=args.entry_sha, byte_count=args.entry_bytes)
        request.update(entrySha=expected.sha256, entryBytes=expected.bytes)
    if any(getattr(args, name) is not None for name in ('worker_url', 'worker_file', 'worker_sha', 'worker_bytes')):
        worker = Worker.expected(args.worker_url, filename=args.worker_file,
                                 sha256=args.worker_sha, byte_count=args.worker_bytes)
        request.update(workerUrl=worker.url, workerSha=worker.entry.sha256, workerBytes=worker.entry.bytes)
    print(json.dumps(submit(args.work_dir, request)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
