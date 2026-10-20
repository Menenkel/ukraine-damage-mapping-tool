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

## Rolling 12-month reference (re-run, T01–T21)

| @0.655 | pre | T05 | T06 | T07–T21 mean / quarter | UNOSAT recall by T06 | UNOSAT share of T05 detections |
|---|---|---|---|---|---|---|
| fixed | 106 | 258 | 135 | 98.1 | 30.4 % | 45.0 % |
| rolling | 46 | 231 | 41 | 11.5 | 27.0 % | 55.8 % |

- Raw exceedance @0.655 after 2022 falls from 1–2 % (fixed) to 0.02–0.06 % (rolling), the pre-war T01 level: drift removed.
- The siege peak is kept (231 vs 258 buildings) with slightly lower recall and higher precision.
- Late detections are no longer clustered with noise across the city (172 T07+ detections vs 1,471).
- **Remaining artefact: winter quarters.** T20 (Nov 2025–Feb 2026) has 43 detections; mean probability rises for the whole
  city (0.40 vs ≈0.35; smaller rises in T08 and T12), detections are scattered (median nearest neighbour 563 m) and fall
  back in T21. Consistent with snow/frozen-ground backscatter changes, not strikes.
- Building-level recall vs UNOSAT stays low (≈27 % by T06): counts are lower bounds.
