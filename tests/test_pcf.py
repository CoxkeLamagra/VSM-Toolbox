import app
import test_api


class PCFTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def create_entry(self, kind='Category', parent=None, number=1, name=None, client=None):
        return self.request(
            'POST',
            '/api/pcf_entries',
            {'name': name or kind, 'entry_type': kind, 'parent_id': parent, 'number': number},
            client=client,
        )

    def hierarchy(self):
        entries = []
        for kind in app.PCF_TYPES:
            status, entry = self.create_entry(kind, entries[-1]['id'] if entries else None)
            self.assertEqual(status, 201, entry)
            entries.append(entry)
        return entries

    def test_hierarchy_indexes_renumber_move_and_migration(self):
        entries = self.hierarchy()
        self.assertEqual(
            [entry['index'] for entry in entries], ['1', '1.1', '1.1.1', '1.1.1.1', '1.1.1.1.1']
        )
        _, category = self.create_entry(number=10, name='Other')
        group = entries[1]
        self.assertEqual(
            self.request(
                'PUT',
                '/api/pcf_entries/' + str(group['id']),
                {'parent_id': category['id'], 'number': 2},
            )[0],
            200,
        )
        task = self.request('GET', '/api/pcf_entries/' + str(entries[-1]['id']))[1]
        self.assertEqual(task['index'], '10.2.1.1.1')
        self.assertEqual(
            self.request('PUT', '/api/pcf_entries/' + str(category['id']), {'number': 3})[0], 200
        )
        self.assertEqual(
            self.request('GET', '/api/pcf_entries/' + str(entries[-1]['id']))[1]['index'],
            '3.2.1.1.1',
        )
        app.initialize()
        self.assertEqual(len(self.request('GET', '/api/data')[1]['pcf_entries']), 6)
        # An older workspace gains empty PCF tables without changing stream content.
        _, stream = self.request('POST', '/api/streams', {'name': 'Preserved'})
        with app.connect() as conn:
            conn.execute('DROP TABLE stream_pcf')
            for entry in reversed(entries[1:]):
                conn.execute('DELETE FROM pcf_entries WHERE id=?', (entry['id'],))
            conn.execute('DROP TABLE pcf_entries')
        app.initialize()
        self.assertEqual(
            self.request('GET', '/api/streams/' + str(stream['id']))[1]['name'], 'Preserved'
        )

    def test_invalid_hierarchies_numbers_and_deletion(self):
        entries = self.hierarchy()
        self.assertEqual(self.create_entry()[0], 409)
        for number in (0, -1, 1.5, True, 1000000):
            self.assertEqual(self.create_entry(number=number)[0], 400)
        for kind in app.PCF_TYPES[1:]:
            self.assertEqual(self.create_entry(kind, None, 2)[0], 400)
            self.assertEqual(self.create_entry(kind, entries[-1]['id'], 2)[0], 400)
        self.assertEqual(self.create_entry('Category', entries[0]['id'], 2)[0], 400)
        self.assertEqual(self.create_entry('Unknown', None, 2)[0], 400)
        category_path = '/api/pcf_entries/' + str(entries[0]['id'])
        self.assertEqual(self.request('DELETE', category_path)[0], 409)
        self.assertEqual(
            self.request(
                'PUT', category_path, {'entry_type': 'Process Group', 'parent_id': entries[0]['id']}
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                'PUT',
                '/api/pcf_entries/' + str(entries[1]['id']),
                {'entry_type': 'Category', 'parent_id': None, 'number': 4},
            )[0],
            409,
        )
        self.assertEqual(
            self.request('DELETE', '/api/pcf_entries/' + str(entries[-1]['id']))[0], 200
        )

    def test_multiple_links_permissions_validation_and_cleanup(self):
        entries = self.hierarchy()
        ids = [entries[0]['id'], entries[-1]['id']]
        _, stream = self.request('POST', '/api/streams', {'name': 'Service', 'pcf_ids': ids + ids})
        self.assertEqual(stream['pcf_ids'], sorted(ids))
        path = '/api/streams/' + str(stream['id'])
        for invalid in (None, [True], '1', [99999]):
            self.assertEqual(
                self.request('PUT', path, {'pcf_ids': invalid, 'name': 'Invalid'})[0], 400
            )
            self.assertEqual(self.request('GET', path)[1]['name'], 'Service')
        self.request('PUT', path, {'description': 'Retain links'})
        self.assertEqual(self.request('GET', path)[1]['pcf_ids'], sorted(ids))
        self.assertEqual(self.request('PUT', path, {'pcf_ids': []})[1]['pcf_ids'], [])
        self.request('PUT', path, {'pcf_ids': ids})
        self.request('DELETE', '/api/pcf_entries/' + str(entries[-1]['id']))
        self.assertEqual(self.request('GET', path)[1]['pcf_ids'], [entries[0]['id']])
        for role in ('Editor', 'Viewer'):
            self.request(
                'POST',
                '/api/users',
                {'username': role, 'password': 'pcf-password-123', 'role': role},
            )
            client = self.new_client()
            self.request(
                'POST',
                '/api/auth/login',
                {'username': role, 'password': 'pcf-password-123'},
                client=client,
            )
            self.assertEqual(self.request('GET', '/api/pcf_entries', client=client)[0], 200)
            self.assertEqual(
                self.create_entry(number=5, name=role, client=client)[0],
                201 if role == 'Editor' else 403,
            )
            self.assertEqual(
                self.request('PUT', path, {'pcf_ids': []}, client=client)[0],
                200 if role == 'Editor' else 403,
            )
        self.assertEqual(
            self.request(
                'POST',
                '/api/pcf_entries',
                {'name': 'Blocked', 'entry_type': 'Category', 'number': 6},
                headers={'X-CSRF-Token': ''},
            )[0],
            403,
        )
