from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
import time
from unittest import mock
import app
import test_api


class AccountTest(test_api.ApiTest):
    bootstrap = False
    # Run inherited content tests with their authenticated fixture in ApiTest only.
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def register(self, client=None, username='admin'):
        return self.request('POST','/api/auth/register',{'username':username,'password':'example-password-123'},client=client)

    def create(self, username, role='Viewer'):
        return self.request('POST','/api/users',{'username':username,'password':'example-password-123','role':role})

    def login(self, username, client):
        return self.request('POST','/api/auth/login',{'username':username,'password':'example-password-123'},client=client)

    def test_first_account_registration_login_logout(self):
        self.assertTrue(self.request('GET','/api/session')[1]['setup_required'])
        self.assertEqual(self.request('GET','/api/data')[0],401)
        status, result = self.register()
        self.assertEqual(status,201)
        self.assertEqual(result['user']['role'],'Admin')
        self.assertEqual(self.register(username='second')[0],403)
        self.assertEqual(self.request('GET','/api/roles')[1],['Admin','Editor','Viewer'])
        old = dict(self.client)
        self.assertEqual(self.request('POST','/api/auth/logout',{})[0],200)
        self.assertEqual(self.request('GET','/api/data',client=old)[0],401)
        self.assertEqual(self.login('ADMIN',self.client)[0],200)
        self.assertEqual(self.request('GET','/api/session')[1]['user']['username'],'admin')
        with app.connect() as conn:
            stored=conn.execute('SELECT password_hash FROM users').fetchone()[0]
            self.assertTrue(stored.startswith('pbkdf2_sha256$600000$'))
            self.assertNotIn('example-password',stored)
            token=self.client['cookie'].split('=',1)[1]
            session=conn.execute('SELECT token_hash FROM sessions').fetchone()[0]
            self.assertEqual(session,hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn('password',str(self.request('GET','/api/users')[1]))

    def test_concurrent_bootstrap_creates_one_admin(self):
        def attempt(n):
            return self.register(client=self.new_client(),username='user'+str(n))[0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(attempt,[1,2])),[201,403])
        with app.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM users').fetchone()[0],1)

    def test_role_permissions_and_revocation(self):
        self.register()
        editor_id=self.create('editor','Editor')[1]['id']
        viewer_id=self.create('viewer')[1]['id']
        editor,viewer=self.new_client(),self.new_client()
        self.login('editor',editor);self.login('viewer',viewer)
        for client in (editor,viewer):
            self.assertEqual(self.request('GET','/api/data',client=client)[0],200)
            self.assertEqual(self.request('GET','/api/users',client=client)[0],403)
            self.assertEqual(self.request('POST','/api/users',{'username':'intruder','password':'example-password-123','role':'Admin'},client=client)[0],403)
            self.assertEqual(self.request('GET','/api/updates',client=client)[0],403)
            self.assertEqual(self.request('POST','/api/updates/install',{},client=client)[0],403)
        status,stream=self.request('POST','/api/streams',{'name':'Restore'},client=editor)
        self.assertEqual(status,201)
        for method,path,data in [('POST','/api/streams',{'name':'Denied'}),('PUT',f"/api/streams/{stream['id']}",{'name':'Denied'}),('DELETE',f"/api/streams/{stream['id']}",{})]:
            self.assertEqual(self.request(method,path,data,client=viewer)[0],403)
        self.assertEqual(self.request('PUT',f'/api/users/{editor_id}',{'role':'Viewer'})[0],200)
        self.assertEqual(self.request('POST','/api/streams',{'name':'Revoked'},client=editor)[0],401)
        self.login('editor',editor)
        self.assertEqual(self.request('POST','/api/streams',{'name':'Denied'},client=editor)[0],403)
        self.assertEqual(self.request('DELETE',f'/api/users/{viewer_id}',{})[0],200)
        self.assertEqual(self.request('GET','/api/data',client=viewer)[0],401)

    def test_last_admin_and_password_reset(self):
        ident=self.register()[1]['user']['id']
        self.assertEqual(self.request('DELETE',f'/api/users/{ident}',{})[0],409)
        self.assertEqual(self.request('PUT',f'/api/users/{ident}',{'role':'Editor'})[0],409)
        second=self.create('second','Admin')[1]['id']
        self.assertEqual(self.request('PUT',f'/api/users/{second}',{'password':'reset-password-456','username':'renamed'})[0],200)
        self.assertEqual(self.request('POST','/api/auth/login',{'username':'renamed','password':'example-password-123'},client=self.new_client())[0],401)
        other=self.new_client()
        self.assertEqual(self.request('POST','/api/auth/login',{'username':'renamed','password':'reset-password-456'},client=other)[0],200)
        self.assertEqual(self.request('DELETE',f'/api/users/{ident}',{},client=other)[0],200)
        self.assertEqual(self.request('GET','/api/data')[0],401)
        self.assertEqual(self.request('DELETE',f'/api/users/{second}',{},client=other)[0],409)

    def test_validation_csrf_expiry_and_rate_limit(self):
        self.assertEqual(self.request('POST','/api/auth/register',{'username':'bad spaces','password':'short'})[0],400)
        self.register()
        for data in ({'username':'admin','password':'another-password-123'}, {'username':'ADMIN','password':'another-password-123'}):
            self.assertEqual(self.request('POST','/api/users',data)[0],409)
        self.assertEqual(self.create('unknown','Superadmin')[0],400)
        for headers in ({'X-CSRF-Token':''},{'X-CSRF-Token':'forged'},{'Origin':'https://evil.example'},{'Content-Type':'text/plain'}):
            self.assertIn(self.request('POST','/api/streams',{'name':'Denied'},headers=headers)[0],(403,415))
        with app.connect() as conn:
            conn.execute('UPDATE sessions SET expires_at=?',(time.time()-1,))
        self.assertEqual(self.request('GET','/api/data')[0],401)
        anonymous=self.new_client()
        for _ in range(10):
            self.assertEqual(self.request('POST','/api/auth/login',{'username':'missing','password':'wrong'},client=anonymous)[0],401)
        self.assertEqual(self.request('POST','/api/auth/login',{'username':'MISSING','password':'wrong'},client=anonymous)[0],429)
        self.assertEqual(self.login('admin',anonymous)[0],200)
        with app.connect() as conn:
            conn.execute('UPDATE login_attempts SET started_at=?',(time.time()-301,))
        self.assertEqual(self.login('admin',anonymous)[0],200)

    def test_update_admin_only_and_no_source_overrides(self):
        self.register()
        with mock.patch.dict(os.environ,{'VSM_BACKUP_PROTOCOL':'1'}), mock.patch('updater.status',return_value={'available':True,'state':'idle'}), mock.patch('updater.request',return_value={'queued':True}) as queue:
            self.assertEqual(self.request('POST','/api/updates/install',{'url':'https://evil.example'})[0],400)
            self.assertEqual(self.request('POST','/api/updates/install',{})[0],202)
            queue.assert_called_once_with('install')
        with mock.patch('updater.status',return_value={'available':True,'state':'installing'}):
            self.assertEqual(self.request('POST','/api/streams',{'name':'During update'})[0],503)
