"""Local Value Stream Mapping server. Python 3.11+, no third-party dependencies."""
import json
import tempfile
import uuid
import shutil
import hashlib
import hmac
import re
import secrets
import time
import updater
from http.cookies import SimpleCookie, CookieError
import os
import sqlite3
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

UPDATE_PROTOCOL = 1
ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('VSM_DATABASE', ROOT / 'data' / 'vsm.sqlite3'))


@contextmanager
def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def initialize():
    with connect() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('Admin','Editor','Viewer')));
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_token TEXT NOT NULL, expires_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS login_attempts (
          address TEXT PRIMARY KEY, failures INTEGER NOT NULL, started_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS streams (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, customer TEXT NOT NULL DEFAULT '',
          outcome TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS steps (
          id INTEGER PRIMARY KEY, stream_id INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
          name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
          work_minutes REAL NOT NULL DEFAULT 0 CHECK(work_minutes>=0),
          wait_minutes REAL NOT NULL DEFAULT 0 CHECK(wait_minutes>=0));
        CREATE TABLE IF NOT EXISTS processes (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '', procedure TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS step_processes (
          step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
          process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
          PRIMARY KEY(step_id, process_id));
        ''')


ROLES = ('Admin', 'Editor', 'Viewer')
SESSION_SECONDS = 12 * 60 * 60
PASSWORD_ITERATIONS = 600_000


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), PASSWORD_ITERATIONS).hex()
    return f'pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest}'


def password_matches(password, stored):
    _, iterations, salt, expected = stored.split('$')
    actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(salt), int(iterations)).hex()
    return hmac.compare_digest(actual, expected)


def validate_account(data, creating=False):
    if set(data) - {'username', 'password', 'role'} or not data:
        raise ValueError('Supply only username, password and role')
    if creating and not {'username', 'password'} <= set(data):
        raise ValueError('Username and password are required')
    if 'username' in data and (not isinstance(data['username'], str) or
                              not re.fullmatch(r'[A-Za-z0-9_.-]{3,64}', data['username'])):
        raise ValueError('Username must be 3–64 letters, numbers, dots, underscores or hyphens')
    if 'password' in data and (not isinstance(data['password'], str) or not 12 <= len(data['password']) <= 128):
        raise ValueError('Password must be 12–128 characters')
    if 'role' in data and data['role'] not in ROLES:
        raise ValueError('Role must be Admin, Editor or Viewer')


def public_user(row):
    return {key: row[key] for key in ('id', 'username', 'role')}


FIELDS = {
    'streams': {'name': str, 'customer': str, 'outcome': str, 'description': str},
    'steps': {'name': str, 'stream_id': int, 'owner': str, 'position': int,
              'work_minutes': float, 'wait_minutes': float},
    'processes': {'name': str, 'owner': str, 'description': str, 'procedure': str},
}


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, data, cookie=None):
        payload = json.dumps(data, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if status == 429:
            self.send_header('Retry-After', '300')
        self.end_headers()
        self.wfile.write(payload)

    def session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            token = cookie.get('vsm_session')
            return token.value if token and re.fullmatch(r'[A-Za-z0-9_-]{43}', token.value) else ''
        except CookieError:
            return ''

    def session(self, conn):
        token = hashlib.sha256(self.session_token().encode()).hexdigest()
        return conn.execute('SELECT users.id, username, role, csrf_token FROM sessions '
                            'JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?',
                            (token, time.time())).fetchone()

    def require_user(self, conn, roles=ROLES, csrf=False):
        user = self.session(conn)
        if not user:
            raise ApiError(401, 'Sign in to continue')
        if user['role'] not in roles:
            raise ApiError(403, 'Your role does not allow this action')
        if csrf and not hmac.compare_digest(self.headers.get('X-CSRF-Token', '').encode(), user['csrf_token'].encode()):
            raise ApiError(403, 'Missing or invalid CSRF token')
        return user

    def session_cookie(self, token, expires=False):
        secure = '; Secure' if os.environ.get('VSM_COOKIE_SECURE') == '1' else ''
        return f'vsm_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if expires else SESSION_SECONDS}{secure}'

    def create_session(self, conn, user):
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        conn.execute('DELETE FROM sessions WHERE expires_at<=? OR token_hash=?',
                     (time.time(), hashlib.sha256(self.session_token().encode()).hexdigest()))
        conn.execute('INSERT INTO sessions VALUES (?,?,?,?)',
                     (hashlib.sha256(token.encode()).hexdigest(), user['id'], csrf, time.time()+SESSION_SECONDS))
        return {'user': public_user(user), 'csrf_token': csrf, 'setup_required': False}, self.session_cookie(token)

    def auth_mutation(self, conn, path, method, data):
        if path == '/api/auth/register' and method == 'POST':
            if conn.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                raise ApiError(403, 'Registration is closed. An Admin must create additional accounts.')
            if set(data) != {'username', 'password'}:
                raise ValueError('Username and password are required')
            validate_account(data, creating=True)
            cursor = conn.execute('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)',
                                  (data['username'], password_hash(data['password']), 'Admin'))
            user = conn.execute('SELECT * FROM users WHERE id=?', (cursor.lastrowid,)).fetchone()
            result, cookie = self.create_session(conn, user)
            return 201, result, cookie
        if path == '/api/auth/login' and method == 'POST':
            if set(data) != {'username', 'password'} or not isinstance(data.get('username'), str) or not isinstance(data.get('password'), str):
                raise ValueError('Username and password are required')
            if len(data['username']) > 64 or len(data['password']) > 128:
                raise ValueError('Invalid credentials')
            now = time.time()
            address = self.client_address[0]
            conn.execute('DELETE FROM login_attempts WHERE started_at<=?', (now-300,))
            attempt = conn.execute('SELECT failures FROM login_attempts WHERE address=?', (address,)).fetchone()
            if attempt and attempt['failures'] >= 10:
                return 429, {'error': 'Too many failed sign-in attempts. Try again in five minutes.'}, None
            user = conn.execute('SELECT * FROM users WHERE username=?', (data['username'],)).fetchone()
            # The dummy hash keeps unknown usernames on the same password-check path.
            stored = user['password_hash'] if user else f'pbkdf2_sha256${PASSWORD_ITERATIONS}$' + '00'*16 + '$' + '00'*32
            valid = password_matches(data['password'], stored)
            if not user or not valid:
                conn.execute('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET failures=failures+1', (address, now))
                return 401, {'error': 'Invalid username or password'}, None
            conn.execute('DELETE FROM login_attempts WHERE address=?', (address,))
            result, cookie = self.create_session(conn, user)
            return 200, result, cookie
        if path == '/api/auth/logout' and method == 'POST':
            self.require_user(conn, csrf=True)
            conn.execute('DELETE FROM sessions WHERE token_hash=?', (hashlib.sha256(self.session_token().encode()).hexdigest(),))
            return 200, {'signed_out': True}, self.session_cookie('', expires=True)
        raise ApiError(404, 'Not found')

    def account_mutation(self, conn, parts, method, data):
        self.require_user(conn, ('Admin',), csrf=True)
        if len(parts) not in (2, 3) or len(parts) == 3 and not parts[2].isdigit():
            raise ApiError(404, 'Not found')
        ident = int(parts[2]) if len(parts) == 3 else None
        if (method == 'POST') != (ident is None):
            raise ApiError(405, 'Unsupported method for this resource')
        current = conn.execute('SELECT * FROM users WHERE id=?', (ident,)).fetchone() if ident is not None else None
        if ident is not None and not current:
            raise ApiError(404, 'Account not found')
        if method != 'DELETE':
            validate_account(data, creating=method == 'POST')
            if 'username' in data and conn.execute('SELECT id FROM users WHERE username=? AND id!=?', (data['username'], ident or -1)).fetchone():
                raise ApiError(409, 'Username is already in use')
        if current and current['role'] == 'Admin' and (method == 'DELETE' or data.get('role', 'Admin') != 'Admin'):
            if conn.execute("SELECT count(*) FROM users WHERE role='Admin'").fetchone()[0] <= 1:
                raise ApiError(409, 'The last Admin cannot be removed or demoted')
        if method == 'DELETE':
            conn.execute('DELETE FROM users WHERE id=?', (ident,))
            return {'deleted': ident}
        values = dict(data)
        if 'password' in values:
            values['password_hash'] = password_hash(values.pop('password'))
        if method == 'POST':
            values.setdefault('role', 'Viewer')
            cursor = conn.execute(f'INSERT INTO users ({",".join(values)}) VALUES ({",".join("?" for _ in values)})', list(values.values()))
            ident = cursor.lastrowid
        else:
            conn.execute(f'UPDATE users SET {",".join(k+"=?" for k in values)} WHERE id=?', [*values.values(), ident])
            conn.execute('DELETE FROM sessions WHERE user_id=?', (ident,))
        return public_user(conn.execute('SELECT * FROM users WHERE id=?', (ident,)).fetchone())

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/health':
            with connect() as conn:
                conn.execute('SELECT 1').fetchone()
            return self.respond(200, {'status': 'ok', 'update_protocol': UPDATE_PROTOCOL, 'revision': os.environ.get('VSM_REVISION', 'local')})
        if path == '/api/session':
            with connect() as conn:
                user = self.session(conn)
                result = {'user': public_user(user) if user else None,
                          'csrf_token': user['csrf_token'] if user else None,
                          'setup_required': not bool(conn.execute('SELECT 1 FROM users LIMIT 1').fetchone())}
            return self.respond(200, result)
        if path.startswith('/api/'):
            try:
                with connect() as conn:
                    self.require_user(conn, ('Admin',) if path == '/api/roles' or path.startswith('/api/users') or path.startswith('/api/updates') or path.startswith('/api/backups') else ROLES)
                    if path == '/api/backups':
                        return self.respond(200, {'backups':updater.list_backups(), 'operation':updater.status(),
                                                  'supported':os.environ.get('VSM_BACKUP_PROTOCOL')=='1'})
                    if re.fullmatch(r'/api/backups/[A-Za-z0-9_.-]+/download',path):
                        try: source=updater.backup_path(path.split('/')[3])
                        except ValueError as exc: raise ApiError(404,str(exc)) from exc
                        self.send_response(200)
                        self.send_header('Content-Type','application/octet-stream')
                        self.send_header('Content-Disposition','attachment; filename="'+source.name+'"')
                        self.send_header('Content-Length',str(source.stat().st_size))
                        self.send_header('Cache-Control','no-store')
                        self.send_header('X-Content-Type-Options','nosniff')
                        self.end_headers()
                        with source.open('rb') as handle: shutil.copyfileobj(handle,self.wfile)
                        return
                    if path == '/api/updates':
                        return self.respond(200, updater.status())
                    if path == '/api/roles':
                        return self.respond(200, list(ROLES))
                    if path == '/api/users':
                        return self.respond(200, [public_user(row) for row in conn.execute('SELECT * FROM users ORDER BY username')])
                    if re.fullmatch(r'/api/users/[0-9]+', path):
                        row = conn.execute('SELECT * FROM users WHERE id=?', (int(path.rsplit('/', 1)[1]),)).fetchone()
                        return self.respond(200, public_user(row)) if row else self.respond(404, {'error': 'Account not found'})
            except ApiError as exc:
                return self.respond(exc.status, {'error': str(exc)})
        if path == '/api/data':
            with connect() as conn:
                data = {table: [dict(row) for row in conn.execute('SELECT * FROM ' + table + (' ORDER BY position, id' if table == 'steps' else ' ORDER BY step_id, process_id' if table == 'step_processes' else ' ORDER BY id'))]
                        for table in (*FIELDS, 'step_processes')}
            return self.respond(200, data)
        parts = path.strip('/').split('/')
        if len(parts) in (2, 3) and parts[0] == 'api' and parts[1] in FIELDS:
            with connect() as conn:
                if len(parts) == 2:
                    return self.respond(200, [dict(r) for r in conn.execute('SELECT * FROM ' + parts[1])])
                if parts[2].isdigit():
                    row = conn.execute('SELECT * FROM ' + parts[1] + ' WHERE id=?', (int(parts[2]),)).fetchone()
                    return self.respond(200, dict(row)) if row else self.respond(404, {'error': 'Not found'})
        assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
        if path not in assets:
            return self.respond(404, {'error': 'Not found'})
        filename, mime = assets[path]
        payload = (ROOT / 'web' / filename).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime + '; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(payload)

    def require_backup_engine(self):
        if os.environ.get('VSM_BACKUP_PROTOCOL')!='1' or not updater.status()['available']:
            raise ApiError(409,'Restart with the updated installer or Docker image to enable full application backups.')

    def upload_backup(self):
        source=None
        try:
            with connect() as conn:
                self.require_user(conn,('Admin',),csrf=True)
            self.require_backup_engine()
            if updater.status()['state'] in updater.BUSY: raise ApiError(409,'Another maintenance operation is in progress')
            if self.headers.get('Content-Type')!='application/octet-stream': raise ApiError(415,'Upload the backup as application/octet-stream')
            size=int(self.headers.get('Content-Length','0'))
            if size<=0 or size>updater.BACKUP_LIMIT: raise ApiError(413,'Upload must be between 1 byte and 128 MiB')
            base=updater.directory()/'backups'
            base.mkdir(parents=True,exist_ok=True)
            os.chmod(base,0o700)
            source=base/('.upload-'+uuid.uuid4().hex)
            with source.open('xb') as handle:
                os.chmod(source,0o600)
                remaining=size
                while remaining:
                    chunk=self.rfile.read(min(65536,remaining))
                    if not chunk: raise ValueError('Incomplete backup upload')
                    handle.write(chunk)
                    remaining-=len(chunk)
                handle.flush();os.fsync(handle.fileno())
            with tempfile.TemporaryDirectory(dir=base) as temporary:
                updater.validate_backup(source,Path(temporary))
                updater.validate_backup_database(Path(temporary)/'database.sqlite3')
            identifier='uploaded-'+uuid.uuid4().hex+'.vsm-backup.zip'
            os.replace(source,base/identifier)
            source=None
            self.respond(201,{'id':identifier})
        except ApiError as exc: self.respond(exc.status,{'error':str(exc)})
        except (ValueError,OSError,sqlite3.Error,updater.zipfile.BadZipFile,KeyError,TypeError,RecursionError) as exc:
            self.respond(400,{'error':'Invalid backup upload: '+str(exc)})
        finally:
            if source: source.unlink(missing_ok=True)

    def mutate(self, method):
        # Browser writes must originate from this host; no cross-origin API access.
        origin = self.headers.get('Origin')
        if (origin and (urlparse(origin).scheme not in ('http', 'https') or urlparse(origin).netloc != self.headers.get('Host'))) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.respond(403, {'error': 'Cross-origin writes are disabled'})
        path = urlparse(self.path).path
        parts = path.strip('/').split('/')
        if path=='/api/backups/upload' and method=='POST': return self.upload_backup()
        if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
            return self.respond(415, {'error': 'Content-Type must be application/json'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 1_000_000:
                return self.respond(413, {'error': 'Request too large'})
            data = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object')
            with connect() as conn:
                # Serialize bootstrap and account changes, including the last-Admin invariant.
                conn.execute('BEGIN IMMEDIATE')
                if updater.status()['state'] in ('installing', 'restarting', 'backing-up', 'restoring'):
                    raise ApiError(503, 'An update is being installed. Please wait for the application to restart.')
                if path in ('/api/backups/create','/api/backups/restore','/api/backups/cleanup') and method=='POST':
                    self.require_user(conn,('Admin',),csrf=True)
                    self.require_backup_engine()
                    action=path.rsplit('/',1)[1]
                    if action=='create':
                        if data: raise ValueError('Backup creation accepts an empty object')
                        payload={}; action='backup'
                    elif action=='restore':
                        if set(data)!={'id'}: raise ValueError('A backup identifier is required')
                        updater.backup_path(data['id']);payload={'id':data['id']}
                    else:
                        if set(data)!={'ids'} or not isinstance(data['ids'],list) or not data['ids']: raise ValueError('Select backups to remove')
                        for identifier in data['ids']: updater.backup_path(identifier)
                        payload={'ids':data['ids']}
                    try: result=updater.request(action,**payload)
                    except RuntimeError as exc: raise ApiError(409,str(exc)) from exc
                    status,cookie=202,None
                elif path in ('/api/updates/check', '/api/updates/install') and method == 'POST':
                    self.require_user(conn, ('Admin',), csrf=True)
                    if path.endswith('/install'): self.require_backup_engine()
                    if data:
                        raise ValueError('Update requests do not accept configuration or source overrides')
                    try:
                        result = updater.request(path.rsplit('/', 1)[1])
                    except RuntimeError as exc:
                        raise ApiError(409, str(exc)) from exc
                    status, cookie = 202, None
                elif path.startswith('/api/auth/'):
                    status, result, cookie = self.auth_mutation(conn, path, method, data)
                elif len(parts) >= 2 and parts[:2] == ['api', 'users']:
                    result = self.account_mutation(conn, parts, method, data)
                    status, cookie = (201 if method == 'POST' else 200), None
                else:
                    self.require_user(conn, ('Admin', 'Editor'), csrf=True)
                    result = self.content_mutation(conn, parts, method, data)
                    status, cookie = (201 if method == 'POST' else 200), None
            self.respond(status, result, cookie)
        except ApiError as exc:
            self.respond(exc.status, {'error': str(exc)})
        except (ValueError, sqlite3.IntegrityError) as exc:
            self.respond(400, {'error': str(exc)})

    def content_mutation(self, conn, parts, method, data):
        if len(parts) == 4 and parts[:2] == ['api', 'steps'] and parts[2].isdigit() and parts[3] == 'processes' and method == 'PUT':
            step_id = int(parts[2])
            if not conn.execute('SELECT id FROM steps WHERE id=?', (step_id,)).fetchone():
                raise ApiError(404, 'Step not found')
            ids = data.get('process_ids')
            if not isinstance(ids, list) or any(type(i) is not int for i in ids):
                raise ValueError('process_ids must be an array of integer IDs')
            conn.execute('DELETE FROM step_processes WHERE step_id=?', (step_id,))
            conn.executemany('INSERT INTO step_processes VALUES (?,?)', [(step_id, i) for i in set(ids)])
            result = {'step_id': step_id, 'process_ids': ids}
        else:
            if len(parts) not in (2, 3) or parts[0] != 'api' or parts[1] not in FIELDS:
                raise ApiError(404, 'Not found')
            table = parts[1]
            ident = int(parts[2]) if len(parts) == 3 else None
            if method == 'POST' and ident is not None or method != 'POST' and ident is None:
                raise ApiError(405, 'Unsupported method for this resource')
            if ident is not None and not conn.execute('SELECT id FROM ' + table + ' WHERE id=?', (ident,)).fetchone():
                raise ApiError(404, 'Not found')
            if method == 'DELETE':
                conn.execute('DELETE FROM ' + table + ' WHERE id=?', (ident,))
                result = {'deleted': ident}
            else:
                if set(data) - set(FIELDS[table]):
                    raise ValueError('Unknown fields')
                if method == 'POST' and ('name' not in data or table == 'steps' and 'stream_id' not in data):
                    raise ValueError('name and, for steps, stream_id are required')
                import math
                for key, value in data.items():
                    kind = FIELDS[table][key]
                    if kind is str and (not isinstance(value, str) or len(value) > 20000):
                        raise ValueError(key + ' must be text of at most 20000 characters')
                    if kind is int and type(value) is not int:
                        raise ValueError(key + ' must be an integer')
                    if kind is float and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                        raise ValueError(key + ' must be a finite nonnegative number')
                if 'name' in data and not data['name'].strip():
                    raise ValueError('Name cannot be empty')
                if not data:
                    raise ValueError('No fields supplied')
                if method == 'POST':
                    columns = ','.join(data)
                    cursor = conn.execute(f'INSERT INTO {table} ({columns}) VALUES ({",".join("?" for _ in data)})', list(data.values()))
                    ident = cursor.lastrowid
                else:
                    conn.execute(f'UPDATE {table} SET {",".join(k + "=?" for k in data)} WHERE id=?', [*data.values(), ident])
                result = dict(conn.execute('SELECT * FROM ' + table + ' WHERE id=?', (ident,)).fetchone())
        return result

    def do_POST(self):
        self.mutate('POST')

    def do_PUT(self):
        self.mutate('PUT')

    def do_DELETE(self):
        self.mutate('DELETE')


if __name__ == '__main__':
    initialize()
    host = os.environ.get('VSM_HOST', '127.0.0.1')
    port = int(os.environ.get('VSM_PORT', '8080'))
    print(f'VSM Toolbox listening on {host}:{port}', flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
