"""Shared application configuration and version."""

from pathlib import Path
from .runtime import UPDATE_PROTOCOL

ROOT = Path(__file__).resolve().parents[1]
APP_VERSION = '1.0.0'


ROLES = ('Admin', 'Editor', 'Viewer')


SESSION_SECONDS = 12 * 60 * 60


PASSWORD_ITERATIONS = 600_000
