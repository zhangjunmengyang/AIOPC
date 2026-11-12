"""Read-only worker launched by audit.py in the dedicated Cisco Python environment."""

import json
import sys
from contextlib import redirect_stdout
from pathlib import Path


def main() -> None:
    from skill_scanner import SkillScanner
    from skill_scanner.core.scan_policy import ScanPolicy

    targets = json.load(sys.stdin)
    with redirect_stdout(sys.stderr):
        scanner = SkillScanner(policy=ScanPolicy.from_preset("balanced"))
    try:
        for target in targets:
            try:
                with redirect_stdout(sys.stderr):
                    result = scanner.scan_skill(Path(target))
                report = {
                    "skill_path": result.skill_directory,
                    "is_safe": result.is_safe,
                    "findings_count": len(result.findings),
                    "findings": [{"severity": finding.severity.value} for finding in result.findings],
                    "analyzers_used": result.analyzers_used,
                    "analyzers_failed": bool(result.analyzers_failed),
                }
            except Exception:  # noqa: BLE001 - a scanner exception belongs to this target only
                # Error messages can quote third-party skill text.
                report = None
            print(json.dumps({"target": target, "report": report}), flush=True)
    finally:
        scanner.close()


if __name__ == "__main__":
    main()
