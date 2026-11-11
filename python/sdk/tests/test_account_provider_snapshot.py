"""Project the recorded account cancellation through the real Python SDK."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'


# The SDK launches dsh_bin directly, and the profile runtime is a Node entry
# point behind its POSIX launcher; NTFS cannot mark bin.js executable.
@pytest.mark.skipif(not CLI.exists() or os.name == 'nt', reason='requires the built dsh profile runtime through its POSIX launcher')
def test_account_provider_signout_snapshot(tmp_path: Path) -> None:
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / 'home'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(str(ROOT / 'snapshots' / 'sdk' / 'account-provider-signout' / 'cordis.yml'),),
        provider='deepseek-account',
        model='deepseek-v4-flash',
        env={'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Reply with exactly: SDK snapshot')
    ending = next(event for event in reversed(result.events) if event['type'] == 'turn/end')
    actual = {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
    }
    expected = Path(__file__).with_name('expected') / 'account-provider-signout.json'
    assert actual == json.loads(expected.read_text())
