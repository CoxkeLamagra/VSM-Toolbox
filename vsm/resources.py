"""Resources responsibilities for VSM Toolbox."""

from dataclasses import dataclass


@dataclass(frozen=True)
class ResourceSpec:
    fields: dict[str, type]
    write_roles: tuple[str, ...] = ('Admin', 'Editor')
    tagged: bool = False
    order_by: str = 'id'
    nullable: tuple[str, ...] = ()
    text_limits: tuple[tuple[str, int], ...] = ()


PCF_TYPES = ('Category', 'Process Group', 'Process', 'Activity', 'Task')


RESOURCES = {
    'pcf_entries': ResourceSpec(
        {
            'name': str,
            'entry_type': str,
            'parent_id': int,
            'number': int,
            'reference': str,
            'description': str,
        },
        nullable=('parent_id',),
    ),
    'tags': ResourceSpec(
        {'name': str, 'color': str, 'category_id': int}, ('Admin',), nullable=('category_id',)
    ),
    'tag_categories': ResourceSpec({'name': str}, ('Admin',)),
    'streams': ResourceSpec(
        {
            'name': str,
            'customer': str,
            'outcome': str,
            'description': str,
            'voc': str,
            'takt_available_minutes': float,
            'takt_demand': float,
            'takt_period': str,
            'cva': int,
            'bva': int,
        },
        tagged=True,
        nullable=('cva', 'bva', 'takt_available_minutes', 'takt_demand'),
    ),
    'steps': ResourceSpec(
        {
            'name': str,
            'stream_id': int,
            'owner': str,
            'position': int,
            'work_minutes': float,
            'wait_minutes': float,
            'cva': int,
            'bva': int,
        },
        tagged=True,
        order_by='position, id',
        nullable=('cva', 'bva'),
    ),
    'processes': ResourceSpec(
        {'name': str, 'owner': str, 'description': str, 'procedure': str, 'bpmn_xml': str},
        tagged=True,
        text_limits=(('bpmn_xml', 262144),),
    ),
}


def integer_ids(value, field):
    if not isinstance(value, list) or any(type(ident) is not int for ident in value):
        raise ValueError(field + ' must be an array of integer IDs')
    return value
