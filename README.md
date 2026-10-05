# PSOP — Physical Security Observability Platform

PSOP is an operational observability platform under development for physical security infrastructure.

It combines device telemetry with time-bounded evidence to show what was observed, through which access path, and how recently.

The initial implementation focuses on cameras and network video recorders. The long-term direction is a vendor-neutral platform for heterogeneous physical infrastructure.

## Why PSOP

A reachable device does not necessarily provide usable video. A live stream does not prove that recordings exist.

PSOP distinguishes:

- Device and recorder connectivity.
- Recorder-reported channel state.
- RTSP session negotiation.
- Video RTP packets received during a bounded measurement window.
- Evidence provenance, completeness and expiration.

## Current implementation

- React dashboard with device details and stream measurements.
- NestJS API and PostgreSQL-backed operational evidence ledger.
- Python gateways and stream probes.
- Direct-camera ONVIF/RTSP checks with identity and endpoint validation.
- NVR-mediated RTSP checks with explicit channel bindings.
- Evidence ingestion and separate presentation of connectivity and stream results.
- Speco watcher recovery across supported recorder and API outage scenarios.

A periodic stream scheduler is under active development and further validation.

## Architecture

| Component | Technology | Responsibility |
| --- | --- | --- |
| Dashboard | React, TypeScript, Vite | Device details and evidence presentation |
| API | NestJS, TypeScript | Device operations, ingestion and evidence queries |
| Database | PostgreSQL, Prisma | Device data and operational evidence |
| Gateways | Python | Device communication and bounded measurements |
| Workspace | pnpm, Turborepo | Dependencies and development tasks |

## Repository structure

- `apps/api/`: backend, Prisma schema and API tests.
- `apps/dashboard/`: web dashboard.
- `apps/gateway/`: gateways, stream probes and experimental scheduler.
- `docs/`: architecture and operational documentation.
- `infra/`: infrastructure configuration.
- `scripts/`: development, lab and verification scripts.

## Development prerequisites

- Node.js 22.x.
- pnpm 11.15.0.
- Python 3 for gateway tools and tests.
- Docker for the documented local PostgreSQL setup.
- Local application configuration and authorized credentials for hardware access.

Install workspace dependencies from the repository root with `pnpm install --frozen-lockfile`.

Configure the database and application environment before starting services. See the [lab runtime guide](docs/LAB_RUNTIME.md) and [gateway guide](apps/gateway/README.md).

## Local lab commands

The lab scripts support the project's macOS development environment.

| Command | Purpose |
| --- | --- |
| `pnpm run lab:start` | Start configured lab services |
| `pnpm run lab:status` | Inspect service status |
| `pnpm run lab:stop` | Stop managed lab processes |

These scripts are development tooling, not a production service supervisor.

## Verification

| Command | Purpose |
| --- | --- |
| `pnpm run test:gateway` | Gateway and probe tests |
| `pnpm test` | API unit tests |
| `pnpm --filter api build` | API compilation |
| `pnpm --filter dashboard typecheck` | Dashboard type checking |
| `pnpm --filter dashboard build` | Dashboard production build |
| `pnpm run check` | Combined Prisma, tests and build checks |

Integration tests require a separate environment. Review `scripts/test-security-integration.sh` before running `pnpm run test:integration`.

## Evidence boundaries

- Reachability does not establish video availability.
- Recorder-reported channel state does not independently verify camera identity.
- Successful RTSP negotiation does not establish receipt of video.
- Received video RTP packets do not establish decoded frames, image quality or recording.
- Expired evidence means an observation is no longer current; it does not establish a new device failure.

Current stream checks count video RTP packets without storing video or counting decoded frames.

NVR-mediated checks declare their recorder access path and operator-supplied URI. They do not claim direct-camera ONVIF discovery.

## Validation status

Real lab checks demonstrated RTSP negotiation and video RTP packet reception through a Speco recorder for three connected Hikvision channels. Evidence delivery to the API was also demonstrated for one channel.

These results apply to the tested setup. They do not establish broad manufacturer compatibility, production readiness or continuous availability.

Current limitations:

- Direct-camera probes require network access to the camera.
- Periodic sampling leaves unobserved time between checks.
- The experimental scheduler requires further authentication-suspension and long-running recovery validation.
- Its pending delivery queue is memory-based, not a durable offline store.
- Recording verification and decoded-frame measurement are not implemented by the current stream checks.
- Production supervision and deployment-scale validation remain future work.

## Configuration and credentials

Keep real credentials and machine-specific configuration in ignored local files or the documented credential mechanisms.

Do not commit passwords, API keys, authenticated stream URLs or local runtime state. Configuration examples must use placeholders.

## Roadmap

- Validate periodic measurements and recovery over longer sessions.
- Expand multi-channel and multi-recorder validation.
- Improve asset management and identity provenance.
- Develop operational topology and dependency-aware incident analysis.
- Extend integrations through documented vendor adapters.
- Establish production deployment, supervision and operational benchmarks.

These are planned milestones, not guaranteed current capabilities.

## Documentation

- [Gateway guide](apps/gateway/README.md)
- [Stream probes and scheduler](apps/gateway/STREAM_PROBE.md)
- [Video assurance foundation](docs/VIDEO_ASSURANCE_FOUNDATION.md)
- [Local lab runtime](docs/LAB_RUNTIME.md)
- [Speco delivery recovery](docs/SPECO_DELIVERY_RECOVERY.md)

## Project status

Active development. PSOP contains an evolving implementation and lab tooling. Production readiness has not yet been established.

License metadata differs between workspace packages; a unified project licensing policy remains to be clarified.
