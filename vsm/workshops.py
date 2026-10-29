"""Environment-scoped collaborative brown paper boards.

Mutations run inside the HTTP layer's IMMEDIATE transaction. Per-item revisions
allow independent edits while detecting stale edits to the same object.
"""

import json
import math
import time
from .auth import ApiError

KINDS = (
    'step',
    'customer',
    'wait',
    'decision',
    'handoff',
    'pain',
    'improvement',
    'note',
    'connector',
)


def initialize(conn):
    conn.executescript(
        '''
    CREATE TABLE IF NOT EXISTS workshops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
      name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS workshop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workshop_presence (
      board_id INTEGER NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seen REAL NOT NULL, PRIMARY KEY(board_id,user_id));
    '''
    )


class Workshops:
    def __init__(self, conn, environment):
        self.conn, self.environment = conn, environment

    def board(self, ident):
        row = self.conn.execute(
            'SELECT * FROM workshops WHERE id=? AND environment_id=?', (ident, self.environment)
        ).fetchone()
        if row is None:
            raise ApiError(404, 'Workshop not found')
        return dict(row)

    def read(self, ident=None):
        if ident is None:
            return [
                dict(row)
                for row in self.conn.execute(
                    'SELECT id,name,revision FROM workshops WHERE environment_id=? ORDER BY id',
                    (self.environment,),
                )
            ]
        result = self.board(ident)
        result['items'] = [
            dict(json.loads(row['payload']), id=row['id'], revision=row['revision'])
            for row in self.conn.execute(
                'SELECT * FROM workshop_items WHERE board_id=? ORDER BY id', (ident,)
            )
        ]
        result['participants'] = [
            dict(row)
            for row in self.conn.execute(
                'SELECT u.username FROM workshop_presence p JOIN users u ON u.id=p.user_id WHERE p.board_id=? AND p.seen>? ORDER BY u.username',
                (ident, time.time() - 15),
            )
        ]
        return result

    def mutate(self, parts, method, data, user):
        if len(parts) == 2 and method == 'POST':
            name = data.get('name')
            if (
                set(data) != {'name'}
                or not isinstance(name, str)
                or not 1 <= len(name.strip()) <= 160
            ):
                raise ValueError('Supply a workshop name (1–160 characters)')
            ident = self.conn.execute(
                'INSERT INTO workshops(environment_id,name) VALUES (?,?)',
                (self.environment, name.strip()),
            ).lastrowid
            return self.read(ident)
        if len(parts) < 3 or not parts[2].isdigit():
            raise ApiError(404, 'Not found')
        ident = int(parts[2])
        self.board(ident)
        if len(parts) == 4 and parts[3] == 'presence' and method == 'POST':
            self.conn.execute(
                'INSERT INTO workshop_presence VALUES (?,?,?) ON CONFLICT(board_id,user_id) DO UPDATE SET seen=excluded.seen',
                (ident, user['id'], time.time()),
            )
            return {'ok': True}
        if len(parts) == 3 and method == 'DELETE':
            if data.get('confirmation') != self.board(ident)['name']:
                raise ValueError('Confirm the workshop name')
            self.conn.execute('DELETE FROM workshops WHERE id=?', (ident,))
            return {'deleted': ident}
        if len(parts) == 4 and parts[3] == 'items' and method == 'POST':
            if (
                self.conn.execute(
                    'SELECT count(*) FROM workshop_items WHERE board_id=?', (ident,)
                ).fetchone()[0]
                >= 1000
            ):
                raise ValueError('A workshop supports up to 1000 blocks and connectors')
            payload = self.validate(data, ident)
            self.conn.execute(
                'INSERT INTO workshop_items(board_id,payload) VALUES (?,?)',
                (ident, json.dumps(payload)),
            )
        elif (
            len(parts) == 5
            and parts[3] == 'items'
            and parts[4].isdigit()
            and method in ('PUT', 'DELETE')
        ):
            item_id = int(parts[4])
            row = self.conn.execute(
                'SELECT * FROM workshop_items WHERE id=? AND board_id=?', (item_id, ident)
            ).fetchone()
            if row is None:
                raise ApiError(
                    409, 'This block was removed. Reloaded the shared canvas; retry your change.'
                )
            if type(data.get('revision')) is not int or data['revision'] != row['revision']:
                raise ApiError(
                    409,
                    'Another participant changed this block. Reloaded the shared canvas; review it before retrying.',
                )
            if method == 'DELETE':
                # Remove attached arrows in the same transaction.
                for arrow in self.conn.execute(
                    'SELECT id,payload FROM workshop_items WHERE board_id=?', (ident,)
                ).fetchall():
                    p = json.loads(arrow['payload'])
                    if p.get('source') == item_id or p.get('target') == item_id:
                        self.conn.execute('DELETE FROM workshop_items WHERE id=?', (arrow['id'],))
                self.conn.execute('DELETE FROM workshop_items WHERE id=?', (item_id,))
            else:
                payload = self.validate({k: v for k, v in data.items() if k != 'revision'}, ident)
                if payload['kind'] != json.loads(row['payload'])['kind']:
                    raise ValueError('Block type cannot be changed')
                self.conn.execute(
                    'UPDATE workshop_items SET revision=revision+1,payload=? WHERE id=?',
                    (json.dumps(payload), item_id),
                )
        else:
            raise ApiError(404, 'Not found')
        self.conn.execute('UPDATE workshops SET revision=revision+1 WHERE id=?', (ident,))
        return self.read(ident)

    def validate(self, data, ident):
        fields = {'kind', 'text', 'x', 'y', 'owner', 'work', 'wait', 'source', 'target', 'phase'}
        if set(data) - fields or data.get('kind') not in KINDS:
            raise ValueError('Invalid workshop block')
        result = {'kind': data['kind']}
        for key, limit in (('text', 2000), ('owner', 160), ('phase', 30)):
            value = data.get(key, '')
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError(f'Invalid {key}')
            result[key] = value
        if result['phase'] not in ('', 'Current state', 'Future state'):
            raise ValueError('Invalid map state')
        for key in ('x', 'y', 'work', 'wait'):
            value = data.get(key, 0)
            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or not 0 <= value <= (5780 if key == 'x' else 5870 if key == 'y' else 1000000)
            ):
                raise ValueError(f'Invalid {key}')
            result[key] = value
        if result['kind'] == 'connector':
            for key in ('source', 'target'):
                value = data.get(key)
                row = self.conn.execute(
                    'SELECT payload FROM workshop_items WHERE id=? AND board_id=?',
                    (value if type(value) is int else -1, ident),
                ).fetchone()
                if row is None or json.loads(row['payload'])['kind'] == 'connector':
                    raise ValueError('Connect two existing blocks on this canvas')
                result[key] = value
            if result['source'] == result['target']:
                raise ValueError('Connect two different blocks')
        return result
