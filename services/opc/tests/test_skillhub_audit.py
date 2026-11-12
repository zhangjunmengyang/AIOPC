import json
import subprocess
from pathlib import Path

import pytest

from aiopc.skillhub.audit import CiscoScanner, validate_skill


def test_validate_agent_skills_frontmatter_and_original_directory():
    source = """---
name: 复刻-landing
description: >-
  Rebuild a marketing site.
  Use it when matching an existing layout.
license: MIT
compatibility: Requires a browser.
metadata:
  version: "1.0"
allowed-tools: Read
---
# Skill instructions
"""
    metadata, result = validate_skill(source, "复刻-landing")
    assert result.to_dict() == {"status": "passed", "details": []}
    assert metadata["description"] == "Rebuild a marketing site. Use it when matching an existing layout."
    assert metadata["license"] == "MIT"
    assert validate_skill(source, "generated-id")[1].status == "failed"


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("name: valid", "frontmatter"),
        ("---\nname: valid\n", "frontmatter"),
        ("---\n- item\n---", "mapping"),
        ("---\n!!map item\n---", "YAML"),
        ("---\nname: valid\nname: valid\ndescription: Use me\n---", "duplicate"),
        ("---\nname: &name valid\ndescription: *name\n---", "YAML"),
        ("---\nname: a--b\ndescription: Use me\n---", "name"),
        ("---\nname: valid\ndescription: false\n---", "description"),
        (f"---\nname: valid\ndescription: {'a' * 1025}\n---", "1024"),
        (f"---\nname: {'a' * 65}\ndescription: Use me\n---", "64"),
        (f"---\nname: valid\ndescription: Use me\ncompatibility: {'a' * 501}\n---", "500"),
        ("---\nname: valid\ndescription: Use me\nmetadata:\n  extra: [one, two]\n---", "metadata"),
        ("---\nname: valid\ndescription: Use me\nunknown: value\n---", "unsupported"),
    ],
)
def test_invalid_agent_skills_metadata_is_reported(source, expected):
    _, result = validate_skill(source, "valid")
    assert result.status == "failed"
    assert any(expected in detail for detail in result.details)


def _report(path, **changes):
    return {
        "skill_path": str(path.resolve()),
        "skill_name": "valid",
        "analyzers_used": ["static_analyzer"],
        "is_safe": True,
        "findings_count": 0,
        "findings": [],
        **changes,
    }


def _fake_scanner(monkeypatch, report, code=0):
    def run(args, **kwargs):
        assert args[1] == "-I"
        assert Path(args[2]).name == "_cisco_worker.py"
        target = json.loads(kwargs["input"])[0]
        assert "SKILL_SCANNER_LLM_API_KEY" not in kwargs["env"]
        assert Path(kwargs["cwd"]) != Path(target)
        return subprocess.CompletedProcess(args, code, json.dumps({"target": target, "report": report}) + "\n", "")

    monkeypatch.setattr(subprocess, "run", run)


def test_cisco_scan_pass_requires_completed_static_report(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILL_SCANNER_LLM_API_KEY", "unit-test")
    _fake_scanner(monkeypatch, _report(tmp_path))
    result = CiscoScanner("/trusted/venv/bin/python").scan(tmp_path)
    assert result.status == "passed"
    assert result.details


def test_cisco_scan_marks_high_findings_as_failed(tmp_path, monkeypatch):
    _fake_scanner(
        monkeypatch,
        _report(tmp_path, is_safe=False, findings_count=1, findings=[{"severity": "HIGH"}]),
    )
    result = CiscoScanner("/trusted/venv/bin/python").scan(tmp_path)
    assert result.status == "failed"
    assert any("HIGH" in detail for detail in result.details)


@pytest.mark.parametrize(
    "overrides",
    [
        {"is_safe": "true"},
        {"analyzers_used": []},
        {"analyzers_failed": [{"analyzer": "static_analyzer", "error": "unavailable"}]},
        {"skill_path": "/wrong-skill"},
        {"findings_count": 1},
        {"is_safe": True, "findings_count": 1, "findings": [{"severity": "HIGH"}]},
        {"is_safe": False, "findings_count": 0, "findings": []},
    ],
)
def test_cisco_scan_rejects_incomplete_or_inconsistent_evidence(tmp_path, monkeypatch, overrides):
    _fake_scanner(monkeypatch, _report(tmp_path, **overrides))
    assert CiscoScanner("/trusted/venv/bin/python").scan(tmp_path).status == "unreachable"


def test_cisco_scan_states_for_disabled_and_missing_interpreter(tmp_path):
    assert CiscoScanner(None).scan(tmp_path).status == "skipped"
    assert CiscoScanner(tmp_path / "missing-python").scan(tmp_path).status == "unreachable"


def test_cisco_scan_times_out(tmp_path, monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", timeout)
    result = CiscoScanner("/trusted/venv/bin/python", timeout=0.5).scan(tmp_path)
    assert result.status == "unreachable"
    assert any("timeout" in detail for detail in result.details)


def test_batch_records_each_path_and_keeps_reports_before_timeout(tmp_path, monkeypatch):
    scanned = tmp_path / "scanned"
    pending = tmp_path / "pending"

    def run(args, **kwargs):
        paths = json.loads(kwargs["input"])
        assert paths == [str(scanned.resolve()), str(pending.resolve())]
        output = json.dumps({"target": paths[0], "report": _report(scanned)}) + "\n"
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"], output.encode("utf-8"))

    monkeypatch.setattr(subprocess, "run", run)
    result = CiscoScanner("/trusted/venv/bin/python", timeout=0.5).scan_many([scanned, pending])
    assert result[scanned].status == "passed"
    assert result[pending].status == "unreachable"
