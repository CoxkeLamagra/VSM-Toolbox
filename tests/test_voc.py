import app
import test_api


class VoiceOfCustomerTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_request_round_trip_and_existing_database_migration(self):
        _, stream = self.request('POST', '/api/streams', {'name':'Employee onboarding'})
        self.assertEqual(stream['voc'], '')
        with app.connect() as conn:
            conn.execute('ALTER TABLE streams DROP COLUMN voc')
        app.initialize()
        app.initialize()  # Migration can safely run on each startup.
        _, migrated = self.request('GET', '/api/streams/'+str(stream['id']))
        self.assertEqual(migrated['name'], stream['name'])
        self.assertEqual(migrated['voc'], '')
        request = 'Give new starters working access on day one.\nInclude email and secure remote access.'
        path = '/api/streams/'+str(stream['id'])
        self.assertEqual(self.request('PUT', path, {'voc':request})[0], 200)
        app.initialize()
        self.assertEqual(self.request('GET', '/api/data')[1]['streams'][0]['voc'], request)
        self.assertEqual(self.request('PUT', path, {'voc':123})[0], 400)
        self.assertEqual(self.request('PUT', path, {'voc':''})[1]['voc'], '')
