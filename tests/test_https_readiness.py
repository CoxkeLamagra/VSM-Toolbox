"""Exercise the installer's readiness gate with delayed Nginx activation."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class HTTPSReadinessTest(unittest.TestCase):
    def run_gate(self, mode):
        source = (ROOT / 'scripts/install-debian13.sh').read_text()
        gate = source.split(
            '# Wait for asynchronous Nginx reload to activate both listeners.\n', 1
        )[1].split('# HTTPS activation succeeded.', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            curl = base / 'curl'
            curl.write_text(
                '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
state=Path(os.environ['GATE_STATE'])
counts=json.loads(state.read_text()) if state.exists() else {'https':0,'http':0}
secure=any(arg.startswith('https://') for arg in sys.argv)
key='https' if secure else 'http'
counts[key]+=1
state.write_text(json.dumps(counts))
mode=os.environ['GATE_MODE']
if secure:
    if mode=='never' or mode=='delayed' and counts[key]<=2:
        print('Connection refused',file=sys.stderr)
        sys.exit(7)
    if mode=='invalid-json':
        print('<html>unavailable</html>')
    else:
        print('{"status":"ok"}')
else:
    print('200' if mode=='redirect-delay' and counts[key]<=2 else '301',end='')
'''
            )
            curl.chmod(0o755)
            for name in ('systemctl', 'sleep', 'journalctl'):
                command = base / name
                command.write_text('#!/bin/sh\nexit 0\n')
                command.chmod(0o755)
            script = base / 'gate.sh'
            script.write_text(
                'set -Eeuo pipefail\nHTTPS_IP=192.168.0.144\nTEMP="$GATE_TEMP"\n' + gate
            )
            result = subprocess.run(
                ['bash', str(script)],
                env={
                    **os.environ,
                    'PATH': str(base) + os.pathsep + os.environ['PATH'],
                    'GATE_TEMP': str(base),
                    'GATE_STATE': str(base / 'counts.json'),
                    'GATE_MODE': mode,
                },
                capture_output=True,
                text=True,
            )
            return result, json.loads((base / 'counts.json').read_text())

    def test_delayed_https_recovers(self):
        result, counts = self.run_gate('delayed')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(counts, {'https': 3, 'http': 1})

    def test_delayed_redirect_recovers(self):
        result, counts = self.run_gate('redirect-delay')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(counts, {'https': 3, 'http': 3})

    def test_persistent_failure_and_invalid_health_fail_with_diagnostics(self):
        for mode in ('never', 'invalid-json'):
            result, counts = self.run_gate(mode)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(counts['https'], 30)
            self.assertEqual(counts['http'], 0)
            self.assertIn('restoring the previous configuration', result.stderr)
