import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
import app


class ApiTest(unittest.TestCase):
    bootstrap = True

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_db = app.storage.DB
        app.storage.DB = Path(self.temp.name) / 'test.sqlite3'
        app.initialize()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = self.new_client()
        if self.bootstrap:
            self.assertEqual(self.request('POST', '/api/auth/register', {'username':'admin','password':'admin-password-123'})[0], 201)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()
        app.storage.DB = self.previous_db

    def new_client(self):
        return {'cookie': '', 'csrf': ''}

    def request(self, method, path, data=None, headers=None, client=None):
        client = self.client if client is None else client
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        request_headers = {'Content-Type':'application/json', 'Cookie':client['cookie'], 'X-CSRF-Token':client['csrf']}
        request_headers.update(headers or {})
        conn.request(method, path, json.dumps(data) if data is not None else None, request_headers)
        response = conn.getresponse()
        body = response.read()
        status = response.status
        cookie = response.getheader('Set-Cookie')
        conn.close()
        result = json.loads(body)
        if cookie:
            client['cookie'] = cookie.split(';', 1)[0]
        if 'csrf_token' in result:
            client['csrf'] = result['csrf_token'] or ''
        return status, result

    def test_service_delivery_lifecycle_and_persistence(self):
        status, stream = self.request('POST', '/api/streams', {'name':'Restore service','customer':'Managed service client'})
        self.assertEqual(status, 201)
        _, step = self.request('POST', '/api/steps', {'name':'Triage','stream_id':stream['id'],'work_minutes':15,'wait_minutes':30})
        _, process = self.request('POST','/api/processes',{'name':'Incident classification','procedure':'Assess impact and urgency.'})
        path = f"/api/steps/{step['id']}/processes"
        self.assertEqual(self.request('PUT',path,{'process_ids':[process['id']]})[0],200)
        # Failed link replacement must roll back the original links.
        self.assertEqual(self.request('PUT',path,{'process_ids':[999999]})[0],400)
        _, data = self.request('GET','/api/data')
        self.assertIn({'step_id':step['id'],'process_id':process['id']},data['step_processes'])
        status, updated = self.request('PUT',f"/api/steps/{step['id']}",{'wait_minutes':10,'position':2})
        self.assertEqual(status,200)
        self.assertEqual(updated['wait_minutes'],10)
        app.initialize()  # Reinitialization preserves existing data.
        with app.connect() as conn:
            self.assertEqual(conn.execute('SELECT customer FROM streams WHERE id=?',(stream['id'],)).fetchone()[0],'Managed service client')
        self.assertEqual(self.request('DELETE',f"/api/streams/{stream['id']}")[0],200)
        self.assertEqual(self.request('GET',f"/api/steps/{step['id']}")[0],404)
        self.assertEqual(self.request('GET',f"/api/processes/{process['id']}")[0],200)
        self.assertEqual(self.request('GET','/api/data')[1]['step_processes'],[])

    def test_validation_and_origin_boundary(self):
        for data in ({'name':''},{'name':'x','unknown':1},{'name':3}):
            self.assertEqual(self.request('POST','/api/streams',data)[0],400)
        self.assertEqual(self.request('POST','/api/steps',{'name':'bad','stream_id':99999})[0],400)
        self.assertEqual(self.request('POST','/api/steps',{'name':'bad','stream_id':1,'work_minutes':-1})[0],400)
        self.assertEqual(self.request('PUT','/api/streams/99999',{'name':'missing'})[0],404)
        self.assertEqual(self.request('POST','/api/streams',{'name':'x'},{'Origin':'https://other.example'})[0],403)
        self.assertEqual(self.request('GET','/api/health')[1]['status'],'ok')

    def test_static_application(self):
        conn = http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        for path, expected in [('/',b'VSM Toolbox'),('/app.js',b'renderStream'),('/style.css',b'.canvas'),('/lib/core.js',b'export'),('/features/bpmn.js',b'bpmnMarkup'),('/features/pcf.js',b'createPCFFeature'),('/features/stream-diagram.js',b'createStreamDiagram')]:
            conn.request('GET',path)
            response=conn.getresponse()
            self.assertEqual(response.status,200)
            self.assertEqual(response.getheader('Cache-Control'),'no-cache')
            if path.endswith('.js'): self.assertIn('javascript',response.getheader('Content-Type'))
            self.assertIn(expected,response.read())
        conn.close()


if __name__ == '__main__':
    unittest.main()
