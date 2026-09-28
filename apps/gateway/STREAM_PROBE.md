# Manual E4–E6 stream probe

This is an optional, foreground command for **one** explicitly mapped camera.
It performs read-only ONVIF calls (`GetDeviceInformation`, `GetCapabilities`,
`GetProfiles`, `GetStreamUri`) and a bounded RTSP `DESCRIBE` / `SETUP` / `PLAY`
exchange. It asks ONVIF for the URI; the camera/profile/channel mapping in the
local config does not supply or guess the URI. A discovered stream endpoint must
have the same literal IP address as the ONVIF service. This intentionally
refuses recorder proxies, host changes, redirects and DNS names, so a camera on
an NVR-only PoE network may report unreachable/unsupported until there is a
documented, verified route to that camera.

Discovery follows ONVIF Media `GetProfiles` / `GetStreamUri` and the ONVIF
Media service's RTSP setup parameters ([Media Service specification](https://www.onvif.org/specs/srv/media/ONVIF-Media-Service-Spec-v221.pdf)).
The control/media sequence follows the [RTSP specification](https://www.rfc-editor.org/rfc/rfc2326.html).

The camera must return a Hikvision manufacturer and a serial whose SHA-256
matches the locally pinned expected identity. The selected ONVIF profiles must
all identify one video source; multi-camera NVR profiles fail closed unless a
future implementation can prove the camera-to-profile association. Optional
`profileSha256` pins one profile token. Digests are generated locally and only
the hashes are retained/sent.

RTSP requires matching CSeq values, an SDP video track with a supported video
payload, successful SETUP with interleaved RTP/RTCP channels and session ID, and
PLAY in that same session. Only RTP v2 payloads whose payload type is in the
selected SDP video track and whose interleaved channel/SSRC match count for E6.
Audio, RTCP, unselected RTP, malformed packets and bytes outside RTP do not
count. **Decoded frames are not implemented**: output explicitly says
`decodedFrames=NOT_MEASURED`. No FPS or recording state is treated as video
proof. Negotiated sessions are torn down best effort and the socket is always
closed.

HTTP Digest is supported for ONVIF/RTSP challenges. Basic authentication is
refused, so a camera requiring Basic only is reported unsupported. HTTPS/RTSPS
uses the standard certificate-verifying TLS context. Nothing is logged from
responses, SDP, session headers, credentials, URLs, or tracebacks. Authenticated
RTSP URIs and packets exist in process memory only. No image/video files or
packet captures are created.

## Prepare a private one-camera config

Copy the ignored example to `apps/gateway/stream-probe.local.json`. Replace the
sample values with: a new probe UUID, the exact `channelId` already present in
`speco.local.json`, the actual reachable ONVIF device service URL, and a local
hash of the camera serial. Do not place credentials or an RTSP URI in the file.

To compute the serial hash without echoing the serial to the terminal/history:

```bash
python3 -c 'import getpass,hashlib; print(hashlib.sha256(getpass.getpass("Camera serial (hidden): ").encode()).hexdigest())'
```

For a profile pin, use the same pattern with the profile token. No serial or
profile token is displayed. The config directory and Speco mapping must be the
same existing local config used by the adapter, or use `PSOP_SPECO_CONFIG_DIR`
to point at that already-configured directory. Nothing here changes runtime
selection or starts a service.

Enter the ONVIF username/password at the hidden prompts, or set
`PSOP_HIKVISION_USERNAME` / `PSOP_HIKVISION_PASSWORD` in the foreground
process's environment for one run. Never put them in command arguments.
`--send` reads the existing local `PSOP_SPECO_RECORDER_DEVICE_KEY` and
`PSOP_API_URL`; without `--send`, no ingestion request is made. API validation
authenticates the mapped recorder observer and enforces its active same-tenant,
same-site camera assignment. The collector does not update recorder/camera
connectivity, heartbeat, recording status, or the watcher.

## Safe synthetic verification

```bash
python3 -m unittest discover -s apps/gateway/tests -p 'test_stream_probe.py' -v
```

The fixtures simulate ONVIF SOAP, RTSP, RTP, Digest challenges, authentication
rejection, timeout, no media, session/transport mismatch, evidence delivery
retry, target mapping and secret-free output. They use only synthetic values.

## Real camera command (run together during the validation session)

Once the local mapping is ready, and after confirming the API is available, use:

```bash
python3 apps/gateway/stream_probe.py --config apps/gateway/stream-probe.local.json --timeout 3 --duration 5 --max-duration 60 --send
```

This probes just the configured channel for up to five seconds of media and 60
seconds total, with at most three seconds per I/O. `--send` records three
separate observations (E4/E5/E6) or the partial failed/not-observed outcomes.
Omit `--send` for a network-only run. No hardware test was run while building
this implementation. Lack of direct camera routing or ONVIF/RTSP credentials
will produce a sanitized status rather than substitute evidence.

## NVR-mediated check (`nvr_rtsp_check.py`)

For cameras on the recorder's private PoE network, the stream is taken from the
Speco recorder's own RTSP service with a URI the operator copies from the
recorder UI. This is **not discovery**: it never produces E4, and the evidence
is attested by the recorder adapter (`source=ADAPTER`,
`access=NVR_MEDIATED`, `uriSource=MANUAL_OPERATOR_INPUT`), never as a direct
camera observation. Contract details: `docs/VIDEO_ASSURANCE_FOUNDATION.md`
("NVR-mediated measurements").

Each run performs one bounded DESCRIBE/SETUP/PLAY/TEARDOWN and counts video RTP
packets for up to `--duration` seconds. With `--send` it sends exactly two rows
to `POST /api/v1/telemetry/stream-evidence`: E5 (negotiation) and E6 (RTP
packets, not decoded frames), sharing one `attemptId`, valid for 60 s. Without
`--send` nothing is sent (`delivery=NOT_SENT`).

Binding is explicit. `--channel-id` must be the exact channel key in
`speco.local.json`; `--channel-number` must be the recorder channel the URI
selects and must equal that entry's `channelNumber`. The target `deviceId`
comes only from that mapping entry, never from the number or a name. The API
then requires the target to be an active camera assigned to this recorder in
the same site/tenant **and** the recorder's own latest channel report to place
it on that channel; otherwise it answers 400 and nothing is stored.
`--probe-id` is a stable UUID for this probe installation (not secret).

The URI host must equal `PSOP_SPECO_HOST`; userinfo is refused. Username and
password are always read from hidden prompts. `--send` reads `PSOP_API_URL`
and `PSOP_SPECO_RECORDER_DEVICE_KEY` from the existing `.env.speco.local`
(or the process environment) and authenticates as the recorder. The output
contains only enums, counts, the target `deviceId`, channel number and
`attemptId`; never credentials, URI, realm/nonce, `Authorization` or session.
The check does not touch the watcher, `runtime.env`, heartbeat, connectivity or
incidents.

### Real validation procedure (one channel)

1. Keep the Speco watcher running as is (`psop-runtime-stable`); it keeps the
   recorder channel snapshot current. Confirm the API at `PSOP_API_URL` is up
   and, in the dashboard, that the camera is assigned to the recorder.
2. Once per probe installation, create and keep a probe UUID:
   `uuidgen | tr 'A-Z' 'a-z'`.
3. List the explicit channel bindings the check will load (key, number,
   deviceId; no credentials):

   ```bash
   python3 -c 'import sys; sys.path.insert(0, "apps/gateway"); from speco_n8nrl import DEFAULT_LOCAL_MAP, _load_speco_map; [print(repr(k), v.get("channelNumber"), v.get("deviceId")) for k, v in _load_speco_map(DEFAULT_LOCAL_MAP)["channels"].items()]'
   ```

4. Run one channel with explicit delivery (quote the URI and channel key):

   ```bash
   python3 apps/gateway/nvr_rtsp_check.py \
     --uri 'rtsp://<PSOP_SPECO_HOST>:554/<path copied from the recorder UI>' \
     --channel-id '<exact channel key>' --channel-number <N> \
     --probe-id <probe UUID> --send
   ```

   Expected: `negotiation=SUCCEEDED`, `media.count > 0`,
   `delivery=DELIVERED`, `deliveredRows=2`, exit code 0.
   `CHECK_CONFIGURATION_ERROR` means the binding or URI was refused before any
   network I/O. `DELIVERY_ERROR` means the probe ran but the API refused or
   was unreachable (e.g. channel mismatch → 400); nothing partial is retried
   with new identifiers.
5. Open the camera's device details. "Stream measurement" must show
   *Media observed*, origin *Via recorder … · channel N*, URI source
   *Operator-supplied (no discovery)*, the packet count/window and
   *Valid until*. Connectivity is shown separately and must be unchanged.
6. After 60 s, refresh: the state becomes *Evidence expired* with the original
   result retained. A camera never probed shows *No measurement*.
7. Optional negative check without hardware traffic: repeat step 4 with a
   different `--channel-number`; it must stop with
   `CHECK_CONFIGURATION_ERROR` and send nothing. Avoid deliberate wrong
   passwords on the recorder: repeated failures may lock the account. A real
   authentication failure is recorded as E5 `FAILED:AUTHENTICATION_FAILED`
   with E6 `NOT_OBSERVED`, shown as *Measurement failed*.

Synthetic coverage: `tests/test_stream_probe.py` (`NvrMediatedEvidenceTests`),
`stream-evidence.spec.ts`, `stream-evidence-ingestion.service.spec.ts`,
`device-evidence.service.spec.ts` and the NVR case in
`telemetry-ingestion.e2e-spec.ts`.
