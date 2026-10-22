"""Local Value Stream Mapping server. Python 3.11+, no third-party dependencies."""
import json
import os
import sqlite3
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

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


FIELDS = {
    'streams': {'name': str, 'customer': str, 'outcome': str, 'description': str},
    'steps': {'name': str, 'stream_id': int, 'owner': str, 'position': int,
              'work_minutes': float, 'wait_minutes': float},
    'processes': {'name': str, 'owner': str, 'description': str, 'procedure': str},
}


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, data):
        payload = json.dumps(data, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/health':
            with connect() as conn:
                conn.execute('SELECT 1').fetchone()
            return self.respond(200, {'status': 'ok'})
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

    def mutate(self, method):
        # Browser writes must originate from this host; no cross-origin API access.
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.respond(403, {'error': 'Cross-origin writes are disabled'})
        parts = urlparse(self.path).path.strip('/').split('/')
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 1_000_000:
                return self.respond(413, {'error': 'Request too large'})
            data = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object')
            with connect() as conn:
                if len(parts) == 4 and parts[:2] == ['api', 'steps'] and parts[2].isdigit() and parts[3] == 'processes' and method == 'PUT':
                    step_id = int(parts[2])
                    if not conn.execute('SELECT id FROM steps WHERE id=?', (step_id,)).fetchone():
                        return self.respond(404, {'error': 'Step not found'})
                    ids = data.get('process_ids')
                    if not isinstance(ids, list) or any(type(i) is not int for i in ids):
                        raise ValueError('process_ids must be an array of integer IDs')
                    conn.execute('DELETE FROM step_processes WHERE step_id=?', (step_id,))
                    conn.executemany('INSERT INTO step_processes VALUES (?,?)', [(step_id, i) for i in set(ids)])
                    result = {'step_id': step_id, 'process_ids': ids}
                else:
                    if len(parts) not in (2, 3) or parts[0] != 'api' or parts[1] not in FIELDS:
                        return self.respond(404, {'error': 'Not found'})
                    table = parts[1]
                    ident = int(parts[2]) if len(parts) == 3 else None
                    if method == 'POST' and ident is not None or method != 'POST' and ident is None:
                        return self.respond(405, {'error': 'Unsupported method for this resource'})
                    if ident is not None and not conn.execute('SELECT id FROM ' + table + ' WHERE id=?', (ident,)).fetchone():
                        return self.respond(404, {'error': 'Not found'})
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
            self.respond(201 if method == 'POST' else 200, result)
        except (ValueError, json.JSONDecodeError, sqlite3.IntegrityError) as exc:
            self.respond(400, {'error': str(exc)})

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
