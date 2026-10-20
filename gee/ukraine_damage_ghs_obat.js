/*******************************************************************************
 * Ukraine building-level war damage — Sentinel-1 + GHS-OBAT (GEE Code Editor)
 *
 * Re-implementation and extension of:
 *   Dietrich et al. 2025, "An open-source tool for mapping war destruction at
 *   scale in Ukraine using Sentinel-1 time series", Commun. Earth Environ. 6:215
 *   https://doi.org/10.1038/s43247-025-02183-7
 *   Code: https://github.com/prs-eth/ukraine-damage-mapping-tool (MIT)
 *
 * Extensions: GHS-OBAT footprints (JRC, CC BY 4.0), quarterly windows up to
 * CFG.END_DATE, first-detection of newly damaged buildings, hromada x quarter
 * tables, threshold sensitivity, western-oblast placebo / drift check.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP
 *   1. Upload gee/unosat_labels_destroyed_severe.csv (from the repo) as a table
 *      asset (Assets > New > CSV; longitude/latitude columns are detected).
 *      -> set CFG.LABELS. Expect 10,934 points.
 *   2. Upload hromada (adm3) boundaries, e.g. OCHA COD-AB ukr_admbnda_adm3
 *      shapefile -> set CFG.HROMADAS and the *_FIELD names below.
 *   3. Create the asset folder CFG.ROOT (Assets > New > Folder).
 *
 * RUN ORDER  (set CFG.STEP, press Run, then click "Run" on each task in the
 *             Tasks tab; re-running a step skips outputs that already exist)
 *   CHECK      verify assets + schemas, print windows and S1 image counts
 *   FEATURES   export training features (train AOIs, windows T1..T8)  [1 task]
 *   TRAIN      train RF, export classifier asset                     [1 task]
 *   EVAL       dense predictions on 14 test AOIs, 3x3 max at labels  [1 task]
 *   METRICS    F1 / AUC / precision / recall / 90%-precision thresh. [interactive]
 *   -- Phase 1 sanity check: compare to paper before continuing --
 *   BUILDINGS  (SCOPE 'PILOT')  Chernihiv buildings, on-the-fly probs [1 task]
 *   HROMADA    (SCOPE 'PILOT')  hromada x quarter table               [1 task]
 *   MAP        (SCOPE 'PILOT')  probability + first-detection maps   [interactive]
 *   -- Phase 2 review --
 *   PROB       (SCOPE 'COUNTRY') UInt8 probability rasters per window [1 task/window/tile]
 *   BUILDINGS  (SCOPE 'COUNTRY') per-oblast building tables           [1 task/oblast]
 *   HROMADA    (SCOPE 'COUNTRY') hromada x quarter x threshold table  [1 task]
 *   PLACEBO    (SCOPE 'COUNTRY') western-oblast drift table          [1 task]
 *   TRENDS     national / oblast / top-hromada charts + placebo       [interactive]
 *
 * No getInfo() on large collections: everything big goes through exports.
 ******************************************************************************/

// =============================== CONFIG =====================================
var CFG = {
  STEP: 'CHECK',
  SCOPE: 'PILOT',                       // 'PILOT' (Chernihiv, UKR6) | 'COUNTRY'

  // --- Assets (EDIT) --------------------------------------------------------
  ROOT: 'projects/custom-graph-272808/assets/ukr_damage',
  LABELS: 'projects/custom-graph-272808/assets/ukr_damage/unosat_labels',
  FOOTPRINTS: 'projects/sat-io/open-datasets/JRC/GHS-OBAT/GHS_OBAT_GPKG_UKR_E2020_R2024A_V1_0',
  HROMADAS: 'projects/custom-graph-272808/assets/ukr_admin_boundaries',   // COD-AB adm3 (hromadas)
  HROMADA_ID_FIELD: 'adm3_pcode',       // COD-AB v05 field names (checked with STEP 'CHECK')
  HROMADA_NAME_FIELD: 'adm3_name',
  OBLAST_ID_FIELD: 'adm1_pcode',
  OBLAST_NAME_FIELD: 'adm1_name',

  // --- Table exports --------------------------------------------------------
  EXPORT: {type: 'drive', driveFolder: 'ukr_damage', bucket: 'YOUR_BUCKET', prefix: 'ukr_damage/'},

  // --- Dates ----------------------------------------------------------------
  REF_START: '2020-02-24',              // T0, inclusive
  REF_END: '2021-02-24',                // T0, exclusive (= 2021-02-23 inclusive)
  FIRST_WINDOW_START: '2021-02-24',     // T1 start; windows are consecutive 3 months
  END_DATE: '2026-08-23',               // last inclusive day; only complete windows are used
  WAR_START: '2022-02-24',

  // --- Sensor ---------------------------------------------------------------
  USE_S1C: false,                       // Sentinel-1A only, as in the paper. Validate before enabling.
  MIN_IMAGES_PER_ORBIT: 5,              // orbit used if >= N images in both T0 and Tk (repo default)

  // --- Training / evaluation ------------------------------------------------
  TRAIN_AOIS: ['UKR1', 'UKR2', 'UKR3', 'UKR4'],   // Mariupol, NW Kyiv, Rubizhne, Volnovakha
  TEST_AOIS: ['UKR5', 'UKR6', 'UKR7', 'UKR8', 'UKR9', 'UKR10', 'UKR11', 'UKR12',
              'UKR13', 'UKR14', 'UKR15', 'UKR16', 'UKR17', 'UKR18'],
  TRAIN_N_WINDOWS: 8,                   // T1..T8
  EVAL_N_WINDOWS: 8,                    // T1..T8 (repo); set 12 for T1..T12
  EVAL_FOCAL_MAX: true,                 // 3x3 max window around labels
  EVAL_POSITIVE_RULE: 'spec',           // 'spec': window end > UNOSAT date | 'repo': window start >= UNOSAT date
  EVAL_ONLY_2022_POS: true,             // repo: positives only from windows starting in 2022
  RF: {numberOfTrees: 50, minLeafPopulation: 3, maxNodes: 10000, seed: 0},

  // --- Buildings / first detection -----------------------------------------
  THRESHOLD: 0.655,                     // main threshold (paper: 90% precision)
  SENS_THRESHOLDS: [0.55, 0.655, 0.75],
  MIN_AREA_M2: 50,
  PILOT_AOI: 'UKR6',                    // Chernihiv (test AOI)
  PILOT_ON_THE_FLY: true,               // pilot: compute probs inside the building export (no rasters)
  // GHS-OBAT UKR is published as centroid points. Point footprints are replaced by an equal-area
  // circle (radius = sqrt(area / pi)) so the overlap-weighted mean covers the building's size.
  POINT_FOOTPRINT_TO_AREA_CIRCLE: true,

  // --- Rasters --------------------------------------------------------------
  CRS: 'EPSG:3035',                     // 10 m grid shared by raster export and footprint aggregation
  CRS_TRANSFORM: [10, 0, 0, 0, -10, 0],
  TILE_DEG: 0,                          // 0 = one task per window for all of Ukraine; >0 = grid tiles
  WINDOWS_TO_RUN: null,                 // e.g. ['T22'] to limit PROB exports; null = all
  TILE_SCALE: 4,                        // reduceRegions tileScale

  // --- Placebo / trends -----------------------------------------------------
  // Western oblasts far from the front (COD-AB adm1_pcode): Volynska, Zakarpatska, Ivano-Frankivska,
  // Lvivska, Rivnenska, Ternopilska, Chernivetska. Expect ~0 detections.
  PLACEBO_OBLAST_PCODES: ['UA07', 'UA21', 'UA26', 'UA46', 'UA56', 'UA61', 'UA73'],
  TOP_HROMADAS: 10
};

CFG.STEP = String(CFG.STEP).trim().toUpperCase();     // 'features' and 'Features' both work
CFG.SCOPE = String(CFG.SCOPE).trim().toUpperCase();

// =============================== CONSTANTS ==================================
var BANDS = ['VV', 'VH'];
var REDUCER_NAMES = ['mean', 'stdDev', 'median', 'min', 'max', 'skew', 'kurtosis'];

// Valid orbits per UNOSAT AOI (data/s1_aoi_orbits.csv; orbit 109 dropped for UKR8 as in the repo)
var AOI_ORBITS = {
  UKR1: [43, 94], UKR2: [36, 87, 160], UKR3: [21, 43, 94, 145], UKR4: [43, 94],
  UKR5: [43, 94], UKR6: [14, 36, 87, 138], UKR7: [43, 116], UKR8: [36, 87, 160],
  UKR9: [36, 87, 109, 160], UKR10: [65, 87, 138], UKR11: [21, 94, 145], UKR12: [65, 116],
  UKR13: [65, 116], UKR14: [43, 94, 167], UKR15: [65, 116], UKR16: [14, 65, 87, 138],
  UKR17: [14, 65, 138], UKR18: [14, 116, 167]
};

// Bounding boxes of the UNOSAT AOIs (data/unosat_aois.geojson) [W, S, E, N]
var AOI_BBOX = {
  UKR1: [37.4933, 47.0837, 37.6958, 47.1462], UKR2: [30.1409, 50.4756, 30.3249, 50.6124],
  UKR3: [38.3343, 48.8427, 38.5586, 49.0440], UKR4: [37.4404, 47.5714, 37.5231, 47.6227],
  UKR5: [37.6905, 48.1075, 37.7918, 48.1779], UKR6: [31.2182, 51.4399, 31.3851, 51.5537],
  UKR7: [36.1055, 49.8784, 36.4555, 50.1047], UKR8: [29.8692, 50.6259, 29.9729, 50.6649],
  UKR9: [29.7850, 50.4396, 29.8417, 50.4841], UKR10: [31.8921, 46.8033, 32.0656, 47.0479],
  UKR11: [39.2209, 48.7327, 39.2426, 48.7439], UKR12: [34.7236, 50.8773, 34.8540, 50.9533],
  UKR13: [34.9338, 50.4412, 35.0008, 50.5158], UKR14: [37.5012, 48.7158, 37.6130, 48.7811],
  UKR15: [34.8537, 50.2725, 34.9483, 50.3552], UKR16: [32.4937, 46.5983, 32.7403, 46.6979],
  UKR17: [33.3734, 48.9967, 33.5041, 49.1885], UKR18: [35.2900, 46.7908, 35.4339, 46.8898]
};

var UKRAINE = ee.FeatureCollection('USDOS/LSIB_SIMPLE/2017')
  .filter(ee.Filter.eq('country_na', 'Ukraine')).geometry();

// =========================== DATE WINDOWS ===================================
function addMonths(iso, m) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function pad2(i) { return (i < 10 ? '0' : '') + i; }

// Consecutive 3-month windows from FIRST_WINDOW_START; complete windows only.
function buildWindows() {
  var out = [];
  for (var k = 0; k < 400; k++) {
    var start = addMonths(CFG.FIRST_WINDOW_START, 3 * k);
    var endExcl = addMonths(CFG.FIRST_WINDOW_START, 3 * (k + 1));
    var endIncl = addDays(endExcl, -1);
    if (endIncl > CFG.END_DATE) break;
    out.push({name: 'T' + pad2(k + 1), index: k, start: start, endExcl: endExcl, endIncl: endIncl,
              pre: endIncl <= CFG.WAR_START});
  }
  return out;
}
var WINDOWS = buildWindows();
var WNAMES = WINDOWS.map(function(w) { return w.name; });
var PNAMES = WNAMES.map(function(n) { return 'P_' + n; });
var N_PRE = WINDOWS.filter(function(w) { return w.pre; }).length;   // T1..T4
var POST_WINDOWS = WINDOWS.filter(function(w) { return !w.pre; });

// Label rule (paper): y=0 if window end <= war start; y=1 if window end > UNOSAT
// acquisition date; otherwise discard. Returns 0, 1 or null. Mirrored server-side in labelledPoints().
function labelRule(windowEndIncl, unosatDate) {
  if (windowEndIncl <= CFG.WAR_START) return 0;
  if (windowEndIncl > unosatDate) return 1;
  return null;
}

// ============================== HELPERS =====================================
// Table assets cannot hold null geometries; summary rows get a dummy point (not exported to CSV).
var NO_GEOM = ee.Geometry.Point([0, 0]);
function tag(th) { return 't' + String(th).replace('.', ''); }       // 0.655 -> t0655
function scopeDir() { return CFG.ROOT + '/' + CFG.SCOPE.toLowerCase(); }
function bboxGeom(aoi) { var b = AOI_BBOX[aoi]; return ee.Geometry.Rectangle(b, null, false); }
function cleanDesc(s) { return s.replace(/[^A-Za-z0-9_,:;-]/g, '_').slice(0, 100); }

function log(msg, obj) {
  var line = '[' + new Date().toISOString() + '] [' + CFG.STEP + '/' + CFG.SCOPE + '] ' + msg;
  if (obj === undefined) print(line); else print(line, obj);
}

function assetExists(id) {
  try { return !!ee.data.getAsset(id); } catch (e) { return false; }
}
function requireAsset(id, what) {
  if (!id || !assetExists(id)) throw new Error('Missing asset for ' + what + ': ' + id);
}
function ensureFolder(path) {
  if (assetExists(path)) return;
  try { ee.data.createFolder(path); log('Created folder ' + path); }
  catch (e) { log('Could not create folder ' + path + ' (create it manually): ' + e); }
}
function ensureImageCollection(path) {
  if (assetExists(path)) return;
  try { ee.data.createAsset({type: 'IMAGE_COLLECTION'}, path); log('Created ImageCollection ' + path); }
  catch (e) { log('Could not create ImageCollection ' + path + ' (create it manually): ' + e); }
}
function childNames(parent) {
  try {
    var res = ee.data.listAssets(parent, {});
    return ((res && res.assets) || []).map(function(a) { return (a.id || a.name).split('/').pop(); });
  } catch (e) { return []; }
}
var RUNNING = (function() {
  var s = {};
  try {
    (ee.data.listOperations() || []).forEach(function(op) {
      var st = op.metadata && op.metadata.state;
      if (st === 'PENDING' || st === 'RUNNING') s[op.metadata.description] = true;
    });
  } catch (e) {}
  return s;
})();
// Idempotent submission: skip if output exists or a task with the same description is running.
function shouldSubmit(desc, existsCheck) {
  if (existsCheck) { log('SKIP (exists): ' + desc); return false; }
  if (RUNNING[desc]) { log('SKIP (running): ' + desc); return false; }
  log('SUBMIT: ' + desc);
  return true;
}

function exportTable(fc, name, selectors) {
  var desc = cleanDesc(name + '_csv');
  if (RUNNING[desc]) { log('SKIP (running): ' + desc); return; }
  var args = {collection: fc, description: desc, fileFormat: 'CSV', selectors: selectors};
  if (CFG.EXPORT.type === 'gcs') {
    args.bucket = CFG.EXPORT.bucket; args.fileNamePrefix = CFG.EXPORT.prefix + name;
    Export.table.toCloudStorage(args);
  } else {
    args.folder = CFG.EXPORT.driveFolder; args.fileNamePrefix = name;
    Export.table.toDrive(args);
  }
  log('SUBMIT: ' + desc);
}
function exportTableAsset(fc, assetId) {
  var desc = cleanDesc(assetId.split('/').slice(-2).join('_'));
  if (shouldSubmit(desc, assetExists(assetId))) {
    Export.table.toAsset({collection: fc, description: desc, assetId: assetId});
  }
}

// ============================ SENTINEL-1 ====================================
function s1Collection(region, start, end) {
  var platforms = CFG.USE_S1C ? ['A', 'C'] : ['A'];
  return ee.ImageCollection('COPERNICUS/S1_GRD')
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.inList('platform_number', platforms))
    .filterBounds(region)
    .filterDate(start, end)
    .select(BANDS);
}

var REDUCER = (function() {
  var factory = {
    mean: ee.Reducer.mean(), stdDev: ee.Reducer.stdDev(), median: ee.Reducer.median(),
    min: ee.Reducer.min(), max: ee.Reducer.max(), skew: ee.Reducer.skew(), kurtosis: ee.Reducer.kurtosis()
  };
  var r = factory[REDUCER_NAMES[0]];
  for (var i = 1; i < REDUCER_NAMES.length; i++) {
    r = r.combine({reducer2: factory[REDUCER_NAMES[i]], sharedInputs: true});
  }
  return r;
})();
var ORIG_NAMES = [];
BANDS.forEach(function(b) { REDUCER_NAMES.forEach(function(r) { ORIG_NAMES.push(b + '_' + r); }); });
function prefixed(period) {
  return ORIG_NAMES.map(function(n) { var p = n.split('_'); return p[0] + '_' + period + '_' + p[1]; });
}
var FEATURE_NAMES = prefixed('ref').concat(prefixed('new'));   // 28 features

// 28-band feature image for one orbit's collection and one window.
function featureImage(col, win) {
  var ref = col.filterDate(CFG.REF_START, CFG.REF_END).reduce(REDUCER).select(ORIG_NAMES, prefixed('ref'));
  var neu = col.filterDate(win.start, win.endExcl).reduce(REDUCER).select(ORIG_NAMES, prefixed('new'));
  return ref.addBands(neu);
}

// Orbits with >= MIN_IMAGES_PER_ORBIT images in both T0 and the window (repo: find_orbits).
function validOrbits(s1, win) {
  var ref = ee.Dictionary(s1.filterDate(CFG.REF_START, CFG.REF_END).aggregate_histogram('relativeOrbitNumber_start'));
  var neu = ee.Dictionary(s1.filterDate(win.start, win.endExcl).aggregate_histogram('relativeOrbitNumber_start'));
  return ref.keys().map(function(k) {
    var ok = ee.Number(ref.get(k)).gte(CFG.MIN_IMAGES_PER_ORBIT)
      .and(ee.Number(neu.get(k, 0)).gte(CFG.MIN_IMAGES_PER_ORBIT));
    return ee.Algorithms.If(ok, ee.Number.parse(k), null);
  }, true);
}

// Probability (0-1) for one window: each relative orbit separately, then per-pixel mean.
function predictWindow(region, win, clf) {
  var s1 = s1Collection(region, CFG.REF_START, win.endExcl);
  var orbits = validOrbits(s1, win);
  var preds = ee.ImageCollection.fromImages(orbits.map(function(o) {
    var col = s1.filter(ee.Filter.eq('relativeOrbitNumber_start', o));
    return featureImage(col, win).classify(clf, 'prob').toFloat();
  }));
  return ee.Image(ee.Algorithms.If(orbits.size().gt(0), preds.mean(),
    ee.Image.constant(0).toFloat().updateMask(0))).rename('prob');
}

// A classifier loaded from an asset only supports CLASSIFICATION output, so the RF is re-trained
// from the saved training table in each step. Same data + fixed seed -> same model.
function trainClassifier() {
  var id = CFG.ROOT + '/train_features';
  requireAsset(id, 'training features (run STEP FEATURES)');
  return ee.Classifier.smileRandomForest({
    numberOfTrees: CFG.RF.numberOfTrees, minLeafPopulation: CFG.RF.minLeafPopulation,
    maxNodes: CFG.RF.maxNodes, seed: CFG.RF.seed
  }).train({features: ee.FeatureCollection(id), classProperty: 'label', inputProperties: FEATURE_NAMES});
}
function loadClassifier() {
  return trainClassifier().setOutputMode('PROBABILITY');
}

// ============================== LABELS ======================================
function loadLabels() {
  return ee.FeatureCollection(CFG.LABELS)
    .filter(ee.Filter.inList('damage', [1, 2]))
    .map(function(f) { return f.set('date', ee.String(f.get('date')).slice(0, 10)); });
}

// Server-side mirror of labelRule(): returns labelled points for an AOI and window.
function labelledPoints(labels, aoi, win, positiveRule) {
  var pts = labels.filter(ee.Filter.eq('aoi', aoi));
  if (win.endIncl <= CFG.WAR_START) return pts.map(function(f) { return f.set('label', 0); });
  var posFilter = positiveRule === 'repo' ? ee.Filter.lte('date', win.start) : ee.Filter.lt('date', win.endIncl);
  return pts.filter(posFilter).map(function(f) { return f.set('label', 1); });
}

// ========================= FIRST DETECTION ==================================
// probs: ee.List of per-window building probabilities (0-1, -1 = no data).
// Returns 'pre' if flagged in any pre-invasion window, 'none' if never flagged,
// else the name of the first window with prob >= th (equality counts as flagged).
function firstDetection(probs, th) {
  var flags = probs.map(function(p) { return ee.Number(p).gte(th).toInt(); });
  var preFlag = N_PRE > 0 ? ee.Number(ee.List(flags.slice(0, N_PRE)).reduce(ee.Reducer.max())) : ee.Number(0);
  var idx = ee.Number(flags.indexOf(1));
  return ee.String(ee.Algorithms.If(preFlag.eq(1), 'pre',
    ee.Algorithms.If(idx.lt(0), 'none', ee.List(WNAMES).get(idx))));
}

// ========================== BUILDINGS ========================================
function footprints(region) {
  var fc = ee.FeatureCollection(CFG.FOOTPRINTS).filterBounds(region)
    .filter(ee.Filter.gt('area', CFG.MIN_AREA_M2));
  if (!CFG.POINT_FOOTPRINT_TO_AREA_CIRCLE) return fc;
  return fc.map(function(f) {
    var isPoint = ee.String(f.geometry().type()).equals('Point');
    var r = ee.Number(f.get('area')).divide(Math.PI).sqrt();
    return ee.Feature(ee.Algorithms.If(isPoint, f.setGeometry(f.geometry().buffer(r, 0.5)), f));
  });
}

// Stack of per-window probabilities scaled 0-255, bands P_T01..P_Tn.
function probStack(region) {
  if (CFG.SCOPE === 'PILOT' && CFG.PILOT_ON_THE_FLY) {
    var clf = loadClassifier();
    return ee.Image.cat(WINDOWS.map(function(w) {
      return predictWindow(region, w, clf).multiply(255).round().rename('P_' + w.name);
    }));
  }
  return ee.Image.cat(WINDOWS.map(function(w) {
    var ic = scopeDir() + '/prob_' + w.name;
    requireAsset(ic, 'probability raster ' + w.name + ' (run STEP PROB)');
    return ee.ImageCollection(ic).mosaic().rename('P_' + w.name);
  }));
}

var THRESH_TAGS = CFG.SENS_THRESHOLDS.map(tag);

// Overlap-weighted mean per footprint, per-quarter probs, first detection, centroid geometry.
function buildingTable(fp, stack) {
  var reduced = stack.reduceRegions({
    collection: fp, reducer: ee.Reducer.mean(), crs: CFG.CRS, crsTransform: CFG.CRS_TRANSFORM,
    tileScale: CFG.TILE_SCALE
  });
  return reduced.map(function(f) {
    var probs = ee.List(PNAMES.map(function(n) {
      var v = f.get(n);
      var raw = ee.Algorithms.If(ee.Algorithms.IsEqual(v, null), -255, v);
      return ee.Number(raw).divide(255);
    }));
    var rounded = probs.map(function(p) { return ee.Number(p).multiply(1000).round().divide(1000); });
    var props = ee.Dictionary.fromLists(PNAMES, rounded)
      .set('first_q', firstDetection(probs, CFG.THRESHOLD))
      .combine({hromada_pcode: 'NA', hromada: 'NA', oblast_pcode: 'NA', oblast: 'NA'})
      .set('n_missing', probs.map(function(p) { return ee.Number(p).lt(0); }).reduce(ee.Reducer.sum()));
    CFG.SENS_THRESHOLDS.forEach(function(th) { props = props.set('fq_' + tag(th), firstDetection(probs, th)); });
    var keep = ee.Feature(ee.Feature(null, {}).copyProperties(f, ['id', 'area', 'use', 'height', 'epoch', 'lon', 'lat', 'adm1']));
    var c = f.geometry().centroid(1);
    var lonlat = ee.List(c.coordinates());   // GHS-OBAT UKR has no lon/lat properties
    return ee.Feature(c, keep.toDictionary().combine(props).combine({lon: lonlat.get(0), lat: lonlat.get(1)}));
  });
}

// Assign each building (centroid) to one hromada; buildings outside `hroms` are dropped unless keepUnmatched.
function joinHromadas(bldg, hroms, keepUnmatched) {
  var joined = ee.Join.saveFirst({matchKey: 'h', outer: keepUnmatched}).apply(bldg, hroms,
    ee.Filter.intersects({leftField: '.geo', rightField: '.geo', maxError: 1}));
  return joined.map(function(f) {
    var h = f.get('h');
    var has = ee.Algorithms.IsEqual(h, null).not();
    var hf = ee.Feature(ee.Algorithms.If(has, h, ee.Feature(null, {})));
    var props = ee.Dictionary(f.toDictionary()).remove(['h']).combine({
      hromada_pcode: ee.Algorithms.If(has, hf.get(CFG.HROMADA_ID_FIELD), 'NA'),
      hromada: ee.Algorithms.If(has, hf.get(CFG.HROMADA_NAME_FIELD), 'NA'),
      oblast_pcode: ee.Algorithms.If(has, hf.get(CFG.OBLAST_ID_FIELD), 'NA'),
      oblast: ee.Algorithms.If(has, hf.get(CFG.OBLAST_NAME_FIELD), 'NA')
    });
    return ee.Feature(f.geometry(), props);
  });
}

var BUILDING_COLS = ['id', 'oblast', 'oblast_pcode', 'hromada', 'hromada_pcode', 'area', 'use', 'height',
  'epoch', 'lon', 'lat', 'n_missing', 'first_q'].concat(THRESH_TAGS.map(function(t) { return 'fq_' + t; }))
  .concat(PNAMES);

// ================================ STEPS =====================================
function stepCheck() {
  log('Windows (' + WINDOWS.length + ', ' + N_PRE + ' pre-invasion):',
      WINDOWS.map(function(w) { return w.name + ' ' + w.start + '..' + w.endIncl + (w.pre ? ' (pre)' : ''); }));
  log('Last complete window ends ' + WINDOWS[WINDOWS.length - 1].endIncl + ' (END_DATE ' + CFG.END_DATE + ')');

  if (assetExists(CFG.LABELS)) {
    var labels = loadLabels();
    log('UNOSAT labels destroyed+severe (expect 10934):', labels.size());
    log('Labels per AOI:', labels.aggregate_histogram('aoi'));
    log('Label example (check date is a YYYY-MM-DD string):', labels.first());
  } else { log('MISSING labels asset ' + CFG.LABELS); }

  if (assetExists(CFG.FOOTPRINTS)) {
    var fp = ee.FeatureCollection(CFG.FOOTPRINTS);
    log('GHS-OBAT asset found: ' + CFG.FOOTPRINTS);
    log('GHS-OBAT schema (first feature):', fp.first());
    fp.first().evaluate(function(f, err) {
      if (err) { log('ERROR ' + err); return; }
      log('GHS-OBAT geometry type: ' + f.geometry.type + (f.geometry.type === 'Point' ?
        ' (centroids; POINT_FOOTPRINT_TO_AREA_CIRCLE=' + CFG.POINT_FOOTPRINT_TO_AREA_CIRCLE + ')' : ''));
      log('GHS-OBAT properties: ' + JSON.stringify(f.properties));
    });
    log('GHS-OBAT feature count (server-side):', fp.size());
    log('GHS-OBAT > ' + CFG.MIN_AREA_M2 + ' m2 in pilot AOI:', footprints(bboxGeom(CFG.PILOT_AOI)).size());
  } else {
    log('STOP: GHS-OBAT asset NOT found: ' + CFG.FOOTPRINTS +
        '. Fallbacks: Overture via GEE catalog or OpenBuildingMap — decide before switching.');
  }

  if (CFG.HROMADAS && assetExists(CFG.HROMADAS)) {
    var h = ee.FeatureCollection(CFG.HROMADAS);
    log('Hromadas count:', h.size());
    h.first().evaluate(function(f, err) {
      if (err) { log('ERROR ' + err); return; }
      log('Hromada properties: ' + JSON.stringify(f.properties));
      [CFG.HROMADA_ID_FIELD, CFG.HROMADA_NAME_FIELD, CFG.OBLAST_ID_FIELD, CFG.OBLAST_NAME_FIELD].forEach(function(k) {
        if (!(k in f.properties)) log('FIELD NOT FOUND in hromada asset: ' + k + ' -> fix the *_FIELD settings in CFG');
      });
    });
    ee.Dictionary.fromLists(h.aggregate_array(CFG.OBLAST_ID_FIELD), h.aggregate_array(CFG.OBLAST_NAME_FIELD))
      .evaluate(function(d, err) {
        if (err) { log('ERROR ' + err); return; }
        log('Oblasts (' + CFG.OBLAST_ID_FIELD + ' = ' + CFG.OBLAST_NAME_FIELD + '):\n' + Object.keys(d).sort().map(function(k) {
          return k + ' = ' + d[k] + (CFG.PLACEBO_OBLAST_PCODES.indexOf(k) >= 0 ? '   [placebo]' : '');
        }).join('\n'));
      });
  } else { log('Hromada asset not set or missing: ' + CFG.HROMADAS); }

  // S1 availability per window over Ukraine (per platform), to spot gaps in recent quarters.
  var all = ee.ImageCollection('COPERNICUS/S1_GRD').filterBounds(UKRAINE)
    .filter(ee.Filter.eq('instrumentMode', 'IW'));
  var counts = ee.Dictionary.fromLists(WNAMES, WINDOWS.map(function(w) {
    return all.filterDate(w.start, w.endExcl).aggregate_histogram('platform_number');
  }));
  counts.evaluate(function(c, err) {
    if (err) { log('ERROR ' + err); return; }
    log('S1 IW images over Ukraine per window and platform (USE_S1C=' + CFG.USE_S1C + '):\n' +
      WNAMES.map(function(n) { return n + ' ' + JSON.stringify(c[n]); }).join('\n'));
  });
  log('Training features exist: ' + assetExists(CFG.ROOT + '/train_features'));
}

function stepFeatures() {
  ensureFolder(CFG.ROOT);
  var labels = loadLabels();
  var parts = [];
  CFG.TRAIN_AOIS.forEach(function(aoi) {
    AOI_ORBITS[aoi].forEach(function(orbit) {
      WINDOWS.slice(0, CFG.TRAIN_N_WINDOWS).forEach(function(win) {
        var pts = labelledPoints(labels, aoi, win, 'spec');
        var col = s1Collection(bboxGeom(aoi), CFG.REF_START, win.endExcl)
          .filter(ee.Filter.eq('relativeOrbitNumber_start', orbit));
        var samples = featureImage(col, win).sampleRegions({
          collection: pts, properties: ['unosat_id', 'aoi', 'date', 'label'], scale: 10, geometries: true
        }).map(function(f) { return f.set({orbit: orbit, window: win.name}); });
        parts.push(samples);
      });
    });
  });
  exportTableAsset(ee.FeatureCollection(parts).flatten(), CFG.ROOT + '/train_features');
}

function stepTrain() {
  var id = CFG.ROOT + '/train_features';
  requireAsset(id, 'training features (run STEP FEATURES)');
  var fc = ee.FeatureCollection(id);
  log('Training rows:', fc.size());
  log('Training label balance:', fc.aggregate_histogram('label'));
  var clf = trainClassifier();
  // Optional archive copy (CLASSIFICATION mode only); later steps re-train via loadClassifier().
  log('Classifier explain (importance):', clf.explain());
  var assetId = CFG.ROOT + '/rf_classifier';
  if (shouldSubmit('rf_classifier', assetExists(assetId))) {
    Export.classifier.toAsset({classifier: clf, description: 'rf_classifier', assetId: assetId});
  }
}

function stepEval() {
  var clf = loadClassifier();
  var labels = loadLabels();
  var parts = [];
  CFG.TEST_AOIS.forEach(function(aoi) {
    WINDOWS.slice(0, CFG.EVAL_N_WINDOWS).forEach(function(win) {
      if (!win.pre && CFG.EVAL_ONLY_2022_POS && win.start.slice(0, 4) !== '2022') return;
      var pts = labelledPoints(labels, aoi, win, CFG.EVAL_POSITIVE_RULE);
      var prob = predictWindow(bboxGeom(aoi).buffer(500), win, clf);
      if (CFG.EVAL_FOCAL_MAX) prob = prob.focalMax({radius: 15, kernelType: 'square', units: 'meters'});
      parts.push(prob.sampleRegions({
        collection: pts, properties: ['unosat_id', 'aoi', 'date', 'label'], scale: 10, geometries: true
      }).map(function(f) { return f.set('window', win.name); }));
    });
  });
  exportTableAsset(ee.FeatureCollection(parts).flatten(), CFG.ROOT + '/eval_preds');
}

function stepMetrics() {
  var id = CFG.ROOT + '/eval_preds';
  requireAsset(id, 'evaluation predictions (run STEP EVAL)');
  var fc = ee.FeatureCollection(id);
  var nBins = 1001;   // bin k = [k/1000, (k+1)/1000): "prob >= k/1000" is exact
  var hist = fc.reduceColumns(ee.Reducer.fixedHistogram(0, nBins / 1000, nBins)
    .group({groupField: 1, groupName: 'label'}), ['prob', 'label']);
  var perAoi = fc.reduceColumns(ee.Reducer.count().group({groupField: 1, groupName: 'aoi'}), ['prob', 'aoi']);

  hist.evaluate(function(res, err) {
    if (err) { log('ERROR ' + err); return; }
    var h = {0: [], 1: []};
    res.groups.forEach(function(g) { h[g.label] = g.histogram.map(function(r) { return r[1]; }); });
    var P = h[1].reduce(function(a, b) { return a + b; }, 0);
    var N = h[0].reduce(function(a, b) { return a + b; }, 0);
    // cumulative counts of prob >= k/1000
    var tp = new Array(nBins + 1), fp = new Array(nBins + 1);
    tp[nBins] = 0; fp[nBins] = 0;
    for (var k = nBins - 1; k >= 0; k--) { tp[k] = tp[k + 1] + (h[1][k] || 0); fp[k] = fp[k + 1] + (h[0][k] || 0); }
    function at(k) {
      var prec = tp[k] + fp[k] > 0 ? tp[k] / (tp[k] + fp[k]) : 1;
      var rec = tp[k] / P, spec = 1 - fp[k] / N;
      return {threshold: k / 1000, precision: prec, recall: rec, f1: prec + rec > 0 ? 2 * prec * rec / (prec + rec) : 0,
              auc_binary: (rec + spec) / 2, tp: tp[k], fp: fp[k], fn: P - tp[k], tn: N - fp[k]};
    }
    var auc = 0;   // threshold-free ROC AUC (trapezoid)
    for (var j = nBins; j > 0; j--) {
      auc += (fp[j - 1] - fp[j]) / N * ((tp[j - 1] + tp[j]) / 2) / P;
    }
    var k90 = null;
    for (var i = 0; i < nBins; i++) { if (at(i).precision >= 0.9 && tp[i] > 0) { k90 = i; break; } }
    var m50 = at(500), mPaper = at(Math.round(CFG.THRESHOLD * 1000));
    log('Eval rows: ' + (P + N) + ' (pos ' + P + ', neg ' + N + ')');
    log('ROC AUC (threshold-free): ' + auc.toFixed(3));
    log('@0.5:', m50);
    log('@' + CFG.THRESHOLD + ':', mPaper);
    log('Threshold for >= 90% precision: ' + (k90 === null ? 'not reached' : (k90 / 1000)), k90 === null ? {} : at(k90));
    log('Paper: threshold 0.655, F1 74.9%, AUC 81.3%, recall 46.5% (repo AUC = roc_auc_score on binary preds = auc_binary).');
    var rows = [['threshold', 'precision', 'recall', 'F1']];
    for (var t = 0; t <= 1000; t += 10) { var m = at(t); rows.push([t / 1000, m.precision, m.recall, m.f1]); }
    print(ui.Chart(rows, 'LineChart', {title: 'Test AOIs: precision / recall / F1 vs threshold',
      hAxis: {title: 'threshold'}, vAxis: {viewWindow: {min: 0, max: 1}}}));
  });

  // Per-AOI precision/recall at the main threshold.
  var hit = fc.map(function(f) {
    var pred = ee.Number(f.get('prob')).gte(CFG.THRESHOLD);
    var y = ee.Number(f.get('label'));
    return f.set({tp: pred.and(y.eq(1)), fp: pred.and(y.eq(0)), fn: pred.not().and(y.eq(1))});
  });
  hit.reduceColumns(ee.Reducer.sum().repeat(3).group({groupField: 3, groupName: 'aoi'}), ['tp', 'fp', 'fn', 'aoi'])
    .evaluate(function(res, err) {
      if (err) { log('ERROR ' + err); return; }
      log('Per-AOI @' + CFG.THRESHOLD + ' [aoi, TP, FP, FN, precision, recall]:', res.groups.map(function(g) {
        var s = g.sum; return [g.aoi, s[0], s[1], s[2], s[0] / Math.max(1, s[0] + s[1]), s[0] / Math.max(1, s[0] + s[2])];
      }));
    });
  log('Rows per AOI:', perAoi);
}

function stepProb() {
  if (CFG.SCOPE === 'PILOT' && CFG.PILOT_ON_THE_FLY) log('Note: PILOT_ON_THE_FLY=true, BUILDINGS will not use these rasters.');
  var clf = loadClassifier();
  ensureFolder(CFG.ROOT); ensureFolder(scopeDir());
  var region = CFG.SCOPE === 'PILOT' ? bboxGeom(CFG.PILOT_AOI) : UKRAINE;
  var wins = WINDOWS.filter(function(w) { return !CFG.WINDOWS_TO_RUN || CFG.WINDOWS_TO_RUN.indexOf(w.name) >= 0; });

  function submit(tiles) {   // tiles: [{id, geom}]
    wins.forEach(function(w) {
      var ic = scopeDir() + '/prob_' + w.name;
      ensureImageCollection(ic);
      var existing = childNames(ic);
      tiles.forEach(function(t) {
        var name = 'tile_' + t.id;
        var desc = cleanDesc(CFG.SCOPE + '_prob_' + w.name + '_' + name);
        if (!shouldSubmit(desc, existing.indexOf(name) >= 0)) return;
        var img = predictWindow(t.geom, w, clf).multiply(255).round().toUint8().rename('prob')
          .set({window: w.name, start: w.start, end: w.endIncl, tile: t.id, use_s1c: CFG.USE_S1C});
        Export.image.toAsset({image: img, description: desc, assetId: ic + '/' + name, region: t.geom,
          crs: CFG.CRS, crsTransform: CFG.CRS_TRANSFORM, maxPixels: 1e13, pyramidingPolicy: {prob: 'mean'}});
      });
    });
  }

  if (CFG.SCOPE === 'PILOT' || !CFG.TILE_DEG) { submit([{id: 'all', geom: region}]); return; }
  var d = CFG.TILE_DEG, cells = [];
  for (var x = 22; x < 40.5; x += d) for (var y = 44; y < 52.5; y += d) {
    cells.push(ee.Feature(ee.Geometry.Rectangle([x, y, x + d, y + d], null, false),
      {tid: 'x' + Math.round(x * 100) + 'y' + Math.round(y * 100)}));
  }
  ee.FeatureCollection(cells).filterBounds(UKRAINE).aggregate_array('tid').evaluate(function(ids) {
    submit(ids.map(function(id) {
      var x = parseInt(id.split('y')[0].slice(1), 10) / 100, y = parseInt(id.split('y')[1], 10) / 100;
      return {id: id, geom: ee.Geometry.Rectangle([x, y, x + d, y + d], null, false).intersection(UKRAINE, 1)};
    }));
  });
}

function stepBuildings() {
  ensureFolder(CFG.ROOT); ensureFolder(scopeDir());
  requireAsset(CFG.FOOTPRINTS, 'GHS-OBAT footprints');
  var existing = childNames(scopeDir());
  var hasH = CFG.HROMADAS && assetExists(CFG.HROMADAS);

  if (CFG.SCOPE === 'PILOT') {
    var region = bboxGeom(CFG.PILOT_AOI);
    var bldg = buildingTable(footprints(region), probStack(region));
    if (hasH) bldg = joinHromadas(bldg, ee.FeatureCollection(CFG.HROMADAS).filterBounds(region), true);
    else log('No hromada asset: hromada fields will be missing in the pilot table.');
    var name = 'buildings_pilot_' + CFG.PILOT_AOI;
    if (existing.indexOf(name) < 0) {
      exportTableAsset(bldg, scopeDir() + '/' + name);
      exportTable(bldg, name, BUILDING_COLS);
    } else { log('SKIP (exists): ' + name); }
    return;
  }

  if (!hasH) throw new Error('COUNTRY BUILDINGS needs CFG.HROMADAS (oblast batching + hromada join).');
  var hroms = ee.FeatureCollection(CFG.HROMADAS);
  var stack = probStack(UKRAINE);
  hroms.aggregate_array(CFG.OBLAST_ID_FIELD).distinct().sort().evaluate(function(oblasts, err) {
    if (err) { log('ERROR ' + err); return; }
    log('Oblast batches: ' + oblasts.length);
    oblasts.forEach(function(ob) {
      var name = 'buildings_' + cleanDesc(String(ob));
      if (existing.indexOf(name) >= 0) { log('SKIP (exists): ' + name); return; }
      var hOb = hroms.filter(ee.Filter.eq(CFG.OBLAST_ID_FIELD, ob));
      var fp = footprints(hOb.geometry());
      // centroid join drops buildings whose centroid lies in another oblast (no double counting)
      var bldg = joinHromadas(buildingTable(fp, stack), hOb, false);
      exportTableAsset(bldg, scopeDir() + '/' + name);
      exportTable(bldg, CFG.SCOPE.toLowerCase() + '_' + name, BUILDING_COLS);
    });
  });
}

function loadBuildings() {
  var names = childNames(scopeDir()).filter(function(n) { return n.indexOf('buildings_') === 0; });
  if (!names.length) throw new Error('No building tables in ' + scopeDir() + ' (run STEP BUILDINGS).');
  log('Building tables: ' + names.join(', '));
  return ee.FeatureCollection(names.map(function(n) { return ee.FeatureCollection(scopeDir() + '/' + n); })).flatten();
}

function stepHromada() {
  var bldg = loadBuildings();
  var hasH = CFG.HROMADAS && assetExists(CFG.HROMADAS);
  var hroms = hasH ? ee.FeatureCollection(CFG.HROMADAS) : ee.FeatureCollection([]);
  var hName = ee.Dictionary.fromLists(hroms.aggregate_array(CFG.HROMADA_ID_FIELD), hroms.aggregate_array(CFG.HROMADA_NAME_FIELD));
  var hOb = ee.Dictionary.fromLists(hroms.aggregate_array(CFG.HROMADA_ID_FIELD), hroms.aggregate_array(CFG.OBLAST_NAME_FIELD));

  var rows = ee.List([]);
  CFG.SENS_THRESHOLDS.forEach(function(th) {
    var field = 'fq_' + tag(th);
    var groups = ee.List(ee.Dictionary(bldg.reduceColumns(ee.Reducer.frequencyHistogram()
      .group({groupField: 1, groupName: 'hromada'}), [field, 'hromada_pcode'])).get('groups'));
    var feats = groups.map(function(g) {
      g = ee.Dictionary(g);
      var hist = ee.Dictionary(g.get('histogram'));
      var pc = ee.String(g.get('hromada'));
      var stock = ee.Number(hist.values().reduce(ee.Reducer.sum()));
      var cum = ee.Number(0), out = [];
      POST_WINDOWS.forEach(function(w) {
        var n = ee.Number(hist.get(w.name, 0));
        cum = cum.add(n);
        out.push(ee.Feature(NO_GEOM, {
          hromada_pcode: pc, hromada: hName.get(pc, 'NA'), oblast: hOb.get(pc, 'NA'), oblast_pcode: pc.slice(0, 4),
          threshold: th, quarter: w.name, quarter_start: w.start, quarter_end: w.endIncl,
          new_damaged: n, cum_damaged: cum, stock: stock, share_new: n.divide(stock.max(1)),
          share_cum: cum.divide(stock.max(1)), pre_flagged: ee.Number(hist.get('pre', 0))
        }));
      });
      return out;
    });
    rows = rows.cat(feats.flatten());
  });
  var table = ee.FeatureCollection(rows);
  var name = 'hromada_quarter';
  exportTableAsset(table, scopeDir() + '/' + name);
  exportTable(table, CFG.SCOPE.toLowerCase() + '_' + name,
    ['hromada_pcode', 'hromada', 'oblast', 'oblast_pcode', 'threshold', 'quarter', 'quarter_start', 'quarter_end',
     'new_damaged', 'cum_damaged', 'stock', 'share_new', 'share_cum', 'pre_flagged']);
}

function stepPlacebo() {
  var bldg = loadBuildings().filter(ee.Filter.inList('oblast_pcode', CFG.PLACEBO_OBLAST_PCODES));
  // Drift: per-window mean probability and raw exceedance rate (not first-detection) in western oblasts.
  var withFlags = bldg.filter(ee.Filter.eq('n_missing', 0)).map(function(f) {
    var d = {};
    PNAMES.forEach(function(n) {
      CFG.SENS_THRESHOLDS.forEach(function(th) { d['X_' + tag(th) + '_' + n] = ee.Number(f.get(n)).gte(th); });
    });
    return f.set(d);
  });
  var cols = PNAMES.slice();
  PNAMES.forEach(function(n) { CFG.SENS_THRESHOLDS.forEach(function(th) { cols.push('X_' + tag(th) + '_' + n); }); });
  var means = withFlags.reduceColumns(ee.Reducer.mean().forEach(cols), cols);
  var rows = ee.FeatureCollection(WINDOWS.map(function(w) {
    var p = {window: w.name, start: w.start, end: w.endIncl, mean_prob: means.get('P_' + w.name),
             n_buildings: withFlags.size()};
    CFG.SENS_THRESHOLDS.forEach(function(th) { p['exceed_' + tag(th)] = means.get('X_' + tag(th) + '_P_' + w.name); });
    return ee.Feature(NO_GEOM, p);
  }));
  exportTableAsset(rows, scopeDir() + '/placebo_drift');
  exportTable(rows, CFG.SCOPE.toLowerCase() + '_placebo_drift',
    ['window', 'start', 'end', 'n_buildings', 'mean_prob'].concat(THRESH_TAGS.map(function(t) { return 'exceed_' + t; })));
}

function chartGrouped(fc, valueField, title, seriesField) {
  // Sum valueField grouped by quarter (and optional series), render a line chart.
  var keyed = fc.map(function(f) {
    var k = seriesField ? ee.String(f.get('quarter')).cat('|').cat(ee.String(f.get(seriesField))) : f.get('quarter');
    return f.set('_k', k);
  });
  keyed.reduceColumns(ee.Reducer.sum().group({groupField: 1, groupName: 'k'}), [valueField, '_k'])
    .evaluate(function(res, err) {
      if (err) { log('ERROR ' + err); return; }
      var series = {}, table = {};
      res.groups.forEach(function(g) {
        var parts = String(g.k).split('|'), q = parts[0], s = seriesField ? parts[1] : valueField;
        series[s] = true; table[q] = table[q] || {}; table[q][s] = g.sum;
      });
      var sNames = Object.keys(series).sort();
      var rows = [['quarter'].concat(sNames)];
      POST_WINDOWS.forEach(function(w) {
        rows.push([w.name + ' ' + w.start].concat(sNames.map(function(s) { return (table[w.name] || {})[s] || 0; })));
      });
      print(ui.Chart(rows, 'LineChart', {title: title, hAxis: {slantedText: true}, vAxis: {title: 'buildings'}}));
    });
}

function stepTrends() {
  var id = scopeDir() + '/hromada_quarter';
  requireAsset(id, 'hromada x quarter table (run STEP HROMADA)');
  var t = ee.FeatureCollection(id);
  var main = t.filter(ee.Filter.eq('threshold', CFG.THRESHOLD));

  chartGrouped(t.map(function(f) { return f.set('thr', ee.Number(f.get('threshold')).format('%.3f')); }),
    'new_damaged', 'National newly damaged buildings per quarter (threshold sensitivity)', 'thr');
  chartGrouped(main, 'new_damaged', 'Newly damaged buildings per quarter by oblast @' + CFG.THRESHOLD, 'oblast');

  main.reduceColumns(ee.Reducer.sum().group({groupField: 1, groupName: 'h'}), ['new_damaged', 'hromada_pcode'])
    .evaluate(function(res, err) {
      if (err) { log('ERROR ' + err); return; }
      var top = res.groups.sort(function(a, b) { return b.sum - a.sum; }).slice(0, CFG.TOP_HROMADAS)
        .map(function(g) { return g.h; });
      log('Top hromadas by newly damaged buildings:', res.groups.slice(0, CFG.TOP_HROMADAS));
      chartGrouped(main.filter(ee.Filter.inList('hromada_pcode', top)), 'new_damaged',
        'Top ' + CFG.TOP_HROMADAS + ' hromadas: newly damaged per quarter', 'hromada');
    });

  // Placebo: detections in western oblasts (expected ~0).
  var placebo = t.filter(ee.Filter.inList('oblast_pcode', CFG.PLACEBO_OBLAST_PCODES));
  chartGrouped(placebo.map(function(f) { return f.set('thr', ee.Number(f.get('threshold')).format('%.3f')); }),
    'new_damaged', 'PLACEBO western oblasts: newly flagged buildings per quarter', 'thr');
  log('Placebo building stock:', placebo.filter(ee.Filter.and(ee.Filter.eq('threshold', CFG.THRESHOLD),
    ee.Filter.eq('quarter', POST_WINDOWS[0].name))).aggregate_sum('stock'));

  var driftId = scopeDir() + '/placebo_drift';
  if (assetExists(driftId)) {
    print(ui.Chart.feature.byFeature(ee.FeatureCollection(driftId), 'window',
      ['mean_prob'].concat(THRESH_TAGS.map(function(x) { return 'exceed_' + x; })))
      .setOptions({title: 'Reference drift in western oblasts: mean prob and exceedance rate per window'}));
  } else { log('No placebo_drift asset yet (run STEP PLACEBO).'); }
}

function stepMap() {
  var region = CFG.SCOPE === 'PILOT' ? bboxGeom(CFG.PILOT_AOI) : UKRAINE;
  Map.centerObject(region, CFG.SCOPE === 'PILOT' ? 12 : 6);
  var vis = {min: 0, max: 255, palette: ['000004', '51127c', 'b73779', 'fc8961', 'fcfdbf']};
  var showWins = [WINDOWS[N_PRE - 1], WINDOWS[N_PRE], WINDOWS[N_PRE + 1], WINDOWS[WINDOWS.length - 1]];
  if (CFG.SCOPE === 'PILOT' && CFG.PILOT_ON_THE_FLY) {
    var clf = loadClassifier();
    showWins.forEach(function(w) {
      Map.addLayer(predictWindow(region, w, clf).multiply(255).clip(region), vis, 'prob ' + w.name + ' ' + w.start, false);
    });
  } else {
    showWins.forEach(function(w) {
      Map.addLayer(ee.ImageCollection(scopeDir() + '/prob_' + w.name).mosaic(), vis, 'prob ' + w.name + ' ' + w.start, false);
    });
  }
  var names = childNames(scopeDir()).filter(function(n) { return n.indexOf('buildings_') === 0; });
  if (names.length) {
    var b = loadBuildings().filter(ee.Filter.inList('first_q', POST_WINDOWS.map(function(w) { return w.name; })));
    var palette = ['fde725', 'b5de2b', '6ece58', '35b779', '1f9e89', '26828e', '31688e', '3e4989', '482878', '440154'];
    var styled = b.map(function(f) {
      var i = ee.List(WNAMES).indexOf(f.get('first_q')).subtract(N_PRE);
      var c = ee.List(palette).get(i.multiply(palette.length).divide(POST_WINDOWS.length).floor().min(palette.length - 1).int());
      return f.set('style', {color: c, pointSize: 3, width: 0});
    });
    Map.addLayer(styled.style({styleProperty: 'style'}), {}, 'first detection (yellow=early, purple=late) @' + CFG.THRESHOLD);
    if (CFG.SCOPE === 'PILOT') log('Pilot first-detection counts @' + CFG.THRESHOLD + ':', loadBuildings().aggregate_histogram('first_q'));
  }
  if (CFG.HROMADAS && assetExists(CFG.HROMADAS)) {
    Map.addLayer(ee.Image().paint(ee.FeatureCollection(CFG.HROMADAS).filterBounds(region), 0, 1), {palette: ['ffffff']}, 'hromadas');
  }
}

// ================================= RUN ======================================
if (CFG.USE_S1C) log('WARNING: USE_S1C=true mixes S1C into post-2024 windows while T0 is S1A-only. Validate before use.');
var STEPS = {CHECK: stepCheck, FEATURES: stepFeatures, TRAIN: stepTrain, EVAL: stepEval, METRICS: stepMetrics,
             PROB: stepProb, BUILDINGS: stepBuildings, HROMADA: stepHromada, PLACEBO: stepPlacebo,
             TRENDS: stepTrends, MAP: stepMap};
if (!STEPS[CFG.STEP]) throw new Error('Unknown STEP ' + CFG.STEP + '. Use one of: ' + Object.keys(STEPS).join(', '));
log('Start. ' + WINDOWS.length + ' windows ' + WINDOWS[0].start + '..' + WINDOWS[WINDOWS.length - 1].endIncl);
STEPS[CFG.STEP]();
