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
import zipfile
import tempfile

REPOSITORY = 'CoxkeLamagra/VSM-Toolbox'
FILES = (
    'app.py',
    'updater.py',
    'web/index.html',
    'web/app.js',
    'web/style.css',
    'update-manifest.json',
)
BUSY = (
    'queued',
    'checking',
    'downloading',
    'installing',
    'restarting',
    'backing-up',
    'restoring',
    'cleaning',
)
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


def request(action, **payload):
    if action not in ('check', 'install', 'backup', 'restore', 'cleanup'):
        raise ValueError('Unknown update action')
    base = directory()
    base.mkdir(parents=True, exist_ok=True)
    with (base / 'request.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = status()
        if not current['available']:
            raise RuntimeError(
                'The update supervisor is not running. Reinstall using the current installer or rebuild the Docker image.'
            )
        if current['state'] in BUSY or (base / 'request.json').exists():
            raise RuntimeError('An update operation is already in progress')
        atomic_json(
            base / 'status.json',
            {**current, 'state': 'queued', 'message': 'Update operation queued.'},
        )
        atomic_json(base / 'request.json', {'action': action, **payload})
    return {'queued': True}


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != 'https' or parsed.hostname not in (
            'api.github.com',
            'github.com',
            'codeload.github.com',
        ):
            raise ValueError('Unexpected update download redirect')
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected:
            redirected.remove_header('Authorization')
        return redirected


def download(url, limit):
    opener = urllib.request.build_opener(HTTPSRedirect())
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'VSM-Toolbox-Updater/1', 'Accept': 'application/vnd.github+json'},
    )
    if urllib.parse.urlparse(url).hostname == 'api.github.com':
        token = os.environ.get('VSM_GITHUB_TOKEN')
        if token:
            # Authenticate only the initial API request, never a redirected download.
            req.add_unredirected_header('Authorization', 'Bearer ' + token)
    with opener.open(req, timeout=30) as response:
        body = response.read(limit + 1)
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
        manifests = [
            m.name
            for m in archive.getmembers()
            if m.name.endswith('/update-manifest.json') and m.name.count('/') == 1
        ]
        if len(manifests) != 1:
            raise ValueError('Update archive has no unambiguous manifest')
        prefix = manifests[0].rsplit('/', 1)[0] + '/'
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/', prefix):
            raise ValueError('Invalid update archive root')
        # Only copy known regular files. Never extract archive paths or links.
        for filename in FILES:
            members = [m for m in archive.getmembers() if m.name == prefix + filename]
            if len(members) != 1 or not members[0].isfile() or members[0].size > 2_000_000:
                raise ValueError('Missing or unsafe update file: ' + filename)
            destination = target / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(members[0]) as source:
                destination.write_bytes(source.read())
    manifest = read_json(target / 'update-manifest.json')
    if (
        manifest.get('format') != 1
        or set(manifest.get('files', [])) != set(FILES)
        or manifest.get('runtime') != 'python-stdlib'
        or manifest.get('update_protocol') != 1
    ):
        raise ValueError(
            'This release needs a new installer or Docker image before it can be applied'
        )
    minimum = manifest.get('python_minimum')
    if (
        not isinstance(minimum, list)
        or len(minimum) != 2
        or any(type(n) is not int for n in minimum)
        or tuple(minimum) > sys.version_info[:2]
    ):
        raise ValueError('The update requires a different Python runtime')
    for filename in ('app.py', 'updater.py'):
        compile((target / filename).read_text(), str(target / filename), 'exec')
    tree = ast.parse((target / 'app.py').read_text())
    if not any(
        isinstance(node, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == 'UPDATE_PROTOCOL' for t in node.targets)
        and isinstance(node.value, ast.Constant)
        and node.value.value == 1
        for node in tree.body
    ):
        raise ValueError('Update does not support authenticated update health checks')
    (target / 'REVISION').write_text(revision + '\n')
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
        Path(str(db) + suffix).unlink(missing_ok=True)
    descriptor = os.open(db.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


BACKUP_LIMIT = 128 * 1024 * 1024
BACKUP_FILES = (*FILES, 'database.sqlite3')


def backup_path(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(
        r'[A-Za-z0-9_-]+(?:\.vsm-backup\.zip|\.sqlite3)', identifier
    ):
        raise ValueError('Invalid backup identifier')
    path = directory() / 'backups' / identifier
    if path.is_symlink() or not path.is_file():
        raise ValueError('Backup not found')
    return path


def validate_backup(path, destination=None):
    if path.stat().st_size > BACKUP_LIMIT:
        raise ValueError('Backup exceeds 128 MiB')
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) != len(BACKUP_FILES) + 1 or {i.filename for i in infos} != {
            *BACKUP_FILES,
            'backup.json',
        }:
            raise ValueError(
                'Backup must contain exactly the supported application files and database'
            )
        if any(
            i.file_size > BACKUP_LIMIT
            or i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
            or i.flag_bits & 1
            or (i.external_attr >> 16) & 0o170000 == 0o120000
            for i in infos
        ):
            raise ValueError('Unsupported encrypted, linked or oversized backup entry')
        if (
            sum(i.file_size for i in infos) > BACKUP_LIMIT
            or archive.getinfo('backup.json').file_size > 16384
        ):
            raise ValueError('Unpacked backup exceeds its size limit')
        manifest = json.loads(archive.read('backup.json'))
        if (
            not isinstance(manifest, dict)
            or manifest.get('format') != 1
            or not isinstance(manifest.get('sha256'), dict)
            or set(manifest['sha256']) != set(BACKUP_FILES)
        ):
            raise ValueError('Unsupported backup format')
        if not isinstance(manifest.get('revision'), str) or len(manifest['revision']) > 100:
            raise ValueError('Invalid backup revision')
        for name in BACKUP_FILES:
            content = archive.read(name)
            if hashlib.sha256(content).hexdigest() != manifest['sha256'][name]:
                raise ValueError('Backup checksum mismatch: ' + name)
            if name != 'database.sqlite3' and len(content) > 2_000_000:
                raise ValueError('Application file too large')
            if name in ('app.py', 'updater.py'):
                compile(content, name, 'exec')
            if destination:
                target = destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                os.chmod(target, 0o600)
        application_manifest = json.loads(archive.read('update-manifest.json'))
        if (
            not isinstance(application_manifest, dict)
            or application_manifest.get('update_protocol') != 1
            or application_manifest.get('runtime') != 'python-stdlib'
            or not isinstance(application_manifest.get('files'), list)
            or any(not isinstance(n, str) for n in application_manifest['files'])
            or set(application_manifest['files']) != set(FILES)
        ):
            raise ValueError('Backup uses an incompatible application runtime')
        minimum = application_manifest.get('python_minimum', [])
        if (
            not isinstance(minimum, list)
            or len(minimum) != 2
            or any(type(n) is not int for n in minimum)
            or tuple(minimum) > sys.version_info[:2]
        ):
            raise ValueError('Backup requires a different Python version')
        return manifest


def validate_backup_database(path):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as conn:
        if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Backup database failed integrity validation')
        expected = {
            'streams': {'id', 'name', 'customer', 'outcome', 'description'},
            'steps': {
                'id',
                'stream_id',
                'name',
                'owner',
                'position',
                'work_minutes',
                'wait_minutes',
            },
            'processes': {'id', 'name', 'owner', 'description', 'procedure'},
            'step_processes': {'step_id', 'process_id'},
            'users': {'id', 'username', 'password_hash', 'role'},
            'sessions': {'token_hash', 'user_id', 'csrf_token', 'expires_at'},
            'login_attempts': {'address', 'failures', 'started_at'},
        }
        for table, columns in expected.items():
            if not columns <= {r[1] for r in conn.execute('PRAGMA table_info(' + table + ')')}:
                raise ValueError('Backup database is missing required schema: ' + table)
        if not conn.execute("SELECT 1 FROM users WHERE role='Admin' LIMIT 1").fetchone():
            raise ValueError('Backup must contain at least one Admin account')
        if conn.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Backup contains broken data relationships')


def create_backup(active, db, reason):
    base = directory() / 'backups'
    base.mkdir(parents=True, exist_ok=True)
    os.chmod(base, 0o700)
    identifier = time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex + '.vsm-backup.zip'
    final = base / identifier
    with tempfile.TemporaryDirectory(dir=base) as temporary:
        temporary = Path(temporary)
        backup_database(db, temporary / 'database.sqlite3')
        hashes = {}
        package = temporary / 'bundle.zip'
        with zipfile.ZipFile(package, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name in BACKUP_FILES:
                source = (
                    temporary / 'database.sqlite3'
                    if name == 'database.sqlite3'
                    else Path(active['path']) / name
                )
                if source.is_symlink() or not source.is_file():
                    raise ValueError('Application backup source missing or linked: ' + name)
                data = source.read_bytes()
                if len(data) > BACKUP_LIMIT:
                    raise ValueError('Backup source exceeds size limit')
                hashes[name] = hashlib.sha256(data).hexdigest()
                archive.writestr(name, data)
            archive.writestr(
                'backup.json',
                json.dumps(
                    {
                        'format': 1,
                        'revision': active['revision'],
                        'created_at': time.time(),
                        'reason': reason,
                        'sha256': hashes,
                    }
                ),
            )
        validate_backup(package)
        os.chmod(package, 0o600)
        with package.open('rb') as handle:
            os.fsync(handle.fileno())
        os.replace(package, final)
        descriptor = os.open(base, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return final


def unpack_backup(path):
    target = directory() / 'releases' / ('restore-' + uuid.uuid4().hex)
    target.mkdir(parents=True)
    try:
        metadata = validate_backup(path, target)
        validate_backup_database(target / 'database.sqlite3')
        (target / 'REVISION').write_text(metadata['revision'] + '\n')
        return target, metadata
    except Exception:
        shutil.rmtree(target)
        raise


def list_backups():
    results = []
    pending = read_json(directory() / 'pending.json', {})
    for path in sorted(
        [
            *(directory() / 'backups').glob('*.vsm-backup.zip'),
            *(directory() / 'backups').glob('*.sqlite3'),
        ],
        reverse=True,
    ):
        if path.is_symlink():
            continue
        entry = {
            'id': path.name,
            'size': path.stat().st_size,
            'created_at': path.stat().st_mtime,
            'protected': pending.get('backup') == str(path),
            'restorable': path.name.endswith('.vsm-backup.zip'),
        }
        if path.suffix == '.sqlite3':
            entry['reason'] = 'Legacy database-only backup'
            results.append(entry)
            continue
        try:
            with zipfile.ZipFile(path) as archive:
                if archive.getinfo('backup.json').file_size > 16384:
                    raise ValueError('Oversized metadata')
                metadata = json.loads(archive.read('backup.json'))
                if not isinstance(metadata, dict):
                    raise ValueError('Invalid metadata')
            entry.update({k: metadata.get(k) for k in ('revision', 'reason', 'created_at')})
        except (
            ValueError,
            OSError,
            KeyError,
            zipfile.BadZipFile,
            NotImplementedError,
            RuntimeError,
        ):
            entry['reason'] = 'Invalid backup (can be removed)'
            entry['restorable'] = False
        results.append(entry)
    return results


def delete_backups(identifiers):
    if (
        not isinstance(identifiers, list)
        or not identifiers
        or any(not isinstance(i, str) for i in identifiers)
    ):
        raise ValueError('Select backup identifiers to remove')
    paths = [backup_path(i) for i in set(identifiers)]
    pending = read_json(directory() / 'pending.json', {})
    if any(str(p) == pending.get('backup') for p in paths):
        raise ValueError('Cannot delete a backup required for recovery')
    for path in paths:
        path.unlink()
    return len(paths)


class Supervisor:
    def __init__(self):
        self.base = directory()
        self.base.mkdir(parents=True, exist_ok=True)
        self.db = Path(os.environ.get('VSM_DATABASE', ROOT / 'data' / 'vsm.sqlite3')).resolve()
        revision_file = ROOT / 'REVISION'
        initial_revision = (
            revision_file.read_text().strip()
            if revision_file.exists()
            else os.environ.get('VSM_REVISION', 'local')
        )
        self.initial = {'path': str(ROOT), 'revision': initial_revision}
        self.active = read_json(self.base / 'active.json', self.initial)
        self.child = None
        self.stopping = threading.Event()

    def report(self, state, message, **extra):
        previous = read_json(self.base / 'status.json', {})
        atomic_json(
            self.base / 'status.json',
            {
                **previous,
                'state': state,
                'message': message,
                'current_revision': self.active['revision'],
                'backup_protocol': 1,
                'updated_at': time.time(),
                **extra,
            },
        )

    def start(self):
        environment = {
            **os.environ,
            'VSM_UPDATER': '1',
            'VSM_BACKUP_PROTOCOL': '1',
            'VSM_UPDATE_DIR': str(self.base),
            'VSM_DATABASE': str(self.db),
            'VSM_REVISION': self.active['revision'],
        }
        self.child = subprocess.Popen(
            [sys.executable, str(Path(self.active['path']) / 'app.py')],
            cwd=self.active['path'],
            env=environment,
        )

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
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self.stopping.is_set():
            if self.child.poll() is not None:
                return False
            try:
                with opener.open(url, timeout=2) as response:
                    data = json.load(response)
                if (
                    data.get('status') == 'ok'
                    and data.get('update_protocol') == 1
                    and data.get('revision') == self.active['revision']
                ):
                    return True
            except (OSError, ValueError):
                pass
            self.stopping.wait(0.3)
        return False

    def recover(self):
        pending = read_json(self.base / 'pending.json')
        if pending:
            if pending.get('bundle'):
                target, metadata = unpack_backup(Path(pending['backup']))
                restore_database(self.db, target / 'database.sqlite3')
                (target / 'database.sqlite3').unlink()
                self.active = {'path': str(target), 'revision': metadata['revision']}
            else:
                restore_database(self.db, Path(pending['backup']))
                self.active = pending['previous']
            atomic_json(self.base / 'active.json', self.active)
            (self.base / 'pending.json').unlink()
            self.report(
                'failed', 'Interrupted update recovered. Previous code and database restored.'
            )

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
                self.report(
                    'idle',
                    (
                        'You are up to date.'
                        if revision == self.active['revision']
                        else 'A different main revision is available.'
                    ),
                    latest_revision=revision,
                )
                return
            if revision == self.active['revision']:
                self.report(
                    'idle',
                    'You are already running the latest main revision.',
                    latest_revision=revision,
                )
                return
            self.report(
                'downloading', 'Downloading and validating the update…', latest_revision=revision
            )
            target = self.base / 'releases' / (revision + '-' + uuid.uuid4().hex[:8])
            target.mkdir(parents=True)
            digest = prepare_release(revision, target)
            if self.stopping.is_set():
                raise RuntimeError('Update interrupted by service shutdown')
            self.report(
                'installing', 'Backing up application files and database before switching code…'
            )
            self.stop()
            backup = create_backup(previous, self.db, 'pre-update')
            atomic_json(
                self.base / 'pending.json',
                {'previous': previous, 'backup': str(backup), 'bundle': True},
            )
            pending = True
            self.active = {'path': str(target), 'revision': revision}
            self.report(
                'restarting',
                'Starting the updated application and checking health…',
                backup=str(backup),
            )
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
            self.report(
                'succeeded', 'Update complete. Sign in again to continue.', archive_sha256=digest
            )
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
            self.report('failed', 'Update failed: ' + str(exc) + '. Previous application retained.')

    def maintenance(self, operation):
        action = operation.get('action')
        if action in ('check', 'install'):
            return self.update(action)
        safety = None
        target = None
        pending = False
        committed = False
        try:
            if action == 'cleanup':
                self.report('cleaning', 'Removing selected backups…')
                count = delete_backups(operation.get('ids'))
                self.report('succeeded', f'Removed {count} backup(s).')
                return
            if action == 'backup':
                self.report('backing-up', 'Creating an application and database backup…')
                # SQLite's online backup API captures a consistent snapshot while
                # the web process remains available. Runtime code is immutable;
                # the supervisor serializes maintenance operations.
                safety = create_backup(self.active, self.db, 'manual')
                self.report(
                    'succeeded', 'Application and database backup created.', backup=str(safety)
                )
                return
            if action != 'restore':
                raise ValueError('Unknown maintenance operation')
            # Validate everything before stopping the running application.
            source = backup_path(operation.get('id'))
            target, metadata = unpack_backup(source)
            self.report('restoring', 'Creating a safety backup before restoring…')
            self.stop()
            safety = create_backup(self.active, self.db, 'pre-restore')
            atomic_json(
                self.base / 'pending.json',
                {'previous': dict(self.active), 'backup': str(safety), 'bundle': True},
            )
            pending = True
            restore_database(self.db, target / 'database.sqlite3')
            (target / 'database.sqlite3').unlink()
            self.active = {'path': str(target), 'revision': metadata['revision']}
            with sqlite3.connect(self.db) as conn:
                conn.execute('DELETE FROM sessions')
            self.report('restarting', 'Starting the restored application…', backup=str(safety))
            self.start()
            if not self.healthy():
                raise RuntimeError('Restored application failed its health check')
            atomic_json(self.base / 'active.json', self.active)
            (self.base / 'pending.json').unlink()
            pending = False
            committed = True
            self.report('succeeded', 'Backup restored. Sign in using an account from the backup.')
        except Exception as exc:
            if committed:
                raise
            if pending:
                self.stop()
                self.recover()
            if self.child is None:
                self.start()
            if target and str(target) != self.active['path']:
                shutil.rmtree(target, ignore_errors=True)
            self.report('failed', 'Backup operation failed: ' + str(exc))

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
                while not self.stopping.wait(0.5):
                    if self.child.poll() is not None:
                        raise RuntimeError('Application exited unexpectedly')
                    request_file = self.base / 'request.json'
                    if request_file.exists():
                        operation = read_json(request_file)
                        request_file.unlink()
                        self.maintenance(operation)
            finally:
                self.stop()
                (self.base / 'heartbeat').unlink(missing_ok=True)


if __name__ == '__main__':
    os.umask(0o077)
    supervisor = Supervisor()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: supervisor.stopping.set())
    supervisor.run()
