# Two-minute bar calibration

Open:

```text
http://YOUR_DASHBOARD:8080/fleet?guide=calibrate
```

The guided flow records:

1. Empty customer area
2. Near-left
3. Near-center
4. Near-right
5. Far-left
6. Far-center
7. Far-right

Each capture targets 15 seconds and 300 CSI frames. The six occupied points use normalized room coordinates, so the operator does not need to measure the room or type X/Y values.

After the seventh capture, the dashboard automatically trains and loads a coarse position model using 48-frame windows with a 16-frame step.

## Placement

Place four receivers around the bar-facing customer area, spread across both width and depth. Do not cluster all receivers behind the taps. Different heights and corners generally provide more distinct RF paths than a straight row.

## Fast validation

Walk through all six positions after training. The map circle should move to the corresponding zone and disappear when the customer area is empty.

When two zones are repeatedly confused:

- move one receiver farther from the others
- vary receiver height
- keep furniture and transmitter placement fixed
- run a second calibration pass on another day
- use a different person for the second pass

The second independent pass typically adds more value than making the first pass much longer because it captures environmental and subject variation.

This workflow produces a coarse six-zone position estimate. It is not validated continuous RFV2 XY tracking.
