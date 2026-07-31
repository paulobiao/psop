# Device Provisioning and Gateway Mapping

PSOP supports three monitoring modes:

- `DIRECT`: the equipment authenticates and sends its own telemetry.
- `VIA_GATEWAY`: the equipment is registered as an individual asset but is monitored through a directly connected gateway or recorder.
- `INVENTORY_ONLY`: the equipment is documented without live telemetry.

Gateway assignments are tenant- and site-scoped. A selected gateway must:

- belong to the same organization;
- belong to the same site;
- be a `GATEWAY` or `RECORDER`;
- use direct monitoring;
- remain active in inventory while dependent devices are assigned.

Telemetry credentials are available only for directly monitored cameras, recorders and gateways.

For closed ecosystems such as the Lorex Home Center, PSOP can represent the Home Center as a directly monitored gateway and represent each paired camera separately with `VIA_GATEWAY`. The camera record remains honest: the gateway's reachability does not automatically prove the individual camera is streaming or recording.
