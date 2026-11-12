"""Format validation and isolated, static Cisco Skill Scanner results."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unicodedata
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import yaml

AuditStatus = Literal["passed", "failed", "unreachable", "skipped"]
_FIELDS = {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}
_HEADER = re.compile(r"\A\ufeff?---[ \t]*\r?\n")
_CLOSING = re.compile(r"^---[ \t]*\r?$", re.MULTILINE)
_MAX_FRONTMATTER = 64 * 1024
_SEVERITIES = ("CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO")
_WORKER = Path(__file__).with_name("_cisco_worker.py").resolve()


@dataclass(frozen=True)
class AuditResult:
    status: AuditStatus
    details: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, str | list[str]]:
        return {"status": self.status, "details": list(self.details)}


class _DuplicateKey(yaml.YAMLError):
    pass


class _SkillLoader(yaml.SafeLoader):
    def compose_node(self, parent, index):
        if getattr(self.peek_event(), "anchor", None) is not None:
            raise yaml.YAMLError("YAML anchors and aliases are unsupported")
        return super().compose_node(parent, index)

    def construct_mapping(self, node, deep=False):
        if not isinstance(node, yaml.MappingNode):
            raise yaml.YAMLError("expected a YAML mapping node")
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        if any(not isinstance(key, str) for key in keys):
            raise yaml.YAMLError("YAML mapping keys must be strings")
        if len(set(keys)) != len(keys):
            raise _DuplicateKey
        return super().construct_mapping(node, deep=deep)


def validate_skill(source: str, directory_name: str) -> tuple[dict, AuditResult]:
    """Validate Agent Skills frontmatter against the original directory name."""
    opening = _HEADER.match(source)
    closing = opening and _CLOSING.search(source, opening.end(), opening.end() + _MAX_FRONTMATTER)
    if not opening or not closing or source[closing.end() : closing.end() + 1] not in ("", "\n"):
        return {}, AuditResult("failed", ("missing or oversized YAML frontmatter",))

    try:
        metadata = yaml.load(source[opening.end() : closing.start()], Loader=_SkillLoader)
    except _DuplicateKey:
        return {}, AuditResult("failed", ("duplicate YAML mapping key",))
    except (yaml.YAMLError, RecursionError, ValueError):
        return {}, AuditResult("failed", ("invalid YAML frontmatter",))
    if not isinstance(metadata, dict):
        return {}, AuditResult("failed", ("YAML frontmatter must be a mapping",))

    issues = []
    name = metadata.get("name")
    if not isinstance(name, str) or not 1 <= len(name) <= 64:
        issues.append("name must be a string of 1 to 64 characters")
    else:
        normalized = unicodedata.normalize("NFKC", name)
        if (
            len(normalized) > 64
            or normalized != normalized.lower()
            or normalized.startswith("-")
            or normalized.endswith("-")
            or "--" in normalized
            or not all(char.isalnum() or char == "-" for char in normalized)
        ):
            issues.append("name must be lowercase alphanumeric with optional single internal hyphens")
        if normalized != unicodedata.normalize("NFKC", directory_name):
            issues.append("name must match the original skill directory")

    description = metadata.get("description")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        issues.append("description must be a non-empty string of at most 1024 characters")
    if "compatibility" in metadata:
        compatibility = metadata["compatibility"]
        if not isinstance(compatibility, str) or not compatibility.strip() or len(compatibility) > 500:
            issues.append("compatibility must be a non-empty string of at most 500 characters")
    for field in ("license", "allowed-tools"):
        if field in metadata and not isinstance(metadata[field], str):
            issues.append(f"{field} must be a string")
    if "metadata" in metadata:
        properties = metadata["metadata"]
        if not isinstance(properties, dict) or not all(isinstance(value, str) for value in properties.values()):
            issues.append("metadata must map strings to strings")
    if metadata.keys() - _FIELDS:
        issues.append("unsupported field in frontmatter")
    return metadata, AuditResult("failed" if issues else "passed", tuple(issues))


def _report_status(report: object, target: str) -> AuditResult:
    invalid = AuditResult("unreachable", ("Cisco scanner returned an incomplete or inconsistent report",))
    if not isinstance(report, dict) or report.get("skill_path") != target:
        return invalid
    verdict = report.get("is_safe")
    findings = report.get("findings")
    count = report.get("findings_count")
    if not isinstance(verdict, bool) or not isinstance(findings, list) or type(count) is not int or count != len(findings):
        return invalid
    counts = Counter()
    for finding in findings:
        if not isinstance(finding, dict) or finding.get("severity") not in _SEVERITIES:
            return invalid
        counts[finding["severity"]] += 1

    details = tuple(f"{level}: {counts[level]}" for level in _SEVERITIES if counts[level])
    blocked = bool(counts["CRITICAL"] or counts["HIGH"])
    if verdict == blocked:
        return invalid
    if blocked:
        return AuditResult("failed", details)
    analyzers = report.get("analyzers_used")
    if not isinstance(analyzers, list) or "static_analyzer" not in analyzers or report.get("analyzers_failed"):
        return invalid
    return AuditResult("passed", ("Cisco static scan completed", *details))


class CiscoScanner:
    """Use the Cisco SDK in a separate Python environment with only bundled analyzers."""

    def __init__(self, python: str | Path | None, *, timeout: float = 45) -> None:
        self.python = os.fspath(python) if python is not None else None
        if self.python is not None and not Path(self.python).is_absolute():
            raise ValueError("Cisco scanner Python must use an absolute path")
        self.timeout = timeout

    def scan(self, skill_directory: Path) -> AuditResult:
        return self.scan_many([skill_directory])[skill_directory]

    def scan_many(self, skill_directories: Iterable[Path]) -> dict[Path, AuditResult]:
        directories = list(skill_directories)
        if not directories:
            return {}
        if self.python is None:
            return dict.fromkeys(directories, AuditResult("skipped", ("Cisco scanner disabled",)))

        targets = {directory: str(directory.resolve()) for directory in directories}
        missing = AuditResult("unreachable", ("Cisco scanner returned no result",))
        with tempfile.TemporaryDirectory(prefix="aiopc-cisco-") as scratch:
            try:
                process = subprocess.run(
                    [self.python, "-I", str(_WORKER)],
                    input=json.dumps(list(dict.fromkeys(targets.values()))),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    encoding="utf-8",
                    errors="replace",
                    cwd=scratch,
                    env={
                        "HOME": scratch,
                        "TMPDIR": scratch,
                        "PATH": os.defpath,
                        "LITELLM_LOCAL_MODEL_COST_MAP": "True",
                        "LITELLM_TELEMETRY": "False",
                        "DO_NOT_TRACK": "1",
                    },
                    timeout=self.timeout,
                    check=False,
                )
                output = process.stdout
                if process.returncode:
                    missing = AuditResult("unreachable", (f"Cisco scanner exited with code {process.returncode}",))
            except subprocess.TimeoutExpired as error:
                output = (error.output or b"").decode("utf-8", errors="replace")
                missing = AuditResult("unreachable", ("Cisco scanner timeout",))
            except OSError:
                return dict.fromkeys(directories, AuditResult("unreachable", ("Cisco scanner could not start",)))

        results: dict[str, AuditResult] = {}
        expected_targets = set(targets.values())
        for line in output.splitlines():
            try:
                evidence = json.loads(line)
            except (ValueError, RecursionError):
                continue
            if not isinstance(evidence, dict) or not isinstance(evidence.get("target"), str):
                continue
            target = evidence["target"]
            if target not in expected_targets:
                continue
            if target in results:
                results[target] = AuditResult("unreachable", ("Cisco scanner returned duplicate results",))
            else:
                results[target] = _report_status(evidence.get("report"), target)
        return {directory: results.get(target, missing) for directory, target in targets.items()}
