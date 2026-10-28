"""Bpmn responsibilities for VSM Toolbox."""

import math
import re
import xml.etree.ElementTree as ET

BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL'


def parse_bpmn(xml):
    """Read bounded BPMN data; never render XML markup or resolve external resources."""
    if not isinstance(xml, str) or len(xml.encode('utf-8')) > 262144:
        raise ValueError('BPMN XML must be UTF-8 text of at most 256 KiB')
    if '\x00' in xml or re.search(r'<!\s*(DOCTYPE|ENTITY)', xml, re.I):
        raise ValueError('BPMN files cannot contain DTDs or entity declarations')
    try:
        root = ET.fromstring(xml)
    except (ET.ParseError, ValueError) as exc:
        raise ValueError('Invalid BPMN XML') from exc
    if root.tag != '{' + BPMN_NS + '}definitions':
        raise ValueError('Expected BPMN 2.0 definitions')
    elements = list(root.iter())
    if len(elements) > 10000:
        raise ValueError('BPMN file contains too many XML elements')
    kinds = {
        'task',
        'userTask',
        'serviceTask',
        'manualTask',
        'scriptTask',
        'businessRuleTask',
        'sendTask',
        'receiveTask',
        'callActivity',
        'subProcess',
        'transaction',
        'startEvent',
        'endEvent',
        'intermediateCatchEvent',
        'intermediateThrowEvent',
        'boundaryEvent',
        'exclusiveGateway',
        'parallelGateway',
        'inclusiveGateway',
        'eventBasedGateway',
        'complexGateway',
    }
    nodes, edges, ids = [], [], set()
    for element in elements:
        if not element.tag.startswith('{' + BPMN_NS + '}'):
            continue
        kind = element.tag.split('}', 1)[1]
        ident = element.get('id')
        if ident:
            if ident in ids:
                raise ValueError('BPMN element IDs must be unique')
            ids.add(ident)
        if kind in kinds:
            if not ident:
                raise ValueError('BPMN flow nodes require an ID')
            nodes.append({'id': ident, 'kind': kind, 'name': element.get('name', kind)[:500]})
        elif kind in ('sequenceFlow', 'messageFlow'):
            edges.append(
                {
                    'id': ident,
                    'source': element.get('sourceRef'),
                    'target': element.get('targetRef'),
                    'name': element.get('name', '')[:500],
                    'kind': kind,
                }
            )
    if not nodes or len(nodes) > 500 or len(edges) > 2000:
        raise ValueError('BPMN must contain 1–500 supported flow nodes and at most 2000 flows')
    positions = {}
    for shape in root.iter('{http://www.omg.org/spec/BPMN/20100524/DI}BPMNShape'):
        bounds = shape.find('{http://www.omg.org/spec/DD/20100524/DC}Bounds')
        if bounds is None:
            continue
        try:
            box = {key: float(bounds.get(key, 'nan')) for key in ('x', 'y', 'width', 'height')}
        except ValueError as exc:
            raise ValueError('Invalid BPMN diagram coordinates') from exc
        if (
            any(not math.isfinite(value) or abs(value) > 100000 for value in box.values())
            or min(box['width'], box['height']) <= 0
        ):
            raise ValueError('Invalid BPMN diagram coordinates')
        positions[shape.get('bpmnElement')] = box
    routes = {}
    for edge in root.iter('{http://www.omg.org/spec/BPMN/20100524/DI}BPMNEdge'):
        points = []
        for point in edge.findall('{http://www.omg.org/spec/DD/20100524/DI}waypoint'):
            try:
                x, y = float(point.get('x', 'nan')), float(point.get('y', 'nan'))
            except ValueError as exc:
                raise ValueError('Invalid BPMN flow coordinates') from exc
            if not all(math.isfinite(value) and abs(value) <= 100000 for value in (x, y)):
                raise ValueError('Invalid BPMN flow coordinates')
            points.append({'x': x, 'y': y})
        if len(points) >= 2:
            routes[edge.get('bpmnElement')] = points
    for edge in edges:
        edge['waypoints'] = routes.get(edge['id'], [])
    for index, node in enumerate(nodes):
        node.update(
            positions.get(
                node['id'],
                {'x': (index % 5) * 220, 'y': (index // 5) * 150, 'width': 160, 'height': 80},
            )
        )
    node_ids = {node['id'] for node in nodes}
    visible_edges = [
        edge for edge in edges if edge['source'] in node_ids and edge['target'] in node_ids
    ]
    process = root.find('{' + BPMN_NS + '}process')
    return {
        'name': (
            (process.get('name') or process.get('id') or 'Imported BPMN')[:200]
            if process is not None
            else 'Imported BPMN'
        ),
        'nodes': nodes,
        'edges': visible_edges,
        'omitted_flows': len(edges) - len(visible_edges),
    }
