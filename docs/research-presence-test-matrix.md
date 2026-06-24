# Presence pipeline test matrix

| Gate | Coverage |
| --- | --- |
| Node unit and integration | CSI parsing, per-node isolation, stationary presence, quality-weighted fusion, stale-node exclusion, UDP ingest, replay parity |
| Deterministic smoke | Empty baseline, stationary entry, stationary hold, movement, empty confirmation |
| Firmware host | Protocol, packet integrity, boot identity, and host-side firmware behavior |
| Python analysis | Feature extraction and research tooling |
| Browser E2E | Desktop and mobile control-center behavior |
| ESP-IDF | Pinned ESP-IDF 5.3.2 firmware build |

All gates must pass in GitHub Actions before merge.
