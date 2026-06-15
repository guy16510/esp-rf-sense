# Hardware and placement

The physical setup is part of the measurement. CSI from a single TX/RX link is extremely
sensitive to geometry, so placement must be **recorded** (in the experiment metadata) and **kept
constant** within a comparison — otherwise you are measuring the furniture rearrangement, not the
person.

## Bill of materials

| Item | Notes |
|---|---|
| ESP32-S3-WROOM-1-N4R8 dev board | 4 MB flash, 8 MB octal PSRAM (the pinned target) |
| Existing 2.4 GHz router/AP | the transmitter; unmodified, not flashed by us |
| LAN host | runs the collector / OTA server / experiment runner |
| USB cable | used **once** for the bootstrap flash, then unplugged |
| Stable USB power supply | for headless operation after bootstrap |

The receiver must be on the **2.4 GHz** band with the router, on a fixed channel; ESP32-S3 CSI
is a 2.4 GHz Wi-Fi feature here.

## Placement geometry

```
   router (TX)  ─────────  link line  ─────────  ESP32-S3 (RX)
                              │
                     subject crosses / stands
                        near the link line
```

- **Line-of-sight link.** Put the device where it has a clean, fixed line to the router. The
  body's effect is strongest when it perturbs the dominant path(s) between TX and RX.
- **Subject between/near the link.** People-induced changes are largest when the body is on or
  near the TX–RX line. A subject far off-axis perturbs the channel much less.
- **Fixed height and orientation.** Mount the device at a fixed height (e.g. desk or shelf
  level) and orientation. Antenna orientation matters; do not move it between baseline and
  occupied runs.
- **Record TX/RX positions.** The metadata `link.txPosition` / `link.rxPosition` and the
  subject `position` (label + optional metric x/y/z from a fixed origin) make a session
  reproducible.

## Controlling confounders

Within a single comparison (e.g. empty vs. occupied in room A on one day), hold everything except
the subject constant:

- Don't move the router, the device, furniture, doors, or large reflectors between runs.
- Avoid other people walking through the link during a recording unless that is the variable.
- Keep the Wi-Fi channel fixed; channel changes alter the CSI completely.
- Note environmental changes (windows/doors open, other 2.4 GHz activity) in `notes`.
- Record an **empty baseline close in time** to the occupied runs — multipath drifts over hours.

## Power and endurance

For 24-hour capture/streaming runs, use a reliable supply and a stable mount. The device runs
headless after bootstrap; you interact with it over the LAN (`device:status`, collector,
experiment runner). Endurance numbers (sustained CSI rate, memory/stack stability over 24 h,
≥20 sequential OTA cycles) are properties of **your** hardware and environment and must be
measured there — see [known-limitations.md](known-limitations.md).

## A practical placement checklist

1. Router and device on the same 2.4 GHz network, fixed channel, line-of-sight.
2. Device mounted at a fixed height/orientation; cable removed after bootstrap.
3. Mark subject positions on the floor (tape) so they are repeatable across people and days.
4. Record TX/RX positions and subject positions in the experiment metadata.
5. Capture an `empty-baseline` first, then the occupied conditions, without moving anything else.
6. Repeat on multiple days and with multiple people before claiming anything generalizes.
