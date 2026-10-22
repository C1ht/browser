# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""What tells the vault core's test build apart from the browser's.

The hooks for failure and crash tests (BWV_TESTING) must never reach the
browser. Each of these byte strings exists only in that test code; each
REQUIRED string is in the core proper, so a scan that finds it knows the
core really is in what it scanned.
"""

FORBIDDEN = [b"bwv_test_", b"bwv-test-only", b"BWV_CRASH_AT"]

# By object name (stem).
REQUIRED = {"bwvault": b"vault/v1/index", "bwvtxn": b"vault.bwv.new"}


def scan(data, required=None):
    """(forbidden strings found, whether `required` is present)."""
    found = [f.decode() for f in FORBIDDEN if f in data]
    return found, required is None or required in data
