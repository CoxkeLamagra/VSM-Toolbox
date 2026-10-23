import base64
import sqlite3
import app
import test_api


class BrandingTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_public_branding_admin_updates_and_persistence(self):
        anonymous = self.new_client()
        status, response = self.request('GET', '/api/branding', client=anonymous)
        self.assertEqual(status, 200)
        theme = response['branding']
        self.assertEqual(theme, app.BRANDING_DEFAULTS)
        theme.update(name='Our IT workspace', primary='#112233', tagline='Local services')
        self.assertEqual(self.request('PUT', '/api/branding', theme, client=anonymous)[0], 401)
        self.assertEqual(self.request('PUT', '/api/branding', theme, headers={'X-CSRF-Token': ''})[0], 403)
        self.assertEqual(self.request('PUT', '/api/branding', theme)[0], 200)
        app.initialize()
        self.assertEqual(self.request('GET', '/api/branding', client=anonymous)[1]['branding'], theme)
        with app.connect() as conn:
            self.assertEqual(app.branding(conn), theme)
        for role in ('Editor', 'Viewer'):
            self.request('POST', '/api/users', {'username': role, 'password':'branding-password-123', 'role':role})
            client = self.new_client()
            self.request('POST', '/api/auth/login', {'username':role,'password':'branding-password-123'}, client=client)
            self.assertEqual(self.request('PUT', '/api/branding', theme, client=client)[0], 403)
        self.assertEqual(self.request('PUT', '/api/branding', response['defaults'])[0], 200)

    def test_validation_rejects_css_and_active_logo_content(self):
        for changes in ({'primary':'red; background:url(https://example.com)'}, {'sidebar':'#fff'},
                        {'name':''}, {'tagline':'x'*121}, {'logo':'data:image/svg+xml;base64,PHN2Zy8+'},
                        {'logo':'data:image/png;base64,'+base64.b64encode(b'not png').decode()}, {'unknown':'value'}):
            with self.subTest(changes=changes):
                theme = {**app.BRANDING_DEFAULTS, **changes}
                self.assertEqual(self.request('PUT', '/api/branding', theme)[0], 400)
        self.assertEqual(app.foreground('#ffffff'), '#111827')
        self.assertEqual(app.foreground('#000000'), '#ffffff')
