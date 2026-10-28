"""Repository responsibilities for VSM Toolbox."""

import math
import re
from .auth import ApiError
from .bpmn import parse_bpmn
from .resources import RESOURCES, PCF_TYPES, integer_ids


class ContentRepository:
    """Local content and tag operations; the caller owns the transaction.

    Resource names and SQL column names always come from RESOURCES. HTTP,
    cookies, and permission enforcement belong to Handler instead.
    """

    def __init__(self, conn, environment_id=1):
        self.conn = conn
        self.environment_id = environment_id

    def serialize(self, table, rows, ident=None):
        records = [dict(row) for row in rows]
        if not records:
            return records
        if table == 'processes':
            for record in records:
                record['bpmn'] = parse_bpmn(record['bpmn_xml']) if record['bpmn_xml'] else None
        if table == 'pcf_entries':
            entries = {
                row['id']: dict(row)
                for row in self.conn.execute(
                    'SELECT id,parent_id,number FROM pcf_entries WHERE environment_id=?',
                    (self.environment_id,),
                )
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
            query = f'SELECT j.{entity_key}, j.{item_key} FROM {join_table} j JOIN {table} e ON e.id=j.{entity_key} WHERE e.environment_id=?'
            parameters = (self.environment_id,)
            if ident is not None:
                query += f' AND j.{entity_key}=?'
                parameters = (self.environment_id, ident)
            for entity_id, item_id in self.conn.execute(
                query + f' ORDER BY {item_key}', parameters
            ):
                assignments.setdefault(entity_id, []).append(item_id)
            for record in records:
                record[output] = assignments.get(record['id'], [])
        return records

    def list(self, table, ordered=False):
        order = RESOURCES[table].order_by if ordered else 'id'
        return self.serialize(
            table,
            self.conn.execute(
                f'SELECT * FROM {table} WHERE environment_id=? ORDER BY {order}',
                (self.environment_id,),
            ),
        )

    def get(self, table, ident):
        row = self.conn.execute(
            f'SELECT * FROM {table} WHERE id=? AND environment_id=?', (ident, self.environment_id)
        ).fetchone()
        if row is None:
            raise ApiError(404, 'Not found')
        return self.serialize(table, [row], ident)[0]

    def snapshot(self):
        data = {table: self.list(table, ordered=True) for table in RESOURCES}
        data['step_processes'] = [
            dict(row)
            for row in self.conn.execute(
                'SELECT sp.* FROM step_processes sp JOIN steps s ON s.id=sp.step_id WHERE s.environment_id=? ORDER BY step_id, process_id',
                (self.environment_id,),
            )
        ]
        return data

    def validate(self, table, method, values):
        spec = RESOURCES[table]
        if table == 'processes' and values.get('bpmn_xml'):
            parse_bpmn(values['bpmn_xml'])
        if table in ('streams', 'steps'):
            for rating in ('cva', 'bva'):
                if (
                    rating in values
                    and values[rating] is not None
                    and (type(values[rating]) is not int or values[rating] not in (1, 2, 3))
                ):
                    raise ValueError(
                        rating.upper() + ' must be 1 (Low), 2 (Medium), 3 (High), or null (unrated)'
                    )
        if table == 'streams':
            if 'takt_period' in values and values['takt_period'] not in (
                'shift',
                'day',
                'week',
                'month',
            ):
                raise ValueError('Takt period must be shift, day, week, or month')
            for name in ('takt_available_minutes', 'takt_demand'):
                if (
                    name in values
                    and values[name] is not None
                    and (
                        type(values[name]) not in (int, float)
                        or not math.isfinite(values[name])
                        or values[name] <= 0
                    )
                ):
                    raise ValueError(name + ' must be a finite positive number or null')
        tag_ids = None
        pcf_ids = None
        if table == 'streams' and 'pcf_ids' in values:
            pcf_ids = integer_ids(values.pop('pcf_ids'), 'pcf_ids')
            existing = {
                row[0]
                for row in self.conn.execute(
                    'SELECT id FROM pcf_entries WHERE environment_id=?', (self.environment_id,)
                )
            }
            if not set(pcf_ids) <= existing:
                raise ValueError('Unknown PCF entry')
        if spec.tagged and 'tag_ids' in values:
            tag_ids = integer_ids(values.pop('tag_ids'), 'tag_ids')
            existing = {
                row[0]
                for row in self.conn.execute(
                    'SELECT id FROM tags WHERE environment_id=?', (self.environment_id,)
                )
            }
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
        text_limits = dict(spec.text_limits)
        for key, value in values.items():
            if value is None and key in spec.nullable:
                continue
            kind = spec.fields[key]
            limit = text_limits.get(key, 20000)
            if kind is str and (not isinstance(value, str) or len(value) > limit):
                raise ValueError(f'{key} must be text of at most {limit} characters')
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
        if (
            table == 'steps'
            and 'stream_id' in values
            and not self.conn.execute(
                'SELECT 1 FROM streams WHERE id=? AND environment_id=?',
                (values['stream_id'], self.environment_id),
            ).fetchone()
        ):
            raise ValueError('Unknown stream')
        if (
            table == 'tags'
            and values.get('category_id') is not None
            and not self.conn.execute(
                'SELECT 1 FROM tag_categories WHERE id=? AND environment_id=?',
                (values['category_id'], self.environment_id),
            ).fetchone()
        ):
            raise ValueError('Unknown tag category')
        return tag_ids, pcf_ids

    def replace_process_links(self, step_id, data):
        self.get('steps', step_id)
        ids = integer_ids(data.get('process_ids'), 'process_ids')
        available = {
            row[0]
            for row in self.conn.execute(
                'SELECT id FROM processes WHERE environment_id=?', (self.environment_id,)
            )
        }
        if not set(ids) <= available:
            raise ValueError('Unknown process')
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
            values['environment_id'] = self.environment_id
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
                'SELECT entry_type FROM pcf_entries WHERE id=? AND environment_id=?',
                (parent_id, self.environment_id),
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
            'SELECT 1 FROM pcf_entries WHERE parent_id IS ? AND number=? AND id!=? AND environment_id=?',
            (parent_id, number, ident or -1, self.environment_id),
        ).fetchone():
            raise ApiError(409, 'This number is already used under the selected parent')
