"""Storage responsibilities for VSM Toolbox."""

import os
import sqlite3
import time
from pathlib import Path
from contextlib import contextmanager
from .config import ROOT

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
          environment_id INTEGER NOT NULL DEFAULT 1 REFERENCES environments(id) ON DELETE CASCADE,
          CHECK((entry_type='Category' AND parent_id IS NULL) OR (entry_type!='Category' AND parent_id IS NOT NULL)),
          UNIQUE(parent_id,number));

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

        migrate_optional_fields(conn)
        migrate_environments(conn)
        initialize_environment_guards(conn)
        from .workshops import initialize as initialize_workshops

        initialize_workshops(conn)


def migrate_optional_fields(conn):
    """Add feature columns to existing/restored databases without rebuilding data."""
    columns = {
        'streams': {
            'voc': "TEXT NOT NULL DEFAULT ''",
            'cva': "INTEGER CHECK(cva IS NULL OR (typeof(cva)='integer' AND cva BETWEEN 1 AND 3))",
            'bva': "INTEGER CHECK(bva IS NULL OR (typeof(bva)='integer' AND bva BETWEEN 1 AND 3))",
            'takt_available_minutes': 'REAL CHECK(takt_available_minutes IS NULL OR takt_available_minutes>0)',
            'takt_demand': 'REAL CHECK(takt_demand IS NULL OR takt_demand>0)',
            'takt_period': "TEXT NOT NULL DEFAULT 'day' CHECK(takt_period IN ('shift','day','week','month'))",
        },
        'steps': {
            'cva': "INTEGER CHECK(cva IS NULL OR (typeof(cva)='integer' AND cva BETWEEN 1 AND 3))",
            'bva': "INTEGER CHECK(bva IS NULL OR (typeof(bva)='integer' AND bva BETWEEN 1 AND 3))",
        },
        'processes': {'bpmn_xml': "TEXT NOT NULL DEFAULT ''"},
    }
    for table, definitions in columns.items():
        existing = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})')}
        for name, definition in definitions.items():
            if name not in existing:
                conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')


def migrate_environments(conn):
    """Move legacy content into environment 1, preserving IDs and relationships."""
    if conn.execute("SELECT 1 FROM settings WHERE key='environment_schema'").fetchone():
        return
    conn.commit()
    conn.execute('PRAGMA foreign_keys=OFF')
    try:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute(
            'CREATE TABLE IF NOT EXISTS environments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\', created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at REAL NOT NULL)'
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS environment_members (environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT CHECK(role IN ('Admin','Editor','Viewer')), PRIMARY KEY(environment_id,user_id))"
        )
        conn.execute(
            'CREATE TABLE IF NOT EXISTS session_environments (token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE, environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL)'
        )
        conn.execute(
            "INSERT INTO environments(id,name,description,created_by,created_at) VALUES (1,'Default environment','Existing workspace content',(SELECT id FROM users WHERE role='Admin' ORDER BY id LIMIT 1),?)",
            (time.time(),),
        )
        conn.execute(
            'INSERT INTO environment_members(environment_id,user_id) SELECT 1,id FROM users'
        )
        conn.execute('INSERT INTO session_environments SELECT token_hash,1 FROM sessions')
        for table in ('streams', 'steps', 'processes', 'pcf_entries'):
            if 'environment_id' not in {
                row['name'] for row in conn.execute(f'PRAGMA table_info({table})')
            }:
                conn.execute(
                    f'ALTER TABLE {table} ADD COLUMN environment_id INTEGER NOT NULL DEFAULT 1 REFERENCES environments(id) ON DELETE CASCADE'
                )
            conn.execute(f'CREATE INDEX {table}_environment ON {table}(environment_id)')
        # Rebuild the two catalogs to replace legacy global-name uniqueness.
        conn.execute(
            "CREATE TABLE tag_categories_new (id INTEGER PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE,environment_id INTEGER NOT NULL DEFAULT 1 REFERENCES environments(id) ON DELETE CASCADE,UNIQUE(environment_id,name))"
        )
        conn.execute('INSERT INTO tag_categories_new(id,name) SELECT id,name FROM tag_categories')
        conn.execute('DROP TABLE tag_categories')
        conn.execute('ALTER TABLE tag_categories_new RENAME TO tag_categories')
        conn.execute(
            "CREATE TABLE tags_new (id INTEGER PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE,color TEXT NOT NULL DEFAULT '#e6404d',category_id INTEGER REFERENCES tag_categories(id) ON DELETE SET NULL,environment_id INTEGER NOT NULL DEFAULT 1 REFERENCES environments(id) ON DELETE CASCADE,UNIQUE(environment_id,name))"
        )
        conn.execute(
            'INSERT INTO tags_new(id,name,color,category_id) SELECT id,name,color,category_id FROM tags'
        )
        conn.execute('DROP TABLE tags')
        conn.execute('ALTER TABLE tags_new RENAME TO tags')
        conn.execute('DROP INDEX IF EXISTS pcf_category_number')
        conn.execute(
            'CREATE UNIQUE INDEX pcf_category_number ON pcf_entries(environment_id,number) WHERE parent_id IS NULL'
        )
        conn.execute("INSERT INTO settings VALUES ('environment_schema','1')")
        if conn.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Environment migration found invalid relationships')
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute('PRAGMA foreign_keys=ON')


def initialize_environment_guards(conn):
    conn.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS pcf_category_number ON pcf_entries(environment_id,number) WHERE parent_id IS NULL'
    )
    # Old installed supervisors may delete sessions with foreign keys disabled.
    conn.execute(
        'CREATE TRIGGER IF NOT EXISTS session_environment_cleanup BEFORE DELETE ON sessions BEGIN DELETE FROM session_environments WHERE token_hash=OLD.token_hash; END'
    )
    # Defense in depth for relationships written outside the repository helpers.
    relationships = [
        ('steps', 'stream_id', 'streams'),
        ('pcf_entries', 'parent_id', 'pcf_entries'),
        ('tags', 'category_id', 'tag_categories'),
    ]
    for table, key, parent in relationships:
        for event in ('INSERT', 'UPDATE'):
            conn.execute(
                f"CREATE TRIGGER IF NOT EXISTS env_{table}_{event} BEFORE {event} ON {table} WHEN NEW.{key} IS NOT NULL AND NEW.environment_id IS NOT (SELECT environment_id FROM {parent} WHERE id=NEW.{key}) BEGIN SELECT RAISE(ABORT,'Cross-environment relationship'); END"
            )
    joins = [
        ('step_processes', 'step_id', 'steps', 'process_id', 'processes'),
        ('stream_pcf', 'stream_id', 'streams', 'pcf_id', 'pcf_entries'),
    ]
    joins += [
        (f'{table}_tags', 'entity_id', table, 'tag_id', 'tags')
        for table in ('streams', 'steps', 'processes')
    ]
    for table, left, left_table, right, right_table in joins:
        for event in ('INSERT', 'UPDATE'):
            conn.execute(
                f"CREATE TRIGGER IF NOT EXISTS env_{table}_{event} BEFORE {event} ON {table} WHEN (SELECT environment_id FROM {left_table} WHERE id=NEW.{left}) IS NOT (SELECT environment_id FROM {right_table} WHERE id=NEW.{right}) BEGIN SELECT RAISE(ABORT,'Cross-environment relationship'); END"
            )
