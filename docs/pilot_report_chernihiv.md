# Phase 2 pilot: Chernihiv (UKR6), fixed 2020 reference

32,794 GHS-OBAT buildings > 50 m² (centroids buffered to equal-area circles), 22 quarterly windows.

## Findings
- **T22 (2026-05-24..08-23) has no data**: every building has P_T22 = -1 (no Sentinel-1A orbit with >= 5 images).
- **Drift is visible already before the invasion**: raw exceedance @0.655 rises T01 0.06 % → T04 0.23 % with no war damage,
  i.e. ~0.06 pp per quarter of distance from the 2020 reference. After 2022 it keeps rising at a similar slope
  (≈1.0 % in T06–T08 → ≈2.0 % in T18–T20). Late "new damage" in Chernihiv is consistent with drift, not new strikes.
- **Building-level recall vs UNOSAT** (640 points dated 2022-04-28, 519 matched to a building within 20 m):
  30 % detected by T06 and 52 % at any time @0.655; 1,357 of 1,864 flagged buildings are non-UNOSAT detections from T07 on.
- **Persistence rule (k consecutive quarters) is not a fix**: k=2 halves late detections (≈100 → ≈50/quarter) but also cuts
  UNOSAT recall from 52 % to 34 %; the T05-peak-to-background ratio improves only from ≈2.6 to ≈3.

| threshold / k | pre | T05 | T06–T21 mean per quarter | UNOSAT recall by T06 |
|---|---|---|---|---|
| 0.55 / 1 | 655 | 953 | 417 | 65.5 % |
| 0.655 / 1 | 106 | 258 | 100 | 30.4 % |
| 0.655 / 2 | 63 | 151 | 49 | 18.9 % |
| 0.75 / 1 | 30 | 72 | 26 | 11.4 % |

## Implication
With a fixed 2020 reference, quarterly counts after 2022 mostly measure distance from the reference.
Proposed: rolling reference (the 12 months before each window) so each quarter is compared with its own recent past,
which matches "newly damaged" directly and keeps the false-positive rate at the T01 level.
