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

## Kharkiv building table (per-window exceedance @0.655, corrected probabilities)

| per 10,000 buildings per window | pre-war (T01–T04) | T05 | T06 | 2023–25 (T09–T19) | T20 |
|---|---|---|---|---|---|
| Kharkiv | 29.6 | 33.5 | 33.7 | 19.2 | 47.5 |
| Uzhhorod | 4.9 | 5.1 | 7.7 | 8.1 | 5.1 |
| Chernihiv (pilot) | 4.2 | 70.7 | 29.0 | 3.9 | 14.9 |

- **Signal is real at damaged buildings**: 193 Kharkiv buildings matched to UNOSAT points (2022) have mean probability
  0.53 in T05 vs 0.34 for all other buildings; 22 % of them exceed 0.655 in T05 vs 0.3 % of other buildings.
- **But city-wide counts in Kharkiv sit at the noise floor**: T05 is only 1.1× the pre-war rate (Chernihiv: 17×).
  Kharkiv's 2022 damage was dispersed across a large stock, and its pre-war noise is 6–7× that of Uzhhorod and
  Chernihiv (cause not yet identified; not building size or use).
- **Spatial clustering separates strikes from noise**: T05 detections are clustered (median nearest neighbour 151 m vs
  370 m for random buildings); T14, T19, T21 are not (≈ random). T20 is clustered (182 m vs 285 m) — possibly real
  winter 2025–26 strikes, not verified.
- **Cluster rule** (≥ 2 other flagged buildings within 200 m in the same window): Kharkiv T05/pre-war 1.1× → 2.3×,
  Chernihiv 17× → 62×, at the cost of recall (UNOSAT buildings flagged in T05–T06: Kharkiv 29 % → 18 %,
  Chernihiv 27 % → 17 %).

Implication: per-hromada counts must be reported as excess over the hromada's own pre-war false-positive rate, with
a significance test; raw counts are only meaningful where destruction is concentrated.
