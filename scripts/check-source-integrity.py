#!/usr/bin/env python3
"""Keep the canonical FortiPi requirements unchanged during the build."""

import hashlib
from pathlib import Path
import sys


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    manifest = root / ".agent-docs/source-integrity.sha256"
    failed = False
    for line in manifest.read_text().splitlines():
        expected, name = line.split("  ", 1)
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            print("Missing or invalid canonical source: " + name, file=sys.stderr)
            failed = True
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            print("Canonical source changed: " + name, file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
