import asyncio
import ast
import contextlib
import hashlib
import json
import pathlib
import re
import types
import unittest
from collections import deque

from safari_activation import Budget, error_message, guard_evaluate, release_check
import safari_runner as core
from test_support import DOCUMENT

ENTRY_URL, PDF_PATH = DOCUMENT.entry_url, DOCUMENT.pdf_path


class Clock:
    def __init__(self):
        self.at = 0

    def now(self):
        return self.at

    async def sleep(self, seconds):
        self.at += seconds
        await asyncio.sleep(0)


class Session:
    expected = b'const release = "14da5f8";\n'

    def __init__(self, *, current=False, context=True, child=False, ambiguous=False,
                 interrupt=False, bootstrap_timeout=False, restore_mismatch=False,
                 never_ready=False, debugger_cleanup_failure=False, navigated_away=False,
                 bootstrap_cleanup_failure=False, page_enable_timeout=False):
        self.responses, self.calls = {}, []
        self.current, self.context, self.child, self.ambiguous = current, context, child, ambiguous
        self.interrupt, self.bootstrap_timeout = interrupt, bootstrap_timeout
        self.restore_mismatch, self.never_ready = restore_mismatch, never_ready
        self.debugger_cleanup_failure = debugger_cleanup_failure
        self.navigated_away, self.bootstrap_cleanup_failure = navigated_away, bootstrap_cleanup_failure
        self.generation = 0
        self.recorded_input = False
        self.bootstrap = self.guard = False
        self.page_enabled = False
        self.page_enables = 0
        self.page_enable_timeout = page_enable_timeout
        self.ready_calls = self.restores = 0
        self.clock = Clock()
        self.saved = {'page': 59, 'top': 1000, 'left': 0, 'sidebar': 2, 'scaleValue': '0.9', 'scale': 0.9,
                      'rotation': 0, 'scrollMode': 0, 'spreadMode': 1, 'robots': True, 'lab': False,
                      'url': 'https://cloud.larics.fer.hr/spomenar/#page=59', 'focus': {'kind': 'body'}, 'visualScale': 1}

    async def command(self, method, timeout, **params):
        self.calls.append((method, params))
        if method == 'Page.enable':
            if self.page_enabled:
                raise RuntimeError('Page domain already enabled')
            self.page_enabled = True
            self.page_enables += 1
            if self.page_enable_timeout and self.page_enables == 2:
                raise TimeoutError('Page enable applied but acknowledgement missing')
        elif method == 'Page.disable':
            self.page_enabled = False
        elif method == 'Runtime.enable':
            if self.context:
                self.responses['Runtime.executionContextCreated']({'params': {'context': {'id': 7, 'frameId': 'main', 'type': 'normal'}}})
        elif method == 'Page.getResourceTree':
            return {'frameTree': {'frame': {'id': 'main', 'url': 'https://cloud.larics.fer.hr/spomenar/#page=59'},
                                 'resources': [{'url': ENTRY_URL}], 'childFrames': [{}] if self.child else []}}
        elif method == 'Debugger.enable':
            for number in range(2 if self.ambiguous else 1):
                event = {'scriptId': str(9 + number), 'url': ENTRY_URL}
                if self.context:
                    event['executionContextId'] = 7
                self.responses['Debugger.scriptParsed']({'params': event})
        elif method == 'Debugger.getScriptSource':
            return {'scriptSource': (self.expected if self.current or self.generation else b'const release = "old";\n').decode()}
        elif method == 'Debugger.disable' and self.debugger_cleanup_failure:
            raise TimeoutError('Debugger disable acknowledgement missing')
        elif method == 'Page.setBootstrapScript':
            self.bootstrap = 'source' in params
            if self.bootstrap and self.bootstrap_timeout:
                raise TimeoutError('Bootstrap applied but acknowledgement missing')
            if not self.bootstrap and self.bootstrap_cleanup_failure:
                raise TimeoutError('Bootstrap cleanup acknowledgement missing')
        elif method == 'Page.reload':
            if not self.bootstrap:
                raise AssertionError('Reload without native bootstrap')
            self.generation += 1
            self.guard = self.bootstrap and self.page_enabled
        return {}

    async def evaluate(self, source, timeout):
        action = source.split('/*release:', 1)[1].split('*/', 1)[0]
        self.calls.append(('evaluate:' + action, {}))
        if action == 'install':
            self.guard = True
            value = self.state()
        elif action in ('status', 'arm'):
            if self.generation:
                self.ready_calls += 1
            value = self.state()
        elif action == 'reload':
            if not self.bootstrap:
                raise AssertionError('Reload without native bootstrap')
            if self.recorded_input:
                raise RuntimeError('User interruption: touchstart')
            self.generation += 1
            self.guard = self.bootstrap and self.page_enabled
            value = {**self.state(), 'navigationRequested': True}
        elif action == 'capture':
            value = self.saved.copy()
        elif action == 'restore':
            if not self.state()['ready']:
                raise AssertionError('Restore ran before initial-view settlement')
            if self.interrupt and self.generation:
                raise AssertionError('Restore overwrote trusted input')
            self.restores += 1
            value = {'exact': not self.restore_mismatch, 'state': self.saved.copy()}
        elif action == 'verify':
            value = {'exact': not self.restore_mismatch, 'state': self.saved.copy()}
        elif action == 'cleanup':
            self.guard = self.navigated_away
            value = {'sameOrigin': not self.navigated_away, 'removed': not self.navigated_away}
        else:
            raise AssertionError(action)
        return {'value': value}

    def state(self):
        if self.generation and self.navigated_away:
            return {'missing': True, 'ownedLocation': False, 'transientBlank': False}
        if self.generation and not self.guard:
            return {'missing': True, 'ownedLocation': True, 'transientBlank': False}
        return {'token': 'test-token', 'origin': 1 + self.generation, 'expiresAt': 9999999,
                'interrupted': self.recorded_input or self.interrupt and bool(self.generation),
                'reason': 'touchstart' if self.recorded_input or self.interrupt and self.generation else None,
                'focused': True, 'visible': True, 'visualScale': 1, 'pdfPath': PDF_PATH,
                'ready': not self.generation or not self.never_ready and self.ready_calls >= 3,
                'reloadLifecycle': ['visibilitychange', 'pagehide'] if self.generation else []}

    async def run(self, source_only=False):
        return await release_check(self.command, self.evaluate, self.responses, document=DOCUMENT, source_only=source_only,
                                   expected_sha=hashlib.sha256(self.expected).hexdigest(), expected_bytes=len(self.expected),
                                   budget=Budget(now=self.clock.now, sleep=self.clock.sleep), token='test-token')


class ReleaseActivationTests(unittest.IsolatedAsyncioTestCase):
    async def test_matching_source_skips_guard_and_navigation(self):
        session = Session(current=True)
        result = await session.run()
        self.assertEqual(result['status'], 'current')
        self.assertFalse(result['navigationRequested'])
        self.assertFalse(any(name.startswith('evaluate:') or name == 'Page.setBootstrapScript' for name, _ in session.calls))
        self.assertIn(('Debugger.disable', {}), session.calls)
        self.assertEqual(session.responses, {})

    async def test_stale_source_only_remains_read_only(self):
        session = Session()
        result = await session.run(source_only=True)
        self.assertEqual(result['status'], 'stale')
        self.assertFalse(session.guard or session.bootstrap)
        self.assertNotIn(('Page.reload', {'ignoreCache': True}), session.calls)

    async def test_stale_reload_waits_for_initial_view_then_restores_and_verifies(self):
        session = Session()
        result = await session.run()
        self.assertEqual(result['status'], 'activated')
        self.assertGreaterEqual(session.ready_calls, 3)
        self.assertEqual(session.restores, 1)
        self.assertEqual(result['newGuard']['reloadLifecycle'], ['visibilitychange', 'pagehide'])
        self.assertTrue(result['restored']['exact'] and result['after']['matched'] and result['verified']['exact'])
        self.assertFalse(session.guard or session.bootstrap)

    async def test_page_domain_covers_bootstrap_reload_and_is_released_before_source_recheck(self):
        session = Session()
        result = await session.run()
        self.assertEqual(result['status'], 'activated')
        set_at = next(i for i, (name, params) in enumerate(session.calls)
                      if name == 'Page.setBootstrapScript' and 'source' in params)
        clear_at = next(i for i, (name, params) in enumerate(session.calls)
                        if i > set_at and name == 'Page.setBootstrapScript' and not params)
        reload_at = next(i for i, (name, _) in enumerate(session.calls) if name == 'evaluate:reload')
        enabled = False
        for i, (name, _) in enumerate(session.calls):
            if name == 'Page.enable':
                enabled = True
            elif name == 'Page.disable':
                if i > set_at:
                    self.assertGreater(i, clear_at, 'bootstrap must be cleared before Page release')
                enabled = False
            if i in (set_at, reload_at, clear_at):
                self.assertTrue(enabled)
        self.assertFalse(session.page_enabled)
        self.assertTrue(result['pageReleased'])

    async def test_ambiguous_page_enable_is_owned_and_disabled_without_bootstrap_or_navigation(self):
        session = Session(page_enable_timeout=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['navigationAttempted'])
        self.assertFalse(any(name == 'Page.setBootstrapScript' for name, _ in session.calls))
        self.assertFalse(session.page_enabled or session.guard or session.bootstrap)
        self.assertTrue(result['pageReleased'])

    async def test_recovery_clears_bootstrap_before_disabling_its_owned_page_domain(self):
        session = Session(never_ready=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        cleanup = [(name, bool(params)) for name, params in session.calls
                   if name in ('Page.setBootstrapScript', 'Page.disable')]
        self.assertEqual(cleanup[-2:], [('Page.setBootstrapScript', False), ('Page.disable', False)])
        self.assertFalse(session.page_enabled or session.guard or session.bootstrap)
        self.assertTrue(result['bootstrapCleared'] and result['pageReleased'])

    async def test_trusted_input_survives_navigation_and_prevents_rollback(self):
        session = Session(interrupt=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['interruption'], 'touchstart')
        self.assertEqual(session.restores, 0)
        self.assertTrue(result['bootstrapCleared'] and result['guardCleanup']['removed'])

    async def test_ambiguous_bootstrap_ack_is_cleared_before_any_reload(self):
        session = Session(bootstrap_timeout=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['navigationRequested'])
        self.assertTrue(result['bootstrapCleared'])
        self.assertFalse(session.bootstrap or session.guard)

    async def test_restore_mismatch_cannot_be_reported_as_activation(self):
        session = Session(restore_mismatch=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertIn('not restored exactly', result['error'])
        self.assertNotIn('after', result)
        self.assertFalse(session.bootstrap or session.guard)

    async def test_missing_initial_view_is_bounded_and_never_restored_early(self):
        session = Session(never_ready=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(session.restores, 0)
        self.assertLessEqual(result['elapsedMs'], 60000)
        self.assertTrue(result['bootstrapCleared'] and result['guardCleanup']['removed'])

    async def test_missing_context_relation_requires_one_main_frame_and_unique_script(self):
        result = await Session(current=True, context=False).run(source_only=True)
        self.assertEqual(result['status'], 'current')
        self.assertEqual(result['before']['binding'], 'single-main-frame-unique-entry')
        for session in [Session(current=True, context=False, child=True), Session(current=True, ambiguous=True)]:
            result = await session.run(source_only=True)
            self.assertEqual(result['status'], 'failed')
            self.assertFalse(result['navigationRequested'])

    async def test_source_match_still_fails_if_debugger_cleanup_is_unconfirmed(self):
        session = Session(current=True, debugger_cleanup_failure=True)
        result = await session.run(source_only=True)
        self.assertEqual(result['status'], 'failed')
        self.assertTrue(result['before']['matched'])
        self.assertTrue(result['before']['cleanupErrors'])
        self.assertEqual(session.responses, {})

    async def test_user_navigation_away_is_not_reversed_for_token_cleanup(self):
        session = Session(navigated_away=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['interruption'], 'navigated-away')
        self.assertEqual(session.restores, 0)
        self.assertEqual(sum(name == 'evaluate:reload' for name, _ in session.calls), 1)
        self.assertTrue(result['bootstrapCleared'])
        self.assertFalse(result['guardCleanup']['sameOrigin'])
        self.assertIn('guardExpiresAt', result)
        self.assertTrue(result['cleanupErrors'])

    async def test_unconfirmed_bootstrap_cleanup_is_retried_and_fails_the_receipt(self):
        session = Session(bootstrap_cleanup_failure=True)
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertGreaterEqual(sum(name == 'Page.setBootstrapScript' and not params for name, params in session.calls), 2)
        self.assertFalse(result['bootstrapCleared'])
        self.assertTrue(result['guardCleanup']['removed'])
        self.assertTrue(result['cleanupErrors'])

    async def test_late_recovery_cannot_spend_guard_cleanup_or_detach_allocation(self):
        session = Session()
        original_command, original_evaluate = session.command, session.evaluate
        cleanup_at = []

        async def command(method, timeout, **params):
            result = await original_command(method, timeout, **params)
            if method == 'Page.reload':
                session.clock.at = 45
                raise TimeoutError('Reload acted but its acknowledgement was lost at the work deadline')
            if method == 'Page.setBootstrapScript' and not params and session.generation:
                cleanup_at.append(('bootstrap', session.clock.at, timeout))
                session.clock.at += timeout
            return result

        async def evaluate(source, timeout):
            if '/*release:reload*/' in source:
                session.generation += 1
                session.clock.at = 45
                raise TimeoutError('Reload acted but its acknowledgement was lost at the work deadline')
            if '/*release:restore*/' in source:
                session.restores += 1
                session.clock.at += timeout
                raise TimeoutError('Recovery restore used its available bounded time')
            if '/*release:cleanup*/' in source:
                cleanup_at.append(('guard', session.clock.at, timeout))
                session.clock.at += timeout
            return await original_evaluate(source, timeout)

        session.command, session.evaluate = command, evaluate
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(session.restores, 1)
        self.assertTrue(result['bootstrapCleared'] and result['guardCleanup']['removed'])
        self.assertEqual([item[0] for item in cleanup_at], ['bootstrap', 'guard'])
        self.assertLessEqual(cleanup_at[0][1], 50, 'recovery must finish by its own phase deadline')
        self.assertLessEqual(session.clock.at, 55, 'required detach keeps its separate final five seconds')

    async def test_input_in_the_last_preparation_round_trip_cannot_trigger_reload(self):
        session = Session()
        original_evaluate = session.evaluate

        async def evaluate(source, timeout):
            if '/*release:reload*/' in source:
                session.recorded_input = True
                raise RuntimeError('User interruption: touchstart')
            result = await original_evaluate(source, timeout)
            if '/*release:arm*/' in source:
                session.recorded_input = True  # Old split RPC permitted input after its final guard.
            return result

        session.evaluate = evaluate
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(session.generation, 0, 'no navigation may follow the new trusted input')
        self.assertFalse(session.bootstrap or session.guard)

    async def test_navigation_context_loss_waits_for_new_guard_without_retrying_reload(self):
        session = Session()
        original_evaluate = session.evaluate

        async def evaluate(source, timeout):
            result = await original_evaluate(source, timeout)
            if '/*release:reload*/' in source:
                raise RuntimeError('Execution context was destroyed by navigation')
            return result

        session.evaluate = evaluate
        result = await session.run()
        self.assertEqual(result['status'], 'activated')
        self.assertEqual(result['navigationAcknowledgement'], 'context-lost')
        self.assertTrue(result['navigationObserved'])
        self.assertEqual(session.generation, 1)
        self.assertEqual(sum(name == 'evaluate:reload' for name, _ in session.calls), 1)

    async def test_ambiguous_reload_without_new_origin_cannot_restore_the_old_document(self):
        session = Session()
        original_evaluate = session.evaluate

        async def evaluate(source, timeout):
            if '/*release:reload*/' in source:
                session.clock.at = 45
                raise TimeoutError('Navigation acknowledgement missing without an observed new origin')
            return await original_evaluate(source, timeout)

        session.evaluate = evaluate
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(session.generation, 0)
        self.assertEqual(session.restores, 0)
        self.assertFalse(result['navigationRequested'])
        self.assertTrue(result['bootstrapCleared'] and result['guardCleanup']['removed'])
        self.assertLessEqual(result['elapsedMs'], 50000)

    async def test_lost_install_ack_cleans_the_same_guard_without_navigation(self):
        session = Session()
        original = session.evaluate
        async def evaluate(source, timeout):
            value = await original(source, timeout)
            if '/*release:install*/' in source:
                raise TimeoutError('Installation acted but its acknowledgement was lost')
            return value
        session.evaluate = evaluate
        result = await session.run()
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['navigationAttempted'] or result['navigationRequested'])
        self.assertFalse(session.guard or session.bootstrap)
        self.assertTrue(result['guardCleanup']['removed'])


class ReleaseTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = Clock()
        self.budget = core.Budget(now=self.clock.now)
        self.session = types.SimpleNamespace(target_id='old-target', message_id=1,
            send_message_to_target=self.send, receive_response_by_id=self.receive)
        self.wire = core.Wire(self.session, self.budget, allow_navigation=True)
        self.rpc = {'recent': self.wire.operations, 'errors': self.wire.failed_operations}
        self.calls = []
        self.fail_send = self.block_reply = self.lose_reload = False
        self.prepare_elapsed = 0
        self.installs = 0
        self.flushed = asyncio.Event()
        self.require_flush = self.lose_prepare_reply = self.lose_flush_reply = False
        self.waiters = set()
        self.consumed = []
        async def evaluate(source, timeout=8):
            return await guard_evaluate(self.wire, source, timeout)
        self.command, self.evaluate = self.wire.command, evaluate

    async def send(self, message):
        self.calls.append(message)
        if self.fail_send:
            raise TimeoutError()
        if message['params'].get('expression') == 'void 0':
            self.flushed.set()
        return len(self.calls)

    async def receive(self, identifier):
        call = self.calls[identifier - 1]
        self.waiters.add(identifier)
        prepare = call['method'] == 'Runtime.evaluate' and not call['params']['returnByValue']
        flush = call['params'].get('expression') == 'void 0'
        try:
            if self.block_reply or prepare and self.lose_prepare_reply or flush and self.lose_flush_reply:
                await asyncio.Future()
            if self.require_flush and (prepare or call['method'] == 'Page.setBootstrapScript' and 'source' in call['params']):
                await self.flushed.wait()
            self.consumed.append(identifier)
            return self.reply(call)
        finally:
            self.waiters.discard(identifier)

    def reply(self, call):
        if call['method'] == 'Runtime.evaluate':
            expression = call['params']['expression']
            if self.lose_reload and '/*release:reload*/' in expression:
                self.session.target_id = 'new-target'
                response = {'error': {'code': -32000, 'message': 'Execution context was destroyed by navigation'}}
                return {'params': {'message': json.dumps(response)}}
            if expression.startswith('(() => (/*release:'):
                self.clock.at += self.prepare_elapsed
                stage = re.search(r'/\*release:([a-z]+)\*/', expression).group(1)
                result = {'type': 'function', 'objectId': 'owned-' + stage + '-function'}
            else:
                self.assertTrue(call['params']['returnByValue'], 'synchronous controls must return their value directly')
                self.assertNotIn('(async', expression)
                result = {'type': 'object', 'value': {'ok': True, 'token': 'owned', 'ready': True}}
        elif call['method'] == 'Runtime.callFunctionOn':
            if call['params']['objectId'] == 'owned-install-function':
                self.installs += 1
            result = {'type': 'object', 'value': {'exact': True, 'token': 'owned'}}
        elif call['method'] == 'Page.setBootstrapScript':
            return {'params': {'message': '{"result":{}}'}}
        else:
            self.fail('Unexpected transport method ' + call['method'])
        return {'params': {'message': json.dumps({'result': {'result': result}})}}

    async def test_each_synchronous_guard_stage_returns_in_one_by_value_round_trip(self):
        for stage in ('status', 'capture', 'reload', 'verify', 'cleanup'):
            value = await self.evaluate('/*release:' + stage + '*/ ({ok:true,token:"owned"})')
            self.assertEqual(value['value']['token'], 'owned')
        self.assertEqual([call['method'] for call in self.calls], ['Runtime.evaluate'] * 5)
        self.assertEqual([row['purpose'].removeprefix('release-') for row in self.rpc['recent']],
                         ['status', 'capture', 'reload', 'verify', 'cleanup'])

    async def test_install_prepares_and_flushes_once_before_its_single_invocation(self):
        self.require_flush = True
        value = await self.evaluate('/*release:install*/ ({token:"owned"})')
        self.assertEqual(value['value']['token'], 'owned')
        self.assertEqual(self.installs, 1)
        self.assertEqual([call['method'] for call in self.calls],
                         ['Runtime.evaluate', 'Runtime.evaluate', 'Runtime.callFunctionOn'])
        self.assertFalse(self.calls[0]['params']['returnByValue'])
        self.assertEqual(self.calls[1]['params']['expression'], 'void 0')
        self.assertFalse(self.calls[2]['params']['awaitPromise'])
        self.assertEqual(sorted(self.consumed), [1, 2, 3])
        self.assertEqual(self.waiters, set())

    async def test_bootstrap_source_is_flushed_but_its_clear_has_no_extra_command(self):
        self.require_flush = True
        await self.command('Page.setBootstrapScript', source='void inertSource;', flush_after_send=True)
        await self.command('Page.setBootstrapScript')
        self.assertEqual([call['method'] for call in self.calls],
                         ['Page.setBootstrapScript', 'Runtime.evaluate', 'Page.setBootstrapScript'])
        self.assertEqual(self.calls[1]['params']['expression'], 'void 0')
        self.assertEqual(self.waiters, set())

    async def test_missing_authoritative_preparation_reply_cannot_install(self):
        self.lose_prepare_reply = True
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(.01):
                await self.evaluate('/*release:install*/ ({token:"owned"})')
        self.assertEqual(self.installs, 0)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.waiters, set())
        self.assertEqual(self.consumed, [2])

    async def test_missing_auxiliary_reply_allows_one_authorized_install(self):
        self.lose_flush_reply = True
        async with asyncio.timeout(.01):
            await self.evaluate('/*release:install*/ ({token:"owned"})')
        self.assertEqual(self.installs, 1)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.consumed, [1, 3])
        self.assertEqual(self.waiters, set())
        self.assertEqual(self.wire.operations[1]['outcome'], 'owned-release')
        self.assertEqual(list(self.wire.failed_operations), [])

    async def test_async_restore_is_prepared_inert_then_invoked_once_with_one_shared_budget(self):
        self.prepare_elapsed = 3
        value = await self.evaluate('/*release:restore*/ window.guard.restore({page:46})', timeout=8)
        self.assertTrue(value['value']['exact'])
        self.assertEqual([call['method'] for call in self.calls], ['Runtime.evaluate', 'Runtime.callFunctionOn'])
        self.assertFalse(self.calls[0]['params']['returnByValue'])
        self.assertTrue(self.calls[0]['params']['expression'].startswith('(() => ('))
        self.assertEqual(self.calls[1]['params']['objectId'], 'owned-restore-function')
        self.assertTrue(self.calls[1]['params']['awaitPromise'])
        self.assertTrue(self.calls[1]['params']['returnByValue'])
        self.assertEqual(list(self.rpc['recent'])[1]['timeoutSeconds'], 5)

    async def test_restore_is_not_invoked_after_preparation_spends_its_budget(self):
        self.prepare_elapsed = 9
        with self.assertRaisesRegex(TimeoutError, 'before its one invocation'):
            await self.evaluate('/*release:restore*/ window.guard.restore({page:46})', timeout=8)
        self.assertEqual(len(self.calls), 1)

    async def test_missing_send_ack_records_method_type_stage_and_nonempty_message(self):
        self.fail_send = True
        with self.assertRaisesRegex(TimeoutError, r'Runtime.evaluate timed out during sending'):
            await self.evaluate('/*release:install*/ ({private:"not retained"})')
        row = self.rpc['errors'][0]
        self.assertEqual(row['errorType'], 'TimeoutError')
        self.assertEqual(row['purpose'], 'release-install')
        self.assertIn('elapsedMs', row)
        self.assertNotIn('sendCompletedHostMs', row)
        self.assertNotIn('not retained', json.dumps(row))

    async def test_outer_timeout_keeps_the_actual_reply_wait_and_exception_type(self):
        self.block_reply = True
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(.005):
                await self.evaluate('/*release:status*/ ({ready:true})')
        row = self.rpc['errors'][0]
        self.assertEqual(row['errorType'], 'CancelledError')
        self.assertEqual(row['phase'], 'waiting-reply')
        self.assertIn('sendCompletedHostMs', row)
        self.assertNotIn('replyConsumedHostMs', row)

    async def test_navigation_context_loss_keeps_its_reason_and_new_target_can_be_observed(self):
        self.lose_reload = True
        with self.assertRaises(core.NativeProtocolError) as raised:
            await self.evaluate('/*release:reload*/ window.guard.reload({page:46})')
        self.assertIn('Execution context was destroyed', error_message(raised.exception))
        value = await self.evaluate('/*release:status*/ window.guard.status()')
        self.assertTrue(value['value']['ready'])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.session.target_id, 'new-target')


if __name__ == '__main__':
    unittest.main()
