"""Build the TypeScript dist/ before any integration test runs.

v0.5.0+: scripts/install.sh now invokes `node $FRAMEWORK_ROOT/dist/sync_settings.js`
instead of `python3 scripts/sync_settings.py`. The integration tests
(install/uninstall bash flows) therefore need a built dist/. Running
`npm run build` once per pytest session is cheap and keeps the integration
tests authoritative — they exercise the real binary the user will get.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

FRAMEWORK_ROOT = Path(__file__).resolve().parent


def _npm_run_build() -> None:
    """Run `npm run build` from the framework root."""
    if not (FRAMEWORK_ROOT / "package.json").exists():
        return  # not a checkout, skip
    npm = shutil.which("npm")
    if npm is None:
        return  # npm not available, let downstream tests fail naturally
    result = subprocess.run(
        [npm, "run", "build"],
        cwd=str(FRAMEWORK_ROOT),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "npm run build failed before integration tests; "
            "dist/sync_settings.js (and friends) will not exist.\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )


@pytest.fixture(scope="session", autouse=True)
def _build_dist_once_per_session():
    """Build the TS dist/ before any test in this directory runs."""
    _npm_run_build()
    yield
