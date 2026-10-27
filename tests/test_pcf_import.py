import csv
import io
import app
import test_api


class PCFImportTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def csv_text(self, rows, delimiter=','):
        output = io.StringIO(newline='')
        writer = csv.writer(output, delimiter=delimiter)
        writer.writerow(['PCF ID', 'Hierarchy ID', 'Name'])
        writer.writerows(rows)
        return output.getvalue()

    def preview(self, text, client=None):
        return self.request('POST', '/api/pcf_import/preview', {'csv': text}, client=client)

    def apply(self, text, preview, decisions=None, client=None):
        return self.request(
            'POST',
            '/api/pcf_import/apply',
            {'csv': text, 'fingerprint': preview['fingerprint'], 'decisions': decisions or {}},
            client=client,
        )

    def test_unordered_bom_csv_builds_hierarchy_and_preserves_backup_fields(self):
        text = '\ufeff' + self.csv_text(
            [
                ['T', '1.1.1.1.1', 'Create ticket'],
                ['C', '1.0', 'IT Management'],
                ['A', '1.1.1.1', 'Register, review\nincident'],
                ['P', '1.1.1', 'Incident Management'],
                ['G', '1.1', 'Fault to Restoration'],
            ],
            ';',
        )
        status, preview = self.preview(text)
        self.assertEqual(status, 200, preview)
        self.assertEqual(preview['total'], 5)
        self.assertEqual(self.request('GET', '/api/pcf_entries')[1], [], 'Preview must not write')
        status, result = self.apply(text, preview)
        self.assertEqual(status, 200, result)
        self.assertEqual(result, {'created': 5, 'updated': 0, 'skipped': 0})
        entries = self.request('GET', '/api/pcf_entries')[1]
        self.assertEqual([e['entry_type'] for e in entries], list(app.PCF_TYPES))
        self.assertEqual(entries[-1]['index'], '1.1.1.1.1')
        self.assertEqual(entries[3]['name'], 'Register, review\nincident')
        app.initialize()
        self.assertEqual(len(self.request('GET', '/api/data')[1]['pcf_entries']), 5)

    def test_yes_no_decisions_preserve_ids_links_and_descriptions(self):
        original = self.csv_text([['C', '1', 'Original category'], ['G', '1.1', 'Original group']])
        _, preview = self.preview(original)
        self.apply(original, preview)
        category, group = self.request('GET', '/api/pcf_entries')[1]
        self.request(
            'PUT', '/api/pcf_entries/' + str(group['id']), {'description': 'Keep procedure notes'}
        )
        _, stream = self.request(
            'POST', '/api/streams', {'name': 'Service', 'pcf_ids': [group['id']]}
        )
        text = self.csv_text(
            [['C', '1', 'New category'], ['g', '1.2', 'New group'], ['P', '1.2.1', 'New process']]
        )
        _, preview = self.preview(text)
        self.assertEqual(len(preview['duplicates']), 2)
        self.assertEqual(self.apply(text, preview, {'C': 'yes'})[0], 400)
        status, result = self.apply(text, preview, {'C': 'no', 'g': 'yes'})
        self.assertEqual(status, 200, result)
        self.assertEqual(result, {'created': 1, 'updated': 1, 'skipped': 1})
        entries = self.request('GET', '/api/pcf_entries')[1]
        self.assertEqual(entries[0]['name'], 'Original category')
        self.assertEqual(entries[1]['id'], group['id'])
        self.assertEqual(entries[1]['description'], 'Keep procedure notes')
        self.assertEqual(entries[1]['index'], '1.2')
        self.assertEqual(
            self.request('GET', '/api/streams/' + str(stream['id']))[1]['pcf_ids'], [group['id']]
        )

    def test_description_column_imports_updates_skips_and_preserves_when_omitted(self):
        output = io.StringIO(newline='')
        writer = csv.writer(output)
        writer.writerow(['PCF ID', 'Hierarchy ID', 'Name', 'Description'])
        description = 'Deliver reliable IT, every day.\nCustomer request: "Keep us connected."'
        writer.writerow(['C', '1', 'IT Management', description])
        writer.writerow(['D', '2', 'Other', 'Keep this description'])
        text = output.getvalue()
        _, preview = self.preview(text)
        self.assertEqual(self.apply(text, preview)[0], 200)
        entries = self.request('GET', '/api/pcf_entries')[1]
        self.assertEqual(entries[0]['description'], description)
        changed = text.replace(
            'Deliver reliable IT, every day.', 'Updated delivery description.'
        ).replace('Keep this description', 'Must not replace')
        _, preview = self.preview(changed)
        self.assertEqual(self.apply(changed, preview, {'C': 'yes', 'D': 'no'})[0], 200)
        entries = self.request('GET', '/api/pcf_entries')[1]
        self.assertIn('Updated delivery description.', entries[0]['description'])
        self.assertEqual(entries[1]['description'], 'Keep this description')
        omitted = self.csv_text([['C', '1', 'Renamed category']])
        _, preview = self.preview(omitted)
        self.assertEqual(self.apply(omitted, preview, {'C': 'yes'})[0], 200)
        self.assertIn(
            'Updated delivery description.',
            self.request('GET', '/api/pcf_entries')[1][0]['description'],
        )
        empty = 'PCF ID,Hierarchy ID,Name,Description\nC,1,Renamed category,\n'
        _, preview = self.preview(empty)
        self.assertEqual(self.apply(empty, preview, {'C': 'yes'})[0], 200)
        self.assertEqual(self.request('GET', '/api/pcf_entries')[1][0]['description'], '')

    def test_oversized_description_rejected_without_writing(self):
        text = 'PCF ID,Hierarchy ID,Name,Description\nC,1,Category,' + 'x' * 20001
        self.assertEqual(self.preview(text)[0], 400)
        self.assertEqual(self.request('GET', '/api/pcf_entries')[1], [])

    def test_number_swaps_and_skip_all_keep_parent_links(self):
        initial = self.csv_text([['A', '1', 'One'], ['B', '2', 'Two']])
        _, preview = self.preview(initial)
        self.apply(initial, preview)
        swap = self.csv_text([['A', '2', 'One changed'], ['B', '1', 'Two changed']])
        _, preview = self.preview(swap)
        self.assertEqual(self.apply(swap, preview, {'A': 'yes', 'B': 'yes'})[0], 200)
        _, preview = self.preview(initial)
        self.assertEqual(self.apply(initial, preview, {'A': 'no', 'B': 'no'})[1]['skipped'], 2)
        entries = self.request('GET', '/api/pcf_entries')[1]
        self.assertEqual([e['reference'] for e in entries], ['B', 'A'])

    def test_invalid_csv_stale_preview_and_atomic_conflict(self):
        for text in (
            'PCF ID,Name\nC,Missing hierarchy',
            'PCF ID,Hierarchy ID,Name\n',
            self.csv_text([['C', '1', 'One'], ['c', '2', 'Duplicate ref']]),
            self.csv_text([['C', '1', 'One'], ['D', '1.0', 'Duplicate index']]),
            self.csv_text([['C', '1.1', 'Missing parent']]),
            self.csv_text([['C', '1.1.1.1.1.1', 'Too deep']]),
            self.csv_text([['C', '0', 'Zero']]),
            self.csv_text([['', '1', 'No ref']]),
        ):
            self.assertEqual(self.preview(text)[0], 400, text)
        initial = self.csv_text([['C', '1', 'Existing']])
        _, preview = self.preview(initial)
        self.apply(initial, preview)
        text = self.csv_text([['NEW', '1', 'Collision'], ['OTHER', '2', 'Must not be saved']])
        _, preview = self.preview(text)
        self.assertEqual(self.apply(text, preview)[0], 400)
        self.assertEqual(len(self.request('GET', '/api/pcf_entries')[1]), 1)
        text = self.csv_text([['C', '1', 'Changed']])
        _, preview = self.preview(text)
        ident = self.request('GET', '/api/pcf_entries')[1][0]['id']
        self.request('PUT', '/api/pcf_entries/' + str(ident), {'description': 'Concurrent edit'})
        self.assertEqual(self.apply(text, preview, {'C': 'yes'})[0], 409)
        self.assertEqual(self.preview('x' * (app.PCF_CSV_LIMIT + 1))[0], 400)

    def test_roles_csrf_and_ambiguous_existing_references(self):
        text = self.csv_text([['C', '1', 'Category']])
        self.assertEqual(self.preview(text, self.new_client())[0], 401)
        self.assertEqual(
            self.request(
                'POST', '/api/pcf_import/preview', {'csv': text}, headers={'X-CSRF-Token': ''}
            )[0],
            403,
        )
        for role in ('Viewer', 'Editor'):
            self.request(
                'POST',
                '/api/users',
                {'username': role, 'role': role, 'password': 'import-password-123'},
            )
            client = self.new_client()
            self.request(
                'POST',
                '/api/auth/login',
                {'username': role, 'password': 'import-password-123'},
                client=client,
            )
            status, preview = self.preview(text, client)
            self.assertEqual(status, 403 if role == 'Viewer' else 200)
            if role == 'Editor':
                self.assertEqual(self.apply(text, preview, client=client)[0], 200)
            else:
                self.assertEqual(
                    self.request(
                        'POST',
                        '/api/pcf_import/apply',
                        {'csv': text, 'fingerprint': 'x', 'decisions': {}},
                        client=client,
                    )[0],
                    403,
                )
        self.request(
            'POST',
            '/api/pcf_entries',
            {'name': 'Ambiguous', 'entry_type': 'Category', 'number': 2, 'reference': 'c'},
        )
        self.assertEqual(self.preview(text)[0], 400)
