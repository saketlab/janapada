import { useEffect, useState } from 'react';
import { Moon, Sun, Globe } from 'lucide-react';
import { EvolutionMap, type GeoJSONSource } from './EvolutionMap';

interface ViewerConfig {
  evolutionFile: string;
  geojsonSources: GeoJSONSource[];
}

export default function App() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('janapada-dark-mode');
    if (stored !== null) return stored === 'true';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  const [config, setConfig] = useState<ViewerConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('janapada-dark-mode', String(dark));
  }, [dark]);

  useEffect(() => {
    fetch('/config.json')
      .then(r => { if (!r.ok) throw new Error(`config.json not found (${r.status})`); return r.json(); })
      .then(setConfig)
      .catch(e => setError(e.message));
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="container flex items-center gap-3 h-14">
          <Globe size={20} className="text-[hsl(var(--brand-saffron-hsl))] shrink-0" />
          <span className="font-semibold text-lg tracking-tight">Janapada</span>
          <span className="text-muted-foreground text-sm">boundary evolution</span>
          <div className="flex-1" />
          <button
            onClick={() => setDark(d => !d)}
            aria-label="Toggle dark mode"
            className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </header>

      <main className="flex-1 container py-4">
        {error && (
          <div className="rounded-lg border border-border bg-muted p-4 text-sm font-mono">
            <strong>Could not load config.json:</strong> {error}
            <br /><br />
            Place a <code>config.json</code> in <code>viewer/public/</code> or run{' '}
            <code>node scripts/setup-viewer.cjs path/to/janapada.yml</code>
          </div>
        )}
        {config && (
          <EvolutionMap
            evolutionFile={config.evolutionFile}
            geojsonSources={config.geojsonSources}
            darkMode={dark}
          />
        )}
      </main>
    </div>
  );
}
