"""Explicit delivery profiles and static asset allowlist.

Protocol 1 is accepted only for restoring older backups; protocol 2 is the
modular application. No manifest may choose arbitrary filesystem paths.
"""

UPDATE_PROTOCOL = 2
LEGACY_FILES = (
    'app.py',
    'updater.py',
    'web/index.html',
    'web/app.js',
    'web/style.css',
    'update-manifest.json',
)

MAX_RUNTIME_FILES = 128


def release_files(manifest, allow_legacy=True):
    """Validate a bounded delivery profile; never accept filesystem escapes."""
    import re

    if not isinstance(manifest, dict):
        raise ValueError('Invalid application manifest')
    protocol = manifest.get('update_protocol')
    if type(protocol) is not int or type(manifest.get('format')) is not int:
        raise ValueError('Invalid delivery protocol')
    names = manifest.get('files')
    if (
        manifest.get('format') != 1
        or manifest.get('runtime') != 'python-stdlib'
        or not isinstance(names, list)
        or not names
        or len(names) > MAX_RUNTIME_FILES
        or any(not isinstance(name, str) for name in names)
        or len(names) != len(set(names))
    ):
        raise ValueError('Invalid application delivery profile')
    if protocol == 1 and allow_legacy and set(names) == set(LEGACY_FILES):
        return LEGACY_FILES
    required = {
        'app.py',
        'updater.py',
        'update-manifest.json',
        'vsm/__init__.py',
        'vsm/runtime.py',
        'web/index.html',
        'web/app.js',
        'web/style.css',
    }
    if protocol != 2 or not required <= set(names):
        raise ValueError('Incompatible delivery protocol; rerun the installer')
    for name in names:
        if name in ('app.py', 'updater.py', 'update-manifest.json'):
            continue
        if not re.fullmatch(
            r'vsm/(?:[A-Za-z_][A-Za-z0-9_]*/)*[A-Za-z_][A-Za-z0-9_]*\.py|web/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.(?:js|css|html)',
            name,
        ):
            raise ValueError('Unsafe runtime file path: ' + name)
    return tuple(names)


import json
from pathlib import Path

FILES = release_files(
    json.loads((Path(__file__).resolve().parents[1] / 'update-manifest.json').read_text()),
    allow_legacy=False,
)

STATIC_ASSETS = {'/': ('index.html', 'text/html')}
for name in FILES:
    if name.startswith('web/'):
        suffix = name.rsplit('.', 1)[-1]
        STATIC_ASSETS['/' + name[4:]] = (
            name[4:],
            {'js': 'text/javascript', 'css': 'text/css', 'html': 'text/html'}[suffix],
        )
