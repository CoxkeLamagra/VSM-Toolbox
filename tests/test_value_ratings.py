"""Independent stream and step value-add ratings, validation, and migration."""

import sqlite3
import app
import test_api


class ValueRatingsTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_ratings_persist_and_can_be_cleared_independently(self):
        status, stream = self.request(
            'POST', '/api/streams', {'name': 'Service', 'cva': 3, 'bva': 1}
        )
        self.assertEqual(status, 201)
        status, step = self.request(
            'POST', '/api/steps', {'name': 'Triage', 'stream_id': stream['id'], 'cva': 1, 'bva': 2}
        )
        self.assertEqual(status, 201)
        for resource, item in [('streams', stream), ('steps', step)]:
            path = f"/api/{resource}/{item['id']}"
            self.assertEqual(self.request('PUT', path, {'name': 'Renamed'})[0], 200)
            self.assertEqual(self.request('GET', path)[1]['bva'], item['bva'])
            self.assertEqual(self.request('PUT', path, {'cva': None})[0], 200)
            self.assertIsNone(self.request('GET', path)[1]['cva'])
            self.assertEqual(self.request('GET', path)[1]['bva'], item['bva'])
        app.initialize()
        self.assertEqual(self.request('GET', '/api/data')[1]['steps'][0]['bva'], 2)

    def test_optional_ratings_and_invalid_inputs(self):
        _, stream = self.request('POST', '/api/streams', {'name': 'Service'})
        self.assertIsNone(stream['cva'])
        self.assertIsNone(stream['bva'])
        for table, payload in [
            ('streams', {'name': 'Invalid'}),
            ('steps', {'name': 'Invalid', 'stream_id': stream['id']}),
        ]:
            for key in ('cva', 'bva'):
                for value in (0, 4, -1, True, '3', 2.0, [], {}):
                    self.assertEqual(
                        self.request('POST', '/api/' + table, {**payload, key: value})[0], 400
                    )
        with app.connect() as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute('UPDATE streams SET cva=4 WHERE id=?', (stream['id'],))
