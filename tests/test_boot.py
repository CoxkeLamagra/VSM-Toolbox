"""Verify that systemd actually creates and recognizes the boot activation link."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('systemctl'), 'systemctl is required for offline boot configuration verification')
class BootTest(unittest.TestCase):
    def test_service_can_be_enabled_for_multi_user_boot(self):
        with tempfile.TemporaryDirectory() as directory:
            units = Path(directory) / 'etc/systemd/system'
            units.mkdir(parents=True)
            shutil.copyfile(ROOT / 'deploy/vsm-toolbox.service', units / 'vsm-toolbox.service')
            (units / 'multi-user.target').write_text('[Unit]\nDescription=Multi-user boot target\n')
            result = subprocess.run(['systemctl', '--root', directory, 'enable', 'vsm-toolbox.service'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((units / 'multi-user.target.wants/vsm-toolbox.service').is_symlink())
            result = subprocess.run(['systemctl', '--root', directory, 'is-enabled', 'vsm-toolbox.service'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'enabled')
