#!/usr/bin/env node
// Usage:
//   node scripts/setup-viewer.cjs [path/to/janapada.yml] [--base /janapada/]
//   (defaults to examples/india-districts/janapada.yml, base defaults to /)

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT   = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'viewer', 'public');

const args       = process.argv.slice(2);
const baseIdx    = args.indexOf('--base');
const base       = baseIdx !== -1 ? args.splice(baseIdx, 2)[1] : '/';
const configArg  = args[0] || path.join(ROOT, 'examples', 'india-districts', 'janapada.yml');
const configPath = path.resolve(configArg);

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}

const config    = yaml.load(fs.readFileSync(configPath, 'utf8'));
const configDir = path.dirname(configPath);

fs.mkdirSync(PUBLIC, { recursive: true });

function copy(src, dest) {
  if (!fs.existsSync(src)) { console.warn(`  skip (not found): ${src}`); return; }
  const srcMtime  = fs.statSync(src).mtimeMs;
  const destMtime = fs.existsSync(dest) ? fs.statSync(dest).mtimeMs : 0;
  if (srcMtime <= destMtime) return;
  fs.copyFileSync(src, dest);
  console.log(`  copied: ${path.relative(ROOT, src)} → viewer/public/${path.basename(dest)}`);
}

copy(
  path.resolve(configDir, config.output || 'evolution.json'),
  path.join(PUBLIC, 'evolution.json'),
);

const seenAbs      = new Set();
const seenBasename = new Map();
for (const src of (config.sources || [])) {
  const abs      = path.resolve(configDir, src.geojson);
  const basename = path.basename(abs);
  if (seenAbs.has(abs)) continue;
  seenAbs.add(abs);
  if (seenBasename.has(basename) && seenBasename.get(basename) !== abs) {
    console.error(`  error: basename collision — two different GeoJSON files share the name "${basename}"`);
    process.exit(1);
  }
  seenBasename.set(basename, abs);
  copy(abs, path.join(PUBLIC, basename));
}

const b = base.endsWith('/') ? base : base + '/';
const viewerConfig = {
  evolutionFile: `${b}evolution.json`,
  geojsonSources: (config.sources || []).map(src => ({
    year: src.year,
    url: `${b}${path.basename(src.geojson)}`,
    key: src.key,
    ...(src.parent_key    ? { parentKey:    src.parent_key    } : {}),
    ...(src.parent_filter ? { parentFilter: src.parent_filter } : {}),
  })),
};

fs.writeFileSync(path.join(PUBLIC, 'config.json'), JSON.stringify(viewerConfig, null, 2) + '\n');
console.log('  wrote: viewer/public/config.json');
