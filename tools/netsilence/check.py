# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Evaluate the logs written by run.sh. Exit 0 if the browser stayed silent."""

import ipaddress
import re
import sys
from pathlib import Path

LOCAL_HOSTS = {"localhost", "localhost.localdomain", ""}

RESOLVE = re.compile(r"Resolving host \[([^\]]*)\]")
SOCKET = re.compile(r"nsSocketTransport::Init(?:WithConnectedSocket)? \[.*?host=([^:\s\]]+):(\d+)")
STRACE_V4 = re.compile(r"(connect|sendto)\(.*sa_family=AF_INET,.*sin_port=htons\((\d+)\), sin_addr=inet_addr\(\"([\d.]+)\"\)")
STRACE_V6 = re.compile(r"(connect|sendto)\(.*sa_family=AF_INET6,.*sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6, \"([0-9a-fA-F:.]+)\"")


def is_local_address(addr):
    ip = ipaddress.ip_address(addr)
    return ip.is_loopback or ip.is_unspecified


def main(work):
    work = Path(work)
    gecko_logs = sorted(work.glob("gecko.log*"))
    if not gecko_logs:
        print("netsilence: INVALID - the browser wrote no Gecko log; did it start?")
        print((work / "stdout.log").read_text(errors="replace")[-2000:])
        return 2

    violations = []
    for log in gecko_logs:
        for line in log.read_text(errors="replace").splitlines():
            m = RESOLVE.search(line)
            if m and m.group(1).lower() not in LOCAL_HOSTS:
                violations.append(f"{log.name}: DNS lookup of {m.group(1)}")
            m = SOCKET.search(line)
            if m and m.group(1).lower() not in LOCAL_HOSTS:
                try:
                    if is_local_address(m.group(1)):
                        continue
                except ValueError:
                    pass
                violations.append(f"{log.name}: socket to {m.group(1)}:{m.group(2)}")

    strace = work / "strace.log"
    syscalls = 0
    for line in strace.read_text(errors="replace").splitlines() if strace.exists() else []:
        for pattern in (STRACE_V4, STRACE_V6):
            m = pattern.search(line)
            if m:
                syscalls += 1
                call, port, addr = m.groups()
                if not is_local_address(addr):
                    violations.append(f"strace: {call} to {addr}:{port}")

    processes = len(gecko_logs)
    print(f"netsilence: checked {processes} process log(s) and {syscalls} socket syscall(s)")
    if violations:
        print("netsilence: FAIL - outbound network activity:")
        for v in dict.fromkeys(violations):
            print("  " + v)
        return 1
    print("netsilence: PASS - no outbound network activity")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
