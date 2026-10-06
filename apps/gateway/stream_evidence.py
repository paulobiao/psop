"""Shared stream endpoint sanitization, not a stream discovery or media probe.

Only call after a discovery protocol actually returned a URI for the profile.
Never buffer/log the input or include it in an exception. Hostnames are rejected:
this first contract requires a literal IP, avoiding secret-bearing DNS labels.
"""
import hashlib
import ipaddress
from urllib.parse import urlsplit


def sanitize_discovered_endpoint(uri: str, profile_id: str, discovery_method: str,
                                 channel_number: int | None = None) -> dict:
    try:
        if not isinstance(uri, str) or len(uri) > 8192 or any(ord(c) < 33 for c in uri):
            raise ValueError()
        if not isinstance(profile_id, str) or not profile_id or len(profile_id) > 1024:
            raise ValueError()
        if discovery_method not in {'ONVIF_GET_STREAM_URI', 'VENDOR_API'}:
            raise ValueError()
        parsed = urlsplit(uri)
        if parsed.scheme not in {'rtsp', 'rtsps'} or not parsed.hostname:
            raise ValueError()
        host = str(ipaddress.ip_address(parsed.hostname))
        if '%' in host:  # scoped IPv6 is not supported by the ingestion contract
            raise ValueError()
        port = parsed.port if parsed.port is not None else (322 if parsed.scheme == 'rtsps' else 554)
        if not 1 <= port <= 65535:
            raise ValueError()
        if channel_number is not None and (type(channel_number) is not int or not 1 <= channel_number <= 65535):
            raise ValueError()
        result = {
            'protocol': parsed.scheme, 'host': host, 'port': port,
            # Exclude userinfo, query and fragment entirely. Even path/profile
            # may contain credentials, so neither is ever stored verbatim.
            'pathSha256': hashlib.sha256(parsed.path.encode('utf-8')).hexdigest(),
            'profileSha256': hashlib.sha256(profile_id.encode('utf-8')).hexdigest(),
            'discoveryMethod': discovery_method,
        }
        if channel_number is not None:
            result['channelNumber'] = channel_number
        return result
    except Exception:
        raise ValueError('Unsafe or unsupported stream endpoint') from None
