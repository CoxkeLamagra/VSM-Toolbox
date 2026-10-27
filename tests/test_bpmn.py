"""BPMN parsing, persistence, and environment authorization."""

import unittest
import app
import test_api

XML = '''<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
 xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
 xmlns:dc="http://www.omg.org/spec/DD/20100524/DC">
 <process id="incident" name="Incident handling">
 <startEvent id="start" name="Request"/><userTask id="triage" name="Triage &amp; assign"/>
 <exclusiveGateway id="decision" name="Resolved?"/><endEvent id="end" name="Complete"/>
 <sequenceFlow id="flow1" sourceRef="start" targetRef="triage"/>
 <sequenceFlow id="flow2" sourceRef="triage" targetRef="decision"/>
 <sequenceFlow id="flow3" sourceRef="decision" targetRef="end" name="Yes"/>
 </process><bpmndi:BPMNDiagram><bpmndi:BPMNPlane>
 <bpmndi:BPMNShape bpmnElement="start"><dc:Bounds x="20" y="30" width="36" height="36"/></bpmndi:BPMNShape>
 </bpmndi:BPMNPlane></bpmndi:BPMNDiagram></definitions>'''


class BPMNParserTest(unittest.TestCase):
    def test_shapes_flows_coordinates_and_fallback(self):
        model = app.parse_bpmn(XML)
        self.assertEqual(len(model['nodes']), 4)
        self.assertEqual(len(model['edges']), 3)
        self.assertEqual(model['nodes'][0]['x'], 20)
        self.assertEqual(model['nodes'][1]['name'], 'Triage & assign')
        self.assertEqual(model['name'], 'Incident handling')
        self.assertGreater(model['nodes'][1]['width'], 0)

    def test_diagram_flow_waypoints(self):
        xml = XML.replace(
            '</bpmndi:BPMNPlane>',
            '<bpmndi:BPMNEdge bpmnElement="flow1" xmlns:di="http://www.omg.org/spec/DD/20100524/DI"><di:waypoint x="56" y="48"/><di:waypoint x="150" y="48"/></bpmndi:BPMNEdge></bpmndi:BPMNPlane>',
        )
        self.assertEqual(
            app.parse_bpmn(xml)['edges'][0]['waypoints'], [{'x': 56, 'y': 48}, {'x': 150, 'y': 48}]
        )
        with self.assertRaises(ValueError):
            app.parse_bpmn(xml.replace('x="56"', 'x="inf"'))

    def test_invalid_and_resource_exhaustion_inputs(self):
        for xml in [
            '<broken>',
            '<definitions/>',
            '<!DOCTYPE definitions [<!ENTITY x "boom">]>' + XML,
            XML.replace('x="20"', 'x="NaN"'),
            XML.replace('x="20"', 'x="100001"'),
            XML.replace('id="triage"', 'id="start"'),
            XML.replace('<startEvent', '<startEvent'.replace('Event', '\x00Event')),
            'x' * 262145,
            XML.replace('<startEvent id="start" name="Request"/>', '<task id="x"/>' * 501),
        ]:
            with self.subTest(xml=xml[:60]), self.assertRaises(ValueError):
                app.parse_bpmn(xml)


class BPMNAPITest(test_api.ApiTest):
    test_service_delivery_lifecycle_and_persistence = None
    test_validation_and_origin_boundary = None
    test_static_application = None

    def test_import_replace_and_environment_boundary(self):
        status, process = self.request(
            'POST', '/api/processes', {'name': 'Incident', 'bpmn_xml': XML}
        )
        self.assertEqual(status, 201, process)
        ident = process['id']
        self.assertEqual(len(process['bpmn']['nodes']), 4)
        self.assertEqual(self.request('GET', '/api/processes/' + str(ident))[1]['bpmn_xml'], XML)
        self.assertEqual(
            self.request('PUT', '/api/processes/' + str(ident), {'owner': 'IT'})[0], 200
        )
        self.assertEqual(
            len(self.request('GET', '/api/data')[1]['processes'][0]['bpmn']['edges']), 3
        )
        self.assertEqual(
            self.request('PUT', '/api/processes/' + str(ident), {'bpmn_xml': '<invalid>'})[0], 400
        )
        self.assertEqual(self.request('GET', '/api/processes/' + str(ident))[1]['bpmn_xml'], XML)
        self.request('POST', '/api/environments', {'name': 'Other'})
        self.assertEqual(self.request('GET', '/api/processes/' + str(ident))[0], 404)
        self.assertEqual(
            self.request('PUT', '/api/processes/' + str(ident), {'bpmn_xml': XML})[0], 404
        )

    def test_viewer_can_view_but_cannot_import(self):
        self.request('POST', '/api/processes', {'name': 'Incident', 'bpmn_xml': XML})
        self.request(
            'POST',
            '/api/users',
            {'username': 'reader', 'password': 'viewer-password-123', 'role': 'Viewer'},
        )
        client = self.new_client()
        self.request(
            'POST',
            '/api/auth/login',
            {'username': 'reader', 'password': 'viewer-password-123'},
            client=client,
        )
        self.assertEqual(
            len(self.request('GET', '/api/processes', client=client)[1][0]['bpmn']['nodes']), 4
        )
        self.assertEqual(
            self.request(
                'POST', '/api/processes', {'name': 'Denied', 'bpmn_xml': XML}, client=client
            )[0],
            403,
        )
