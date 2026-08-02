# Gateway Runtime Reliability

The PSOP Edge Gateway can run as a macOS user LaunchAgent instead of requiring an open terminal.

## Runtime model

- The service starts automatically when the macOS user signs in.
- `launchd` restarts the process after an unexpected non-zero exit.
- The device secret stays in `apps/gateway/.env.local`.
- The generated plist contains no PSOP device key.
- Local configuration, logs and the SQLite pending buffer remain ignored by Git.
- If the PSOP API is unavailable, the gateway remains active and keeps the latest eligible heartbeat in the SQLite buffer.
- When the API returns, the buffered heartbeat is flushed before normal delivery resumes.
- If the monitored target is offline, the gateway withholds a fresh heartbeat so PSOP can apply its normal heartbeat-expiration policy.

## Commands

```bash
python3 apps/gateway/install_macos_service.py doctor
python3 apps/gateway/install_macos_service.py install
python3 apps/gateway/install_macos_service.py status
python3 apps/gateway/install_macos_service.py restart
python3 apps/gateway/install_macos_service.py logs --lines 80
python3 apps/gateway/install_macos_service.py logs --follow
python3 apps/gateway/install_macos_service.py stop
python3 apps/gateway/install_macos_service.py uninstall
```

## Local files

- `apps/gateway/gateway.local.json`
- `apps/gateway/.env.local`
- `apps/gateway/state/pending.db`
- `apps/gateway/state/gateway.stdout.log`
- `apps/gateway/state/gateway.stderr.log`

These files are local runtime data and must not be committed.

## Limitation

This LaunchAgent runs in the signed-in macOS user session. It does not run before user login. The PSOP API is a separate process; while the API is offline, gateway delivery is buffered rather than lost.
