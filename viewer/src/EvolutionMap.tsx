import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import { Feature } from 'geojson';
import { Search, X } from 'lucide-react';
import { DistrictEvolution } from './DistrictEvolution';
import { norm, rawGeoCache } from './geoUtils';

export interface EvoNode {
  id: string;
  year: number;
  name: string;
  parentName: string;
  chainId: number;
  color: string;
  geojsonMatch: string | null;
  geojsonParentMatch: string | null;
  geojsonScore: number;
}

export interface EvolutionData {
  name: string;
  levels: { level1: string; level2: string };
  years: number[];
  nodes: EvoNode[];
  links: { sourceId: string; targetId: string }[];
  chains: { chainId: number; canonicalName: string; originParent: string; color: string }[];
}

export interface GeoJSONSource {
  year: number;
  /** URL to the GeoJSON file */
  url: string;
  /** GeoJSON property name for the level-2 unit (e.g. "district_name") */
  key: string;
  /** GeoJSON property name for the level-1 unit (e.g. "state_name") — optional */
  parentKey?: string;
  /**
   * Optional filter: only include features where the parentKey value contains
   * this string. Useful when a GeoJSON covers a broader area (e.g. all-India)
   * and you only want a subset (e.g. one province).
   */
  parentFilter?: string;
}

export interface EvolutionMapProps {
  /** URL to the evolution.json produced by janapada CLI */
  evolutionFile: string;
  /**
   * GeoJSON sources per year. If multiple years share the same file,
   * list the same URL — it will be fetched only once.
   */
  geojsonSources: GeoJSONSource[];
  darkMode?: boolean;
  /** Label used in the legend for "no origin-year ancestor" */
  noOriginLabel?: string;
  /** Default district name pre-loaded in the district focus view */
  defaultDistrict?: string;
  /** Which tab to show on first render: 'grid' (default), 'single', or 'district' */
  initialMode?: 'grid' | 'single' | 'district';
}

interface PanelState {
  hovered: string | null;
  clickedChainId: number | null;
  chainSets: Map<number, Set<string>>;
  colorLookup: Map<string, EvoNode>;
  darkMode: boolean;
}

const HOVER_COLOR   = '#f59e0b';
const CLICKED_COLOR = '#ef4444';

const preparedGeoCache = new Map<string, any>();
const evoCache         = new Map<string, EvolutionData>();

function prepareGeoJSON(gj: any, src: GeoJSONSource): any {
  return {
    type: 'FeatureCollection',
    features: gj.features
      .filter((f: Feature) => {
        if (!src.parentFilter || !src.parentKey) return true;
        const val = (f.properties?.[src.parentKey] || '') as string;
        return val.includes(src.parentFilter);
      })
      .map((f: Feature) => {
        const l2      = (f.properties?.[src.key]        || '').toLowerCase();
        const l1      = (f.properties?.[src.parentKey!] || '').toLowerCase();
        const display = (f.properties?.[src.key]        || '').trim();
        return { ...f, properties: { ...f.properties, _l2: l2, _l1: l1, _key: `${l1}:${l2}`, _display: display } };
      }),
  };
}

function fetchGeoJSONForYear(year: number, sources: GeoJSONSource[]): Promise<any> {
  const src = sources.find(s => s.year === year);
  if (!src) return Promise.resolve(null);

  const yearKey = String(year);
  if (preparedGeoCache.has(yearKey)) return Promise.resolve(preparedGeoCache.get(yearKey));

  const cached = rawGeoCache.get(src.url);
  const base: Promise<any> = cached
    ? Promise.resolve(cached)
    : fetch(src.url)
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
        .then(gj => { rawGeoCache.set(src.url, gj); return gj; });

  return base.then(raw => {
    const fc = prepareGeoJSON(raw, src);
    preparedGeoCache.set(yearKey, fc);
    return fc;
  });
}

function fetchEvoData(url: string): Promise<EvolutionData> {
  if (evoCache.has(url)) return Promise.resolve(evoCache.get(url)!);
  return fetch(url)
    .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
    .then(d => { evoCache.set(url, d); return d; });
}

function nodeKey(n: EvoNode): string {
  return `${(n.geojsonParentMatch || n.parentName).toLowerCase()}:${(n.geojsonMatch || '').toLowerCase()}`;
}

function initPanel(
  svgEl: SVGSVGElement,
  wrapEl: HTMLDivElement,
  fc: any,
  year: number,
  state: PanelState,
  showLabel: boolean,
  refFC: any,
  onEnter: (key: string, node: EvoNode | null, event: MouseEvent) => void,
  onLeave: () => void,
  onClick: (chainId: number | null) => void,
): (newState: PanelState) => void {
  const { darkMode } = state;
  const W = wrapEl.clientWidth || 200;
  const H = Math.round(W * (showLabel ? 1.1 : 0.9));
  const bg     = getComputedStyle(wrapEl).getPropertyValue('--map-bg').trim() || (darkMode ? 'hsl(25,8%,6%)' : 'hsl(38,30%,97%)');
  const stroke = bg;

  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();
  svg.attr('width', W).attr('height', H);
  svg.append('rect').attr('width', W).attr('height', H).attr('fill', bg);

  const pad = showLabel ? 16 : 8;
  const proj = d3.geoMercator()
    .fitExtent([[pad, pad], [W - pad, H - pad - (showLabel ? 18 : 0)]], refFC ?? fc);
  const pathFn = d3.geoPath().projection(proj);

  const g     = svg.append('g');
  const paths = g.selectAll<SVGPathElement, any>('path')
    .data(fc.features)
    .join('path')
    .attr('d', (f: any) => pathFn(f) || '')
    .attr('stroke', stroke)
    .attr('stroke-width', 0.3)
    .attr('cursor', 'pointer')
    .attr('tabindex', 0)
    .attr('role', 'button');

  const labelG = svg.append('g').attr('pointer-events', 'none');

  if (showLabel) {
    svg.append('text')
      .attr('x', W / 2).attr('y', H - 4)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11).attr('font-weight', '700')
      .attr('fill', darkMode ? '#f59e0b' : '#b45309')
      .text(String(year));
  }

  function applyStyle(s: PanelState) {
    const { hovered, clickedChainId, chainSets, colorLookup: cl, darkMode: dm } = s;
    const noData = dm ? 'hsl(25,8%,14%)' : 'hsl(35,18%,88%)';
    const clickedKeys = clickedChainId != null ? (chainSets.get(clickedChainId) ?? new Set()) : null;

    paths
      .attr('fill', (f: any) => {
        const k = f.properties._key;
        if (k === hovered) return HOVER_COLOR;
        if (clickedKeys?.has(k)) return CLICKED_COLOR;
        return cl.get(k)?.color ?? noData;
      })
      .attr('fill-opacity', (f: any) => {
        const k = f.properties._key;
        if (!hovered && !clickedKeys) return 0.85;
        return (k === hovered || clickedKeys?.has(k)) ? 1 : 0.25;
      })
      .attr('stroke-width', (f: any) => f.properties._key === hovered ? 1.2 : 0.3);

    labelG.selectAll('*').remove();
    const labeled = hovered
      ? fc.features.filter((f: any) => f.properties._key === hovered)
      : clickedKeys
      ? fc.features.filter((f: any) => clickedKeys.has(f.properties._key))
      : [];
    if (labeled.length) {
      labelG.selectAll('text')
        .data(labeled)
        .join('text')
        .attr('x', (f: any) => pathFn.centroid(f)[0])
        .attr('y', (f: any) => pathFn.centroid(f)[1] + 4)
        .attr('text-anchor', 'middle')
        .attr('font-size', showLabel ? 7 : 10).attr('font-weight', '600')
        .attr('fill', dm ? '#fff' : '#111')
        .text((f: any) => f.properties._display || f.properties._l2);
    }
  }

  paths
    .on('mouseenter', function(event: MouseEvent, f: any) {
      onEnter(f.properties._key, state.colorLookup.get(f.properties._key) ?? null, event);
    })
    .on('mouseleave', () => onLeave())
    .on('click', function(_: MouseEvent, f: any) {
      onClick(state.colorLookup.get(f.properties._key)?.chainId ?? null);
    });

  applyStyle(state);
  return (ns: PanelState) => { Object.assign(state, ns); applyStyle(ns); };
}

function Panel({
  year, fc, refFC, colorLookup, chainSets, darkMode, showLabel,
  hovered, clickedChainId, onHover, onLeave, onClick,
}: {
  year: number; fc: any; refFC: any;
  colorLookup: Map<string, EvoNode>; chainSets: Map<number, Set<string>>;
  darkMode: boolean; showLabel: boolean;
  hovered: string | null; clickedChainId: number | null;
  onHover: (k: string, n: EvoNode | null, e: MouseEvent) => void;
  onLeave: () => void;
  onClick: (id: number | null) => void;
}) {
  const svgRef     = useRef<SVGSVGElement>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);
  const updaterRef = useRef<((s: PanelState) => void) | null>(null);

  const reinit = useCallback(() => {
    if (!svgRef.current || !wrapRef.current || !fc) return;
    updaterRef.current = initPanel(
      svgRef.current, wrapRef.current, fc, year,
      { hovered, clickedChainId, chainSets, colorLookup, darkMode },
      showLabel, refFC, onHover, onLeave, onClick,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fc, year, colorLookup, chainSets, darkMode, showLabel, refFC]);

  useEffect(reinit, [reinit]);

  useEffect(() => {
    updaterRef.current?.({ hovered, clickedChainId, chainSets, colorLookup, darkMode });
  }, [hovered, clickedChainId, chainSets, colorLookup, darkMode]);

  useEffect(() => {
    const ro = new ResizeObserver(reinit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [reinit]);

  const selectedNames = useMemo(() => {
    if (clickedChainId == null) return null;
    const keys = chainSets.get(clickedChainId);
    if (!keys) return null;
    const names: string[] = [];
    for (const [key, node] of colorLookup) {
      if (keys.has(key)) names.push(node.name);
    }
    return names.length ? names : null;
  }, [clickedChainId, chainSets, colorLookup]);

  return (
    <div
      ref={wrapRef}
      className={`rounded border overflow-hidden ${darkMode ? 'bg-[hsl(25,8%,6%)] border-[hsl(25,8%,14%)]' : 'bg-[hsl(38,30%,97%)] border-[hsl(35,18%,84%)]'}`}
    >
      {showLabel && selectedNames && (
        <div className={`px-1.5 py-0.5 text-center text-[9px] font-semibold truncate leading-tight ${
          darkMode ? 'bg-[hsl(22,60%,14%)] text-[hsl(22,70%,60%)]' : 'bg-[hsl(28,80%,96%)] text-[hsl(22,62%,38%)]'
        }`}>
          {selectedNames.join(' · ')}
        </div>
      )}
      <svg ref={svgRef} className="block w-full" />
    </div>
  );
}

function SegBtn({ label, active, darkMode, onClick }: { label: string; active: boolean; darkMode: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
        active
          ? darkMode ? 'bg-[hsl(25,8%,18%)] text-amber-400' : 'bg-white text-amber-700 shadow-sm'
          : darkMode ? 'text-[hsl(30,8%,52%)] hover:text-[hsl(35,10%,78%)]' : 'text-[hsl(28,8%,44%)] hover:text-[hsl(28,20%,22%)]'
      }`}
    >
      {label}
    </button>
  );
}

export function EvolutionMap({ evolutionFile, geojsonSources, darkMode = false, noOriginLabel, defaultDistrict, initialMode = 'grid' }: EvolutionMapProps) {
  const [mode, setMode]                     = useState<'single' | 'grid' | 'district'>(initialMode);
  const [yearIdx, setYearIdx]               = useState(0);
  const [allFCs, setAllFCs]                 = useState<Map<number, any>>(new Map());
  const [evoData, setEvoData]               = useState<EvolutionData | null>(null);
  const [loading, setLoading]               = useState(true);
  const [hovered, setHovered]               = useState<string | null>(null);
  const [clickedChainId, setClickedChainId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery]       = useState('');
  const [tooltip, setTooltip]               = useState<{
    x: number; y: number; name: string; parentName: string;
    chainName?: string; originParent?: string;
    prevName?: string; nextName?: string; color: string;
  } | null>(null);

  const YEARS = useMemo(
    () => evoData?.years ?? geojsonSources.map(s => s.year).sort((a, b) => a - b),
    [evoData, geojsonSources],
  );
  const year  = YEARS[yearIdx];
  const refFC = allFCs.get(YEARS[0]) ?? null;

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    const toLoad = mode === 'grid' ? YEARS : [YEARS[0], year];
    const needed: number[] = [], cached: [number, any][] = [];
    for (const y of toLoad) {
      const fc = preparedGeoCache.get(String(y));
      if (fc) cached.push([y, fc]); else needed.push(y);
    }
    Promise.all(needed.map(y => fetchGeoJSONForYear(y, geojsonSources).then(fc => [y, fc] as [number, any])))
      .then(fetched => {
        if (ac.signal.aborted) return;
        setAllFCs(new Map([...cached, ...fetched]));
        setLoading(false);
      })
      .catch(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [mode, year, YEARS, geojsonSources]);

  useEffect(() => {
    const ac = new AbortController();
    fetchEvoData(evolutionFile)
      .then(d => { if (!ac.signal.aborted) setEvoData(d); })
      .catch(() => {});
    return () => ac.abort();
  }, [evolutionFile]);

  const derived = useMemo(() => {
    if (!evoData) return {
      colorLookups:  new Map<number, Map<string, EvoNode>>(),
      chainSets:     new Map<number, Set<string>>(),
      prevNextLookup: new Map<string, { prev?: string; next?: string }>(),
      chainMeta:     new Map<number, { name: string; parent: string }>(),
    };

    const colorLookups  = new Map<number, Map<string, EvoNode>>();
    const chainSets     = new Map<number, Set<string>>();
    for (const y of YEARS) colorLookups.set(y, new Map());

    for (const n of evoData.nodes) {
      if (!n.geojsonMatch) continue;
      const k = nodeKey(n);
      colorLookups.get(n.year)?.set(k, n);
      if (!chainSets.has(n.chainId)) chainSets.set(n.chainId, new Set());
      chainSets.get(n.chainId)!.add(k);
    }

    const nodeById = new Map(evoData.nodes.map(n => [n.id, n]));
    const fwd = new Map<string, string[]>();
    const bwd = new Map<string, string[]>();
    for (const lk of evoData.links) {
      if (!fwd.has(lk.sourceId)) fwd.set(lk.sourceId, []);
      if (!bwd.has(lk.targetId)) bwd.set(lk.targetId, []);
      fwd.get(lk.sourceId)!.push(lk.targetId);
      bwd.get(lk.targetId)!.push(lk.sourceId);
    }

    const prevNextLookup = new Map<string, { prev?: string; next?: string }>();
    for (const n of evoData.nodes) {
      if (!n.geojsonMatch) continue;
      const prevNames = (bwd.get(n.id) || []).map(id => nodeById.get(id)?.name).filter(Boolean) as string[];
      const nextNames = (fwd.get(n.id) || []).map(id => nodeById.get(id)?.name).filter(Boolean) as string[];
      const prev = prevNames.length && prevNames[0] !== n.name ? prevNames.join(', ') : undefined;
      const next = nextNames.length && !(nextNames.length === 1 && nextNames[0] === n.name) ? nextNames.join(', ') : undefined;
      prevNextLookup.set(`${n.year}:${nodeKey(n)}`, { prev, next });
    }

    const chainMeta = new Map(evoData.chains.map(c => [c.chainId, { name: c.canonicalName, parent: c.originParent }]));
    return { colorLookups, chainSets, prevNextLookup, chainMeta };
  }, [evoData, YEARS]);

  const { colorLookups, chainSets, prevNextLookup, chainMeta } = derived;

  const handleHover = useCallback((key: string, node: EvoNode | null, event: MouseEvent) => {
    setHovered(key);
    if (!node) { setTooltip(null); return; }
    const pn   = prevNextLookup.get(`${node.year}:${key}`);
    const meta = chainMeta.get(node.chainId);
    setTooltip({
      x: event.clientX, y: event.clientY,
      name: node.name, parentName: node.parentName,
      chainName:   meta?.name !== node.name ? meta?.name : undefined,
      originParent: meta?.parent !== node.parentName ? meta?.parent : undefined,
      prevName: pn?.prev, nextName: pn?.next,
      color: node.color,
    });
  }, [prevNextLookup, chainMeta]);

  const handleLeave  = useCallback(() => { setHovered(null); setTooltip(null); }, []);
  const handleClick  = useCallback((chainId: number | null) => {
    setClickedChainId(prev => prev === chainId ? null : chainId);
    setSearchQuery('');
  }, []);

  const normalizedChains = useMemo(() => {
    if (!evoData) return new Map<number, string>();
    return new Map(evoData.chains.map(c => [c.chainId, norm(c.canonicalName)]));
  }, [evoData]);

  const searchSuggestions = useMemo(() => {
    if (!evoData || !searchQuery.trim()) return [];
    const q = norm(searchQuery);
    const prefix: { chainId: number; name: string; parent: string }[] = [];
    const substr: { chainId: number; name: string; parent: string }[] = [];
    for (const chain of evoData.chains) {
      const norm = normalizedChains.get(chain.chainId) ?? '';
      const item = { chainId: chain.chainId, name: chain.canonicalName, parent: chain.originParent };
      if (norm.startsWith(q)) prefix.push(item);
      else if (norm.includes(q)) substr.push(item);
    }
    return [...prefix, ...substr].slice(0, 20);
  }, [evoData, searchQuery, normalizedChains]);

  const reset = (m: 'single' | 'grid' | 'district') => {
    setMode(m); setClickedChainId(null); setHovered(null); setTooltip(null); setSearchQuery('');
  };

  const selectedMeta    = clickedChainId != null ? chainMeta.get(clickedChainId) : null;
  const originYear      = YEARS[0];
  const level2Label     = evoData?.levels?.level2 ?? 'unit';
  const panelProps = { chainSets, darkMode, hovered, clickedChainId, onHover: handleHover, onLeave: handleLeave, onClick: handleClick };

  return (
    <div className="relative">
      <div className={`flex items-center justify-between px-3 py-2 border-b ${darkMode ? 'border-[hsl(25,8%,14%)]' : 'border-[hsl(35,16%,88%)]'}`}>
        <div className={`flex items-center gap-1 p-1 rounded-lg ${darkMode ? 'bg-[hsl(25,8%,13%)]' : 'bg-[hsl(35,20%,93%)]'}`}>
          <SegBtn label="All years"    active={mode === 'grid'}     darkMode={darkMode} onClick={() => reset('grid')} />
          <SegBtn label="Single year"  active={mode === 'single'}   darkMode={darkMode} onClick={() => reset('single')} />
          <SegBtn label={`By ${level2Label}`} active={mode === 'district'} darkMode={darkMode} onClick={() => reset('district')} />
        </div>

        <div className="flex items-center gap-2">
          <div className={`relative ${mode === 'district' ? 'hidden' : ''}`}>
            <div className={`flex items-center gap-1.5 rounded-md px-2 py-1 border text-xs ${
              darkMode ? 'bg-[hsl(25,8%,11%)] border-[hsl(25,8%,18%)] text-[hsl(35,12%,82%)]' : 'bg-white border-[hsl(35,18%,84%)] text-[hsl(28,20%,14%)]'
            }`}>
              <Search className="w-3 h-3 shrink-0 opacity-50" />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder={`Search ${level2Label}…`}
                className="bg-transparent outline-none w-28 placeholder:opacity-40"
              />
              {searchQuery && (
                <button onClick={() => { setSearchQuery(''); setClickedChainId(null); }} className="opacity-50 hover:opacity-100">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {searchSuggestions.length > 0 && (
              <div className={`absolute right-0 top-full mt-1 z-50 rounded-md shadow-lg border overflow-hidden text-xs ${
                darkMode ? 'bg-[hsl(25,8%,9%)] border-[hsl(25,8%,18%)] text-[hsl(35,12%,82%)]' : 'bg-white border-[hsl(35,18%,84%)] text-[hsl(28,20%,14%)]'
              }`} style={{ minWidth: '180px', maxHeight: '200px', overflowY: 'auto' }}>
                {searchSuggestions.map(s => (
                  <button
                    key={s.chainId}
                    onMouseDown={() => { setClickedChainId(s.chainId); setSearchQuery(''); }}
                    className={`w-full text-left px-3 py-1.5 flex flex-col gap-0.5 ${darkMode ? 'hover:bg-[hsl(25,8%,14%)]' : 'hover:bg-amber-50'}`}
                  >
                    <span className="font-medium">{s.name}</span>
                    {s.parent && <span className={`text-[10px] ${darkMode ? 'text-[hsl(30,8%,46%)]' : 'text-[hsl(28,8%,52%)]'}`}>{s.parent}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedMeta ? (
            <span className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${darkMode ? 'bg-[hsl(25,8%,14%)] text-[hsl(35,10%,82%)]' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 shrink-0" />
              {selectedMeta.name}
              {selectedMeta.parent && <span className={darkMode ? 'text-[hsl(30,8%,44%)]' : 'text-amber-600'}> · {selectedMeta.parent}</span>}
              <button onClick={() => { setClickedChainId(null); setSearchQuery(''); }} className="ml-1 opacity-50 hover:opacity-100">✕</button>
            </span>
          ) : (
            <span className={`text-xs italic hidden sm:inline ${darkMode ? 'text-[hsl(30,8%,36%)]' : 'text-[hsl(28,8%,58%)]'}`}>
              Click a {level2Label} to trace its lineage
            </span>
          )}
          {loading && <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-amber-500 shrink-0" />}
        </div>
      </div>

      {mode === 'single' && (
        <div className={`flex items-center gap-3 px-4 py-2 border-b ${darkMode ? 'border-[hsl(25,8%,14%)]' : 'border-[hsl(35,16%,92%)]'}`}>
          <span className={`text-sm font-semibold w-10 shrink-0 ${darkMode ? 'text-amber-400' : 'text-amber-700'}`}>{year}</span>
          <div className="flex-1 overflow-x-auto">
            <div className="flex items-center gap-1">
              {YEARS.map((y, i) => (
                <button key={y} onClick={() => setYearIdx(i)} className="flex-1 min-w-[28px] flex flex-col items-center gap-1 group">
                  <div className={`h-2 w-full rounded-full transition-all ${i === yearIdx ? 'bg-amber-500' : darkMode ? 'bg-[hsl(25,8%,18%)] group-hover:bg-[hsl(25,8%,22%)]' : 'bg-[hsl(35,14%,88%)] group-hover:bg-[hsl(35,14%,82%)]'}`} />
                  <span className={`text-[9px] font-mono leading-none ${i === yearIdx ? (darkMode ? 'text-amber-400' : 'text-amber-700') : (darkMode ? 'text-[hsl(30,8%,40%)]' : 'text-[hsl(28,8%,58%)]')}`}>{y}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {mode === 'single' && allFCs.get(year) && (
        <div style={{ maxHeight: 'calc(100vh - 180px)', overflow: 'hidden' }}>
          <Panel year={year} fc={allFCs.get(year)} refFC={refFC}
            colorLookup={colorLookups.get(year) ?? new Map()} showLabel={false} {...panelProps} />
        </div>
      )}

      {mode === 'grid' && (
        <div className="p-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
          {YEARS.map(y => allFCs.get(y) && (
            <Panel key={y} year={y} fc={allFCs.get(y)} refFC={refFC}
              colorLookup={colorLookups.get(y) ?? new Map()} showLabel {...panelProps} />
          ))}
        </div>
      )}

      {mode === 'district' && evoData && (
        <DistrictEvolution
          evoData={evoData}
          geojsonSources={geojsonSources}
          darkMode={darkMode}
          defaultDistrict={defaultDistrict}
        />
      )}

      <div className={`px-4 py-2 flex items-center gap-4 text-[10px] border-t ${darkMode ? 'border-[hsl(25,8%,14%)] text-[hsl(30,8%,36%)]' : 'border-[hsl(35,16%,92%)] text-[hsl(28,8%,58%)]'}`}>
        {clickedChainId != null && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500" />
            Selected lineage
          </span>
        )}
        <span className="flex items-center gap-1">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: darkMode ? 'hsl(25,8%,22%)' : 'hsl(35,14%,82%)' }} />
          {noOriginLabel ?? `No ${originYear} origin`}
        </span>
        {evoData && <span className="ml-auto">{evoData.chains.length} origin {level2Label}s</span>}
      </div>

      {tooltip && (
        <div
          className={`fixed z-50 pointer-events-none rounded-lg shadow-lg border text-xs p-3 ${
            darkMode ? 'bg-[hsl(25,8%,9%)] border-[hsl(25,8%,14%)] text-[hsl(35,12%,90%)]' : 'bg-white border-[hsl(35,18%,84%)] text-[hsl(28,20%,14%)]'
          }`}
          style={{ left: Math.min(tooltip.x + 14, window.innerWidth - 248), top: tooltip.y - 10, maxWidth: 240 }}
        >
          <div className="font-bold text-sm mb-0.5" style={{ color: tooltip.color }}>{tooltip.name}</div>
          <div className={`mb-1 text-[10px] ${darkMode ? 'text-[hsl(30,8%,52%)]' : 'text-[hsl(28,8%,44%)]'}`}>{tooltip.parentName}</div>
          {tooltip.chainName && (
            <div className={`mb-1 ${darkMode ? 'text-[hsl(30,8%,52%)]' : 'text-[hsl(28,8%,44%)]'}`}>
              Origin: <span className="font-medium">{tooltip.chainName}</span>
              {tooltip.originParent && ` (${tooltip.originParent})`}
            </div>
          )}
          {tooltip.prevName && <div><span className={darkMode ? 'text-[hsl(30,8%,42%)]' : 'text-[hsl(28,8%,54%)]'}>Carved from: </span>{tooltip.prevName}</div>}
          {tooltip.nextName && <div><span className={darkMode ? 'text-[hsl(30,8%,42%)]' : 'text-[hsl(28,8%,54%)]'}>Split into: </span>{tooltip.nextName}</div>}
        </div>
      )}
    </div>
  );
}
