"""Stop processes and wait until they have exited, also processes that are not this one's children.

    python3 -I stop-processes.py (--group G | --pid P) [--signal TERM] --limit SECONDS

--group G stops the members of process group G, --pid P the one process P. The script opens a
pidfd for each process before it sends the signal, so that an exit between the listing and the
signal still counts, sends the signal (to the whole group with --group), and waits on the pidfds
until every process has ended. A group is listed again after its members have ended, for a process
that joined it meanwhile. SECONDS is the last resort for a process that ignores the signal.

Exit status 0 when every process has ended (also when they had ended before), 1 when some still run
after the limit (listed on stderr), 2 on wrong usage.
"""
import argparse
import os
import select
import signal
import sys
import time


def members(group):
    """The processes of process group `group` that have not exited, from /proc/<pid>/stat. A process
    that has exited stays listed, as a zombie, until its parent collects it; it counts as ended."""
    found = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            with open(f'/proc/{entry}/stat') as f:
                stat = f.read()
        except (FileNotFoundError, ProcessLookupError):
            continue  # ended since the listing
        # the command name, in parentheses, can hold spaces; after it: state, ppid, pgrp, ...
        state, _, pgrp = stat[stat.rindex(')') + 2:].split()[:3]
        if int(pgrp) == group and state not in ('Z', 'X'):
            found.append(int(entry))
    return found


def open_pidfds(pids):
    """pidfds of the processes of `pids` that still exist."""
    fds = {}
    for pid in pids:
        try:
            fds[pid] = os.pidfd_open(pid)
        except ProcessLookupError:
            pass
    return fds


def wait(fds, deadline):
    """Wait until the processes of `fds` end or the deadline passes; the ones still running."""
    poll = select.poll()
    for fd in fds.values():
        poll.register(fd, select.POLLIN)
    running = dict(fds)
    while running:
        left = deadline - time.monotonic()
        if left <= 0:
            break
        for fd, _ in poll.poll(left * 1000):
            poll.unregister(fd)
            running = {pid: f for pid, f in running.items() if f != fd}
    return running


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument('--group', type=int)
    which.add_argument('--pid', type=int)
    parser.add_argument('--signal', default='TERM')
    parser.add_argument('--limit', type=float, required=True)
    args = parser.parse_args()
    sig = getattr(signal, f'SIG{args.signal}')
    deadline = time.monotonic() + args.limit
    if args.pid is not None:
        fds = open_pidfds([args.pid])
        if fds:
            os.kill(args.pid, sig)
        running = wait(fds, deadline)
    else:
        fds = open_pidfds(members(args.group))
        if fds:
            try:
                os.killpg(args.group, sig)
            except ProcessLookupError:
                pass  # every member ended since the listing
        running = wait(fds, deadline)
        while not running:
            joined = open_pidfds(members(args.group))
            if not joined:
                break
            try:
                os.killpg(args.group, sig)
            except ProcessLookupError:
                pass  # every member ended since the listing
            running = wait(joined, deadline)
    for pid in running:
        print(f'process {pid} still runs {args.limit:g} s after SIG{args.signal}', file=sys.stderr)
    return 1 if running else 0


if __name__ == '__main__':
    sys.exit(main())
