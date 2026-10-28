"""Auth responsibilities for VSM Toolbox."""

import hashlib
import hmac
import re
import secrets
from .config import ROLES, PASSWORD_ITERATIONS


class ApiError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        'sha256', password.encode(), bytes.fromhex(salt), PASSWORD_ITERATIONS
    ).hex()
    return f'pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest}'


def password_matches(password, stored):
    _, iterations, salt, expected = stored.split('$')
    actual = hashlib.pbkdf2_hmac(
        'sha256', password.encode(), bytes.fromhex(salt), int(iterations)
    ).hex()
    return hmac.compare_digest(actual, expected)


def validate_account(data, creating=False):
    if set(data) - {'username', 'password', 'role'} or not data:
        raise ValueError('Supply only username, password and role')
    if creating and not {'username', 'password'} <= set(data):
        raise ValueError('Username and password are required')
    if 'username' in data and (
        not isinstance(data['username'], str)
        or not re.fullmatch(r'[A-Za-z0-9_.-]{3,64}', data['username'])
    ):
        raise ValueError('Username must be 3–64 letters, numbers, dots, underscores or hyphens')
    if 'password' in data and (
        not isinstance(data['password'], str) or not 12 <= len(data['password']) <= 128
    ):
        raise ValueError('Password must be 12–128 characters')
    if 'role' in data and data['role'] not in ROLES:
        raise ValueError('Role must be Admin, Editor or Viewer')


def public_user(row):
    return {key: row[key] for key in ('id', 'username', 'role')}
