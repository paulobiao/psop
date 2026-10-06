# Speco watcher: delivery outage recovery

## Exit path and runtime selection

`PsopRecorderApiClient._post()` turned connection refusal/timeout into
`SpecoError`; `run_psop_once()` propagated it. In the selected lab runtime,
`watch_tick()` and `run_watch_loop()` did not catch delivery errors (the loop
caught only `KeyboardInterrupt`). The exception reached `main()`'s outer
one-shot delivery handler, which printed `DELIVERY_ERROR`, returned 7, and
terminated through `SystemExit(main())`. Other delivery exceptions could
terminate with an uncaught traceback instead.

`start.sh` launches the explicitly selected runtime through `spawn()` and
`spawn.py`, which redirects logs, creates a session, and execs Python. These
helpers do not supervise or restart an exited watcher. `status.sh` checks
process identity; a missing process does not prove the recorder is unreachable.

At diagnosis, the selected runtime was the sibling `psop-runtime/apps/gateway`.
This checkout lacked its reachability, startup retry, relogin, and config-dir
support. Those existing runtime behaviors and their tests were brought into
this checkout before applying the delivery fix. The sibling runtime and local
runtime selection were not changed. Existing E4–E6 files were preserved.

## Retry behavior

The watch delivery boundary catches ordinary delivery exceptions and returns
`delivery=DELIVERY_ERROR` while keeping the current collection unchanged.
Known API errors use fixed reason codes; response bodies, URLs, and arbitrary
exception text are not logged. Unknown exceptions use `PSOP_DELIVERY_EXCEPTION`.

There is one delivery attempt per fresh collection cycle, followed by the
normal interval (default 30 seconds, minimum 5). Request timeouts still apply.
There is no immediate replay or tight retry loop, and no extra outage backoff
to delay recovery. A failed POST has ambiguous acceptance, so failed-cycle
counts are reported as `children=unknown`; successful earlier POSTs are not
claimed to have been rolled back. Delivery failures do not trigger recorder
relogin. Recorder unreachability still permits one relogin per cycle and
recollection after `RELOGIN_OK`.

A failed delivery creates no offline observation. Previously received API
evidence may still age out under normal freshness rules during a long outage.
One-shot delivery continues to fail on API errors. Ctrl+C still stops watch.

## Safe reproduction without touching the lab

From the repository root:

```sh
python3 -m unittest discover -s apps/gateway/tests -p 'test_speco_delivery_recovery.py' -v
```

This simulates refusal, timeout, HTTP 500, arbitrary delivery exceptions,
partial delivery, and later recovery. A subprocess test enters `main --watch`,
checks that its PID survives a refused connection, advances the wait boundary,
and checks successful delivery with the same live process. Recorder/API I/O
and credentials are fake; no lab configuration is loaded or modified.

## Optional real lab check during a maintenance window

The fix is in this working tree only. `pnpm lab:start` still selects the
external runtime and will not deploy these uncommitted changes. Its clean
runtime guard remains intact. To test the working tree manually:

1. Run `pnpm lab:stop` to stop managed lab processes (Postgres stays running).
   Check its output for unmanaged watchers and stop any such watcher in its
   owning terminal before proceeding; avoid duplicate recorder watchers.
2. In terminal A, from this repository, start just the API:
   `LOCAL_TELEMETRY_INGESTION_ENABLED=true pnpm --filter api start:dev`.
3. In terminal B, from this repository, run
   `python3 apps/gateway/speco_n8nrl.py --watch --interval 30`.
   This uses the existing local configuration and prompts for the recorder
   password without echo. If config is elsewhere, set `PSOP_SPECO_CONFIG_DIR`
   to that existing directory. Never pass secrets on the command line.
4. After a `delivery=DELIVERED` cycle, Ctrl+C terminal A only. Verify the API
   listener stopped. Keep terminal B running. Its next cycle should show
   `collection=PASSED reachable=True ... delivery=DELIVERY_ERROR`
   and `reason=PSOP_API_UNAVAILABLE retryIn=30s` if the recorder is reachable.
5. Restart the same API command in A. After API readiness and the next watch
   cycle, B should report `delivery=DELIVERED` without a watcher restart.
6. Ctrl+C both foreground commands when finished. `pnpm lab:start` restores
   the normal manually managed lab, still using its previously selected
   external runtime until that runtime is separately updated.

No launchd or other OS service is installed. This procedure intentionally
interrupts local telemetry; use the isolated regression above if the live lab
must remain uninterrupted.
