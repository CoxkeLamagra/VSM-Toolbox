"""Environments responsibilities for VSM Toolbox."""

import time
from .auth import ApiError
from .config import ROLES
from .resources import PCF_TYPES


class EnvironmentRepository:
    """Environment ownership and membership rules within the caller's transaction.

    The HTTP layer authenticates the actor and checks CSRF before mutation.
    No method opens a connection or commits; session selection shares the same
    transaction as environment creation and membership changes.
    """

    def __init__(self, conn, user, token_hash):
        self.conn = conn
        self.user = user
        self.token_hash = token_hash

    def selected(self):
        user = self.user
        if user is None:
            return None
        token = self.token_hash
        row = self.conn.execute(
            'SELECT e.id,e.name,e.description,COALESCE(m.role,u.role) AS role FROM environment_members m JOIN environments e ON e.id=m.environment_id JOIN users u ON u.id=m.user_id LEFT JOIN session_environments se ON se.token_hash=? WHERE m.user_id=? ORDER BY CASE WHEN e.id=se.environment_id THEN 0 ELSE 1 END,e.id LIMIT 1',
            (token, user['id']),
        ).fetchone()
        return dict(row) if row else None

    def member(self, ident, roles=ROLES):
        user = self.user
        row = self.conn.execute(
            'SELECT e.*,COALESCE(m.role,u.role) AS role FROM environments e JOIN environment_members m ON m.environment_id=e.id JOIN users u ON u.id=m.user_id WHERE e.id=? AND m.user_id=?',
            (ident, user['id']),
        ).fetchone()
        if row is None:
            raise ApiError(404, 'Environment not found')
        if row['role'] not in roles:
            raise ApiError(403, 'Only environment Admins can perform this action')
        return dict(row)

    def overview(self):
        user = self.user
        rows = self.conn.execute(
            'SELECT e.*,COALESCE(m.role,u.role) AS role FROM environments e JOIN environment_members m ON m.environment_id=e.id JOIN users u ON u.id=m.user_id WHERE m.user_id=? ORDER BY e.name COLLATE NOCASE,e.id',
            (user['id'],),
        )
        results = {
            row['id']: {
                **dict(row),
                'counts': {
                    key: 0
                    for key in (
                        'streams',
                        'steps',
                        'processes',
                        'pcf_entries',
                        'tags',
                        'workshops',
                        'members',
                    )
                },
            }
            for row in rows
        }
        for table in (
            'streams',
            'steps',
            'processes',
            'pcf_entries',
            'tags',
            'workshops',
            'environment_members',
        ):
            key = 'members' if table == 'environment_members' else table
            counts = self.conn.execute(
                f'SELECT environment_id,count(*) AS total FROM {table} WHERE environment_id IN (SELECT environment_id FROM environment_members WHERE user_id=?) GROUP BY environment_id',
                (user['id'],),
            )
            for count in counts:
                results[count['environment_id']]['counts'][key] = count['total']
        return list(results.values())

    def members(self, ident):
        self.member(ident, ('Admin',))
        return [
            dict(row)
            for row in self.conn.execute(
                'SELECT u.id AS user_id,u.username,COALESCE(m.role,u.role) AS role,m.role IS NULL AS inherited FROM environment_members m JOIN users u ON u.id=m.user_id WHERE m.environment_id=? ORDER BY u.username',
                (ident,),
            )
        ]

    def mutate(self, parts, method, data):
        if len(parts) == 2 and method == 'POST':
            return self.create(data)
        if len(parts) not in (3, 4, 5) or not parts[2].isdigit():
            raise ApiError(404, 'Not found')
        ident = int(parts[2])
        if len(parts) == 4 and parts[3] == 'switch' and method == 'POST':
            return self.switch(ident, data)
        environment = self.member(ident, ('Admin',))
        if len(parts) == 4 and parts[3] == 'members' and method == 'POST':
            return self.add_member(ident, data)
        if (
            len(parts) == 5
            and parts[3] == 'members'
            and parts[4].isdigit()
            and method in ('PUT', 'DELETE')
        ):
            return self.change_member(ident, int(parts[4]), method, data)
        if len(parts) == 3 and method == 'DELETE':
            return self.delete(ident, environment, data)
        if len(parts) == 3 and method == 'PUT':
            return self.update(ident, data)
        raise ApiError(405, 'Unsupported environment operation')

    def create(self, data):
        user = self.user
        if (
            set(data) - {'name', 'description'}
            or not isinstance(data.get('name'), str)
            or not 1 <= len(data['name'].strip()) <= 200
            or not isinstance(data.get('description', ''), str)
            or len(data.get('description', '')) > 20000
        ):
            raise ValueError(
                'Supply an environment name (1–200 characters) and optional description'
            )
        cursor = self.conn.execute(
            'INSERT INTO environments(name,description,created_by,created_at) VALUES (?,?,?,?)',
            (data['name'].strip(), data.get('description', ''), user['id'], time.time()),
        )
        ident = cursor.lastrowid
        self.conn.execute(
            "INSERT INTO environment_members VALUES (?,?,'Admin')", (ident, user['id'])
        )
        token = self.token_hash
        self.conn.execute(
            'INSERT INTO session_environments VALUES (?,?) ON CONFLICT(token_hash) DO UPDATE SET environment_id=excluded.environment_id',
            (token, ident),
        )
        return self.member(ident)

    def switch(self, ident, data):
        if data:
            raise ValueError('Switch accepts an empty object')
        environment = self.member(ident)
        token = self.token_hash
        self.conn.execute(
            'INSERT INTO session_environments VALUES (?,?) ON CONFLICT(token_hash) DO UPDATE SET environment_id=excluded.environment_id',
            (token, ident),
        )
        return environment

    def add_member(self, ident, data):
        if (
            set(data) != {'username', 'role'}
            or not isinstance(data['username'], str)
            or data['role'] not in ROLES
        ):
            raise ValueError('Supply an existing local username and Admin, Editor, or Viewer role')
        member = self.conn.execute(
            'SELECT id FROM users WHERE username=?', (data['username'],)
        ).fetchone()
        if member is None:
            raise ValueError('Local account not found')
        if self.conn.execute(
            'SELECT 1 FROM environment_members WHERE environment_id=? AND user_id=?',
            (ident, member['id']),
        ).fetchone():
            raise ApiError(409, 'This account is already a member; edit its role instead')
        self.conn.execute(
            'INSERT INTO environment_members VALUES (?,?,?)',
            (ident, member['id'], data['role']),
        )
        return self.members(ident)

    def change_member(self, ident, member_id, method, data):
        current = self.conn.execute(
            'SELECT COALESCE(m.role,u.role) AS role FROM environment_members m JOIN users u ON u.id=m.user_id WHERE m.environment_id=? AND m.user_id=?',
            (ident, member_id),
        ).fetchone()
        if current is None:
            raise ApiError(404, 'Member not found')
        if method == 'PUT' and (set(data) != {'role'} or data['role'] not in ROLES):
            raise ValueError('Supply an Admin, Editor, or Viewer role')
        removing_admin = current['role'] == 'Admin' and (
            method == 'DELETE' or data.get('role') != 'Admin'
        )
        admins = self.conn.execute(
            "SELECT count(*) FROM environment_members m JOIN users u ON u.id=m.user_id WHERE m.environment_id=? AND COALESCE(m.role,u.role)='Admin'",
            (ident,),
        ).fetchone()[0]
        if removing_admin and admins <= 1:
            raise ApiError(409, 'The last environment Admin cannot be removed or demoted')
        if method == 'DELETE':
            self.conn.execute(
                'DELETE FROM environment_members WHERE environment_id=? AND user_id=?',
                (ident, member_id),
            )
        else:
            self.conn.execute(
                'UPDATE environment_members SET role=? WHERE environment_id=? AND user_id=?',
                (data['role'], ident, member_id),
            )
        return {'updated': member_id}

    def delete(self, ident, environment, data):
        if data != {'confirmation': environment['name']}:
            raise ValueError('Confirm the environment name before deleting it')
        self.conn.execute('DELETE FROM streams WHERE environment_id=?', (ident,))
        self.conn.execute('DELETE FROM processes WHERE environment_id=?', (ident,))
        for kind in reversed(PCF_TYPES):
            self.conn.execute(
                'DELETE FROM pcf_entries WHERE environment_id=? AND entry_type=?', (ident, kind)
            )
        self.conn.execute('DELETE FROM environments WHERE id=?', (ident,))
        return {'deleted': ident}

    def update(self, ident, data):
        if not data or set(data) - {'name', 'description'}:
            raise ValueError('Supply name and/or description')
        if 'name' in data and (
            not isinstance(data['name'], str) or not 1 <= len(data['name'].strip()) <= 200
        ):
            raise ValueError('Name must contain 1–200 characters')
        if 'description' in data and (
            not isinstance(data['description'], str) or len(data['description']) > 20000
        ):
            raise ValueError('Description must contain at most 20000 characters')
        self.conn.execute(
            'UPDATE environments SET ' + ','.join(key + '=?' for key in data) + ' WHERE id=?',
            [*data.values(), ident],
        )
        return {'updated': ident}
