"""Unprivileged application supervisor and fixed-source GitHub updater (Linux)."""
import ast
import fcntl
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import uuid

REPOSITORY = 'CoxkeLamagra/VSM-Toolbox'
FILES = ('app.py', 'updater.py', 'web/index.html', 'web/app.js', 'web/style.css', 'update-manifest.json')
BUSY = ('queued', 'checking', 'downloading', 'installing', 'restarting')
ROOT = Path(__file__).resolve().parent


def directory():
    db = Path(os.environ.get('VSM_DATABASE', ROOT / 'data' / 'vsm.sqlite3'))
    return Path(os.environ.get('VSM_UPDATE_DIR', db.parent / 'updates')).resolve()


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        with temp.open('x') as handle:
            os.chmod(temp, 0o600)
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temp.unlink(missing_ok=True)


def status():
    base = directory()
    result = read_json(base / 'status.json', {})
    try:
        alive = time.time() - (base / 'heartbeat').stat().st_mtime < 20
    except FileNotFoundError:
        alive = False
    result['available'] = os.environ.get('VSM_UPDATER') == '1' and alive
    result.setdefault('state', 'idle')
    result.setdefault('current_revision', os.environ.get('VSM_REVISION', 'local'))
    return result


def request(action):
    if action not in ('check', 'install'):
        raise ValueError('Unknown update action')
    base = directory()
    base.mkdir(parents=True, exist_ok=True)
    with (base / 'request.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = status()
        if not current['available']:
            raise RuntimeError('The update supervisor is not running. Reinstall using the current installer or rebuild the Docker image.')
        if current['state'] in BUSY or (base / 'request.json').exists():
            raise RuntimeError('An update operation is already in progress')
        atomic_json(base / 'status.json', {**current, 'state': 'queued', 'message': 'Update operation queued.'})
        atomic_json(base / 'request.json', {'action': action})
    return {'queued': True}


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != 'https' or parsed.hostname not in ('api.github.com', 'github.com', 'codeload.github.com'):
            raise ValueError('Unexpected update download redirect')
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected:
            redirected.remove_header('Authorization')
        return redirected


def download(url, limit):
    opener = urllib.request.build_opener(HTTPSRedirect())
    req = urllib.request.Request(url, headers={'User-Agent': 'VSM-Toolbox-Updater/1', 'Accept': 'application/vnd.github+json'})
    if urllib.parse.urlparse(url).hostname == 'api.github.com':
        token = os.environ.get('VSM_GITHUB_TOKEN')
        if token:
            # Authenticate only the initial API request, never a redirected download.
            req.add_unredirected_header('Authorization', 'Bearer '+token)
    with opener.open(req, timeout=30) as response:
        body = response.read(limit+1)
    if len(body) > limit:
        raise ValueError('Update download exceeds the size limit')
    return body


def latest_revision():
    info = json.loads(download(f'https://api.github.com/repos/{REPOSITORY}/commits/main', 100_000))
    revision = info.get('sha', '')
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('GitHub returned an invalid commit revision')
    return revision


def prepare_release(revision, target):
    if not re.fullmatch('[0-9a-f]{40}', revision):
        raise ValueError('Invalid revision')
    data = download(f'https://api.github.com/repos/{REPOSITORY}/tarball/{revision}', 20_000_000)
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
        unpacked = compressed.read(20_000_001)
    if len(unpacked) > 20_000_000:
        raise ValueError('Unpacked update exceeds the size limit')
    with tarfile.open(fileobj=io.BytesIO(unpacked), mode='r:') as archive:
        manifests = [m.name for m in archive.getmembers() if m.name.endswith('/update-manifest.json') and m.name.count('/') == 1]
        if len(manifests) != 1:
            raise ValueError('Update archive has no unambiguous manifest')
        prefix = manifests[0].rsplit('/', 1)[0]+'/'
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/', prefix):
            raise ValueError('Invalid update archive root')
        # Only copy known regular files. Never extract archive paths or links.
        for filename in FILES:
            members = [m for m in archive.getmembers() if m.name == prefix+filename]
            if len(members) != 1 or not members[0].isfile() or members[0].size > 2_000_000:
                raise ValueError('Missing or unsafe update file: ' + filename)
            destination = target / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(members[0]) as source:
                destination.write_bytes(source.read())
    manifest = read_json(target / 'update-manifest.json')
    if (manifest.get('format') != 1 or set(manifest.get('files', [])) != set(FILES) or
            manifest.get('runtime') != 'python-stdlib' or manifest.get('update_protocol') != 1):
        raise ValueError('This release needs a new installer or Docker image before it can be applied')
    minimum = manifest.get('python_minimum')
    if not isinstance(minimum, list) or len(minimum) != 2 or any(type(n) is not int for n in minimum) or tuple(minimum) > sys.version_info[:2]:
        raise ValueError('The update requires a different Python runtime')
    for filename in ('app.py', 'updater.py'):
        compile((target / filename).read_text(), str(target / filename), 'exec')
    tree = ast.parse((target / 'app.py').read_text())
    if not any(isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'UPDATE_PROTOCOL' for t in node.targets)
               and isinstance(node.value, ast.Constant) and node.value.value == 1 for node in tree.body):
        raise ValueError('Update does not support authenticated update health checks')
    (target / 'REVISION').write_text(revision+'\n')
    return hashlib.sha256(data).hexdigest()


def backup_database(db, backup):
    backup.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(backup.parent, 0o700)
    with sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True) as source:
        if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database integrity check failed; update cancelled')
        with sqlite3.connect(backup) as target:
            source.backup(target)
    os.chmod(backup, 0o600)


def restore_database(db, backup):
    # The application must be stopped before restoring, including on crash recovery.
    if not backup.is_file():
        raise RuntimeError('Update backup is missing; refusing to claim recovery')
    replacement = db.with_name(db.name + '.restore')
    shutil.copyfile(backup, replacement)
    os.chmod(replacement, 0o600)
    with replacement.open('rb') as handle:
        os.fsync(handle.fileno())
    os.replace(replacement, db)
    for suffix in ('-wal', '-shm', '-journal'):
        Path(str(db)+suffix).unlink(missing_ok=True)
    descriptor = os.open(db.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Supervisor:
    def __init__(self):
        self.base = directory()
        self.base.mkdir(parents=True, exist_ok=True)
        self.db = Path(os.environ.get('VSM_DATABASE', ROOT / 'data' / 'vsm.sqlite3')).resolve()
        revision_file = ROOT / 'REVISION'
        initial_revision = revision_file.read_text().strip() if revision_file.exists() else os.environ.get('VSM_REVISION', 'local')
        self.initial = {'path': str(ROOT), 'revision': initial_revision}
        self.active = read_json(self.base / 'active.json', self.initial)
        self.child = None
        self.stopping = threading.Event()

    def report(self, state, message, **extra):
        previous = read_json(self.base / 'status.json', {})
        atomic_json(self.base / 'status.json', {**previous, 'state': state, 'message': message,
                                               'current_revision': self.active['revision'], 'updated_at': time.time(), **extra})

    def start(self):
        environment = {**os.environ, 'VSM_UPDATER': '1', 'VSM_UPDATE_DIR': str(self.base),
                       'VSM_DATABASE': str(self.db), 'VSM_REVISION': self.active['revision']}
        self.child = subprocess.Popen([sys.executable, str(Path(self.active['path']) / 'app.py')],
                                      cwd=self.active['path'], env=environment)

    def stop(self):
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        self.child = None

    def healthy(self, timeout=30):
        host = os.environ.get('VSM_HOST', '127.0.0.1')
        if host in ('0.0.0.0', ''):
            host = '127.0.0.1'
        url = f'http://{host}:{os.environ.get("VSM_PORT", "8080")}/api/health'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline and not self.stopping.is_set():
            if self.child.poll() is not None:
                return False
            try:
                with opener.open(url, timeout=2) as response:
                    data = json.load(response)
                if (data.get('status') == 'ok' and data.get('update_protocol') == 1 and
                        data.get('revision') == self.active['revision']):
                    return True
            except (OSError, ValueError):
                pass
            self.stopping.wait(.3)
        return False

    def recover(self):
        pending = read_json(self.base / 'pending.json')
        if pending:
            restore_database(self.db, Path(pending['backup']))
            self.active = pending['previous']
            atomic_json(self.base / 'active.json', self.active)
            (self.base / 'pending.json').unlink()
            self.report('failed', 'Interrupted update recovered. Previous code and database restored.')

    def update(self, action):
        if action not in ('check', 'install'):
            raise ValueError('Unknown update action')
        previous = dict(self.active)
        target = None
        pending = False
        committed = False
        try:
            self.report('checking', 'Checking the latest GitHub main revision…')
            revision = latest_revision()
            if action == 'check':
                self.report('idle', 'You are up to date.' if revision == self.active['revision'] else 'A different main revision is available.', latest_revision=revision)
                return
            if revision == self.active['revision']:
                self.report('idle', 'You are already running the latest main revision.', latest_revision=revision)
                return
            self.report('downloading', 'Downloading and validating the update…', latest_revision=revision)
            target = self.base / 'releases' / (revision+'-'+uuid.uuid4().hex[:8])
            target.mkdir(parents=True)
            digest = prepare_release(revision, target)
            if self.stopping.is_set():
                raise RuntimeError('Update interrupted by service shutdown')
            self.report('installing', 'Backing up the database and switching application code…')
            self.stop()
            backup = self.base / 'backups' / (time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]+'.sqlite3')
            backup_database(self.db, backup)
            atomic_json(self.base / 'pending.json', {'previous': previous, 'backup': str(backup)})
            pending = True
            self.active = {'path': str(target), 'revision': revision}
            self.report('restarting', 'Starting the updated application and checking health…', backup=str(backup))
            self.start()
            if not self.healthy():
                raise RuntimeError('Updated application failed its health check')
            # Existing sessions must not survive code or schema changes.
            with sqlite3.connect(self.db) as conn:
                conn.execute('DELETE FROM sessions')
            atomic_json(self.base / 'active.json', self.active)
            (self.base / 'pending.json').unlink()
            pending = False
            committed = True
            self.report('succeeded', 'Update complete. Sign in again to continue.', archive_sha256=digest)
        except Exception as exc:
            if committed:
                raise
            if pending:
                self.stop()
            self.active = previous
            if pending:
                self.recover()
            if self.child is None and not self.stopping.is_set():
                self.start()
            if target and target.exists():
                shutil.rmtree(target)
            self.report('failed', 'Update failed: '+str(exc)+'. Previous application retained.')

    def heartbeat(self):
        while not self.stopping.is_set():
            (self.base / 'heartbeat').touch()
            self.stopping.wait(2)

    def run(self):
        with (self.base / 'supervisor.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.recover()
            # Requests left by a stopped instance are never silently applied on startup.
            (self.base / 'request.json').unlink(missing_ok=True)
            self.report('idle', 'Ready to check for updates.')
            threading.Thread(target=self.heartbeat, daemon=True).start()
            self.start()
            try:
                while not self.stopping.wait(.5):
                    if self.child.poll() is not None:
                        raise RuntimeError('Application exited unexpectedly')
                    request_file = self.base / 'request.json'
                    if request_file.exists():
                        operation = read_json(request_file)
                        request_file.unlink()
                        self.update(operation['action'])
            finally:
                self.stop()
                (self.base / 'heartbeat').unlink(missing_ok=True)


if __name__ == '__main__':
    os.umask(0o077)
    supervisor = Supervisor()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: supervisor.stopping.set())
    supervisor.run()
