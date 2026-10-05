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
If the URI is in the known Speco format, its `chID=N` (in the path,
`/chID=N&...`, or the query, `?chID=N`) must appear once and equal
`--channel-number` (a repeated `chID`, even identical, is refused);
otherwise the check stops before prompts or network I/O. For any other URI
format the tool cannot tell which channel the URI selects: the association is
the operator's declaration and is reported as `uriChannel=OPERATOR_DECLARED`,
never as verified (`URI_CHID_MATCHED` only when chID matched).

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
   different `--channel-number` (or a URI whose `chID` names another
   channel); it must stop with
   `CHECK_CONFIGURATION_ERROR` and send nothing. Avoid deliberate wrong
   passwords on the recorder: repeated failures may lock the account. A real
   authentication failure is recorded as E5 `FAILED:AUTHENTICATION_FAILED`
   with E6 `NOT_OBSERVED`, shown as *Measurement failed*.

Synthetic coverage: `tests/test_stream_probe.py` (`NvrMediatedEvidenceTests`),
`stream-evidence.spec.ts`, `stream-evidence-ingestion.service.spec.ts`,
`device-evidence.service.spec.ts` and the NVR case in
`telemetry-ingestion.e2e-spec.ts`.

## Periodic executor (`stream_scheduler.py`)

A foreground executor runs the same NVR-mediated check (`nvr_rtsp_check.check`)
periodically for several recorders and channels and delivers through the same
ingestion code (`stream_probe.post_row`). It adds scheduling, a bounded
delivery queue and suspension; it has no RTSP or delivery code of its own. It
does not install or start any service, and never touches the Speco watcher,
`psop-runtime-stable`, `runtime.env`, heartbeat, connectivity or incidents.

### Configuration

Copy `stream-scheduler.example.json` (fictitious values) to the ignored
`stream-scheduler.local.json`. Relative paths are resolved from the config
file's directory.

- `probeId`: one persistent UUID for this probe installation; every run
  generates a fresh `attemptId` per check.
- `recorders[]`: `id` (local name), `integration` (today only
  `NVR_RTSP_MANUAL_URI`), recorder `deviceId`, literal-IP `host`, and
  `targets[]` with `channelNumber`, camera `deviceId` and the operator-supplied
  credential-free `uri` (same host as the recorder). Nothing about vendors,
  models, IPs or camera counts is in code.
- Secrets are **references only**: `{"env": "NAME"}`,
  `{"envFile": "path", "key": "NAME"}` or `{"prompt": "label"}` (hidden prompt at
  start). `deviceKey` is the recorder's existing PSOP ingestion key,
  `credentials` the recorder RTSP account. Inline values, `tenantId`, `siteId`
  and any unknown field are rejected: authorization comes only from the
  recorder's ingestion key, and the API still enforces tenant, site, recorder
  assignment and the recorder-reported channel.
- Optional `bindingSource: {"format": "SPECO_MAP", "file": "speco.local.json"}`
  cross-checks every target before any network I/O: `channelKey` must exist
  for that recorder with the same `channelNumber` and camera `deviceId`.
- Always validated before collection: UUIDs, unique recorders/channels, a camera
  bound only once and never equal to a recorder, URI host = recorder host, no
  userinfo, and, for a Speco-format URI, `chID` = `channelNumber` (same rule
  and code as the manual check).
- What is and is not verified locally. `channelKey` ↔ `channelNumber` ↔ camera
  `deviceId` ↔ recorder: only with `bindingSource`; without it they are the
  operator's declaration. URI ↔ `channelNumber`: only for URIs carrying
  `chID`; any other format is `OPERATOR_DECLARED`. `--validate` prints both per
  channel (`binding`, `uriChannel`) and every `CHECK` line carries
  `uriChannel`. Independently, the API accepts a row only if the camera is
  assigned to that recorder and the recorder's own latest channel report puts
  it on that channel; that does not prove which camera a non-Speco URI path
  actually streams.

`schedule` (defaults in brackets): `intervalSeconds` [300, min 60],
`durationSeconds` [5, 1-5], `timeoutSeconds` [3], `maxCheckSeconds` [30],
`evidenceValiditySeconds` [60, max 120 by contract], `maxConcurrentRecorders`
[2], `maxBackoffSeconds` [1800], `deliverySeconds` [15], `maxPendingRows` [100].

**Three different things.**

- *Observation validity* (`evidenceValiditySeconds`, on each row as
  `expiresAt - observedAt`): how long one sample may be presented as current.
  It is fixed when the observation is made and never extended on resend.
- *Expected collection frequency* (`intervalSeconds`): how often the executor
  intends to sample each channel. It is local configuration; the API and the
  dashboard do not know it.
- *Delay or absence of execution*: the executor late, stopped, backed off or
  suspended. A single row cannot express it. The panel only shows that the
  latest evidence has expired; it cannot tell "normal gap between samples"
  from "collector not running". Locally, `CHECK` timestamps,
  `RECORDER_BACKOFF`, `SUSPENDED` and `STOPPED` show it.

**Policy: `evidenceValiditySeconds <= intervalSeconds`.** This is a deliberate
policy of this executor, not a correctness requirement of the contract (the
API only caps validity at 120 s). With it, a sample never stays current into
the time the next sample should have replaced it, so a missed or late cycle
shows up as *Evidence expired* instead of being hidden by an old success.
Consequence: with validity < interval the panel shows *Evidence expired* for
part of every interval, which is accurate. Do not raise validity to cover
gaps; shorten the interval if fresher evidence is needed, at the cost of more
RTSP sessions on the recorder. Even validity = interval leaves short expiry
gaps whenever a cycle runs late, which is also accurate.

**Viable intervals for three channels on one recorder.** Channels run
sequentially and the config is refused unless
`targets × (maxCheckSeconds + deliverySeconds) <= intervalSeconds`, i.e. the
worst case (every check and delivery hitting its hard budget) fits.
`maxCheckSeconds` must be `>= durationSeconds + 2 × timeoutSeconds`.

| Settings (duration / timeout / maxCheck / delivery) | Worst-case cycle | Minimum interval | Typical successful cycle |
|---|---|---|---|
| defaults 5 / 3 / 30 / 15 | 3 × 45 = 135 s | 135 s (300 s default) | ≈ 3 × 6 s ≈ 20 s |
| tight 5 / 3 / 11 / 6 | 3 × 17 = 51 s | 60 s (floor) | ≈ 20 s |

Typical = 5 s media window plus a few LAN round trips and two POSTs per
channel; measure it in the real validation (`elapsedMs`) before tightening.
Suggested: interval 300 s / validity 60 s for routine sampling; interval
120 s / validity 60–120 s if fresher evidence is needed. Above 120 s the
API cap keeps validity below the interval anyway. Every cycle opens three
RTSP sessions on the recorder.

### Behavior

- **Execution**: `--once` runs one cycle per recorder and exits; without it the
  executor runs in the foreground until Ctrl+C. `--send` is required to post;
  otherwise rows are discarded (`delivery.status=NOT_SENT`).
- **One executor per installation**: the executor and `--resume` take an
  exclusive `flock` on `<stateFile>.lock` and refuse to start while another
  process holds it (`SCHEDULER_CONFIGURATION_ERROR: stateFile: another
  stream_scheduler holds this installation's lock`). The kernel releases it
  when the process exits for any reason, including a crash or `kill -9`, so a
  leftover lock file is harmless and must not be deleted by hand; neither its
  existence nor a PID is used. `--validate` and `--status` do not lock. Scope:
  processes on this host using the same `stateFile`; two configs with
  different `stateFile`s (even the same `probeId`) are not excluded, and
  `flock` is not reliable on network filesystems.
- **No overlap / concurrency** within the process: a recorder's channels run
  sequentially and a recorder never starts a new cycle while one is running; at most
  `maxConcurrentRecorders` recorders run at once. Missed slots (long cycle) are
  not replayed: the next cycle starts once, then the normal interval resumes.
- **Isolation**: an error in one target is reported as `CHECK` with
  `error=CHECK_ERROR` and the other targets continue.
- **Recorder unavailable** (every attempted channel failed negotiation with
  UNREACHABLE/TIMEOUT): next cycle after `interval × 2^n`, capped at
  `maxBackoffSeconds`; one successful cycle restores the interval. The failed
  attempts are delivered as FAILED evidence, not hidden.
- **Authentication rejected**: after one rejected login the whole recorder is
  suspended (same account, avoids lockout), or only the channel for 403
  (`FORBIDDEN`). Suspension is persisted in `stateFile` (secret-free) and
  survives restarts; only `--resume RECORDER[:CHANNEL]` clears it. `--status`
  lists suspensions. If every recorder is suspended the executor exits with 3.
- **Delivery**: rows are queued (in memory, oldest first, at most
  `maxPendingRows` per recorder; drops are reported) and posted after each
  check, stopping at the first unavailable response. Pending rows are resent
  byte-identical on later cycles: same `sourceEventKey`, `attemptId`,
  `observedAt` and `expiresAt`. The ledger's `sourceEventKey` uniqueness makes a
  resend `accepted: 0`, and a late row stays as old as it was, so nothing is
  renewed. 4xx rows are reported and never resent. Each `CHECK` line reports
  `delivery.status` = `DELIVERED`, `PARTIAL`, `PENDING`, `REJECTED` or
  `NOT_SENT` with counts, plus older rows delivered in that flush. API
  trouble never triggers recorder backoff and never implies the equipment is
  offline. The dashboard shows *Partial delivery* while only E5 or E6 of the
  latest attempt has arrived.
- **Shutdown**: Ctrl+C (or SIGTERM) stops new work and immediately shuts down
  every open probe/delivery socket, so workers blocked in connect, an RTSP
  read or an HTTP delivery return at once and close their sockets; the
  process then waits at most `2 + timeoutSeconds + 1` s for them
  (`STOPPED.stillRunning` reports any left). No TEARDOWN is sent on this path:
  the RTSP session ends with its TCP connection. The interrupted check's
  result is discarded (`CHECK_INTERRUPTED`), since a cut-short check is not a
  measurement. Limit: TLS (`rtsps`/`https`) sockets are wrapped after
  connect and are not cut; they end at their per-I/O timeout
  (`<= timeoutSeconds`). `STOPPED` reports undelivered rows, which are lost because the
  queue is not persisted. A second Ctrl+C aborts immediately.
- **Output**: JSON lines (`STARTED`, `CHECK`, `SUSPENDED`, `RECORDER_BACKOFF`,
  `STOPPED`, ...) with enums, counts, camera `deviceId`, channel and
  `attemptId`; never credentials, device keys, URIs, realm/nonce or sessions.

Adding another integration means one function with the signature
`check(target, credentials, budget, duration, validity) -> (summary, rows)`
registered in `stream_scheduler.INTEGRATIONS`; there is no plugin framework.

### Limits

Periodic sampling does **not** prove continuous availability: a success only
shows that negotiation and video RTP packets were observed in a few seconds at
that time, through the recorder. RTP packets are not decoded frames and not
proof of recording or retrieval. The executor stops with its terminal; queued
rows and backoff state are memory only.

### Real validation (one channel first, then all three)

Run from the repository root. Keep the Speco watcher running as is. Never
print or paste the local config's URIs, `.env.speco.local` or credentials.

1. Create the local config (mode 600) from the example:
   `cp apps/gateway/stream-scheduler.example.json apps/gateway/stream-scheduler.local.json && chmod 600 apps/gateway/stream-scheduler.local.json`.
   Edit it: reuse the probe UUID from the manual validation as `probeId`; keep
   one recorder with `deviceId` = recorder id from `speco.local.json`, `host` =
   `PSOP_SPECO_HOST`, `deviceKey`/`apiUrl` referencing `.env.speco.local`,
   `credentials` as prompts, `bindingSource` = `speco.local.json`, and only the
   channel 1 target (its `channelKey`, camera `deviceId` and the validated URI).
   Remove the second example recorder. Keep the default schedule
   (300 s interval, 60 s validity) for the first run.
2. Validate without network:
   `python3 apps/gateway/stream_scheduler.py --config apps/gateway/stream-scheduler.local.json --validate`.
   Expect `CONFIG_VALID` with channel 1 `binding=BINDING_SOURCE`. If the URI
   carries `chID`, expect `uriChannel=URI_CHID_MATCHED`; `OPERATOR_DECLARED`
   means the URI format could not be checked and the channel association
   rests on the operator (confirm it in the recorder UI).
3. One cycle, nothing sent: `python3 apps/gateway/stream_scheduler.py --config apps/gateway/stream-scheduler.local.json --once`.
   Note `elapsedMs` of the check: it is the real per-channel cost used to
   judge tighter intervals.
4. One cycle, sent: `python3 apps/gateway/stream_scheduler.py --config apps/gateway/stream-scheduler.local.json --once --send`.
   Expect `negotiation=SUCCEEDED`, `media.count>0`,
   `delivery.status=DELIVERED`; the camera panel shows *Media observed* via
   recorder, channel 1, and *Evidence expired* after the configured validity
   (60 s), with the result retained. Expiry between samples is expected and
   is not a failure.
5. Periodic for two intervals, then Ctrl+C:
   `python3 apps/gateway/stream_scheduler.py --config apps/gateway/stream-scheduler.local.json --send`.
   Expect two `CHECK` lines about one interval apart and, within about a
   second of Ctrl+C, `STOPPED` with `stillRunning=0`, `undeliveredRows=0`
   (a Ctrl+C during a check prints `CHECK_INTERRUPTED` and sends nothing for
   it).
6. Single-instance check, no extra recorder traffic: while step 5 runs, start
   `--once` with the same config in a second terminal. It must stop at once
   with the `stateFile` lock error before any prompt. After step 5 stops, the
   `.lock` file remains and the next start works.
7. Add the channel 2 and 3 targets (each with its `channelKey`, camera
   `deviceId` and its own URI), repeat steps 2, 4 and 5. Expect three `CHECK`
   lines per cycle, sequential on the recorder, each with its own camera
   `deviceId` and `attemptId`, and each camera panel showing its own channel.
   If a chID-format URI names another channel, step 2 fails with
   `targets[N].uri: chID does not select channelNumber` and nothing is sent.
8. `--status` must show no suspension. Do not test wrong passwords on the
   recorder; suspension and resume are covered synthetically.

Synthetic coverage: `tests/test_stream_scheduler.py`.
