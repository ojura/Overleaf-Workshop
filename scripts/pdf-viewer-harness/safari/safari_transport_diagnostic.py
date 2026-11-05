"""Inert payload-size diagnostic on a supplied, retained native session."""
import asyncio
import json
import time

import safari_runner as transport


def inert_source(padding):
    # The function body is never invoked. There are no document/global writes.
    return '(() => { /*' + 'x' * padding + '*/ return 1; })'


def reply_fields(result):
    remote = result.get('result', {})
    fields = {'functionPrepared': remote.get('type') == 'function' and bool(remote.get('objectId')),
              'wasThrown': result.get('wasThrown', False)}
    value = remote.get('value')
    if isinstance(value, dict):
        fields['value'] = {key: value[key] for key in ('at', 'payloadLength') if transport.number(value.get(key))}
    return fields


async def observe_sizes(wire, budget, stop, persist, sleep=asyncio.sleep):
    cases = []
    for label, kind, padding, ping_after in (
        ('small-value-first', 'value', 0, None), ('large-function-alone', 'function', 20000, None),
        ('small-function-after-large', 'function', 0, None), ('large-value-alone', 'value', 20000, None),
        ('small-value-after-large', 'value', 0, None), ('large-function-with-ping', 'function', 20000, .25),
    ):
        if stop.is_set() or budget.remaining('work') <= 0:
            break
        row = {'label': label, 'kind': kind, 'paddingBytes': padding, 'startedHostMs': budget.now() * 1000,
               'startedWallMs': time.time() * 1000, 'rpcSequence': wire.sequence + 1}
        cases.append(row)
        limit = min(3, budget.remaining('work'))
        source = inert_source(padding) if kind == 'function' else '({at:Date.now(),payloadLength:' + json.dumps('x' * padding) + '.length})'
        operation = asyncio.create_task(wire.command('Runtime.evaluate', timeout=limit,
            expression=source, returnByValue=kind == 'value',
            emulateUserGesture=False, objectGroup=transport.OBJECT_GROUP))
        async def ping():
            await sleep(ping_after)
            if operation.done() or stop.is_set() or budget.remaining('work') <= 0:
                row['pingSkipped'] = True
                return
            row['pingStartedHostMs'] = budget.now() * 1000
            try:
                row['pingValue'] = await wire.evaluate('performance.now()', timeout=min(3, budget.remaining('work')))
                row['pingFinishedHostMs'] = budget.now() * 1000
            except Exception as error:
                row['pingError'] = {'type': type(error).__name__, 'message': str(error)}
        ping_task = asyncio.create_task(ping()) if ping_after is not None else None
        try:
            result = await operation
            row.update(reply_fields(result))
        except Exception as error:
            row['error'] = {'type': type(error).__name__, 'message': str(error)}
        finally:
            if ping_task:
                await ping_task
            row['finishedHostMs'] = budget.now() * 1000
            row['finishedWallMs'] = time.time() * 1000
            persist(cases)
    return cases


async def run_diagnostic(wire, session, budget, stop_event, checkpoint, recorder):
    output = {'kind': 'inert-size-and-ping', 'status': 'running', 'cases': []}
    def persist(cases):
        output['cases'] = cases
        by_sequence = {case['rpcSequence']: case for case in cases}
        for identifier, operation in wire.id_rows.items():
            case = by_sequence.get(operation['sequence'])
            if case:
                case['innerId'] = identifier
                raw = session._dispatch_message_responses.get(identifier)
                if raw:
                    message = json.loads(raw['params']['message'])
                    case['lateReply'] = reply_fields(message.get('result', {}))
                    case['lateReply']['receivedHostMs'] = operation.get('replyReceivedHostMs')
        checkpoint(output, recorder)
    try:
        cases = await observe_sizes(wire, budget, stop_event, persist)
        output['status'] = 'observed' if len(cases) == 6 else 'interrupted'
    except Exception as error:
        output.update(status='failed', error={'type': type(error).__name__, 'message': str(error)})
    persist(output['cases'])
    return output


if __name__ == '__main__':
    print(json.dumps({'status': 'inert', 'liveEntryPoint': 'safari_owner.py command --execute transport-check'}))
