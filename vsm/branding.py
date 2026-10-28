"""Branding responsibilities for VSM Toolbox."""

import base64
import binascii
import json
import re

BRANDING_DEFAULTS = {
    'name': 'VSM Toolbox',
    'tagline': 'Value streams. Connected.',
    'primary': '#e6404d',
    'sidebar': '#151d44',
    'background': '#f5f6fa',
    'logo': '',
}


def branding(conn):
    row = conn.execute("SELECT value FROM settings WHERE key='branding'").fetchone()
    return {**BRANDING_DEFAULTS, **(json.loads(row['value']) if row else {})}


def validate_branding(data):
    if set(data) != set(BRANDING_DEFAULTS):
        raise ValueError('Supply name, tagline, primary, sidebar, background and logo')
    for key, limit in (('name', 64), ('tagline', 120)):
        if not isinstance(data[key], str) or not data[key].strip() or len(data[key]) > limit:
            raise ValueError(f'{key} must contain 1–{limit} characters')
        data[key] = data[key].strip()
    for key in ('primary', 'sidebar', 'background'):
        if not isinstance(data[key], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', data[key]):
            raise ValueError(f'{key} must be a six-digit hex color')
    logo = data['logo']
    if not isinstance(logo, str) or len(logo) > 180000:
        raise ValueError('Logo must be a PNG or JPEG up to 128 KiB')
    if logo:
        match = re.fullmatch(r'data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)', logo)
        if not match:
            raise ValueError('Logo must be a PNG or JPEG')
        try:
            raw = base64.b64decode(match[2], validate=True)
        except binascii.Error as exc:
            raise ValueError('Invalid logo encoding') from exc
        signature = b'\x89PNG\r\n\x1a\n' if match[1] == 'png' else b'\xff\xd8\xff'
        if len(raw) > 131072 or not raw.startswith(signature):
            raise ValueError('Invalid logo image or logo exceeds 128 KiB')
    return data


def foreground(color):
    values = [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
    luminance = sum(v * w for v, w in zip(linear, (0.2126, 0.7152, 0.0722)))
    return '#ffffff' if luminance < 0.179 else '#111827'


def branding_stylesheet(theme, tag_colors):
    """Generate the one local stylesheet used by branding and colored tags."""
    css = ':root{' + ';'.join(
        f'--{key}:{theme[key]}' for key in ('primary', 'sidebar', 'background')
    )
    css += (
        f";--on-primary:{foreground(theme['primary'])};--on-sidebar:{foreground(theme['sidebar'])}"
        + '}'
    )
    for tag in tag_colors:
        color = tag['color'] if re.fullmatch(r'#[0-9a-fA-F]{6}', tag['color']) else '#e6404d'
        css += f".tag-color-{tag['id']}{{--tag-color:{color};--tag-ink:{foreground(color)}}}"
    return css.encode()
