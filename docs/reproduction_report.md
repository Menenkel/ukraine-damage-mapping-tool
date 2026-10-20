# Reproduction report: Dietrich et al. 2025 in the GEE Code Editor

Script: `gee/ukraine_damage_ghs_obat.js` (STEP `FEATURES` → `TRAIN` → `EVAL` → `METRICS`), run 2026-10-20.

Setup: Sentinel-1A IW GRD VV+VH, reference 2020-02-24..2021-02-23, 3-month windows; 28 features
(7 reducers × 2 bands × ref/new); RF 50 trees, minLeafPopulation 3, maxNodes 10000, seed 0.
Train: UKR1–4 (Mariupol, NW Kyiv, Rubizhne, Volnovakha), windows T1–T8, valid orbits per AOI.
Test: UKR5–18, windows T1–T4 (negatives) and 2022 windows T5–T8 (positives if window end > UNOSAT date),
dense prediction averaged over orbits, 3×3 max around each label.

| Metric | Paper | This run |
|---|---|---|
| Threshold for 90 % precision | 0.655 | 0.618 |
| Recall @ 0.655 | 46.5 % | ≈ 49.5 % (precision ≈ 92.7 %) |
| F1 @ 0.5 | 74.9 % | 79.2 % (P 73.9 %, R 85.4 %) |
| AUC as in repo (binary preds @ 0.5) | 81.3 % | ≈ 80.9 % |
| ROC AUC (threshold-free) | – | 88.7 % |

Test rows: 13,793 (6,049 positive, 7,744 negative = 4 pre-invasion windows × 1,936 test points).

Assessment: no material deviation. Slightly higher scores and the lower 90 %-precision threshold are
consistent with the 3×3 max evaluation (which raises probabilities; the repo scores single points).
Threshold 0.655 is kept for comparability with the paper (≈ 93 % precision here); 0.55 and 0.75
are run as sensitivity cases.

Known deviations from the repo: evaluation uses dense 3×3 max and the "window end > UNOSAT date" rule
(repo: point features, "window start ≥ UNOSAT date"); the RF is re-trained from the saved training
table in each step because a classifier loaded from a GEE asset cannot output probabilities.
