# janapada

Track how administrative boundaries split, merge, and rename over time. Each unit's lineage is color-coded forward from its earliest known boundary.

## How it works

1. Provide a **transitions CSV**: a wide table where each row is one unit's journey through time, columns are census years.
2. Provide **GeoJSON boundary files**: one per year, or shared across years.
3. Run `janapada process` with a `janapada.yml` config. It matches the CSV to the GeoJSON features and writes `evolution.json`.
4. Drop `EvolutionMap.tsx` into a React app and pass it `evolution.json` and the GeoJSON URLs.

## Requirements

Node.js 20+. Install via [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install --lts
nvm use --lts
```

Or download directly from [nodejs.org](https://nodejs.org).

## Quickstart

```bash
npm install
node cli/process.cjs examples/india-districts/janapada.yml
npm run dev
```

`npm run dev` copies the processed data into `viewer/public/` and starts the Vite dev server.

## Using your own dataset

1. Copy the example config:
   ```bash
   cp janapada.yml.example mydata/janapada.yml
   ```
2. Edit `mydata/janapada.yml` to set `levels`, `years`, `transitions`, and `sources`.
3. Process:
   ```bash
   node cli/process.cjs mydata/janapada.yml
   npm run dev -- mydata/janapada.yml
   ```

## Transition CSV format

One row per lineage chain, columns follow `{year}-{level1}` / `{year}-{level2}`:

```csv
1951-State,1951-District,1961-State,1961-District,2001-State,2001-District,2011-State,2011-District,2024-State,2024-District
Madras,Srikakulam,Andhra Pradesh,Srikakulam,Andhra Pradesh,Srikakulam,Andhra Pradesh,Srikakulam,Andhra Pradesh,Srikakulam
Madras,Srikakulam,Andhra Pradesh,Srikakulam,Andhra Pradesh,Srikakulam,Andhra Pradesh,Srikakulam,Andhra Pradesh,Parvathipuram Manyam
```

The two rows above both originate from Srikakulam in 1951. By 2024 it split: one row stays Srikakulam, the other becomes Parvathipuram Manyam.

- Empty cells mean the unit didn't exist that year.
- Splits: one source row, multiple destination rows sharing that source.
- Merges: multiple source rows converging to the same destination.
- Level names (`state`, `district`) are set in the config and can be anything.

## Config reference (`janapada.yml`)

```yaml
name: "India Districts 1951–2024"

levels:
  level1: state      # parent unit (province, region, …)
  level2: district   # child unit (municipality, county, …)

years: [1951, 1961, 1971, 1981, 1991, 2001, 2011, 2024]

transitions: ./data/transitions.csv

sources:
  - year: 1951
    geojson: ./data/1951.geojson
    key: district_name      # GeoJSON property matching level-2 values
    parent_key: state_name  # GeoJSON property matching level-1 values (optional)
    parent_filter: "Bengal" # restrict to features where parent_key contains this (optional)
  - year: 2024
    geojson: ./data/2011.geojson  # reuse a file for multiple years

fuzzy_match: true  # tolerate spelling variations

level1_aliases:
  "nct of delhi": "delhi"

level2_corrections:
  2011:
    "north twenty four parganas": "North 24 Parganas"

output: ./evolution.json

palette:
  - "#e63946"
  - "#f4a261"
```

## Viewer

```tsx
import { EvolutionMap } from './EvolutionMap';

<EvolutionMap
  evolutionFile="/evolution.json"
  geojsonSources={[
    { year: 1951, url: '/India-1951-districts.geojson', key: 'district_name', parentKey: 'state_name' },
    { year: 1961, url: '/India-1961-districts.geojson', key: 'district_name', parentKey: 'state_name' },
    { year: 2024, url: '/India-2011-districts.geojson', key: 'district_name', parentKey: 'state_name' },
  ]}
  darkMode={false}
/>
```

Fetch `evolution.json` and GeoJSON at runtime. Serve them from `public/` or any static host.

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `evolutionFile` | `string` | | URL to `evolution.json` |
| `geojsonSources` | `GeoJSONSource[]` | | `{ year, url, key, parentKey?, parentFilter? }` per year |
| `darkMode` | `boolean` | `false` | |
| `initialMode` | `string` | `'grid'` | Opening tab: `'grid'`, `'single'`, or `'district'` |
| `defaultDistrict` | `string` | | Pre-loaded district in the "By district" tab |
| `noOriginLabel` | `string` | | Legend label for units with no origin-year ancestor |

## License

MIT

> जनपद (Sanskrit janpada), "foothold of a clan"
