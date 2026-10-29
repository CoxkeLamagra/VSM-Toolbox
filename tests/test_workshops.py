"""Shared canvas concurrency, scope, permissions and lifecycle regression tests."""

from concurrent.futures import ThreadPoolExecutor
import app
import test_api


class WorkshopTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def board(self):
        status, board = self.request('POST', '/api/workshops', {'name': 'Incident brown paper'})
        self.assertEqual(status, 200, board)
        return '/api/workshops/' + str(board['id'])

    def block(self, path, text='Triage'):
        status, result = self.request(
            'POST', path + '/items', {'kind': 'step', 'text': text, 'x': 30, 'y': 40}
        )
        self.assertEqual(status, 200, result)
        return result['items'][-1]

    def edit(self, item, **changes):
        return {k: v for k, v in dict(item, **changes).items() if k != 'id'}

    def test_conflicts_independent_edits_connectors_and_persistence(self):
        path = self.board()
        a, b = self.block(path), self.block(path, 'Restore')

        def put(item):
            return self.request(
                'PUT',
                path + '/items/' + str(item['id']),
                self.edit(item, text='Changed ' + item['text']),
            )

        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(put, [a, b]))
        self.assertEqual([r[0] for r in results], [200, 200])
        self.assertEqual(put(a)[0], 409)
        current = self.request('GET', path)[1]
        self.assertEqual([i['revision'] for i in current['items']], [2, 2])
        self.assertEqual(
            self.request(
                'POST',
                path + '/items',
                {'kind': 'connector', 'source': a['id'], 'target': b['id'], 'text': 'Then'},
            )[0],
            200,
        )
        self.assertEqual(
            self.request('DELETE', path + '/items/' + str(a['id']), {'revision': 1})[0], 409
        )
        self.assertEqual(
            self.request('DELETE', path + '/items/' + str(a['id']), {'revision': 2})[0], 200
        )
        app.initialize()
        self.assertEqual(len(self.request('GET', path)[1]['items']), 1)
        self.assertEqual(
            self.request(
                'POST', path + '/items', {'kind': 'connector', 'source': a['id'], 'target': b['id']}
            )[0],
            400,
        )

    def test_environment_isolation_cascade_and_validation(self):
        path = self.board()
        self.block(path)
        for payload in (
            {'kind': 'invalid'},
            {'kind': 'note', 'x': -1},
            {'kind': 'note', 'text': 'x' * 2001},
            {'kind': 'note', 'x': float('inf')},
            {'kind': 'note', 'unexpected': 1},
        ):
            self.assertEqual(self.request('POST', path + '/items', payload)[0], 400)
        status, other = self.request('POST', '/api/environments', {'name': 'Private'})
        self.assertEqual(status, 201)
        self.assertEqual(self.request('GET', path)[0], 404)
        self.assertEqual(self.request('POST', path + '/items', {'kind': 'note'})[0], 404)
        self.assertEqual(self.request('GET', '/api/workshops')[1], [])
        private = self.board()
        self.block(private)
        self.assertEqual(self.request('DELETE', f"/api/environments/{other['id']}", {'confirmation':'Private'})[0],200)
        self.request('POST', '/api/environments/1/switch', {})
        self.assertEqual(self.request('DELETE', path, {'confirmation': 'wrong'})[0], 400)
        self.assertEqual(
            self.request('DELETE', path, {'confirmation': 'Incident brown paper'})[0], 200
        )
        with app.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM workshop_items').fetchone()[0], 0)

    def test_viewer_presence_editor_access_and_csrf(self):
        path = self.board()
        for role in ('Viewer', 'Editor'):
            _, account = self.request(
                'POST',
                '/api/users',
                {'username': role, 'password': 'workshop-password-123', 'role': role},
            )
            # Explicit environment membership, independent of global account role.
            self.assertEqual(
                self.request('PUT', f"/api/environments/1/members/{account['id']}", {'role': role})[
                    0
                ],
                200,
            )
            client = self.new_client()
            self.request(
                'POST',
                '/api/auth/login',
                {'username': role, 'password': 'workshop-password-123'},
                client=client,
            )
            self.assertEqual(self.request('GET', path, client=client)[0], 200)
            self.assertEqual(self.request('POST', path + '/presence', {}, client=client)[0], 200)
            self.assertEqual(
                self.request('POST', path + '/items', {'kind': 'note'}, client=client)[0],
                403 if role == 'Viewer' else 200,
            )
            self.assertEqual(
                self.request(
                    'POST', path + '/presence', {}, headers={'X-CSRF-Token': ''}, client=client
                )[0],
                403,
            )
        self.assertEqual(len(self.request('GET', path)[1]['participants']), 2)
        self.assertEqual(self.request('GET', path, client=self.new_client())[0], 401)
