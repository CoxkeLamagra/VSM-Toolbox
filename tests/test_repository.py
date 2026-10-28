"""Repository behavior and workspace query growth, independent of HTTP."""

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app


class RepositoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = mock.patch.object(app.storage, 'DB', Path(self.temp.name) / 'workspace.sqlite3')
        self.database.start()
        app.initialize()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.database.stop)

    def test_workspace_tag_queries_do_not_grow_per_entity(self):
        def snapshot_query_count(conn):
            queries = []
            conn.set_trace_callback(queries.append)
            snapshot = app.ContentRepository(conn).snapshot()
            conn.set_trace_callback(None)
            return snapshot, sum(query.startswith('SELECT') for query in queries)

        with app.connect() as conn:
            conn.execute("INSERT INTO tags(name,color) VALUES ('Critical','#336699')")
            repository = app.ContentRepository(conn)
            first = repository.mutate(
                ['api', 'streams'], 'POST', {'name': 'Service 0', 'tag_ids': [1]}
            )
            repository.mutate(
                ['api', 'steps'],
                'POST',
                {'name': 'Triage', 'stream_id': first['id'], 'tag_ids': [1]},
            )
            repository.mutate(['api', 'processes'], 'POST', {'name': 'Procedure 0', 'tag_ids': [1]})
            small, small_count = snapshot_query_count(conn)
            for index in range(1, 80):
                stream = repository.mutate(
                    ['api', 'streams'], 'POST', {'name': f'Service {index}', 'tag_ids': [1]}
                )
                repository.mutate(
                    ['api', 'steps'],
                    'POST',
                    {'name': 'Triage', 'stream_id': stream['id'], 'tag_ids': [1]},
                )
                repository.mutate(
                    ['api', 'processes'], 'POST', {'name': f'Procedure {index}', 'tag_ids': [1]}
                )
            large, large_count = snapshot_query_count(conn)
            self.assertEqual(
                large_count,
                small_count,
                'Workspace reads must not issue a tag query for every entity',
            )
            self.assertEqual(small['streams'][0], first)
            for table in ('streams', 'steps', 'processes'):
                self.assertTrue(large[table])
                self.assertTrue(all(row['tag_ids'] == [1] for row in large[table]))
            self.assertEqual(repository.get('streams', first['id']), large['streams'][0])

    def test_content_and_tags_rollback_together_and_do_not_mutate_input(self):
        with app.connect() as conn:
            repository = app.ContentRepository(conn)
            conn.execute("INSERT INTO tags(name) VALUES ('Critical')")
            original = repository.mutate(
                ['api', 'streams'], 'POST', {'name': 'Original', 'tag_ids': [1]}
            )
        payload = {'name': 'Changed', 'tag_ids': []}
        with self.assertRaises(sqlite3.IntegrityError):
            with app.connect() as conn:
                repository = app.ContentRepository(conn)
                repository.mutate(['api', 'streams', str(original['id'])], 'PUT', payload)
                conn.execute("INSERT INTO steps(name,stream_id) VALUES ('Invalid',999999)")
        self.assertEqual(payload, {'name': 'Changed', 'tag_ids': []})
        with app.connect() as conn:
            self.assertEqual(app.ContentRepository(conn).get('streams', original['id']), original)
