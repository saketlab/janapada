import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Search, X, ChevronDown } from 'lucide-react';
import { type EvolutionData, type EvoNode, type GeoJSONSource } from './EvolutionMap';
import { norm, rawGeoCache } from './geoUtils';

interface YearSlice {
  nodes: EvoNode[];
  geojson: any | null;
}

interface DistrictMatch {
  chainId: number;
  canonicalName: string;
  originParent: string;
  evolution: Record<number, YearSlice>;
}

export interface DistrictEvolutionProps {
  evoData: EvolutionData;
  geojsonSources: GeoJSONSource[];
  darkMode?: boolean;
  defaultDistrict?: string;
}

const DISTRICT_COLOR  = '#e07b39';
const EARTH_RADIUS_KM = 6371;

function computeMetrics(geojson: any): { area: number; compactness: number } | null {
  if (!geojson?.features?.length) return null;
  const collection = { type: 'GeometryCollection' as const, geometries: geojson.features.map((f: any) => f.geometry) };
  const areaSr = d3.geoArea(collection as any);
  const perimRad = d3.geoLength(collection as any);
  if (!areaSr || !perimRad) return null;
  const area = areaSr * EARTH_RADIUS_KM * EARTH_RADIUS_KM;
  const perim = perimRad * EARTH_RADIUS_KM;
  return { area, compactness: (4 * Math.PI * area) / (perim * perim) };
}

async function loadGeoJSON(src: GeoJSONSource): Promise<any> {
  if (rawGeoCache.has(src.url)) return rawGeoCache.get(src.url);
  const r = await fetch(src.url);
  if (!r.ok) throw new Error(r.statusText);
  const gj = await r.json();
  rawGeoCache.set(src.url, gj);
  return gj;
}

function extractFeatures(gj: any, nodes: EvoNode[], src: GeoJSONSource): any[] {
  if (!gj?.features) return [];
  return nodes.flatMap(node => {
    const l2 = (node.geojsonMatch || '').toLowerCase();
    const l1 = (node.geojsonParentMatch || node.parentName).toLowerCase();
    return gj.features.filter((f: any) => {
      const fl2 = (f.properties?.[src.key] || '').toLowerCase();
      const fl1 = src.parentKey ? (f.properties?.[src.parentKey] || '').toLowerCase() : '';
      return fl2 === l2 && (!src.parentKey || fl1 === l1);
    });
  });
}

function YearMap({ year, geojson, color, darkMode }: {
  year: number; geojson: any; color: string; darkMode: boolean;
}) {
  const svgRef  = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const svg  = svgRef.current;
    const wrap = wrapRef.current;
    if (!svg || !wrap || !geojson?.features?.length) return;
    const W = wrap.clientWidth || 160;
    if (!W) return;
    const H = Math.round(W * 1.2);
    const d3svg = d3.select(svg);
    d3svg.selectAll('*').remove();
    d3svg.attr('width', W).attr('height', H);

    const strokeColor = darkMode ? 'hsl(25,8%,20%)' : 'hsl(38,30%,80%)';
    const pad = 8;
    const proj = d3.geoMercator().fitExtent([[pad, pad], [W - pad, H - pad - 16]], geojson);
    const path = d3.geoPath().projection(proj);
    const g    = d3svg.append('g');

    g.selectAll('path')
      .data(geojson.features)
      .join('path')
      .attr('d', (f: any) => path(f) || '')
      .attr('fill', color)
      .attr('fill-opacity', 0.8)
      .attr('stroke', strokeColor)
      .attr('stroke-width', 0.8);

    const n = geojson.features.length;
    const fontSize = Math.max(5, Math.min(9, W / (n * 5)));
    g.selectAll('text')
      .data(geojson.features)
      .join('text')
      .attr('x', (f: any) => path.centroid(f)[0])
      .attr('y', (f: any) => path.centroid(f)[1] + 3)
      .attr('text-anchor', 'middle')
      .attr('font-size', fontSize)
      .attr('font-weight', '600')
      .attr('fill', darkMode ? '#fff' : '#111')
      .attr('pointer-events', 'none')
      .text((f: any) => {
        const p = f.properties || {};
        return p.district_name || p.name || p.NAME || '';
      });

    d3svg.append('text')
      .attr('x', W / 2).attr('y', H - 5)
      .attr('text-anchor', 'middle').attr('font-size', 10).attr('font-weight', '700')
      .attr('fill', darkMode ? '#f59e0b' : '#b45309')
      .text(String(year));
  }, [geojson, year, color, darkMode]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(draw);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [draw]);

  const metrics = useMemo(() => computeMetrics(geojson), [geojson]);

  return (
    <div ref={wrapRef} className={`rounded border overflow-hidden ${
      darkMode ? 'bg-[hsl(25,8%,6%)] border-[hsl(25,8%,14%)]' : 'bg-[hsl(38,30%,97%)] border-[hsl(35,18%,84%)]'
    }`}>
      <svg ref={svgRef} className="block w-full" />
      {metrics && (
        <div className={`px-1 pb-1 text-center leading-tight ${darkMode ? 'text-[hsl(30,8%,40%)]' : 'text-[hsl(28,8%,56%)]'}`}>
          <div className="text-[8px]">{Math.round(metrics.area).toLocaleString()} km²</div>
          <div className="text-[8px]">compact. {metrics.compactness.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
}

export function DistrictEvolution({ evoData, geojsonSources, darkMode = false, defaultDistrict = 'Hazaribagh' }: DistrictEvolutionProps) {
  const [inputValue, setInputValue]           = useState(defaultDistrict);
  const [suggestions, setSuggestions]         = useState<{ chainId: number; name: string; parent: string }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const [stateDropdownOpen, setStateDropdownOpen] = useState(false);
  const [allMatches, setAllMatches]           = useState<DistrictMatch[]>([]);
  const [selectedMatchIdx, setSelectedMatchIdx] = useState(0);

  const inputRef    = useRef<HTMLInputElement>(null);
  const suggestRef  = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const chainIndex = useMemo(() => {
    return evoData.chains.map(c => ({
      chainId:    c.chainId,
      name:       c.canonicalName,
      parent:     c.originParent,
      color:      c.color,
      normalized: norm(c.canonicalName),
    }));
  }, [evoData]);

  const nodesByChainYear = useMemo(() => {
    const m = new Map<number, Map<number, EvoNode[]>>();
    for (const n of evoData.nodes) {
      if (!m.has(n.chainId)) m.set(n.chainId, new Map());
      const byYear = m.get(n.chainId)!;
      if (!byYear.has(n.year)) byYear.set(n.year, []);
      byYear.get(n.year)!.push(n);
    }
    return m;
  }, [evoData]);

  useEffect(() => {
    const q = norm(inputValue);
    if (!q) { setSuggestions([]); setShowSuggestions(false); return; }
    const prefix: typeof suggestions = [];
    const substr: typeof suggestions = [];
    for (const c of chainIndex) {
      const item = { chainId: c.chainId, name: c.name, parent: c.parent };
      if (c.normalized.startsWith(q)) prefix.push(item);
      else if (c.normalized.includes(q)) substr.push(item);
    }
    const results = [...prefix, ...substr].slice(0, 40);
    setSuggestions(results);
    setActiveSuggestion(-1);
    setShowSuggestions(results.length > 0);
  }, [inputValue, chainIndex]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (suggestRef.current && !suggestRef.current.contains(e.target as Node) &&
          inputRef.current   && !inputRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setStateDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const search = useCallback(async (name: string) => {
    const q = norm(name);
    if (!q) return;
    setLoading(true);
    setError(null);
    setAllMatches([]);
    setSelectedMatchIdx(0);
    setShowSuggestions(false);
    setStateDropdownOpen(false);

    const hits = chainIndex.filter(c => c.normalized === q || c.name.toLowerCase() === name.toLowerCase().trim());

    if (!hits.length) {
      setError(`No district found matching "${name}".`);
      setLoading(false);
      return;
    }

    try {
      const srcByYear = new Map(geojsonSources.map(s => [s.year, s]));
      const built: DistrictMatch[] = await Promise.all(hits.map(async hit => {
        const byYear = nodesByChainYear.get(hit.chainId) ?? new Map();
        const evolution: Record<number, YearSlice> = {};

        await Promise.all(evoData.years.map(async y => {
          const nodes = byYear.get(y) ?? [];
          const src   = srcByYear.get(y);
          if (!src) { evolution[y] = { nodes, geojson: null }; return; }

          const gj       = await loadGeoJSON(src);
          const features = extractFeatures(gj, nodes, src);
          evolution[y]   = {
            nodes,
            geojson: features.length ? { type: 'FeatureCollection', features } : null,
          };
        }));

        return { chainId: hit.chainId, canonicalName: hit.name, originParent: hit.parent, evolution };
      }));

      setAllMatches(built);
    } catch (e) {
      setError('Failed to load boundary data.');
    } finally {
      setLoading(false);
    }
  }, [chainIndex, nodesByChainYear, evoData.years, geojsonSources]);

  useEffect(() => { search(defaultDistrict); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectSuggestion = (s: { name: string }) => {
    setInputValue(s.name);
    setShowSuggestions(false);
    search(s.name);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions) {
      if (e.key === 'Enter') { e.preventDefault(); search(inputValue); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault(); setActiveSuggestion(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setActiveSuggestion(i => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSuggestion >= 0 && suggestions[activeSuggestion]) selectSuggestion(suggestions[activeSuggestion]);
      else { setShowSuggestions(false); search(inputValue); }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const clear = () => {
    setInputValue(''); setAllMatches([]); setError(null);
    setShowSuggestions(false); inputRef.current?.focus();
  };

  const currentMatch = allMatches[selectedMatchIdx] ?? null;

  const bg         = darkMode ? 'bg-[hsl(25,8%,9%)]'  : 'bg-white';
  const border     = darkMode ? 'border-[hsl(25,8%,14%)]' : 'border-[hsl(35,18%,84%)]';
  const muted      = darkMode ? 'text-[hsl(30,8%,50%)]'   : 'text-[hsl(28,8%,48%)]';
  const inputCls   = darkMode
    ? 'bg-[hsl(25,8%,12%)] border-[hsl(25,8%,18%)] text-[hsl(35,12%,90%)] placeholder-[hsl(30,8%,36%)]'
    : 'bg-white border-[hsl(35,18%,84%)] text-[hsl(28,20%,14%)] placeholder-[hsl(28,8%,62%)]';
  const suggBg     = darkMode ? 'bg-[hsl(25,8%,10%)] border-[hsl(25,8%,16%)]' : 'bg-white border-[hsl(35,18%,84%)]';
  const suggHover  = darkMode ? 'hover:bg-[hsl(25,8%,14%)]' : 'hover:bg-[hsl(35,20%,96%)]';
  const suggActive = darkMode ? 'bg-[hsl(25,8%,16%)] text-amber-400' : 'bg-amber-50 text-amber-800';

  return (
    <div className="relative">
      <div className={`px-4 py-3 border-b ${border} ${bg}`}>
        <div className="relative">
          <div className="relative flex-1">
            <Search className={`absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 ${muted}`} />
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder={`Search ${evoData.levels.level2}, e.g. ${defaultDistrict}…`}
              className={`w-full pl-9 pr-8 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 ${inputCls}`}
              autoComplete="off"
              spellCheck={false}
            />
            {inputValue && (
              <button type="button" onClick={clear}
                className={`absolute right-2.5 top-1/2 -translate-y-1/2 ${muted} hover:text-current`}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {showSuggestions && (
            <div ref={suggestRef}
              className={`absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border shadow-lg overflow-hidden ${suggBg}`}
              style={{ maxHeight: 280, overflowY: 'auto' }}>
              {suggestions.map((s, i) => (
                <button key={s.chainId} type="button"
                  onMouseDown={e => { e.preventDefault(); selectSuggestion(s); }}
                  onMouseEnter={() => setActiveSuggestion(i)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-baseline justify-between gap-2 transition-colors ${
                    i === activeSuggestion ? suggActive : `${darkMode ? 'text-[hsl(35,10%,82%)]' : 'text-[hsl(28,20%,14%)]'} ${suggHover}`
                  }`}>
                  <span className="font-medium">{s.name}</span>
                  <span className={`text-xs shrink-0 ${i === activeSuggestion ? 'opacity-70' : muted}`}>{s.parent}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* State disambiguation when same name appears in multiple states */}
        {allMatches.length > 1 && (
          <div className="mt-2 flex items-center gap-2" ref={dropdownRef}>
            <span className={`text-xs ${muted}`}>Found in {allMatches.length} states:</span>
            <div className="relative">
              <button type="button" onClick={() => setStateDropdownOpen(o => !o)}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                  darkMode
                    ? 'bg-[hsl(25,8%,14%)] border-[hsl(25,8%,20%)] text-[hsl(35,10%,82%)] hover:bg-[hsl(25,8%,18%)]'
                    : 'bg-amber-50 border-amber-200 text-amber-800 hover:bg-amber-100'
                }`}>
                {currentMatch?.originParent ?? 'Select state'}
                <ChevronDown className={`h-3 w-3 transition-transform ${stateDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {stateDropdownOpen && (
                <div className={`absolute left-0 top-full mt-1 z-20 rounded-lg border shadow-lg overflow-hidden min-w-[180px] ${suggBg}`}>
                  {allMatches.map((m, i) => (
                    <button key={m.chainId} type="button"
                      onClick={() => { setSelectedMatchIdx(i); setStateDropdownOpen(false); }}
                      className={`w-full text-left text-xs px-3 py-2 transition-colors ${
                        i === selectedMatchIdx ? suggActive : `${darkMode ? 'text-[hsl(35,10%,78%)]' : 'text-[hsl(28,20%,14%)]'} ${suggHover}`
                      }`}>
                      {m.originParent}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={bg}>
        {!currentMatch && !loading && !error && (
          <div className={`py-16 text-center ${muted} text-sm`}>
            <Search className="h-10 w-10 mx-auto mb-3 opacity-25" />
            <p>Search for any {evoData.levels.level2} to see its boundaries across years.</p>
            <p className="mt-1 text-xs opacity-70">Splits, merges, and renames are all traced.</p>
          </div>
        )}

        {loading && (
          <div className={`py-16 text-center ${muted} text-sm`}>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500 mx-auto mb-3" />
            <p>Loading boundaries…</p>
          </div>
        )}

        {error && !loading && (
          <div className="px-4 py-6">
            <p className={`text-sm ${darkMode ? 'text-red-400' : 'text-red-600'}`}>{error}</p>
          </div>
        )}

        {currentMatch && !loading && (
          <div className="p-3">
            <div className={`mb-3 px-3 py-2 rounded-lg border text-xs flex items-start gap-3 ${
              darkMode ? 'bg-[hsl(25,8%,12%)] border-[hsl(25,8%,16%)]' : 'bg-amber-50 border-amber-100'
            }`}>
              <span className="mt-0.5 h-3 w-3 rounded-full shrink-0" style={{ background: DISTRICT_COLOR }} />
              <div className="min-w-0">
                <div className={`font-semibold ${darkMode ? 'text-amber-400' : 'text-amber-800'}`}>
                  {currentMatch.canonicalName}
                </div>
                <div className={`mt-0.5 ${muted}`}>{currentMatch.originParent} · origin {evoData.years[0]}</div>
                <div className={`mt-1.5 leading-relaxed ${muted}`}>
                  {evoData.years.map((y, i) => {
                    const slice  = currentMatch.evolution[y];
                    const names  = slice?.nodes.map(n => n.name);
                    const label  = names?.length ? [...new Set(names)].join(' / ') : null;
                    return (
                      <span key={y}>
                        {i > 0 && <span className="opacity-30"> → </span>}
                        <span className={label ? '' : 'opacity-30 italic'}>{label ?? String(y)}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              {evoData.years.map(y => {
                const slice     = currentMatch.evolution[y];
                const nodes     = slice?.nodes ?? [];
                const geojson   = slice?.geojson ?? null;
                const names     = nodes.length ? [...new Set(nodes.map(n => n.name))].join(' / ') : null;
                const namesDiffer = names && names !== currentMatch.canonicalName;

                return (
                  <div key={y}>
                    {nodes.length > 0 ? (
                      <>
                        {geojson ? (
                          <YearMap year={y} geojson={geojson} color={DISTRICT_COLOR} darkMode={darkMode} />
                        ) : (
                          <div className={`rounded border ${darkMode ? 'bg-[hsl(25,8%,6%)] border-[hsl(25,8%,14%)]' : 'bg-[hsl(35,18%,96%)] border-[hsl(35,18%,88%)]'}`}>
                            <div className={`aspect-[5/6] flex flex-col items-center justify-center gap-1 text-[9px] italic ${muted} opacity-60`}>
                              <span>{names}</span>
                              <span className="opacity-60">no boundary</span>
                            </div>
                            <p className={`text-center text-[9px] font-bold pb-1 ${darkMode ? 'text-amber-500' : 'text-amber-700'}`}>{y}</p>
                          </div>
                        )}
                        {namesDiffer && geojson && (
                          <p className={`mt-0.5 text-center text-[9px] leading-tight px-0.5 ${muted}`} title={names}>
                            {names}
                          </p>
                        )}
                      </>
                    ) : (
                      <div className={`rounded border ${darkMode ? 'bg-[hsl(25,8%,6%)] border-[hsl(25,8%,14%)]' : 'bg-[hsl(35,18%,96%)] border-[hsl(35,18%,88%)]'}`}>
                        <div className={`aspect-[5/6] flex items-center justify-center text-[9px] italic ${muted} opacity-50`}>
                          not extant
                        </div>
                        <p className={`text-center text-[9px] font-bold pb-1 ${darkMode ? 'text-amber-500' : 'text-amber-700'}`}>{y}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
