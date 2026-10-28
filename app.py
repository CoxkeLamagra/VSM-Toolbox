"""VSM Toolbox executable and public Python compatibility facade."""

import os
import sqlite3
from vsm import storage
from vsm.config import (
    ROOT,
    APP_VERSION,
    UPDATE_PROTOCOL,
    ROLES,
    SESSION_SECONDS,
    PASSWORD_ITERATIONS,
)
from vsm.storage import connect, initialize
from vsm.auth import ApiError, password_hash, password_matches, validate_account, public_user
from vsm.branding import (
    BRANDING_DEFAULTS,
    branding,
    validate_branding,
    branding_stylesheet,
    foreground,
)
from vsm.resources import ResourceSpec, RESOURCES, PCF_TYPES, integer_ids
from vsm.bpmn import parse_bpmn
from vsm.pcf import PCFImporter, parse_pcf_csv, PCF_CSV_LIMIT, PCF_CSV_ROWS
from vsm.repository import ContentRepository
from vsm.environments import EnvironmentRepository
from vsm.http import Handler, BoundedHTTPServer

if __name__ == '__main__':
    initialize()
    host = os.environ.get('VSM_HOST', '127.0.0.1')
    port = int(os.environ.get('VSM_PORT', '8080'))
    print(f'VSM Toolbox listening on {host}:{port}', flush=True)
    BoundedHTTPServer((host, port), Handler).serve_forever()
