"""Takt configuration persistence, valid numeric inputs, and optional fields."""

import app
import test_api


class ServiceTimeTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_takt_configuration_preserved_and_cleared(self):
        status, stream = self.request(
            'POST',
            '/api/streams',
            {
                'name': 'Service',
                'takt_available_minutes': 420,
                'takt_demand': 35,
                'takt_period': 'day',
            },
        )
        self.assertEqual(status, 201)
        path = '/api/streams/' + str(stream['id'])
        self.request('PUT', path, {'description': 'Keep times'})
        app.initialize()
        saved = self.request('GET', path)[1]
        self.assertEqual(saved['takt_available_minutes'] / saved['takt_demand'], 12)
        self.assertEqual(saved['takt_period'], 'day')
        self.assertEqual(self.request('PUT', path, {'takt_demand': None})[0], 200)
        self.assertIsNone(self.request('GET', path)[1]['takt_demand'])
        self.assertEqual(self.request('GET', path)[1]['takt_available_minutes'], 420)

    def test_optional_and_invalid_takt_inputs(self):
        _, stream = self.request('POST', '/api/streams', {'name': 'Unconfigured'})
        self.assertIsNone(stream['takt_demand'])
        self.assertIsNone(stream['takt_available_minutes'])
        self.assertEqual(stream['takt_period'], 'day')
        for key in ('takt_demand', 'takt_available_minutes'):
            for value in (0, -1, True, '20', [], {}, float('inf')):
                self.assertEqual(
                    self.request('PUT', '/api/streams/' + str(stream['id']), {key: value})[0], 400
                )
        self.assertEqual(
            self.request('PUT', '/api/streams/' + str(stream['id']), {'takt_period': 'unknown'})[0],
            400,
        )
