"""Offline only: inert size/ping diagnostic scheduling and opt-in boundary."""
import asyncio
import json
import pathlib
import subprocess
import sys
import unittest

import safari_transport_diagnostic as diagnostic

FILE = pathlib.Path(diagnostic.__file__)


class Wire:
    def __init__(self, delayed=False):
        self.calls = []
        self.delayed = delayed
        self.flushed = asyncio.Event()
        self.pings = 0
        self.sequence = 0

    async def command(self, method, **params):
        self.calls.append((method, params))
        self.sequence += 1
        count = len(self.calls)
        if self.delayed and count in (2, 4):
            raise TimeoutError('Padded inert payload timed out')
        if self.delayed and count == 6:
            await self.flushed.wait()
        if params['returnByValue']:
            return {'result': {'type': 'object', 'value': {'at': 1000000, 'payloadLength': params['expression'].count('x')}}}
        return {'result': {'type': 'function', 'objectId': 'owned'}}

    async def evaluate(self, source, timeout):
        assert source == 'performance.now()'
        self.pings += 1
        self.sequence += 1
        self.flushed.set()
        return 250


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def run_cases(self, wire, stop=None):
        values = []
        async def sleep(seconds):
            self.assertEqual(seconds, .25)
            await asyncio.sleep(0)
        result = await diagnostic.observe_sizes(wire, diagnostic.transport.Budget(), stop or asyncio.Event(),
                                               lambda rows: values.append(len(rows)), sleep)
        return result, values

    async def test_no_ping_is_sent_when_inert_preparation_already_replied(self):
        wire = Wire()
        result, persisted = await self.run_cases(wire)
        self.assertEqual(len(result), 6)
        self.assertEqual(persisted, [1, 2, 3, 4, 5, 6])
        self.assertEqual(wire.pings, 0)
        self.assertTrue(result[5]['pingSkipped'])
        self.assertTrue(all(row['functionPrepared'] for row in result if row['kind'] == 'function'))
        self.assertEqual(result[3]['value']['payloadLength'], 20000)
        for method, params in wire.calls:
            self.assertEqual(method, 'Runtime.evaluate')
            self.assertFalse(params['emulateUserGesture'])
            self.assertEqual(params['objectGroup'], diagnostic.transport.OBJECT_GROUP)

    async def test_failed_large_command_is_recorded_and_only_explicit_ping_releases_next_large_case(self):
        wire = Wire(delayed=True)
        result, _ = await self.run_cases(wire)
        self.assertEqual(result[1]['error']['type'], 'TimeoutError')
        self.assertTrue(result[2]['functionPrepared'])
        self.assertEqual(result[3]['error']['type'], 'TimeoutError')
        self.assertEqual(result[4]['value']['payloadLength'], 0)
        self.assertTrue(result[5]['functionPrepared'])
        self.assertEqual(wire.pings, 1)
        self.assertEqual(result[5]['pingValue'], 250)
        self.assertEqual([params['expression'].count('x') for _, params in wire.calls], [0, 20000, 0, 20000, 0, 20000])

    async def test_stopped_diagnostic_dispatches_nothing(self):
        stop = asyncio.Event()
        stop.set()
        wire = Wire()
        result, _ = await self.run_cases(wire, stop)
        self.assertEqual(result, [])
        self.assertEqual(wire.calls, [])

    def test_no_argument_invocation_is_inert_without_device_imports(self):
        result = subprocess.run([sys.executable, '-B', str(FILE)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)['status'], 'inert')
        self.assertNotIn('pymobiledevice3', sys.modules)


if __name__ == '__main__':
    unittest.main()
