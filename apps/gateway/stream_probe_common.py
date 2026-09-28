"""Bounded, secret-free primitives for the optional manual stream probe."""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import re
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit
from urllib.request import parse_http_list, parse_keqv_list


class ProbeError(Exception):
    """Only enumerated diagnostic codes cross the collector boundary."""
    def __init__(self, reason='PROTOCOL_ERROR', *, unsupported=False, detail=None):
        if reason not in {'AUTHENTICATION_FAILED', 'UNREACHABLE', 'TIMEOUT',
                          'PROTOCOL_ERROR', 'CAPABILITY_UNAVAILABLE'}:
            reason = 'PROTOCOL_ERROR'
        self.reason = reason
        self.result = 'UNSUPPORTED' if unsupported else 'FAILED'
        # Filled by the RTSP client; never headers, realm, nonce, URI or session.
        self.detail, self.stage, self.status, self.scheme = detail, None, None, None
        super().__init__(reason)

    def diagnostic(self):
        """Whitelisted values only, for local operator output."""
        out = {'stage': self.stage if self.stage in STAGES else None,
               'status': self.status if isinstance(self.status, int) and 100 <= self.status <= 599 else None,
               'authScheme': self.scheme if self.scheme and set(self.scheme.split('+')) <= SCHEMES else None,
               'detail': self.detail if self.detail in DETAILS else None}
        return {k: v for k, v in out.items() if v is not None}


STAGES = {'DESCRIBE', 'SETUP', 'PLAY', 'TEARDOWN'}
SCHEMES = {'DIGEST', 'BASIC', 'OTHER', 'NONE'}
DETAILS = {'NO_CHALLENGE', 'NO_DIGEST_CHALLENGE', 'MALFORMED_CHALLENGE', 'UNSUPPORTED_ALGORITHM',
           'UNSUPPORTED_QOP', 'CREDENTIALS_REJECTED', 'STALE_NONCE', 'FORBIDDEN', 'UNEXPECTED_STATUS'}


def offered_schemes(challenges):
    """Enumerated scheme names offered by WWW-Authenticate headers."""
    names = {c.strip().split(' ', 1)[0].upper() for c in challenges if c.strip()}
    return '+'.join(sorted({n if n in {'DIGEST', 'BASIC'} else 'OTHER' for n in names})) or 'NONE'


@dataclass(repr=False, frozen=True)
class Credentials:
    username: str
    password: str


class Budget:
    def __init__(self, seconds, timeout):
        self.end = time.monotonic() + seconds
        self.timeout = timeout

    def remaining(self):
        left = self.end - time.monotonic()
        if left <= 0:
            raise ProbeError('TIMEOUT')
        return min(left, self.timeout)


def checked_url(url, schemes, *, host=None, origin=None, allow_userinfo=False):
    """Literal IP only; no redirects, control characters, or credential echo."""
    try:
        if not isinstance(url, str) or not 1 <= len(url) <= 8192:
            raise ValueError()
        if any(ord(c) < 33 or ord(c) > 126 for c in url):
            raise ValueError()
        value = urlsplit(url)
        if value.scheme not in schemes or value.fragment:
            raise ValueError()
        ip = str(ipaddress.ip_address(value.hostname))
        if '%' in ip or (host is not None and ip != host):
            raise ValueError()
        if not allow_userinfo and (value.username is not None or value.password is not None):
            raise ValueError()
        port = value.port or {'http': 80, 'https': 443, 'rtsp': 554, 'rtsps': 322}[value.scheme]
        if value.port == 0 or not 1 <= port <= 65535:
            raise ValueError()
        if origin is not None and (value.scheme, ip, port) != origin:
            raise ValueError()
        # Discovered userinfo is never used, logged, or sent in request lines.
        authority = f'[{ip}]' if ':' in ip else ip
        if value.port is not None:
            authority += f':{port}'
        clean = urlunsplit((value.scheme, authority, value.path or '/', value.query, ''))
        return clean, (value.scheme, ip, port)
    except Exception:
        raise ProbeError() from None


def authorization(challenges, method, uri, credentials, nonce_counts=None):
    """HTTP/RTSP Digest (MD5/SHA-256, auth); never Basic, no auth-int downgrade.

    Accepts every WWW-Authenticate value and answers the first usable Digest one.
    `nonce_counts` keeps nc per nonce across requests of one connection.
    """
    if isinstance(challenges, str):
        challenges = [challenges]
    detail = 'NO_DIGEST_CHALLENGE'
    for challenge in challenges:
        scheme, _, params = challenge.strip().partition(' ')
        if scheme.lower() != 'digest':
            continue
        try:
            fields = parse_keqv_list(parse_http_list(params))
            realm, nonce = fields['realm'], fields['nonce']
        except Exception:
            detail = 'MALFORMED_CHALLENGE'
            continue
        algorithm = fields.get('algorithm', 'MD5').upper()
        if algorithm not in {'MD5', 'MD5-SESS', 'SHA-256', 'SHA-256-SESS'}:
            detail = 'UNSUPPORTED_ALGORITHM'
            continue
        qop = fields.get('qop')
        if qop is not None and 'auth' not in [v.strip().lower() for v in parse_http_list(qop)]:
            detail = 'UNSUPPORTED_QOP'
            continue
        try:
            digest = hashlib.sha256 if algorithm.startswith('SHA-256') else hashlib.md5
            h = lambda text: digest(text.encode()).hexdigest()
            counts = {} if nonce_counts is None else nonce_counts
            counts[nonce] = counts.get(nonce, 0) + 1
            cnonce, nc = secrets.token_hex(16), f'{counts[nonce]:08x}'
            ha1 = h(f'{credentials.username}:{realm}:{credentials.password}')
            if algorithm.endswith('-SESS'):
                ha1 = h(f'{ha1}:{nonce}:{cnonce}')
            ha2 = h(f'{method}:{uri}')
            result = h(f'{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}' if qop else f'{ha1}:{nonce}:{ha2}')
            def quote(value):
                if any(ord(c) < 32 or ord(c) == 127 for c in value):
                    raise ValueError()
                return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
            out = {'username': credentials.username, 'realm': realm, 'nonce': nonce,
                   'uri': uri, 'response': result}
            if 'opaque' in fields:
                out['opaque'] = fields['opaque']
            if qop or algorithm.endswith('-SESS'):
                out['cnonce'] = cnonce
            parts = [f'{key}={quote(value)}' for key, value in out.items()]
        except Exception:
            detail = 'MALFORMED_CHALLENGE'
            continue
        parts.append(f'algorithm={algorithm}')
        if qop:
            parts.extend(['qop=auth', f'nc={nc}'])
        return 'Digest ' + ', '.join(parts)
    raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True, detail=detail)


def http_post(url, body, headers, budget, max_bytes=262144):
    """One nonredirecting request, bounded response, always closes the socket."""
    url, (scheme, host, port) = checked_url(url, {'http', 'https'})
    parsed = urlsplit(url)
    path = parsed.path + ('?' + parsed.query if parsed.query else '')
    cls = http.client.HTTPSConnection if scheme == 'https' else http.client.HTTPConnection
    connection = cls(host, port, timeout=budget.remaining())
    try:
        connection.request('POST', path, body=body, headers=headers)
        reply = connection.getresponse()
        data = bytearray()
        while True:
            if connection.sock is not None:
                connection.sock.settimeout(budget.remaining())
            else:
                budget.remaining()
            part = reply.read1(min(8192, max_bytes + 1 - len(data)))
            if not part:
                break
            data.extend(part)
            if len(data) > max_bytes:
                raise ProbeError()
        return reply.status, {k.lower(): v for k, v in reply.getheaders()}, bytes(data)
    except TimeoutError:
        raise ProbeError('TIMEOUT') from None
    except OSError:
        raise ProbeError('UNREACHABLE') from None
    except (http.client.HTTPException, ValueError):
        raise ProbeError() from None
    finally:
        connection.close()
