"""Environment transaction guarantees without HTTP transport."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app


class EnvironmentRepositoryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database = mock.patch.object(app, 'DB', Path(temporary.name) / 'workspace.sqlite3')
        database.start()
        self.addCleanup(database.stop)
        app.initialize()
        with app.connect() as conn:
            conn.execute("INSERT INTO users VALUES (1,'owner','unused','Viewer')")
            conn.execute("INSERT INTO sessions VALUES ('token',1,'csrf',9999999999)")
        self.actor = {'id': 1, 'role': 'Viewer'}

    def test_creation_and_selection_roll_back_together(self):
        with self.assertRaisesRegex(RuntimeError, 'abort'):
            with app.connect() as conn:
                repository = app.EnvironmentRepository(conn, self.actor, 'token')
                created = repository.mutate(['api', 'environments'], 'POST', {'name': 'Client'})
                self.assertEqual(created['role'], 'Admin')
                self.assertEqual(repository.selected()['id'], created['id'])
                raise RuntimeError('abort')
        with app.connect() as conn:
            repository = app.EnvironmentRepository(conn, self.actor, 'token')
            self.assertIsNone(repository.selected())
            self.assertEqual(repository.overview(), [])
            self.assertEqual(conn.execute('SELECT count(*) FROM environments').fetchone()[0], 1)
            self.assertEqual(
                conn.execute('SELECT count(*) FROM session_environments').fetchone()[0], 0
            )

    def test_last_admin_rejection_preserves_membership(self):
        with app.connect() as conn:
            repository = app.EnvironmentRepository(conn, self.actor, 'token')
            created = repository.mutate(['api', 'environments'], 'POST', {'name': 'Client'})
            with self.assertRaises(app.ApiError) as caught:
                repository.mutate(
                    ['api', 'environments', str(created['id']), 'members', '1'],
                    'PUT',
                    {'role': 'Viewer'},
                )
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(repository.members(created['id'])[0]['role'], 'Admin')
