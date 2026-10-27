"""Local Value Stream Mapping server. Python 3.11+, no third-party dependencies."""

import base64
import csv
import io
import binascii
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import updater

UPDATE_PROTOCOL = 1
ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('VSM_DATABASE', ROOT / 'data' / 'vsm.sqlite3'))


@contextmanager
def connect():
    """Own one connection, commit on success, and roll back on an exception."""
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
    """Create missing tables and apply additive migrations without resetting data."""
    with connect() as conn:
        conn.executescript(
            '''
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
          outcome TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
          voc TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS steps (
          id INTEGER PRIMARY KEY, stream_id INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
          name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
          work_minutes REAL NOT NULL DEFAULT 0 CHECK(work_minutes>=0),
          wait_minutes REAL NOT NULL DEFAULT 0 CHECK(wait_minutes>=0));
        CREATE TABLE IF NOT EXISTS processes (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '', procedure TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS tag_categories (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
        CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          color TEXT NOT NULL DEFAULT '#e6404d',
          category_id INTEGER REFERENCES tag_categories(id) ON DELETE SET NULL);
        CREATE TABLE IF NOT EXISTS pcf_entries (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL,
          entry_type TEXT NOT NULL CHECK(entry_type IN ('Category','Process Group','Process','Activity','Task')),
          parent_id INTEGER REFERENCES pcf_entries(id) ON DELETE RESTRICT,
          number INTEGER NOT NULL CHECK(number>0 AND number<=999999),
          reference TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
          CHECK((entry_type='Category' AND parent_id IS NULL) OR (entry_type!='Category' AND parent_id IS NOT NULL)),
          UNIQUE(parent_id,number));
        CREATE UNIQUE INDEX IF NOT EXISTS pcf_category_number ON pcf_entries(number) WHERE parent_id IS NULL;
        CREATE TABLE IF NOT EXISTS stream_pcf (
          stream_id INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
          pcf_id INTEGER NOT NULL REFERENCES pcf_entries(id) ON DELETE CASCADE,
          PRIMARY KEY(stream_id,pcf_id));
        CREATE TABLE IF NOT EXISTS step_processes (
          step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
          process_id INTEGER NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
          PRIMARY KEY(step_id, process_id));
        '''
        )

        for entity in ('streams', 'steps', 'processes'):
            conn.execute(
                f'CREATE TABLE IF NOT EXISTS {entity}_tags (entity_id INTEGER NOT NULL REFERENCES {entity}(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(entity_id,tag_id))'
            )

        # Existing workspaces gain an optional customer request without losing data.
        if 'voc' not in {row['name'] for row in conn.execute('PRAGMA table_info(streams)')}:
            conn.execute("ALTER TABLE streams ADD COLUMN voc TEXT NOT NULL DEFAULT ''")


BRANDING_DEFAULTS = {
    'name': 'VSM Toolbox',
    'tagline': 'Value streams. Connected.',
    'primary': '#e6404d',
    'sidebar': '#151d44',
    'background': '#f5f6fa',
    'logo': '',
}


def branding(conn):
    row = conn.execute("SELECT value FROM settings WHERE key='branding'").fetchone()
    return {**BRANDING_DEFAULTS, **(json.loads(row['value']) if row else {})}


def validate_branding(data):
    if set(data) != set(BRANDING_DEFAULTS):
        raise ValueError('Supply name, tagline, primary, sidebar, background and logo')
    for key, limit in (('name', 64), ('tagline', 120)):
        if not isinstance(data[key], str) or not data[key].strip() or len(data[key]) > limit:
            raise ValueError(f'{key} must contain 1–{limit} characters')
        data[key] = data[key].strip()
    for key in ('primary', 'sidebar', 'background'):
        if not isinstance(data[key], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', data[key]):
            raise ValueError(f'{key} must be a six-digit hex color')
    logo = data['logo']
    if not isinstance(logo, str) or len(logo) > 180000:
        raise ValueError('Logo must be a PNG or JPEG up to 128 KiB')
    if logo:
        match = re.fullmatch(r'data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)', logo)
        if not match:
            raise ValueError('Logo must be a PNG or JPEG')
        try:
            raw = base64.b64decode(match[2], validate=True)
        except binascii.Error as exc:
            raise ValueError('Invalid logo encoding') from exc
        signature = b'\x89PNG\r\n\x1a\n' if match[1] == 'png' else b'\xff\xd8\xff'
        if len(raw) > 131072 or not raw.startswith(signature):
            raise ValueError('Invalid logo image or logo exceeds 128 KiB')
    return data


def foreground(color):
    values = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
    luminance = sum(v * w for v, w in zip(linear, (0.2126, 0.7152, 0.0722)))
    return '#ffffff' if luminance < 0.179 else '#111827'


ROLES = ('Admin', 'Editor', 'Viewer')
SESSION_SECONDS = 12 * 60 * 60
PASSWORD_ITERATIONS = 600_000


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        'sha256', password.encode(), bytes.fromhex(salt), PASSWORD_ITERATIONS
    ).hex()
    return f'pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest}'


def password_matches(password, stored):
    _, iterations, salt, expected = stored.split('$')
    actual = hashlib.pbkdf2_hmac(
        'sha256', password.encode(), bytes.fromhex(salt), int(iterations)
    ).hex()
    return hmac.compare_digest(actual, expected)


def validate_account(data, creating=False):
    if set(data) - {'username', 'password', 'role'} or not data:
        raise ValueError('Supply only username, password and role')
    if creating and not {'username', 'password'} <= set(data):
        raise ValueError('Username and password are required')
    if 'username' in data and (
        not isinstance(data['username'], str)
        or not re.fullmatch(r'[A-Za-z0-9_.-]{3,64}', data['username'])
    ):
        raise ValueError('Username must be 3–64 letters, numbers, dots, underscores or hyphens')
    if 'password' in data and (
        not isinstance(data['password'], str) or not 12 <= len(data['password']) <= 128
    ):
        raise ValueError('Password must be 12–128 characters')
    if 'role' in data and data['role'] not in ROLES:
        raise ValueError('Role must be Admin, Editor or Viewer')


def public_user(row):
    return {key: row[key] for key in ('id', 'username', 'role')}


@dataclass(frozen=True)
class ResourceSpec:
    fields: dict[str, type]
    write_roles: tuple[str, ...] = ('Admin', 'Editor')
    tagged: bool = False
    order_by: str = 'id'


PCF_TYPES = ('Category', 'Process Group', 'Process', 'Activity', 'Task')


RESOURCES = {
    'pcf_entries': ResourceSpec(
        {
            'name': str,
            'entry_type': str,
            'parent_id': int,
            'number': int,
            'reference': str,
            'description': str,
        }
    ),
    'tags': ResourceSpec({'name': str, 'color': str, 'category_id': int}, ('Admin',)),
    'tag_categories': ResourceSpec({'name': str}, ('Admin',)),
    'streams': ResourceSpec(
        {'name': str, 'customer': str, 'outcome': str, 'description': str, 'voc': str}, tagged=True
    ),
    'steps': ResourceSpec(
        {
            'name': str,
            'stream_id': int,
            'owner': str,
            'position': int,
            'work_minutes': float,
            'wait_minutes': float,
        },
        tagged=True,
        order_by='position, id',
    ),
    'processes': ResourceSpec(
        {'name': str, 'owner': str, 'description': str, 'procedure': str}, tagged=True
    ),
}


def integer_ids(value, field):
    if not isinstance(value, list) or any(type(ident) is not int for ident in value):
        raise ValueError(field + ' must be an array of integer IDs')
    return value


ADMIN_READ_PATHS = ('/api/roles', '/api/users', '/api/updates', '/api/backups', '/api/maintenance')
STATIC_ASSETS = {
    '/': ('index.html', 'text/html'),
    '/app.js': ('app.js', 'text/javascript'),
    '/style.css': ('style.css', 'text/css'),
}
CONTENT_SECURITY_POLICY = "default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'"
WRITES_PAUSED = ('installing', 'restarting', 'backing-up', 'restoring', 'clearing')


def branding_stylesheet(theme, tag_colors):
    """Generate the one local stylesheet used by branding and colored tags."""
    css = ':root{' + ';'.join(
        f'--{key}:{theme[key]}' for key in ('primary', 'sidebar', 'background')
    )
    css += (
        f";--on-primary:{foreground(theme['primary'])};--on-sidebar:{foreground(theme['sidebar'])}"
        + '}'
    )
    for tag in tag_colors:
        color = tag['color'] if re.fullmatch(r'#[0-9a-fA-F]{6}', tag['color']) else '#e6404d'
        css += f".tag-color-{tag['id']}{{--tag-color:{color};--tag-ink:{foreground(color)}}}"
    return css.encode()


class ContentRepository:
    """Local content and tag operations; the caller owns the transaction.

    Resource names and SQL column names always come from RESOURCES. HTTP,
    cookies, and permission enforcement belong to Handler instead.
    """

    def __init__(self, conn):
        self.conn = conn

    def serialize(self, table, rows, ident=None):
        records = [dict(row) for row in rows]
        if not records:
            return records
        if table == 'pcf_entries':
            entries = {
                row['id']: dict(row)
                for row in self.conn.execute('SELECT id,parent_id,number FROM pcf_entries')
            }
            for record in records:
                path, current = [], record['id']
                while current is not None:
                    ancestor = entries[current]
                    path.append(str(ancestor['number']))
                    current = ancestor['parent_id']
                record['index'] = '.'.join(reversed(path))
            records.sort(key=lambda row: tuple(map(int, row['index'].split('.'))))
        relationships = []
        if RESOURCES[table].tagged:
            relationships.append((f'{table}_tags', 'entity_id', 'tag_id', 'tag_ids'))
        if table == 'streams':
            relationships.append(('stream_pcf', 'stream_id', 'pcf_id', 'pcf_ids'))
        for join_table, entity_key, item_key, output in relationships:
            assignments = {}
            query = f'SELECT {entity_key}, {item_key} FROM {join_table}'
            parameters = ()
            if ident is not None:
                query += f' WHERE {entity_key}=?'
                parameters = (ident,)
            for entity_id, item_id in self.conn.execute(
                query + f' ORDER BY {item_key}', parameters
            ):
                assignments.setdefault(entity_id, []).append(item_id)
            for record in records:
                record[output] = assignments.get(record['id'], [])
        return records

    def list(self, table, ordered=False):
        order = RESOURCES[table].order_by if ordered else 'id'
        return self.serialize(table, self.conn.execute(f'SELECT * FROM {table} ORDER BY {order}'))

    def get(self, table, ident):
        row = self.conn.execute(f'SELECT * FROM {table} WHERE id=?', (ident,)).fetchone()
        if row is None:
            raise ApiError(404, 'Not found')
        return self.serialize(table, [row], ident)[0]

    def snapshot(self):
        data = {table: self.list(table, ordered=True) for table in RESOURCES}
        data['step_processes'] = [
            dict(row)
            for row in self.conn.execute(
                'SELECT * FROM step_processes ORDER BY step_id, process_id'
            )
        ]
        return data

    def validate(self, table, method, values):
        spec = RESOURCES[table]
        tag_ids = None
        pcf_ids = None
        if table == 'streams' and 'pcf_ids' in values:
            pcf_ids = integer_ids(values.pop('pcf_ids'), 'pcf_ids')
            existing = {row[0] for row in self.conn.execute('SELECT id FROM pcf_entries')}
            if not set(pcf_ids) <= existing:
                raise ValueError('Unknown PCF entry')
        if spec.tagged and 'tag_ids' in values:
            tag_ids = integer_ids(values.pop('tag_ids'), 'tag_ids')
            existing = {row[0] for row in self.conn.execute('SELECT id FROM tags')}
            if not set(tag_ids) <= existing:
                raise ValueError('Unknown tag')
        if (
            table == 'tags'
            and 'color' in values
            and (
                not isinstance(values['color'], str)
                or not re.fullmatch(r'#[0-9a-fA-F]{6}', values['color'])
            )
        ):
            raise ValueError('Tag color must be a six-digit hex color')
        if table in ('tags', 'tag_categories') and 'name' in values:
            name = values['name']
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                raise ValueError('Name must contain 1–80 characters')
            values['name'] = name.strip()
        if set(values) - set(spec.fields):
            raise ValueError('Unknown fields')
        if method == 'POST' and (
            'name' not in values or table == 'steps' and 'stream_id' not in values
        ):
            raise ValueError('name and, for steps, stream_id are required')
        for key, value in values.items():
            kind = spec.fields[key]
            if kind is str and (not isinstance(value, str) or len(value) > 20000):
                raise ValueError(key + ' must be text of at most 20000 characters')
            if (
                (table == 'tags' and key == 'category_id')
                or (table == 'pcf_entries' and key == 'parent_id')
            ) and value is None:
                continue
            if kind is int and type(value) is not int:
                raise ValueError(key + ' must be an integer')
            if kind is float and (
                type(value) not in (int, float) or not math.isfinite(value) or value < 0
            ):
                raise ValueError(key + ' must be a finite nonnegative number')
        if 'name' in values and not values['name'].strip():
            raise ValueError('Name cannot be empty')
        if not values and tag_ids is None and pcf_ids is None:
            raise ValueError('No fields supplied')
        return tag_ids, pcf_ids

    def replace_process_links(self, step_id, data):
        if not self.conn.execute('SELECT id FROM steps WHERE id=?', (step_id,)).fetchone():
            raise ApiError(404, 'Step not found')
        ids = integer_ids(data.get('process_ids'), 'process_ids')
        self.conn.execute('DELETE FROM step_processes WHERE step_id=?', (step_id,))
        self.conn.executemany(
            'INSERT INTO step_processes VALUES (?,?)', [(step_id, ident) for ident in set(ids)]
        )
        return {'step_id': step_id, 'process_ids': ids}

    def mutate(self, parts, method, data):
        if (
            len(parts) == 4
            and parts[:2] == ['api', 'steps']
            and parts[2].isdigit()
            and parts[3] == 'processes'
            and method == 'PUT'
        ):
            return self.replace_process_links(int(parts[2]), data)
        if len(parts) not in (2, 3) or parts[0] != 'api' or parts[1] not in RESOURCES:
            raise ApiError(404, 'Not found')
        table = parts[1]
        if len(parts) == 3 and not parts[2].isdigit():
            raise ApiError(404, 'Not found')
        ident = int(parts[2]) if len(parts) == 3 else None
        if (method == 'POST') != (ident is None):
            raise ApiError(405, 'Unsupported method for this resource')
        if ident is not None:
            self.get(table, ident)
        if method == 'DELETE':
            if (
                table == 'pcf_entries'
                and self.conn.execute(
                    'SELECT 1 FROM pcf_entries WHERE parent_id=?', (ident,)
                ).fetchone()
            ):
                raise ApiError(409, 'Remove or move child entries before deleting this PCF entry')
            self.conn.execute(f'DELETE FROM {table} WHERE id=?', (ident,))
            return {'deleted': ident}
        values = dict(data)
        tag_ids, pcf_ids = self.validate(table, method, values)
        if table == 'pcf_entries':
            self.validate_pcf(ident, values)
        if method == 'POST':
            columns = ','.join(values)
            placeholders = ','.join('?' for _ in values)
            cursor = self.conn.execute(
                f'INSERT INTO {table} ({columns}) VALUES ({placeholders})', list(values.values())
            )
            ident = cursor.lastrowid
        elif values:
            assignments = ','.join(key + '=?' for key in values)
            self.conn.execute(
                f'UPDATE {table} SET {assignments} WHERE id=?', [*values.values(), ident]
            )
        if tag_ids is not None:
            self.conn.execute(f'DELETE FROM {table}_tags WHERE entity_id=?', (ident,))
            self.conn.executemany(
                f'INSERT INTO {table}_tags VALUES (?,?)',
                [(ident, tag_id) for tag_id in set(tag_ids)],
            )
        if pcf_ids is not None:
            self.conn.execute('DELETE FROM stream_pcf WHERE stream_id=?', (ident,))
            self.conn.executemany(
                'INSERT INTO stream_pcf VALUES (?,?)', [(ident, pcf_id) for pcf_id in set(pcf_ids)]
            )
        return self.get(table, ident)

    def validate_pcf(self, ident, values):
        merged = {**(self.get('pcf_entries', ident) if ident is not None else {}), **values}
        kind = merged.get('entry_type')
        if kind not in PCF_TYPES:
            raise ValueError('Choose a valid PCF entry type')
        number = merged.get('number')
        if type(number) is not int or not 1 <= number <= 999999:
            raise ValueError('PCF number must be an integer between 1 and 999999')
        if len(merged['name']) > 200:
            raise ValueError('PCF name must contain at most 200 characters')
        parent_id = merged.get('parent_id')
        level = PCF_TYPES.index(kind)
        if level == 0:
            if parent_id is not None:
                raise ValueError('A Category cannot have a parent')
        else:
            parent = self.conn.execute(
                'SELECT entry_type FROM pcf_entries WHERE id=?', (parent_id,)
            ).fetchone()
            if parent is None or parent['entry_type'] != PCF_TYPES[level - 1] or parent_id == ident:
                raise ValueError(kind + ' must be linked to an existing ' + PCF_TYPES[level - 1])
        if ident is not None:
            expected = PCF_TYPES[level + 1] if level < 4 else ''
            if self.conn.execute(
                'SELECT 1 FROM pcf_entries WHERE parent_id=? AND entry_type!=?', (ident, expected)
            ).fetchone():
                raise ApiError(409, 'Entry type cannot change while it has incompatible children')
        if self.conn.execute(
            'SELECT 1 FROM pcf_entries WHERE parent_id IS ? AND number=? AND id!=?',
            (parent_id, number, ident or -1),
        ).fetchone():
            raise ApiError(409, 'This number is already used under the selected parent')


PCF_CSV_LIMIT = 256 * 1024
PCF_CSV_ROWS = 5000


def parse_pcf_csv(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > PCF_CSV_LIMIT:
        raise ValueError('CSV must be UTF-8 text up to 256 KiB')
    text = text.lstrip('\ufeff')
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=',;\t')
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text, newline=''), dialect=dialect, strict=True)
    try:
        headers = [header.strip() for header in (reader.fieldnames or [])]
        if len(set(headers)) != len(headers) or not {'PCF ID', 'Hierarchy ID', 'Name'} <= set(
            headers
        ):
            raise ValueError('CSV requires unique columns named PCF ID, Hierarchy ID, and Name')
        reader.fieldnames = headers
        rows, references, indexes = [], set(), set()
        for raw in reader:
            line = reader.line_num
            if None in raw:
                raise ValueError(f'CSV line {line}: too many columns')
            if not any((value or '').strip() for value in raw.values()):
                continue
            reference = (raw.get('PCF ID') or '').strip()
            name = (raw.get('Name') or '').strip()
            index = (raw.get('Hierarchy ID') or '').strip().rstrip('.')
            # APQC exports commonly write top-level categories as 1.0, 2.0, etc.
            if re.fullmatch(r'[0-9]+\.0', index):
                index = index[:-2]
            if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,4}', index):
                raise ValueError(
                    f'CSV line {line}: Hierarchy ID must have one to five numeric levels'
                )
            numbers = tuple(map(int, index.split('.')))
            if any(not 1 <= number <= 999999 for number in numbers):
                raise ValueError(f'CSV line {line}: hierarchy numbers must be between 1 and 999999')
            index = '.'.join(map(str, numbers))
            if not reference or len(reference) > 200 or not name or len(name) > 200:
                raise ValueError(f'CSV line {line}: PCF ID and Name must contain 1–200 characters')
            if reference.casefold() in references or index in indexes:
                raise ValueError(
                    f'CSV line {line}: duplicate PCF ID or Hierarchy ID inside the file'
                )
            description = raw.get('Description') or ''
            if len(description) > 20000:
                raise ValueError(
                    f'CSV line {line}: Description must contain at most 20000 characters'
                )
            references.add(reference.casefold())
            indexes.add(index)
            rows.append(
                {
                    'line': line,
                    'reference': reference,
                    'name': name,
                    'index': index,
                    'number': numbers[-1],
                    'entry_type': PCF_TYPES[len(numbers) - 1],
                    **({'description': description} if 'Description' in headers else {}),
                }
            )
            if len(rows) > PCF_CSV_ROWS:
                raise ValueError('CSV may contain at most 5000 entries')
    except csv.Error as exc:
        raise ValueError('Invalid CSV: ' + str(exc)) from exc
    if not rows:
        raise ValueError('CSV contains no entries')
    return sorted(
        rows,
        key=lambda row: (len(row['index'].split('.')), tuple(map(int, row['index'].split('.')))),
    )


class PCFImporter:
    """Preview and apply a whole CSV within the caller's database transaction."""

    def __init__(self, conn, text):
        self.conn = conn
        self.rows = parse_pcf_csv(text)
        self.existing = {
            row['id']: dict(row) for row in conn.execute('SELECT * FROM pcf_entries ORDER BY id')
        }
        serialized = ContentRepository(conn).list('pcf_entries')
        self.indexes = {row['index']: row['id'] for row in serialized}
        self.labels = {row['id']: row['index'] for row in serialized}
        self.references = {}
        for entry in self.existing.values():
            if entry['reference'].strip():
                self.references.setdefault(entry['reference'].strip().casefold(), []).append(
                    entry['id']
                )
        self.fingerprint = hashlib.sha256(
            json.dumps(list(self.existing.values()), sort_keys=True).encode()
        ).hexdigest()
        self.duplicates = []
        incoming_indexes = {row['index'] for row in self.rows}
        for row in self.rows:
            matches = self.references.get(row['reference'].casefold(), [])
            if len(matches) > 1:
                raise ValueError(
                    f"APQC reference {row['reference']} matches multiple existing entries; resolve them manually first"
                )
            if matches:
                entry = self.existing[matches[0]]
                self.duplicates.append(
                    {
                        **row,
                        'existing_id': entry['id'],
                        'existing_name': entry['name'],
                        'existing_index': self.labels[entry['id']],
                    }
                )
            if '.' in row['index']:
                parent = row['index'].rsplit('.', 1)[0]
                if parent not in incoming_indexes and parent not in self.indexes:
                    raise ValueError(
                        f"CSV line {row['line']}: missing parent {parent}; include it in the CSV or create it first"
                    )

    def preview(self):
        return {
            'fingerprint': self.fingerprint,
            'total': len(self.rows),
            'new': len(self.rows) - len(self.duplicates),
            'duplicates': self.duplicates,
        }

    def apply(self, fingerprint, decisions):
        if not isinstance(fingerprint, str) or not hmac.compare_digest(
            fingerprint, self.fingerprint
        ):
            raise ApiError(
                409, 'PCF entries changed since preview. Preview the CSV again before importing.'
            )
        expected = {row['reference'] for row in self.duplicates}
        if (
            not isinstance(decisions, dict)
            or set(decisions) != expected
            or any(choice not in ('yes', 'no') for choice in decisions.values())
        ):
            raise ValueError('Choose Yes or No for every duplicate APQC reference ID')
        model = {ident: dict(entry) for ident, entry in self.existing.items()}
        incoming_ids, changed, skipped = {}, [], 0
        next_id = max(model, default=0) + 1
        for row in self.rows:
            matches = self.references.get(row['reference'].casefold(), [])
            if matches:
                ident = matches[0]
            else:
                ident = next_id
                next_id += 1
            incoming_ids[row['index']] = ident
        for row in self.rows:
            ident = incoming_ids[row['index']]
            if ident in self.existing and decisions[row['reference']] == 'no':
                skipped += 1
                continue
            parent_index = row['index'].rsplit('.', 1)[0] if '.' in row['index'] else None
            parent_id = (
                incoming_ids.get(parent_index, self.indexes.get(parent_index))
                if parent_index
                else None
            )
            model[ident] = {
                **model.get(ident, {'id': ident, 'description': ''}),
                **{key: row[key] for key in ('name', 'reference', 'entry_type', 'number')},
                'parent_id': parent_id,
                **({'description': row['description']} if 'description' in row else {}),
            }
            changed.append(ident)
        slots = set()
        for entry in model.values():
            level = PCF_TYPES.index(entry['entry_type'])
            parent = model.get(entry['parent_id'])
            if (level == 0 and entry['parent_id'] is not None) or (
                level > 0 and (parent is None or parent['entry_type'] != PCF_TYPES[level - 1])
            ):
                raise ValueError(
                    f"Import would give {entry['name']} an incompatible parent or child. Review overwrite decisions."
                )
            slot = (entry['parent_id'], entry['number'])
            if slot in slots:
                raise ValueError(
                    'Import would reuse an occupied hierarchy number. Review overwrite decisions or existing entries; unrelated reference IDs are never overwritten.'
                )
            slots.add(slot)
        # Stage changed existing numbers so valid sibling/root number swaps work.
        used = {entry['number'] for entry in model.values()} | {
            entry['number'] for entry in self.existing.values()
        }
        temporary = 999999
        for ident in changed:
            if ident in self.existing:
                while temporary in used:
                    temporary -= 1
                if temporary < 1:
                    raise ValueError('No temporary hierarchy numbers available for import')
                self.conn.execute('UPDATE pcf_entries SET number=? WHERE id=?', (temporary, ident))
                used.add(temporary)
        for ident in sorted(changed, key=lambda ident: PCF_TYPES.index(model[ident]['entry_type'])):
            entry = model[ident]
            columns = ('name', 'reference', 'entry_type', 'number', 'parent_id', 'description')
            values = [entry[key] for key in columns]
            if ident in self.existing:
                self.conn.execute(
                    'UPDATE pcf_entries SET '
                    + ','.join(key + '=?' for key in columns)
                    + ' WHERE id=?',
                    [*values, ident],
                )
            else:
                self.conn.execute(
                    'INSERT INTO pcf_entries(id,' + ','.join(columns) + ') VALUES (?,?,?,?,?,?,?)',
                    [ident, *values],
                )
        return {
            'created': sum(ident not in self.existing for ident in changed),
            'updated': sum(ident in self.existing for ident in changed),
            'skipped': skipped,
        }


class Handler(BaseHTTPRequestHandler):
    def response_headers(self, status, length, content_type, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(length))
        self.send_header('X-Content-Type-Options', 'nosniff')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def respond(self, status, data, cookie=None):
        payload = json.dumps(data, allow_nan=False).encode()
        headers = {'Cache-Control': 'no-store'}
        if cookie:
            headers['Set-Cookie'] = cookie
        if status == 429:
            headers['Retry-After'] = '300'
        self.response_headers(status, len(payload), 'application/json; charset=utf-8', headers)
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
        return conn.execute(
            'SELECT users.id, username, role, csrf_token FROM sessions '
            'JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?',
            (token, time.time()),
        ).fetchone()

    def require_user(self, conn, roles=ROLES, csrf=False):
        user = self.session(conn)
        if not user:
            raise ApiError(401, 'Sign in to continue')
        if user['role'] not in roles:
            raise ApiError(403, 'Your role does not allow this action')
        if csrf and not hmac.compare_digest(
            self.headers.get('X-CSRF-Token', '').encode(), user['csrf_token'].encode()
        ):
            raise ApiError(403, 'Missing or invalid CSRF token')
        return user

    def session_cookie(self, token, expires=False):
        secure = '; Secure' if os.environ.get('VSM_COOKIE_SECURE') == '1' else ''
        return f'vsm_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={0 if expires else SESSION_SECONDS}{secure}'

    def create_session(self, conn, user):
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        conn.execute(
            'DELETE FROM sessions WHERE expires_at<=? OR token_hash=?',
            (time.time(), hashlib.sha256(self.session_token().encode()).hexdigest()),
        )
        conn.execute(
            'INSERT INTO sessions VALUES (?,?,?,?)',
            (
                hashlib.sha256(token.encode()).hexdigest(),
                user['id'],
                csrf,
                time.time() + SESSION_SECONDS,
            ),
        )
        return {
            'user': public_user(user),
            'csrf_token': csrf,
            'setup_required': False,
        }, self.session_cookie(token)

    def auth_mutation(self, conn, path, method, data):
        if path == '/api/auth/register' and method == 'POST':
            if conn.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                raise ApiError(
                    403, 'Registration is closed. An Admin must create additional accounts.'
                )
            if set(data) != {'username', 'password'}:
                raise ValueError('Username and password are required')
            validate_account(data, creating=True)
            cursor = conn.execute(
                'INSERT INTO users (username,password_hash,role) VALUES (?,?,?)',
                (data['username'], password_hash(data['password']), 'Admin'),
            )
            user = conn.execute('SELECT * FROM users WHERE id=?', (cursor.lastrowid,)).fetchone()
            result, cookie = self.create_session(conn, user)
            return 201, result, cookie
        if path == '/api/auth/login' and method == 'POST':
            if (
                set(data) != {'username', 'password'}
                or not isinstance(data.get('username'), str)
                or not isinstance(data.get('password'), str)
            ):
                raise ValueError('Username and password are required')
            if len(data['username']) > 64 or len(data['password']) > 128:
                raise ValueError('Invalid credentials')
            now = time.time()
            address = self.client_address[0]
            conn.execute('DELETE FROM login_attempts WHERE started_at<=?', (now - 300,))
            attempt = conn.execute(
                'SELECT failures FROM login_attempts WHERE address=?', (address,)
            ).fetchone()
            if attempt and attempt['failures'] >= 10:
                return (
                    429,
                    {'error': 'Too many failed sign-in attempts. Try again in five minutes.'},
                    None,
                )
            user = conn.execute(
                'SELECT * FROM users WHERE username=?', (data['username'],)
            ).fetchone()
            # The dummy hash keeps unknown usernames on the same password-check path.
            stored = (
                user['password_hash']
                if user
                else f'pbkdf2_sha256${PASSWORD_ITERATIONS}$' + '00' * 16 + '$' + '00' * 32
            )
            valid = password_matches(data['password'], stored)
            if not user or not valid:
                conn.execute(
                    'INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(address) DO UPDATE SET failures=failures+1',
                    (address, now),
                )
                return 401, {'error': 'Invalid username or password'}, None
            conn.execute('DELETE FROM login_attempts WHERE address=?', (address,))
            result, cookie = self.create_session(conn, user)
            return 200, result, cookie
        if path == '/api/auth/logout' and method == 'POST':
            self.require_user(conn, csrf=True)
            conn.execute(
                'DELETE FROM sessions WHERE token_hash=?',
                (hashlib.sha256(self.session_token().encode()).hexdigest(),),
            )
            return 200, {'signed_out': True}, self.session_cookie('', expires=True)
        raise ApiError(404, 'Not found')

    def account_mutation(self, conn, parts, method, data):
        self.require_user(conn, ('Admin',), csrf=True)
        if len(parts) not in (2, 3) or len(parts) == 3 and not parts[2].isdigit():
            raise ApiError(404, 'Not found')
        ident = int(parts[2]) if len(parts) == 3 else None
        if (method == 'POST') != (ident is None):
            raise ApiError(405, 'Unsupported method for this resource')
        current = (
            conn.execute('SELECT * FROM users WHERE id=?', (ident,)).fetchone()
            if ident is not None
            else None
        )
        if ident is not None and not current:
            raise ApiError(404, 'Account not found')
        if method != 'DELETE':
            validate_account(data, creating=method == 'POST')
            if (
                'username' in data
                and conn.execute(
                    'SELECT id FROM users WHERE username=? AND id!=?',
                    (data['username'], ident or -1),
                ).fetchone()
            ):
                raise ApiError(409, 'Username is already in use')
        if (
            current
            and current['role'] == 'Admin'
            and (method == 'DELETE' or data.get('role', 'Admin') != 'Admin')
        ):
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
            cursor = conn.execute(
                f'INSERT INTO users ({",".join(values)}) VALUES ({",".join("?" for _ in values)})',
                list(values.values()),
            )
            ident = cursor.lastrowid
        else:
            conn.execute(
                f'UPDATE users SET {",".join(k+"=?" for k in values)} WHERE id=?',
                [*values.values(), ident],
            )
            conn.execute('DELETE FROM sessions WHERE user_id=?', (ident,))
        return public_user(conn.execute('SELECT * FROM users WHERE id=?', (ident,)).fetchone())

    def do_GET(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/') and path != '/branding.css':
            return self.serve_asset(path)
        try:
            download = re.fullmatch(r'/api/backups/([A-Za-z0-9_.-]+)/download', path)
            with connect() as conn:
                # Read the session, content, and assignments from one snapshot.
                # Release the database before writing to a potentially slow client.
                conn.execute('BEGIN')
                if path == '/api/health':
                    conn.execute('SELECT 1').fetchone()
                    result = {
                        'status': 'ok',
                        'update_protocol': UPDATE_PROTOCOL,
                        'revision': os.environ.get('VSM_REVISION', 'local'),
                    }
                elif path in ('/api/branding', '/branding.css'):
                    theme = branding(conn)
                    if path == '/api/branding':
                        result = {'branding': theme, 'defaults': BRANDING_DEFAULTS}
                    else:
                        result = branding_stylesheet(
                            theme, conn.execute('SELECT id,color FROM tags')
                        )
                elif path == '/api/session':
                    user = self.session(conn)
                    result = {
                        'user': public_user(user) if user else None,
                        'csrf_token': user['csrf_token'] if user else None,
                        'setup_required': not bool(
                            conn.execute('SELECT 1 FROM users LIMIT 1').fetchone()
                        ),
                    }
                else:
                    admin_only = any(
                        path == base or path.startswith(base + '/') for base in ADMIN_READ_PATHS
                    )
                    self.require_user(conn, ('Admin',) if admin_only else ROLES)
                    result = None if download else self.read_api(conn, path)
            if download:
                return self.download_backup(download[1])
            if path == '/branding.css':
                self.response_headers(
                    200, len(result), 'text/css; charset=utf-8', {'Cache-Control': 'no-store'}
                )
                self.wfile.write(result)
                return
            return self.respond(200, result)
        except ApiError as exc:
            return self.respond(exc.status, {'error': str(exc)})

    def read_api(self, conn, path):
        if path == '/api/maintenance':
            operation = updater.status()
            return {
                'operation': operation,
                'supported': os.environ.get('VSM_DATA_RESET_PROTOCOL') == '1'
                and operation.get('data_reset_protocol') == 1,
            }
        if path == '/api/backups':
            return {
                'backups': updater.list_backups(),
                'operation': updater.status(),
                'supported': os.environ.get('VSM_BACKUP_PROTOCOL') == '1',
            }
        if path == '/api/updates':
            return updater.status()
        if path == '/api/roles':
            return list(ROLES)
        if path == '/api/users':
            return [
                public_user(row) for row in conn.execute('SELECT * FROM users ORDER BY username')
            ]
        if re.fullmatch(r'/api/users/[0-9]+', path):
            row = conn.execute(
                'SELECT * FROM users WHERE id=?', (int(path.rsplit('/', 1)[1]),)
            ).fetchone()
            if row is None:
                raise ApiError(404, 'Account not found')
            return public_user(row)
        repository = ContentRepository(conn)
        if path == '/api/data':
            return repository.snapshot()
        parts = path.strip('/').split('/')
        if len(parts) in (2, 3) and parts[1] in RESOURCES:
            if len(parts) == 2:
                return repository.list(parts[1])
            if parts[2].isdigit():
                return repository.get(parts[1], int(parts[2]))
        raise ApiError(404, 'Not found')

    def serve_asset(self, path):
        if path not in STATIC_ASSETS:
            return self.respond(404, {'error': 'Not found'})
        filename, mime = STATIC_ASSETS[path]
        payload = (ROOT / 'web' / filename).read_bytes()
        self.response_headers(
            200,
            len(payload),
            mime + '; charset=utf-8',
            {'Content-Security-Policy': CONTENT_SECURITY_POLICY},
        )
        self.wfile.write(payload)

    def download_backup(self, identifier):
        try:
            source = updater.backup_path(identifier)
        except ValueError as exc:
            raise ApiError(404, str(exc)) from exc
        # Stream from an opened file so cleanup cannot replace a later lookup.
        try:
            handle = source.open('rb')
        except FileNotFoundError as exc:
            raise ApiError(404, 'Backup not found') from exc
        with handle:
            self.response_headers(
                200,
                os.fstat(handle.fileno()).st_size,
                'application/octet-stream',
                {
                    'Content-Disposition': 'attachment; filename="' + source.name + '"',
                    'Cache-Control': 'no-store',
                },
            )
            shutil.copyfileobj(handle, self.wfile)

    def require_backup_engine(self):
        if os.environ.get('VSM_BACKUP_PROTOCOL') != '1' or not updater.status()['available']:
            raise ApiError(
                409,
                'Restart with the updated installer or Docker image to enable full application backups.',
            )

    def upload_backup(self):
        source = None
        try:
            with connect() as conn:
                self.require_user(conn, ('Admin',), csrf=True)
            self.require_backup_engine()
            if updater.status()['state'] in updater.BUSY:
                raise ApiError(409, 'Another maintenance operation is in progress')
            if self.headers.get('Content-Type') != 'application/octet-stream':
                raise ApiError(415, 'Upload the backup as application/octet-stream')
            size = int(self.headers.get('Content-Length', '0'))
            if size <= 0 or size > updater.BACKUP_LIMIT:
                raise ApiError(413, 'Upload must be between 1 byte and 128 MiB')
            base = updater.directory() / 'backups'
            base.mkdir(parents=True, exist_ok=True)
            os.chmod(base, 0o700)
            source = base / ('.upload-' + uuid.uuid4().hex)
            with source.open('xb') as handle:
                os.chmod(source, 0o600)
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('Incomplete backup upload')
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            with tempfile.TemporaryDirectory(dir=base) as temporary:
                updater.validate_backup(source, Path(temporary))
                updater.validate_backup_database(Path(temporary) / 'database.sqlite3')
            identifier = 'uploaded-' + uuid.uuid4().hex + '.vsm-backup.zip'
            os.replace(source, base / identifier)
            source = None
            self.respond(201, {'id': identifier})
        except ApiError as exc:
            self.respond(exc.status, {'error': str(exc)})
        except (
            ValueError,
            OSError,
            sqlite3.Error,
            updater.zipfile.BadZipFile,
            KeyError,
            TypeError,
            RecursionError,
        ) as exc:
            self.respond(400, {'error': 'Invalid backup upload: ' + str(exc)})
        finally:
            if source:
                source.unlink(missing_ok=True)

    def maintenance_request(self, conn, path, data):
        """Validate an Admin request before handing it to the supervisor queue."""
        self.require_user(conn, ('Admin',), csrf=True)
        action = path.rsplit('/', 1)[1]
        payload = {}
        if path.startswith('/api/backups/'):
            self.require_backup_engine()
            if action == 'create':
                if data:
                    raise ValueError('Backup creation accepts an empty object')
                action = 'backup'
            elif action == 'restore':
                if set(data) != {'id'}:
                    raise ValueError('A backup identifier is required')
                updater.backup_path(data['id'])
                payload = {'id': data['id']}
            else:
                if set(data) != {'ids'} or not isinstance(data['ids'], list) or not data['ids']:
                    raise ValueError('Select backups to remove')
                for identifier in data['ids']:
                    updater.backup_path(identifier)
                payload = {'ids': data['ids']}
        else:
            if action == 'install':
                self.require_backup_engine()
            if data:
                raise ValueError('Update requests do not accept configuration or source overrides')
        try:
            return updater.request(action, **payload)
        except RuntimeError as exc:
            raise ApiError(409, str(exc)) from exc

    def mutate(self, method):
        # Browser writes must originate from this host; no cross-origin API access.
        origin = self.headers.get('Origin')
        if (
            origin
            and (
                urlparse(origin).scheme not in ('http', 'https')
                or urlparse(origin).netloc != self.headers.get('Host')
            )
        ) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.respond(403, {'error': 'Cross-origin writes are disabled'})
        path = urlparse(self.path).path
        parts = path.strip('/').split('/')
        if path == '/api/backups/upload' and method == 'POST':
            return self.upload_backup()
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
                if updater.status()['state'] in WRITES_PAUSED:
                    raise ApiError(
                        503,
                        'An update is being installed. Please wait for the application to restart.',
                    )
                if method == 'POST' and path in (
                    '/api/backups/create',
                    '/api/backups/restore',
                    '/api/backups/cleanup',
                    '/api/updates/check',
                    '/api/updates/install',
                ):
                    result = self.maintenance_request(conn, path, data)
                    status, cookie = 202, None
                elif path == '/api/maintenance/clear-data' and method == 'POST':
                    self.require_user(conn, ('Admin',), csrf=True)
                    self.require_backup_engine()
                    if (
                        os.environ.get('VSM_DATA_RESET_PROTOCOL') != '1'
                        or updater.status().get('data_reset_protocol') != 1
                    ):
                        raise ApiError(
                            409,
                            'Rerun the Debian installer or rebuild the Docker image to enable safe data clearing.',
                        )
                    if data != {'confirmation': 'DELETE ALL BUSINESS DATA'}:
                        raise ValueError(
                            'Type DELETE ALL BUSINESS DATA to confirm clearing business data'
                        )
                    try:
                        result = updater.request('clear-data')
                    except RuntimeError as exc:
                        raise ApiError(409, str(exc)) from exc
                    status, cookie = 202, None
                elif (
                    path in ('/api/pcf_import/preview', '/api/pcf_import/apply')
                    and method == 'POST'
                ):
                    self.require_user(conn, ('Admin', 'Editor'), csrf=True)
                    required = (
                        {'csv'}
                        if path.endswith('/preview')
                        else {'csv', 'fingerprint', 'decisions'}
                    )
                    if set(data) != required:
                        raise ValueError(
                            'Supply CSV text and, for apply, the preview fingerprint and overwrite decisions'
                        )
                    importer = PCFImporter(conn, data['csv'])
                    result = (
                        importer.preview()
                        if path.endswith('/preview')
                        else importer.apply(data['fingerprint'], data['decisions'])
                    )
                    status, cookie = 200, None
                elif path == '/api/branding' and method == 'PUT':
                    self.require_user(conn, ('Admin',), csrf=True)
                    theme = validate_branding(data)
                    conn.execute(
                        "INSERT INTO settings(key,value) VALUES ('branding',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (json.dumps(theme),),
                    )
                    status, result, cookie = 200, theme, None
                elif path.startswith('/api/auth/'):
                    status, result, cookie = self.auth_mutation(conn, path, method, data)
                elif len(parts) >= 2 and parts[:2] == ['api', 'users']:
                    result = self.account_mutation(conn, parts, method, data)
                    status, cookie = (201 if method == 'POST' else 200), None
                else:
                    spec = RESOURCES.get(parts[1]) if len(parts) > 1 else None
                    self.require_user(
                        conn, spec.write_roles if spec else ('Admin', 'Editor'), csrf=True
                    )
                    result = ContentRepository(conn).mutate(parts, method, data)
                    status, cookie = (201 if method == 'POST' else 200), None
            self.respond(status, result, cookie)
        except ApiError as exc:
            self.respond(exc.status, {'error': str(exc)})
        except (ValueError, sqlite3.IntegrityError) as exc:
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
