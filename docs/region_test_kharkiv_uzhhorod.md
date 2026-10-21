# Region test: Kharkiv city vs Uzhhorod (placebo), rolling reference + winter correction

Kharkivska hromada (UA6312027, 115,802 buildings > 50 m²) and Uzhhorodska hromada (UA2110023, 15,658), T01–T21.
Rates are newly flagged buildings per 10,000 per quarter (first detection, background-corrected).

| @0.655 | pre-flagged (T01–T04, any) | T05 | T06 | T07–T21 mean | T20 |
|---|---|---|---|---|---|
| Kharkiv | 100.1 | 28.0 | 23.6 | 16.6 | 41.3 |
| Uzhhorod (placebo) | 17.9 | 4.5 | 6.4 | 6.1 | 3.2 |

Findings
- **Placebo passes**: Uzhhorod stays at ≈6 per 10,000 per quarter from 2022 to 2026 with no upward trend; its
  pre-invasion windows give ≈5 per 10,000 per window (7, 6, 13, 5 buildings). Rolling reference + background
  correction remove drift.
- **Kharkiv is noisier even before the invasion**: 1.0 % of buildings flagged in T01–T04 vs 0.18 % in Uzhhorod.
  The urban fabric (large blocks, industry, construction) raises the noise floor, so Uzhhorod is not a sufficient
  noise baseline for Kharkiv.
- Kharkiv shows its highest rates in T05–T06 (2022 offensive) and a spike in T20 (Nov 2025–Feb 2026) that the
  background correction did not remove, unlike in Uzhhorod and Chernihiv.
- Open: per-window raw exceedance for Kharkiv before vs after the invasion, and a building-level check against the
  UNOSAT Kharkiv points (UKR7), need the Kharkiv building table.
