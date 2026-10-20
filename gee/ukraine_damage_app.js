/*******************************************************************************
 * Ukraine war damage explorer — Earth Engine App (viewer)
 *
 * Interactive map of the outputs of gee/ukraine_damage_ghs_obat.js:
 *   - newly damaged buildings per quarter (first detection, GHS-OBAT footprints)
 *   - hromada choropleth: share of building stock newly / cumulatively damaged
 *   - Sentinel-1 damage probability raster per quarter
 *   - click a hromada for its quarterly time series, a building for its probabilities
 *
 * Reads precomputed assets only (no training or exports), so it is fast enough to
 * publish: Apps > New App > pick this script > Publish. Grant the app read access
 * to CFG.ROOT and CFG.HROMADAS in the publish dialog (or share them "Anyone can read").
 *
 * Method: Dietrich et al. 2025, Commun. Earth Environ. 6:215,
 * https://doi.org/10.1038/s43247-025-02183-7. Footprints: JRC GHS-OBAT (CC BY 4.0).
 ******************************************************************************/

// =============================== CONFIG =====================================
// Must match the values used in gee/ukraine_damage_ghs_obat.js.
var CFG = {
  ROOT: 'projects/custom-graph-272808/assets/ukr_damage',
  SCOPE: 'country',                     // 'country' | 'pilot'
  HROMADAS: 'projects/custom-graph-272808/assets/ukr_admin3',
  HROMADA_ID_FIELD: 'ADM3_PCODE',
  HROMADA_NAME_FIELD: 'ADM3_EN',
  OBLAST_NAME_FIELD: 'ADM1_EN',
  FIRST_WINDOW_START: '2021-02-24',
  END_DATE: '2026-08-23',
  WAR_START: '2022-02-24',
  THRESHOLDS: [0.55, 0.655, 0.75],
  DEFAULT_THRESHOLD: 0.655,
  SHARE_MAX_NEW: 2,                     // % for colour scale, newly damaged per quarter
  SHARE_MAX_CUM: 20,                    // % for colour scale, cumulative
  MIN_ZOOM_BUILDINGS: 10,
  TITLE: 'Ukraine: newly damaged buildings per quarter'
};

// ============================ WINDOWS =======================================
function addMonths(iso, m) {
  var d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function pad2(i) { return (i < 10 ? '0' : '') + i; }
var WINDOWS = [];
for (var k = 0; k < 400; k++) {
  var s = addMonths(CFG.FIRST_WINDOW_START, 3 * k), e = addDays(addMonths(CFG.FIRST_WINDOW_START, 3 * (k + 1)), -1);
  if (e > CFG.END_DATE) break;
  WINDOWS.push({name: 'T' + pad2(k + 1), start: s, end: e, pre: e <= CFG.WAR_START});
}
var WNAMES = WINDOWS.map(function(w) { return w.name; });
var POST = WINDOWS.filter(function(w) { return !w.pre; });
function tag(th) { return 't' + String(th).replace('.', ''); }
function label(w) { return w.name + '  ' + w.start + ' – ' + w.end; }

// ============================== DATA ========================================
var DIR = CFG.ROOT + '/' + CFG.SCOPE;
var HROMS = ee.FeatureCollection(CFG.HROMADAS);
var HTABLE = ee.FeatureCollection(DIR + '/hromada_quarter');
var BLDG = null;   // set asynchronously from the building tables in DIR
var READY = {hroms: false, htable: false, dir: false};   // set by checkAssets() at start

var state = {q: POST[POST.length - 1].name, th: CFG.DEFAULT_THRESHOLD, cumulative: false,
             showProb: false, showHrom: true, showBldg: true};

// ================================ UI ========================================
var map = ui.Map();
map.setOptions('HYBRID');
map.style().set('cursor', 'crosshair');
map.setCenter(31.5, 48.8, 6);

var panel = ui.Panel({style: {width: '380px', padding: '8px'}});
var chartPanel = ui.Panel();
var status = ui.Label('', {color: '666666', fontSize: '11px'});

panel.add(ui.Label(CFG.TITLE, {fontSize: '18px', fontWeight: 'bold'}));
panel.add(ui.Label('Sentinel-1 damage probabilities (Dietrich et al. 2025) aggregated to JRC GHS-OBAT ' +
  'footprints > 50 m². A building counts once, in the first quarter its probability reaches the threshold; ' +
  'buildings already flagged before the invasion (T1–T4) are excluded.', {fontSize: '12px'}));

var qSelect = ui.Select({
  items: POST.map(function(w) { return {label: label(w), value: w.name}; }),
  value: state.q, onChange: function(v) { state.q = v; redraw(); }
});
var thSelect = ui.Select({
  items: CFG.THRESHOLDS.map(function(t) { return {label: String(t) + (t === CFG.DEFAULT_THRESHOLD ? ' (≈90% precision)' : ''), value: t}; }),
  value: state.th, onChange: function(v) { state.th = v; redraw(); nationalChart(); }
});
function check(lbl, key) {
  return ui.Checkbox({label: lbl, value: state[key], onChange: function(v) { state[key] = v; redraw(); }});
}
panel.add(ui.Label('Quarter', {fontWeight: 'bold'})); panel.add(qSelect);
panel.add(ui.Label('Probability threshold', {fontWeight: 'bold'})); panel.add(thSelect);
panel.add(check('Cumulative (all damage up to this quarter)', 'cumulative'));
panel.add(check('Hromadas: share of building stock damaged', 'showHrom'));
panel.add(check('Buildings (zoom in)', 'showBldg'));
panel.add(check('Damage probability raster', 'showProb'));

var legend = ui.Panel();
panel.add(legend);
panel.add(ui.Label('Click a hromada or building for its time series.', {fontStyle: 'italic', fontSize: '12px'}));
panel.add(status);
panel.add(chartPanel);
panel.add(ui.Label('Caveats: undercount (recall ≈ 46%); drift from the fixed 2020 reference (false positives ' +
  'from construction grow over time); saturation (each building counted once); quarterly timing lag; damage in ' +
  'Donbas before 2022 is not captured; amplitude only, no terrain flattening. Non-commercial use (GEE terms).',
  {fontSize: '11px', color: '666666'}));
panel.add(ui.Label('Method: Dietrich et al. 2025', {fontSize: '11px'}, 'https://doi.org/10.1038/s43247-025-02183-7'));
panel.add(ui.Label('Footprints: JRC GHS-OBAT (CC BY 4.0)', {fontSize: '11px'}, 'https://doi.org/10.2905/f41a22f1-5741-4c41-86eb-6384654f6927'));

ui.root.clear();
ui.root.add(ui.SplitPanel(panel, map));

// ============================== LAYERS ======================================
var SHARE_PALETTE = ['ffffcc', 'fed976', 'fd8d3c', 'e31a1c', '800026'];
var PROB_PALETTE = ['000004', '51127c', 'b73779', 'fc8961', 'fcfdbf'];

function quartersUpTo(q) { var i = WNAMES.indexOf(q); return POST.filter(function(w) { return WNAMES.indexOf(w.name) <= i; }).map(function(w) { return w.name; }); }

function hromadaLayer() {
  var rows = HTABLE.filter(ee.Filter.eq('threshold', state.th)).filter(ee.Filter.eq('quarter', state.q));
  var field = state.cumulative ? 'share_cum' : 'share_new';
  var dict = ee.Dictionary.fromLists(rows.aggregate_array('hromada_pcode'), rows.aggregate_array(field));
  var img = HROMS.map(function(f) {
    return f.set('v', ee.Number(dict.get(ee.String(f.get(CFG.HROMADA_ID_FIELD)), 0)).multiply(100));
  }).reduceToImage(['v'], ee.Reducer.first());
  var max = state.cumulative ? CFG.SHARE_MAX_CUM : CFG.SHARE_MAX_NEW;
  return ui.Map.Layer(img.updateMask(img.gt(0)), {min: 0, max: max, palette: SHARE_PALETTE},
    'Hromadas: % ' + (state.cumulative ? 'cumulatively' : 'newly') + ' damaged', true, 0.75);
}

function outlineLayer() {
  return ui.Map.Layer(ee.Image().byte().paint(HROMS, 1, 1), {palette: ['ffffff']}, 'Hromada boundaries', true, 0.4);
}

function buildingLayer() {
  var field = 'fq_' + tag(state.th);
  var f = state.cumulative ? ee.Filter.inList(field, quartersUpTo(state.q)) : ee.Filter.eq(field, state.q);
  return ui.Map.Layer(BLDG.filter(f).style({color: '00ffff', pointSize: 2, width: 0}),
    {}, 'Buildings damaged (' + (state.cumulative ? 'up to ' : 'in ') + state.q + ')');
}

function probLayer() {
  var img = ee.ImageCollection(DIR + '/prob_' + state.q).mosaic();
  return ui.Map.Layer(img.updateMask(img.gte(0.3 * 255)), {min: 0, max: 255, palette: PROB_PALETTE},
    'Damage probability ' + state.q + ' (≥ 0.3)', true, 0.8);
}

function redraw() {
  var layers = [];
  if (state.showProb && READY.dir) layers.push(probLayer());
  if (state.showHrom && READY.hroms && READY.htable) layers.push(hromadaLayer());
  if (READY.hroms) layers.push(outlineLayer());
  if (state.showBldg && BLDG && map.getZoom() >= CFG.MIN_ZOOM_BUILDINGS) layers.push(buildingLayer());
  map.layers().reset(layers);
  drawLegend();
}
map.onChangeZoom(function() { if (state.showBldg) redraw(); });

function drawLegend() {
  legend.clear();
  var max = state.cumulative ? CFG.SHARE_MAX_CUM : CFG.SHARE_MAX_NEW;
  var bar = ui.Thumbnail({image: ee.Image.pixelLonLat().select(0),
    params: {bbox: [0, 0, 1, 0.1], dimensions: '200x12', format: 'png', min: 0, max: 1, palette: SHARE_PALETTE}});
  legend.add(ui.Label('% of hromada building stock ' + (state.cumulative ? 'damaged up to ' : 'newly damaged in ') + state.q,
    {fontSize: '12px'}));
  legend.add(ui.Panel([ui.Label('0'), bar, ui.Label('≥ ' + max + '%')], ui.Panel.Layout.flow('horizontal')));
}

// ============================== CHARTS ======================================
function nationalChart() {
  if (!READY.htable) return;
  HTABLE.filter(ee.Filter.eq('threshold', state.th))
    .reduceColumns(ee.Reducer.sum().group({groupField: 1, groupName: 'q'}), ['new_damaged', 'quarter'])
    .evaluate(function(res, err) {
      if (err) { status.setValue('Could not load hromada table: ' + err); return; }
      var byQ = {};
      res.groups.forEach(function(g) { byQ[g.q] = g.sum; });
      var rows = [['quarter', 'newly damaged buildings']];
      POST.forEach(function(w) { rows.push([w.name + ' ' + w.start.slice(0, 7), byQ[w.name] || 0]); });
      chartPanel.clear();
      chartPanel.add(ui.Chart(rows, 'ColumnChart', {title: 'Ukraine: newly damaged buildings per quarter @' + state.th,
        legend: {position: 'none'}, hAxis: {slantedText: true}, colors: ['e31a1c']}));
    });
}

function hromadaChart(pcode, name, oblast) {
  var rows = HTABLE.filter(ee.Filter.eq('hromada_pcode', pcode)).filter(ee.Filter.eq('threshold', state.th))
    .sort('quarter');
  chartPanel.clear();
  chartPanel.add(ui.Label(name + ' (' + oblast + ', ' + pcode + ')', {fontWeight: 'bold'}));
  chartPanel.add(ui.Chart.feature.byFeature(rows, 'quarter', ['new_damaged'])
    .setChartType('ColumnChart')
    .setOptions({title: 'Newly damaged buildings per quarter @' + state.th, legend: {position: 'none'},
      colors: ['e31a1c'], hAxis: {slantedText: true}}));
  chartPanel.add(ui.Chart.feature.byFeature(rows, 'quarter', ['share_cum'])
    .setOptions({title: 'Cumulative share of building stock damaged', legend: {position: 'none'},
      vAxis: {format: 'percent'}, colors: ['800026'], hAxis: {slantedText: true}}));
  var back = ui.Button('← national trend', nationalChart);
  chartPanel.add(back);
}

function buildingChart(props) {
  var rows = [['quarter', 'probability', 'threshold']];
  WINDOWS.forEach(function(w) {
    var p = props['P_' + w.name];
    rows.push([w.name + ' ' + w.start.slice(0, 7), p < 0 ? null : p, state.th]);
  });
  chartPanel.clear();
  chartPanel.add(ui.Label('Building ' + props.id + ' — ' + props.hromada + ', ' + props.oblast, {fontWeight: 'bold'}));
  chartPanel.add(ui.Label('Area ' + Math.round(props.area) + ' m², height ' + (props.height || '–') + ' m, use ' +
    ({1: 'residential', 2: 'non-residential'}[props.use] || 'n/a') + '. First detection @' + state.th + ': ' +
    props['fq_' + tag(state.th)], {fontSize: '12px'}));
  chartPanel.add(ui.Chart(rows, 'LineChart', {title: 'Damage probability per quarter',
    vAxis: {viewWindow: {min: 0, max: 1}}, hAxis: {slantedText: true}, series: {1: {lineDashStyle: [4, 4], color: '999999'}},
    colors: ['e31a1c', '999999']}));
  chartPanel.add(ui.Button('← national trend', nationalChart));
}

map.onClick(function(c) {
  var pt = ee.Geometry.Point([c.lon, c.lat]);
  status.setValue('Loading…');
  var near = (BLDG && map.getZoom() >= 14) ? BLDG.filterBounds(pt.buffer(25)).first() : null;
  if (!READY.hroms) { status.setValue('Hromada boundaries not available (see setup message).'); return; }
  var hrom = HROMS.filterBounds(pt).first();
  ee.Dictionary({
    b: near ? ee.Algorithms.If(near, ee.Feature(near).toDictionary(), null) : null,
    h: ee.Algorithms.If(hrom, ee.Feature(hrom).toDictionary(
      [CFG.HROMADA_ID_FIELD, CFG.HROMADA_NAME_FIELD, CFG.OBLAST_NAME_FIELD]), null)
  }).evaluate(function(r, err) {
    status.setValue(err ? 'Error: ' + err : '');
    if (err || !r) return;
    if (r.b) { buildingChart(r.b); return; }
    if (r.h) { hromadaChart(r.h[CFG.HROMADA_ID_FIELD], r.h[CFG.HROMADA_NAME_FIELD], r.h[CFG.OBLAST_NAME_FIELD]); return; }
    status.setValue('Outside Ukraine hromadas.');
  });
});

// ============================== START =======================================
// Check every input asset asynchronously; show what is missing instead of layer errors.
function checkAssets() {
  var missing = [];
  var setup = ui.Label('', {color: 'b00020', fontSize: '12px', whiteSpace: 'pre-wrap'});
  panel.widgets().insert(2, setup);
  function report() {
    setup.setValue(missing.length ? 'Setup needed:\n- ' + missing.join('\n- ') +
      '\nEdit CFG at the top of the app script, and run the pipeline steps in ukraine_damage_ghs_obat.js ' +
      '(BUILDINGS, then HROMADA) for SCOPE "' + CFG.SCOPE + '".' : '');
    redraw(); nationalChart();
  }
  if (CFG.ROOT.indexOf('YOUR_PROJECT') >= 0 || String(CFG.HROMADAS).indexOf('YOUR_PROJECT') >= 0) {
    missing.push('Replace YOUR_PROJECT in CFG.ROOT / CFG.HROMADAS with your Cloud project ID.');
    report(); return;
  }
  var pending = 3;
  function done() { if (--pending === 0) report(); }
  ee.data.getAsset(CFG.HROMADAS, function(a, err) {
    if (a && !err) READY.hroms = true; else missing.push('Hromada boundaries not found or not readable: ' + CFG.HROMADAS);
    done();
  });
  ee.data.getAsset(DIR + '/hromada_quarter', function(a, err) {
    if (a && !err) READY.htable = true; else missing.push('Hromada x quarter table missing: ' + DIR + '/hromada_quarter (pipeline STEP HROMADA)');
    done();
  });
  ee.data.listAssets(DIR, {}, function(res, err) {
    var names = ((res && res.assets) || []).map(function(a) { return (a.id || a.name).split('/').pop(); });
    READY.dir = !err && names.some(function(n) { return n.indexOf('prob_') === 0; });
    var b = names.filter(function(n) { return n.indexOf('buildings_') === 0; });
    if (b.length) BLDG = ee.FeatureCollection(b.map(function(n) { return ee.FeatureCollection(DIR + '/' + n); })).flatten();
    else missing.push('No building tables in ' + DIR + ' (pipeline STEP BUILDINGS)');
    done();
  });
}
drawLegend();
checkAssets();
