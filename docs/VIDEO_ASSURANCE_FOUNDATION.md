# Video assurance foundation: E4–E6

## Scope and current limitation

This change provides a vendor-neutral ingestion contract, validation, evidence persistence and an edge URI sanitizer. **It does not implement or run a discovery/RTSP/media collector.** No lab E4–E6 observations have been produced. Existing Speco/Lorex senders and health behavior are unchanged. No frontend or database migration is required.

The active adapter source is `apps/gateway/speco_n8nrl.py`. Its read-only commands return channels, recording configuration/status and optional device identity, not an actual stream URI. `psop_gateway.py:probe_rtsp` performs OPTIONS/TCP reachability only. Neither is an E5 or E6 probe. We must not invent a URI from a channel number. The missing integration inputs are a confirmed read-only stream discovery method (ONVIF GetStreamUri or documented vendor API), its profile-to-camera mapping, and an authorized reachable RTSP endpoint/authentication mechanism from the Edge Witness network. The recorder's private PoE cameras may require recorder-mediated access. Keep credentials local and runtime-only; do not put them in tickets, payloads, command arguments or logs.

A future optional collector must detect its capabilities and report UNSUPPORTED/CAPABILITY_UNAVAILABLE when unavailable (including a missing external executable, if one is chosen). This patch adds no external executable dependency and does not claim to detect a nonexistent probe. A failed optional collector must remain isolated from core collection and delivery.

## Meaning of success

| Contract level | Required distinct observation | Does not prove |
| --- | --- | --- |
| E4_STREAM_URI_OBTAINED | Discovery returned a stream URI for the identified camera/profile; sanitizer produces the endpoint descriptor | Reachability, successful authentication, negotiation or media |
| E5_RTSP_SESSION_NEGOTIATED | For that discovered stream: DESCRIBE 200 with a selected SDP video track, SETUP 200 establishing a session/transport, then PLAY 200 for that session | Any media was received, image quality or recording |
| E6_FRAMES_RECEIVED | Same negotiation plus at least one received video RTP packet belonging to the selected session/track, or decoded video frame, during the bounded measurement window | Packet receipt alone does not prove decode; neither metric proves usable images, continuous coverage, storage, recording or retrieval |

E5 requires the complete DESCRIBE/SETUP/PLAY sequence above. TCP connection, OPTIONS 200, an HTTP response, NVR online status and configured stream parameters are insufficient. Probe implementations must correlate responses with requests/session, and packet observations with the selected video track; arbitrary network bytes, audio and RTCP are not video packets. Session IDs, headers and SDP are never submitted.

E6 explicitly distinguishes `RTP_VIDEO_PACKETS` from `DECODED_VIDEO_FRAMES`. The count must be 1–10,000,000, window 1–60,000 ms, and lastReceivedAt must fall within the window ending at observedAt. Recorder frameRate, bitrate, online/recording status and E3 profiles cannot create E4–E6. No HDD affects storage/recording capabilities, not the meaning of live stream evidence.

These are authenticated probe attestations, not independently verified packet captures. The API validates the shape, timing and required proof fields; it cannot verify a sender's honesty. Confidence is OBSERVED, never automatically VERIFIED. A compound E6 observation includes negotiation proof, but does not synthesize separate E4/E5 rows.

## Ingestion and persistence

`POST /api/v1/telemetry/stream-evidence` uses the existing `x-device-id` and `x-device-key` authentication with local ingestion enabled. It accepts one `IngestStreamEvidenceDto` (see `apps/api/src/modules/device/dto/ingest-stream-evidence.dto.ts`).

Required envelope: target deviceId, probeId (installation UUID), sourceEventKey (observation UUID, stable on retry), explicit level, result, source, reason, observedAt and expiresAt. Subject is fixed to `video.stream`; observerDeviceId is derived from the authenticated principal. Probe identity is scoped to that principal, not a separately authenticated identity. Recorder principals use ADAPTER; gateway principals GATEWAY; directly monitored camera principals DEVICE.

The authenticated observer must be active and directly monitored. Recorder/gateway targets must be active VIA_GATEWAY cameras explicitly assigned to that observer in its site and tenant. Direct cameras can attest only for themselves. The existing organization-scoped evidence read endpoint remains unchanged.

For success, endpoint is mandatory. E5/E6 additionally require negotiation, and E6 requires media. All statuses and proof flags are enumerated; numeric ranges, timestamps and a 4096-byte serialized contract limit are enforced. Observation timestamps allow up to 5 minutes of clock skew into the future. Expiry must be after observation and at most 120 seconds later. Historical/buffered observations are accepted without refreshing their expiry.

Endpoint contains only rtsp/rtsps protocol, literal IP host, port, SHA-256 of path and profile identifier, optional numeric channel number and discovery method (ONVIF_GET_STREAM_URI, VENDOR_API or MANUAL_OPERATOR_INPUT; see below). No raw URI is accepted as proof. DNS hostnames are intentionally unsupported in this first contract. The pure helper `apps/gateway/stream_evidence.py:sanitize_discovered_endpoint` drops userinfo, query and fragment and hashes the path/profile, with constant errors that never echo input. Call it only after discovery; it does not discover or validate stream availability itself. Hashes are correlation fingerprints, not encryption; avoid publishing payloads unnecessarily. Never persist raw discovery responses or credential-bearing URLs.

New contract payloads have no free-form diagnostic fields or generic details. Service validation rejects unknown fields; the application's existing HTTP whitelist may strip unknown fields before service validation. Neither path persists those fields. Legacy generic telemetry behavior is unchanged; callers must not send raw stream information through its details field.

The existing ledger enum names are retained:

- E4_STREAM_URI_OBTAINED → E4_STREAM_URI_OBTAINED
- E5_RTSP_SESSION_NEGOTIATED → E5_SESSION_NEGOTIATED
- E6_FRAMES_RECEIVED → E6_MEDIA_RECEIVED

Only SUCCEEDED observations use those ledger levels. Other results use E0_UNKNOWN and retain the attempted level in the typed payload, so level queries cannot mistake a failed attempt for attainment. Results remain distinct: UNKNOWN/UNKNOWN, NOT_OBSERVED/NOT_ATTEMPTED, UNSUPPORTED/CAPABILITY_UNAVAILABLE, FAILED with AUTHENTICATION_FAILED, UNREACHABLE, TIMEOUT or PROTOCOL_ERROR. SUCCEEDED requires reason NONE. Failed/nonobserved attempts cannot include positive negotiation/media proof. An absent row means no observation; it does not imply success or failure.

STALE is derived at read time from expiresAt independently of the observed result; it is not a submitted result and does not rewrite history. Idempotency uses the existing database unique sourceEventKey, scoped by observer, probe, target, attempted level and event UUID. Duplicate retries return accepted: 0 and cannot mutate the first observation. A new attempt needs a new event UUID. This endpoint writes only the ledger; it does not refresh heartbeat/runtime, mutate snapshots or evaluate outage incidents.

## NVR-mediated measurements (contract adjustment)

The first real E5/E6 measurements were obtained through the Speco N8NRL itself: the recorder's RTSP service, with a URI copied by the operator from the recorder UI. That does not match the original E5 wording ("for that discovered stream") and must not be forced into it. The contract was adjusted explicitly instead:

- `endpoint.discoveryMethod = MANUAL_OPERATOR_INPUT` means the URI was **not discovered**. Such rows can never be E4 (rejected), and `profileSha256` is omitted because no profile was discovered. Discovered endpoints still require it.
- `endpoint.access = NVR_MEDIATED` means the recorder served the stream. It is required with MANUAL_OPERATOR_INPUT (and only accepted with it in this version), requires `source = ADAPTER` (a recorder observer), an explicit `channelNumber` and an `attemptId`. It is never a direct camera observation: observerDeviceId is the recorder, the target is the camera it reports on that channel.
- `attemptId` (UUID) groups the E5 and E6 rows of one probe run. Each row still has its own `sourceEventKey`.
- Ingestion additionally requires the recorder's own latest channel report (`recorder_observation_snapshots`, written by the Speco adapter from the recorder's channel list) to place the target camera on `endpoint.channelNumber` for this recorder. A channel number is only ever cross-checked; the target identity is always the explicit `deviceId` from `speco.local.json`.

Meaning is unchanged otherwise. E5 = DESCRIBE/SETUP/PLAY 200 in one session through the recorder. E6 = the same plus ≥ 1 video RTP packet for the selected track, reported as `RTP_VIDEO_PACKETS` with count and window; **not decoded frames** (`decodedFrames = NOT_MEASURED`) and never recording or retrieval proof. Rows expire 60 s after observation.

Each run sends exactly two rows: E5 (SUCCEEDED, or FAILED/UNSUPPORTED with reason) and E6 (SUCCEEDED, FAILED, or NOT_OBSERVED/NOT_ATTEMPTED when negotiation failed). Positive proof is only attached to SUCCEEDED rows.

### Periodic execution

`apps/gateway/stream_scheduler.py` runs these checks periodically (see `apps/gateway/STREAM_PROBE.md`, "Periodic executor"). Validity stays a per-observation property (`evidenceValiditySeconds`, at most 120 s by contract) and must be `<= intervalSeconds`, so a missed sample becomes visible as expired instead of being bridged. Resends reuse the original row bytes; the unique `sourceEventKey` makes them idempotent and old rows are never renewed. Sampling does not prove continuous availability.

### Read model and UI

`GET /api/v1/devices/:id/stream-measurement` (organization-scoped like the other device routes) projects the latest attempt: `state` is `NO_MEASUREMENT` (no row ever), `SUCCEEDED`, `FAILED` (the first non-succeeded stage decides result/reason), `INCOMPLETE` (an NVR-mediated attempt whose E5 or E6 row has not reached the ledger yet, e.g. partial delivery; never shown as success) or `EXPIRED` (validity passed; the original result is still shown, with `complete=false` if it was partial). It returns provenance (source, observer recorder, access, URI source, channel), negotiation and media outcomes, packet count/window, `observedAt` and `expiresAt`, but no host, hashes or raw payload. The device details panel shows it as a separate "Stream measurement" section for cameras; it does not change connectivity, health, heartbeat or incidents.

## Verification

From the repository root:

```bash
pnpm run check
pnpm run test:integration
python3 -m unittest discover -s apps/gateway/tests -p 'test_stream_evidence.py' -v
pnpm --filter api exec jest --runInBand stream-evidence device-evidence
git diff --check
```

The integration suite requires Docker and uses the dedicated `psop_test` database. Unit test data is synthetic test-only input; no demo evidence is ingested into a running lab.

With existing ignored local Speco configuration and the API running, check the real core collection and ingestion (password is prompted securely if not supplied by the existing runtime environment):

```bash
python3 apps/gateway/speco_n8nrl.py --diagnose
python3 apps/gateway/speco_n8nrl.py --once
```

These commands verify existing core/E1/E3 behavior only. The real NVR-mediated E5/E6 procedure is in `apps/gateway/STREAM_PROBE.md` ("NVR-mediated check"). For direct discovery, once the discovery method, reachable stream access and camera/profile mapping are confirmed, implement an isolated optional Edge Witness collector against this contract, then test successful discovery/negotiation/media, wrong credentials, blocked stream, missing capability and expiry with the real N8NRL/Hikvision setup. Never submit test fixture claims to represent real lab observations.
