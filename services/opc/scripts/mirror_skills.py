"""Build the local third-party skill mirror using an installed aiopc-opc package."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from aiopc.skillhub.audit import CiscoScanner
from aiopc.skillhub.mirror import build_mirror


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--library", type=Path, default=Path.home() / ".aiopc" / "library")
    parser.add_argument("--scratch", type=Path, required=True, help="existing directory for temporary upstream clones")
    parser.add_argument("--scanner-python", type=Path, help="absolute interpreter path from the Cisco scanner environment")
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--repository", action="append", help="only mirror this owner/repo into a separate sample library")
    args = parser.parse_args()
    checkout = Path(__file__).resolve().parents[3]
    if any(path.resolve().is_relative_to(checkout) for path in (args.library, args.scratch)):
        parser.error("--library and --scratch must be outside the AIOPC worktree")
    if not args.scratch.is_dir():
        parser.error("--scratch must be an existing directory")
    if args.scanner_python is not None and not args.scanner_python.is_absolute():
        parser.error("--scanner-python must be absolute")
    if args.repository and args.library.resolve() == (Path.home() / ".aiopc" / "library").resolve():
        parser.error("a sample requires an explicit --library directory")
    report = build_mirror(
        args.catalog, args.library, args.scratch.resolve(), CiscoScanner(args.scanner_python), jobs=args.jobs,
        repositories={repo.casefold() for repo in args.repository} if args.repository else None,
        progress=lambda message: print(message, file=sys.stderr, flush=True),
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
