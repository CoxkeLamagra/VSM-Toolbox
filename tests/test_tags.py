import app
import test_api


class TagTest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_management_assignment_and_cleanup(self):
        _, category = self.request('POST','/api/tag_categories',{'name':'Service type'})
        _, tag = self.request('POST','/api/tags',{'name':'Managed service','color':'#336699','category_id':category['id']})
        for table, fields in [('streams',{}),('steps',{'stream_id':self.request('POST','/api/streams',{'name':'Parent'})[1]['id']}),('processes',{})]:
            status, entity = self.request('POST','/api/'+table,{'name':'Tagged '+table,**fields,'tag_ids':[tag['id'],tag['id']]})
            self.assertEqual(status,201,entity)
            self.assertEqual(entity['tag_ids'],[tag['id']])
            path='/api/'+table+'/'+str(entity['id'])
            self.assertEqual(self.request('GET',path)[1]['tag_ids'],[tag['id']])
            self.assertEqual(self.request('PUT',path,{'tag_ids':[999999],'name':'Must roll back'})[0],400)
            self.assertEqual(self.request('GET',path)[1]['name'],entity['name'])
            for invalid in (None, '1', [True]):
                self.assertEqual(self.request('PUT',path,{'tag_ids':invalid})[0],400)
            self.assertEqual(self.request('PUT',path,{'tag_ids':[]})[1]['tag_ids'],[])
            self.request('PUT',path,{'tag_ids':[tag['id']]})
        app.initialize()
        self.assertEqual(self.request('GET','/api/data')[1]['tags'][0]['color'],'#336699')
        self.assertEqual(self.request('PUT','/api/tags/'+str(tag['id']),{'name':'Renamed','color':'#ffcc00'})[0],200)
        self.assertEqual(self.request('DELETE','/api/tag_categories/'+str(category['id']))[0],200)
        self.assertIsNone(self.request('GET','/api/tags')[1][0]['category_id'])
        self.assertEqual(self.request('DELETE','/api/tags/'+str(tag['id']))[0],200)
        for table in ('streams','steps','processes'):
            self.assertTrue(all(not e['tag_ids'] for e in self.request('GET','/api/'+table)[1]))

    def test_roles_and_validation(self):
        self.assertEqual(self.request('POST','/api/tags',{'name':'Tag','color':'red;background:url(x)'})[0],400)
        self.assertEqual(self.request('POST','/api/tags',{'name':'Tag','category_id':999})[0],400)
        _, tag=self.request('POST','/api/tags',{'name':'Tag'})
        _, category=self.request('POST','/api/tag_categories',{'name':'Group'})
        self.assertEqual(self.request('POST','/api/tags',{'name':'tag'})[0],400)
        _, stream=self.request('POST','/api/streams',{'name':'Service'})
        self.assertEqual(self.request('PUT','/api/tags/'+str(tag['id']),{'color':'#abcdef'},headers={'X-CSRF-Token':''})[0],403)
        for role in ('Editor','Viewer'):
            self.request('POST','/api/users',{'username':role,'password':'tag-test-password-123','role':role})
            client=self.new_client()
            self.request('POST','/api/auth/login',{'username':role,'password':'tag-test-password-123'},client=client)
            for table, ident in [('tags',tag['id']),('tag_categories',category['id'])]:
                self.assertEqual(self.request('GET','/api/'+table,client=client)[0],200)
                for method, path, payload in [('POST','/api/'+table,{'name':'Forbidden'}),('PUT','/api/'+table+'/'+str(ident),{'name':'Forbidden'}),('DELETE','/api/'+table+'/'+str(ident),{})]:
                    self.assertEqual(self.request(method,path,payload,client=client)[0],403)
            self.assertEqual(self.request('PUT','/api/streams/'+str(stream['id']),{'tag_ids':[tag['id']]},client=client)[0],200 if role=='Editor' else 403)
