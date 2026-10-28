"""Self-signed certificate lifecycle and real TLS reverse-proxy integration."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_https', ROOT / 'scripts/prepare-https.py')
https = importlib.util.module_from_spec(spec)
spec.loader.exec_module(https)


class HTTPSTest(unittest.TestCase):
    def test_certificate_reuse_address_change_and_key_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            live, output = base / 'live', base / 'stage'
            https.stage('127.0.0.1', output, live)
            live.mkdir()
            for name in ('certificate.pem', 'private-key.pem'):
                shutil.copyfile(output / name, live / name)
            original = (output / 'certificate.pem').read_bytes()
            https.stage('127.0.0.1', output, live)
            self.assertEqual(original, (output / 'certificate.pem').read_bytes())
            https.stage('127.0.0.2', output, live)
            self.assertNotEqual(original, (output / 'certificate.pem').read_bytes())
            # A certificate with an unrelated private key must not be reused.
            shutil.copyfile(output / 'private-key.pem', live / 'private-key.pem')
            https.stage('127.0.0.1', output, live)
            self.assertNotEqual(original, (output / 'certificate.pem').read_bytes())
            https.stage('127.0.0.2', output, live)
            subprocess.run(
                [
                    'openssl',
                    'verify',
                    '-CAfile',
                    str(output / 'certificate.pem'),
                    '-verify_ip',
                    '127.0.0.2',
                    str(output / 'certificate.pem'),
                ],
                check=True,
                capture_output=True,
            )
            self.assertEqual((output / 'private-key.pem').stat().st_mode & 0o777, 0o600)
            for address in ('0.0.0.0', '224.0.0.1', 'not-an-ip', '127.0.0.1;bad'):
                with self.assertRaises(ValueError):
                    https.stage(address, output, live)

    @unittest.skipUnless(
        os.environ.get('VSM_TEST_NGINX') or shutil.which('nginx'),
        'Nginx binary required for TLS integration',
    )
    def test_https_proxy_redirect_and_secure_login(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)

            def port():
                with socket.socket() as connection:
                    connection.bind(('127.0.0.1', 0))
                    return connection.getsockname()[1]

            backend_port, http_port, tls_port = port(), port(), port()
            https.stage('127.0.0.1', base / 'tls', base / 'tls')
            site = (
                (base / 'tls/nginx.conf')
                .read_text()
                .replace('127.0.0.1:80;', f'127.0.0.1:{http_port};')
                .replace('127.0.0.1:443 ssl;', f'127.0.0.1:{tls_port} ssl;')
                .replace('127.0.0.1:8080;', f'127.0.0.1:{backend_port};')
            )
            (base / 'site.conf').write_text(site)
            config = f'pid {base}/nginx.pid; error_log stderr; events {{}} http {{ access_log off; '
            for name in ('client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'):
                config += f'{name}_temp_path {base}/{name}; '
            config += f'include {base}/site.conf; }}'
            (base / 'nginx.conf').write_text(config)
            backend = subprocess.Popen(
                ['python3', str(ROOT / 'app.py')],
                env={
                    **os.environ,
                    'VSM_HOST': '127.0.0.1',
                    'VSM_PORT': str(backend_port),
                    'VSM_DATABASE': str(base / 'db.sqlite3'),
                    'VSM_COOKIE_SECURE': '1',
                },
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            nginx = None
            try:
                nginx = subprocess.Popen(
                    [
                        os.environ.get('VSM_TEST_NGINX') or shutil.which('nginx'),
                        '-p',
                        str(base),
                        '-c',
                        str(base / 'nginx.conf'),
                        '-g',
                        'daemon off;',
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                context = ssl.create_default_context(cafile=str(base / 'tls/certificate.pem'))
                opener = urllib.request.build_opener(
                    urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context)
                )
                url = f'https://127.0.0.1:{tls_port}'
                for _ in range(100):
                    try:
                        with opener.open(url + '/api/health', timeout=1) as response:
                            if json.load(response)['status'] == 'ok':
                                break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.1)
                else:
                    self.fail('TLS proxy did not become healthy')

                class NoRedirect(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, *args):
                        return None

                plain = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                with self.assertRaises(urllib.error.HTTPError) as redirect:
                    plain.open(f'http://127.0.0.1:{http_port}/processes')
                self.assertEqual(redirect.exception.code, 301)
                self.assertEqual(
                    redirect.exception.headers['Location'], 'https://127.0.0.1/processes'
                )
                request = urllib.request.Request(
                    url + '/api/auth/register',
                    data=json.dumps(
                        {'username': 'https-admin', 'password': 'https-password-123'}
                    ).encode(),
                    headers={'Content-Type': 'application/json'},
                )
                with opener.open(request) as response:
                    self.assertEqual(response.status, 201)
                    self.assertIn('Secure', response.headers['Set-Cookie'])
                    self.assertEqual(json.load(response)['user']['role'], 'Admin')
            finally:
                for process in (nginx, backend):
                    if process is not None:
                        process.terminate()
                        process.wait(timeout=10)
