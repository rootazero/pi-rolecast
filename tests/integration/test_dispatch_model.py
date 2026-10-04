"""End-to-end PoC: verify model bindings flow through pi-subagents dispatch.

Two layers of verification:

1. **Contract test** (deterministic). Read the project-local agent file written
   by `sync_settings.py` and verify the frontmatter `model:` field is in
   `provider/modelId` format. This is the side of the contract that
   `sync_settings.py` controls.

2. **Behavioral test** (LLM-driven). Invoke `pi -p` with a directive that
   forces the main LLM to call the `Agent` tool with `subagent_type`. The
   subagent runs in background and writes its transcript to a known file.
   Read that file and verify the model used by the subagent matches the
   binding from the agent md — not the parent default.

The behavioral test proves the SWITCH happens: it would FAIL if
sync_settings.py silently fell back to the parent model.

Requires:
    - `pi` CLI on PATH
    - `python3` with stdlib only
    - A project with `.pi/agent-workflow.yaml` + `.pi/agents/*.md` populated
      by `sync_settings.py`. By default the test uses `/tmp/real-workflow-test`
      (override via `PI_DISPATCH_TEST_PROJECT` env var).

Run with:
    python3 tests/integration/test_dispatch_model.py
    pytest tests/integration/test_dispatch_model.py -v -s
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from typing import Optional

DEFAULT_PROJECT = "/tmp/real-workflow-test"
PROJECT_ENV = "PI_DISPATCH_TEST_PROJECT"
# A role whose binding is known to differ from the parent default. Using
# `planner` (bound to deepseek/deepseek-flash in the test project) instead of
# `architect` (bound to the same model as the parent default) makes the
# "switch happened" assertion meaningful.
TEST_ROLE = "planner"
# How long to wait for the background subagent to write its transcript file.
SUBAGENT_POLL_TIMEOUT_S = 90
SUBAGENT_POLL_INTERVAL_S = 2


def _project_root() -> Path:
    return Path(os.environ.get(PROJECT_ENV, DEFAULT_PROJECT))


def _read_agent_model(project: Path, role: str) -> tuple[Optional[str], Optional[str]]:
    """Return (provider, modelId) parsed from the agent md frontmatter.

    Returns (None, None) if the file is missing or malformed.
    """
    md = project / ".pi/agents" / f"{role}.md"
    if not md.is_file():
        return None, None
    text = md.read_text()
    m = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not m:
        return None, None
    fm = m.group(1)
    model_match = re.search(r"^model:\s*(.+)$", fm, re.MULTILINE)
    if not model_match:
        return None, None
    model = model_match.group(1).strip().strip("\"")
    if "/" not in model:
        return None, None
    provider, model_id = model.split("/", 1)
    return provider, model_id


class ContractTest(unittest.TestCase):
    """The sync_settings.py contract: every binding writes provider/modelId."""

    def setUp(self):
        self.project = _project_root()
        if not (self.project / ".pi/agent-workflow.yaml").is_file():
            self.skipTest(f"no project at {self.project}; set ${PROJECT_ENV}")

    def test_planner_binding_has_provider_prefix(self):
        provider, model_id = _read_agent_model(self.project, TEST_ROLE)
        self.assertIsNotNone(provider, "agent md missing model field")
        self.assertIsNotNone(model_id, "model field has no slash → provider/ prefix")
        self.assertTrue(provider, "provider part is empty")
        self.assertTrue(model_id, "modelId part is empty")

    def test_all_role_bindings_have_provider_prefix(self):
        agents_dir = self.project / ".pi/agents"
        if not agents_dir.is_dir():
            self.skipTest(f"no agents dir at {agents_dir}")
        for md in sorted(agents_dir.glob("*.md")):
            provider, model_id = _read_agent_model(self.project, md.stem)
            with self.subTest(role=md.stem):
                self.assertTrue(
                    provider and model_id,
                    f"{md.name}: model field missing provider/modelId format",
                )


class BehavioralTest(unittest.TestCase):
    """The pi-subagents contract: dispatch uses the bound model."""

    def setUp(self):
        self.project = _project_root()
        if not (self.project / ".pi/agent-workflow.yaml").is_file():
            self.skipTest(f"no project at {self.project}; set ${PROJECT_ENV}")
        if not _which("pi"):
            self.skipTest("pi CLI not on PATH")
        provider, model_id = _read_agent_model(self.project, TEST_ROLE)
        if not (provider and model_id):
            self.skipTest(f"{TEST_ROLE}.md has no provider/modelId binding")
        self.bound_provider = provider
        self.bound_model_id = model_id

    def test_agent_tool_dispatch_uses_bound_model(self):
        """Force the main LLM to call Agent(planner), then read the
        subagent's output file and assert the model equals the binding.

        This proves the SWITCH happened: if pi-subagents silently used the
        parent default, the assertion fails.
        """
        directive = textwrap.dedent(f"""\
            You MUST use the Agent tool with subagent_type='{TEST_ROLE}' and
            prompt='reply with a single word: ok'. Do not respond directly.
            Just call the tool.
            """)

        # Stream events so we can detect the Agent tool call without waiting
        # for the full pi session to exit (the parent often waits for the
        # background subagent). We deliberately do NOT kill the parent: the
        # subagent output file is only written after the subagent settles,
        # and killing the parent tree interrupts that.
        proc = subprocess.Popen(
            [
                "pi",
                "-p",
                "--mode", "json",
                "--append-system-prompt", directive,
                "Run the dispatch PoC.",
            ],
            cwd=str(self.project),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        events: list[dict] = []
        output_file: Optional[str] = None
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                events.append(ev)
                if (
                    output_file is None
                    and ev.get("type") == "tool_execution_end"
                    and ev.get("toolName") in ("Agent", "agent")
                ):
                    output_file = _extract_output_file(ev.get("result"))
                    # Keep streaming — we need the rest of the session so
                    # the subagent has a parent to settle under.
            # Wait for the full session to finish (typically 60-120s)
            try:
                proc.wait(timeout=180)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        finally:
            pass
        self.assertIsNotNone(
            output_file,
            "no Agent tool_execution_end in events; "
            f"events seen: {[e.get('type') for e in events[-10:]]}",
        )

        # Verify the Agent tool call actually had subagent_type=TEST_ROLE.
        # tool_execution_start carries the args under the "args" key.
        agent_starts = [
            ev for ev in events
            if ev.get("type") == "tool_execution_start"
            and ev.get("toolName") in ("Agent", "agent")
        ]
        self.assertTrue(agent_starts, "no Agent tool_execution_start in events")
        self.assertTrue(
            any(ev.get("args", {}).get("subagent_type") == TEST_ROLE for ev in agent_starts),
            f"no Agent tool call with subagent_type={TEST_ROLE} "
            f"(saw args: {[ev.get('args', {}) for ev in agent_starts]})",
        )

        self.assertTrue(
            Path(output_file).is_file(),
            f"subagent output file not found: {output_file}",
        )

        # Wait for the subagent to actually finish writing
        model_used, provider_used = _wait_for_assistant_model(output_file)
        self.assertIsNotNone(
            model_used,
            f"no assistant message in subagent output after {SUBAGENT_POLL_TIMEOUT_S}s: {output_file}",
        )

        # The assertion: the subagent used the BOUND model
        self.assertEqual(
            model_used, self.bound_model_id,
            f"subagent used model={provider_used}/{model_used} but binding is "
            f"{self.bound_provider}/{self.bound_model_id}",
        )
        self.assertEqual(
            provider_used, self.bound_provider,
            f"subagent used provider={provider_used} but binding is {self.bound_provider}",
        )


# ---- helpers ----

def _which(cmd: str) -> Optional[str]:
    for p in os.environ.get("PATH", "").split(":"):
        cand = Path(p) / cmd
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(cand)
    return None


def _parse_jsonl(stdout: str) -> list[dict]:
    """Parse stdout as JSONL, dropping lines that aren't JSON objects."""
    out = []
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _extract_output_file(result) -> Optional[str]:
    """Pull 'Output file: <path>' out of a tool result."""
    if not isinstance(result, dict):
        return None
    for c in result.get("content", []) or []:
        if isinstance(c, dict) and c.get("type") == "text":
            m = re.search(r"Output file:\s*(\S+)", c.get("text", ""))
            if m:
                return m.group(1)
    return None


def _wait_for_assistant_model(output_file: str) -> tuple[Optional[str], Optional[str]]:
    """Poll the subagent output file for an assistant message with model info."""
    deadline = time.monotonic() + SUBAGENT_POLL_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            with open(output_file) as f:
                for line in f:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if ev.get("type") == "assistant":
                        m = ev.get("message", {})
                        model = m.get("model")
                        provider = m.get("provider")
                        if model:
                            return model, provider
        except FileNotFoundError:
            pass
        time.sleep(SUBAGENT_POLL_INTERVAL_S)
    return None, None


def main() -> int:
    """Standalone entry point (also pickable by pytest)."""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(ContractTest))
    suite.addTests(loader.loadTestsFromTestCase(BehavioralTest))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
