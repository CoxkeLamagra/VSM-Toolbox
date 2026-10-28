"""Pcf responsibilities for VSM Toolbox."""

import csv
import io
import re
import json
import hashlib
import hmac
from .auth import ApiError
from .resources import PCF_TYPES
from .repository import ContentRepository

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

    def __init__(self, conn, text, environment_id=1):
        self.conn = conn
        self.environment_id = environment_id
        self.rows = parse_pcf_csv(text)
        self.existing = {
            row['id']: dict(row)
            for row in conn.execute(
                'SELECT * FROM pcf_entries WHERE environment_id=? ORDER BY id', (environment_id,)
            )
        }
        serialized = ContentRepository(conn, environment_id).list('pcf_entries')
        self.indexes = {row['index']: row['id'] for row in serialized}
        self.labels = {row['id']: row['index'] for row in serialized}
        self.references = {}
        for entry in self.existing.values():
            if entry['reference'].strip():
                self.references.setdefault(entry['reference'].strip().casefold(), []).append(
                    entry['id']
                )
        self.fingerprint = hashlib.sha256(
            json.dumps(
                {'environment_id': environment_id, 'entries': list(self.existing.values())},
                sort_keys=True,
            ).encode()
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
        next_id = self.conn.execute('SELECT COALESCE(max(id),0)+1 FROM pcf_entries').fetchone()[0]
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
                    'INSERT INTO pcf_entries(id,environment_id,'
                    + ','.join(columns)
                    + ') VALUES (?,?,?,?,?,?,?,?)',
                    [ident, self.environment_id, *values],
                )
        return {
            'created': sum(ident not in self.existing for ident in changed),
            'updated': sum(ident in self.existing for ident in changed),
            'skipped': skipped,
        }
