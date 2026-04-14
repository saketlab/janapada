#!/usr/bin/env node
// Usage:
//   node process.cjs [config.yml]   (defaults to janapada.yml in cwd)

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function normalize(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/&/g, 'and');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i || j)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function fuzzyMatch(name, candidates) {
  const nl = normalize(name);
  const exact = candidates.find(c => normalize(c) === nl);
  if (exact) return { match: exact, score: 1.0 };
  const contains = candidates.find(c => normalize(c).includes(nl) || nl.includes(normalize(c)));
  if (contains) return { match: contains, score: 0.9 };
  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(nl, normalize(c));
    if (d < bestDist) { bestDist = d; best = c; }
  }
  const maxLen = Math.max(nl.length, best ? normalize(best).length : 1);
  const score = best ? 1 - bestDist / maxLen : 0;
  return score > 0.5 ? { match: best, score: parseFloat(score.toFixed(2)) } : { match: null, score: 0 };
}

function parseCSV(text) {
  const rows = [];
  let inQuote = false, field = '', row = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') { field += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      row.push(field.trim()); field = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some(v => v)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some(v => v)) rows.push(row); }
  return rows;
}

const configArg = process.argv[2] || 'janapada.yml';
const configPath = path.resolve(configArg);
const configDir  = path.dirname(configPath);

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const cfg = yaml.load(fs.readFileSync(configPath, 'utf8'));

const YEARS       = cfg.years.map(Number);
const LEVEL1      = (cfg.levels?.level1 || 'state').toLowerCase();
const LEVEL2      = (cfg.levels?.level2 || 'district').toLowerCase();
const ORIGIN_YEAR = Number(cfg.origin_year || YEARS[0]);
const FUZZY       = cfg.fuzzy_match !== false;
const PALETTE     = cfg.palette || [
  '#e63946','#f4a261','#2a9d8f','#457b9d','#a8dadc',
  '#6a4c93','#f72585','#4cc9f0','#80b918','#ffb703',
  '#06d6a0','#118ab2','#ef476f','#ffd166','#3a86ff',
  '#8338ec','#fb5607','#ff006e','#3d405b','#81b29a',
];
const LEVEL1_ALIASES     = cfg.level1_aliases    || {};
const LEVEL2_CORRECTIONS = cfg.level2_corrections || {};

const sourceByYear = {};
for (const src of (cfg.sources || [])) {
  sourceByYear[Number(src.year)] = src;
}

console.log(`\njanapada — ${cfg.name || 'unnamed'}`);
console.log(`Years: ${YEARS.join(', ')}`);
console.log(`Levels: ${LEVEL1} / ${LEVEL2}, origin: ${ORIGIN_YEAR}, fuzzy: ${FUZZY}\n`);

const csvPath = path.resolve(configDir, cfg.transitions);
const [headers, ...dataRows] = parseCSV(fs.readFileSync(csvPath, 'utf8'));

const raw = dataRows.map(vals => {
  const row = {};
  headers.forEach((h, i) => { row[h] = (vals[i] || '').trim(); });
  return row;
});
console.log(`Loaded ${raw.length} transition rows`);

// Matches "1951-State", "1951-district", etc.
function colKey(year, levelKeyword) {
  return headers.find(h =>
    h.startsWith(`${year}-`) && h.toLowerCase().includes(levelKeyword.toLowerCase())
  );
}

const COLS = {};
for (const y of YEARS) {
  COLS[`${y}_l1`] = colKey(y, LEVEL1);
  COLS[`${y}_l2`] = colKey(y, LEVEL2);
}

function getVal(row, year, kind) {
  const col = COLS[`${year}_${kind}`];
  return col ? String(row[col] || '').trim() : '';
}

const nodeMap  = new Map();
const links    = [];
const linkSet  = new Set();

function nkey(year, l1, l2) { return `${year}:${l1}:${l2}`; }

function getOrCreate(year, l1, l2) {
  const k = nkey(year, l1, l2);
  if (!nodeMap.has(k)) {
    nodeMap.set(k, {
      id: k, year,
      name: l2, parentName: l1,
      chainId: null, color: '#cccccc',
      geojsonMatch: null, geojsonParentMatch: null, geojsonScore: 0,
    });
  }
  return nodeMap.get(k);
}

for (const row of raw) {
  for (let i = 0; i < YEARS.length - 1; i++) {
    const srcYear = YEARS[i], dstYear = YEARS[i + 1];
    const srcL1 = getVal(row, srcYear, 'l1'), srcL2 = getVal(row, srcYear, 'l2');
    const dstL1 = getVal(row, dstYear, 'l1'), dstL2 = getVal(row, dstYear, 'l2');
    if (!srcL2 || !dstL2) continue;
    const src = getOrCreate(srcYear, srcL1, srcL2);
    const dst = getOrCreate(dstYear, dstL1, dstL2);
    const lk = `${src.id}-->${dst.id}`;
    if (!linkSet.has(lk)) { linkSet.add(lk); links.push({ sourceId: src.id, targetId: dst.id }); }
  }
}

console.log(`Nodes: ${nodeMap.size}, Links: ${links.length}`);

const fwd = new Map();
for (const lk of links) {
  if (!fwd.has(lk.sourceId)) fwd.set(lk.sourceId, []);
  fwd.get(lk.sourceId).push(lk.targetId);
}

const originNodes = [...nodeMap.values()].filter(n => n.year === ORIGIN_YEAR);
originNodes.sort((a, b) => a.id.localeCompare(b.id));

const chains = [];
let chainIdCounter = 0;

for (const origin of originNodes) {
  if (origin.chainId !== null) continue;
  const chainId = chainIdCounter++;
  const color   = PALETTE[chainId % PALETTE.length];
  const queue   = [origin.id];
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodeMap.get(id);
    if (!node) continue;
    if (node.chainId === null) { node.chainId = chainId; node.color = color; }
    for (const nxt of (fwd.get(id) || [])) { if (!visited.has(nxt)) queue.push(nxt); }
  }
  chains.push({ chainId, canonicalName: origin.name, originParent: origin.parentName, color });
}

let orphanId = chainIdCounter;
for (const node of nodeMap.values()) {
  if (node.chainId === null) { node.chainId = orphanId; node.color = '#9ca3af'; orphanId++; }
}

console.log(`Chains from ${ORIGIN_YEAR}: ${chains.length}`);

function resolveL1(raw) {
  const n = normalize(raw);
  return LEVEL1_ALIASES[n] || n;
}

function resolveL2(raw, year) {
  const corrections = LEVEL2_CORRECTIONS[year] || {};
  const n = normalize(raw);
  return corrections[n] ?? raw.replace(/'+$/, '').trim();
}

const gjFileToYears = new Map();
for (const [year, src] of Object.entries(sourceByYear)) {
  const absPath = path.resolve(configDir, src.geojson);
  if (!gjFileToYears.has(absPath)) gjFileToYears.set(absPath, []);
  gjFileToYears.get(absPath).push(Number(year));
}

const geojsonMaps = {};

for (const [gjPath, years] of gjFileToYears) {
  if (!fs.existsSync(gjPath)) {
    console.warn(`  Missing GeoJSON: ${gjPath}`);
    continue;
  }
  const gj  = JSON.parse(fs.readFileSync(gjPath, 'utf8'));
  const src  = sourceByYear[years[0]];
  const key  = src.key;
  const pkey = src.parent_key;

  const featureMap = new Map();
  for (const f of gj.features) {
    const l2raw = (f.properties[key] || '').split('\r\n')[0].trim();
    const l1raw = pkey ? (f.properties[pkey] || '').split('\r\n')[0].trim() : '';
    const mapKey = resolveL1(l1raw) + ':' + normalize(l2raw);
    featureMap.set(mapKey, { l2: l2raw, l1: l1raw });
  }

  const candidatesByL1  = new Map();
  const l2ToL1          = new Map();
  for (const [, val] of featureMap) {
    const l1k = resolveL1(val.l1);
    if (!candidatesByL1.has(l1k)) candidatesByL1.set(l1k, []);
    candidatesByL1.get(l1k).push(val.l2);
    l2ToL1.set(val.l2, val.l1);
  }
  const allCandidates = [...featureMap.values()].map(v => v.l2);

  for (const year of years) {
    geojsonMaps[year] = { featureMap, candidatesByL1, allCandidates, l2ToL1, src };
    console.log(`  Loaded ${featureMap.size} features for year ${year} from ${path.basename(gjPath)}`);
  }
}

let matched = 0;
for (const node of nodeMap.values()) {
  const gj = geojsonMaps[node.year];
  if (!gj) continue;

  const l1resolved  = resolveL1(node.parentName);
  const l2corrected = resolveL2(node.name, node.year);

  const exactKey = l1resolved + ':' + normalize(l2corrected);
  const exactFeat = gj.featureMap.get(exactKey);
  if (exactFeat) {
    node.geojsonMatch = exactFeat.l2;
    node.geojsonParentMatch = exactFeat.l1;
    node.geojsonScore = 1;
    matched++;
    continue;
  }

  if (!FUZZY) continue;

  const scopedCandidates = gj.candidatesByL1.get(l1resolved) || gj.allCandidates;
  const result = fuzzyMatch(l2corrected, scopedCandidates);
  if (result.match) {
    node.geojsonMatch = result.match;
    node.geojsonParentMatch = gj.l2ToL1.get(result.match) || '';
    node.geojsonScore = result.score;
    matched++;
  }
}

console.log(`Matched ${matched} / ${nodeMap.size} nodes to GeoJSON features`);

const chainedIds    = new Set(chains.map(c => c.chainId));
const gjKeyToChains = new Map();
const chainColorMap = new Map();

for (const node of nodeMap.values()) {
  if (node.geojsonMatch) {
    const gjKey = `${normalize(node.geojsonParentMatch || node.parentName)}:${normalize(node.geojsonMatch)}`;
    if (!gjKeyToChains.has(gjKey)) gjKeyToChains.set(gjKey, new Set());
    gjKeyToChains.get(gjKey).add(node.chainId);
  }
  if (!chainColorMap.has(node.chainId) || node.color !== '#9ca3af') {
    chainColorMap.set(node.chainId, node.color);
  }
}

const mergeMap = new Map();
for (const [, cids] of gjKeyToChains) {
  if (cids.size <= 1) continue;
  let canonical = null;
  for (const cid of cids) { if (chainedIds.has(cid)) { canonical = cid; break; } }
  if (canonical === null) canonical = Math.min(...cids);
  for (const cid of cids) { if (cid !== canonical) mergeMap.set(cid, canonical); }
}

function resolve(id) {
  const seen = new Set();
  while (mergeMap.has(id)) {
    if (seen.has(id)) break;
    seen.add(id);
    id = mergeMap.get(id);
  }
  return id;
}

let mergeCount = 0;
for (const node of nodeMap.values()) {
  const merged = resolve(node.chainId);
  if (merged !== node.chainId) {
    node.chainId = merged;
    const col = chainColorMap.get(merged);
    if (col) node.color = col;
    mergeCount++;
  }
}

console.log(`Merged ${mergeCount} nodes across duplicate-geometry chains`);

const output = {
  name:   cfg.name || '',
  levels: { level1: LEVEL1, level2: LEVEL2 },
  years:  YEARS,
  nodes:  [...nodeMap.values()],
  links,
  chains,
};

const outPath = path.resolve(configDir, cfg.output || 'evolution.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(output));

console.log(`\nWrote ${outPath}`);
console.log(`  ${output.nodes.length} nodes, ${output.links.length} links, ${output.chains.length} chains`);
