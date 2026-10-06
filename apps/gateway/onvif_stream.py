"""Read-only ONVIF Media1 discovery, pinned to one identified camera host.

No stream URI templates or vendor guesses. No network/device configuration calls.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from stream_probe_common import ProbeError, authorization, checked_url, http_post
from stream_evidence import sanitize_discovered_endpoint

SOAP = 'http://www.w3.org/2003/05/soap-envelope'
DEVICE = 'http://www.onvif.org/ver10/device/wsdl'
MEDIA = 'http://www.onvif.org/ver10/media/wsdl'
TT = 'http://www.onvif.org/ver10/schema'
WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd'
WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'
TOKEN = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0'
ENCODING = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0'


@dataclass(repr=False, frozen=True)
class DiscoveredStream:
    uri: str
    endpoint: dict


class OnvifDiscovery:
    def __init__(self, service, credentials, budget, *, post=http_post):
        self.service, self.origin = checked_url(service, {'http', 'https'})
        self.credentials, self.budget, self.post = credentials, budget, post

    def call(self, url, namespace, operation, content=None):
        url, _ = checked_url(url, {'http', 'https'}, host=self.origin[1])
        # Never downgrade transport protection advertised by the device service.
        if self.origin[0] == 'https' and not url.startswith('https:'):
            raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
        envelope = ET.Element(f'{{{SOAP}}}Envelope')
        header = ET.SubElement(envelope, f'{{{SOAP}}}Header')
        security = ET.SubElement(header, f'{{{WSSE}}}Security', {f'{{{SOAP}}}mustUnderstand': 'true'})
        token = ET.SubElement(security, f'{{{WSSE}}}UsernameToken')
        ET.SubElement(token, f'{{{WSSE}}}Username').text = self.credentials.username
        nonce = secrets.token_bytes(20)
        created = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + self.credentials.password.encode()).digest()).decode()
        ET.SubElement(token, f'{{{WSSE}}}Password', {'Type': TOKEN + '#PasswordDigest'}).text = digest
        ET.SubElement(token, f'{{{WSSE}}}Nonce', {'EncodingType': ENCODING + '#Base64Binary'}).text = base64.b64encode(nonce).decode()
        ET.SubElement(token, f'{{{WSU}}}Created').text = created
        body = ET.SubElement(envelope, f'{{{SOAP}}}Body')
        request = ET.SubElement(body, f'{{{namespace}}}{operation}')
        if content:
            content(request)
        data = ET.tostring(envelope, encoding='utf-8', xml_declaration=True)
        headers = {'Content-Type': f'application/soap+xml; charset=utf-8; action="{namespace}/{operation}"'}
        for attempt in range(2):
            status, response_headers, raw = self.post(url, data, headers, self.budget)
            if status == 401 and attempt == 0:
                challenge = response_headers.get('www-authenticate')
                if not challenge:
                    raise ProbeError('AUTHENTICATION_FAILED')
                parsed = urlsplit(url)
                path = parsed.path + ('?' + parsed.query if parsed.query else '')
                headers['Authorization'] = authorization(challenge, 'POST', path, self.credentials)
                continue
            if status in {401, 403}:
                raise ProbeError('AUTHENTICATION_FAILED')
            if status in {404, 405, 501}:
                raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
            # ElementTree does not fetch external entities; forbid declarations
            # as well, including local expansion. Only bounded UTF-8 SOAP here.
            try:
                text = raw.decode('utf-8')
                if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
                    raise ValueError()
                root = ET.fromstring(text)
            except (ValueError, ET.ParseError):
                raise ProbeError() from None
            fault = root.find(f'{{{SOAP}}}Body/{{{SOAP}}}Fault')
            if fault is not None:
                codes = [item.text or '' for item in fault.iter(f'{{{SOAP}}}Value')]
                if any(v.split(':')[-1] in {'NotAuthorized', 'FailedAuthentication'} for v in codes):
                    raise ProbeError('AUTHENTICATION_FAILED')
                if any(v.split(':')[-1] in {'ActionNotSupported', 'OptionalActionNotImplemented'} for v in codes):
                    raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
                raise ProbeError()
            result = root.find(f'{{{SOAP}}}Body/{{{namespace}}}{operation}Response')
            if status != 200 or result is None:
                raise ProbeError()
            return result
        raise ProbeError('AUTHENTICATION_FAILED')

    def discover(self, expected_serial_sha256, *, profile_sha256=None, channel_number=None):
        info = self.call(self.service, DEVICE, 'GetDeviceInformation')
        manufacturer = info.findtext(f'{{{DEVICE}}}Manufacturer', '')
        serial = info.findtext(f'{{{DEVICE}}}SerialNumber', '')
        if 'hikvision' not in manufacturer.lower() or not serial or not secrets.compare_digest(
                hashlib.sha256(serial.encode()).hexdigest(), expected_serial_sha256):
            raise ProbeError()  # identity mismatch: never attribute to requested camera
        caps = self.call(self.service, DEVICE, 'GetCapabilities',
                         lambda node: setattr(ET.SubElement(node, f'{{{DEVICE}}}Category'), 'text', 'Media'))
        address = caps.findtext(f'{{{DEVICE}}}Capabilities/{{{TT}}}Media/{{{TT}}}XAddr')
        if not address:
            raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
        address, _ = checked_url(address, {'http', 'https'}, host=self.origin[1])
        profiles = self.call(address, MEDIA, 'GetProfiles').findall(f'{{{MEDIA}}}Profiles')
        candidates, sources = [], set()
        for profile in profiles:
            source = profile.findtext(f'{{{TT}}}VideoSourceConfiguration/{{{TT}}}SourceToken')
            token = profile.get('token')
            if not source or not token or profile.find(f'{{{TT}}}VideoEncoderConfiguration') is None:
                continue
            sources.add(source)
            if profile_sha256 is None or hashlib.sha256(token.encode()).hexdigest() == profile_sha256:
                candidates.append(token)
        # Multi-source encoders/NVRs require a separate documented camera mapping;
        # a configured profile alone cannot prove that mapping.
        if len(sources) != 1 or not candidates or (profile_sha256 and len(candidates) != 1):
            raise ProbeError('CAPABILITY_UNAVAILABLE', unsupported=True)
        profile = candidates[0]  # one camera; use its first returned video profile
        def setup(node):
            stream = ET.SubElement(node, f'{{{MEDIA}}}StreamSetup')
            ET.SubElement(stream, f'{{{TT}}}Stream').text = 'RTP-Unicast'
            transport = ET.SubElement(stream, f'{{{TT}}}Transport')
            ET.SubElement(transport, f'{{{TT}}}Protocol').text = 'RTSP'
            ET.SubElement(node, f'{{{MEDIA}}}ProfileToken').text = profile
        reply = self.call(address, MEDIA, 'GetStreamUri', setup)
        raw_uri = reply.findtext(f'{{{MEDIA}}}MediaUri/{{{TT}}}Uri')
        # E4 attests what ONVIF returned. RTSP must be reachable at the same
        # camera IP: no host substitution, proxy guessing, or redirect auth.
        uri, _ = checked_url(raw_uri, {'rtsp', 'rtsps'}, host=self.origin[1], allow_userinfo=True)
        try:
            endpoint = sanitize_discovered_endpoint(uri, profile, 'ONVIF_GET_STREAM_URI', channel_number)
        except ValueError:
            raise ProbeError() from None
        return DiscoveredStream(uri, endpoint)
