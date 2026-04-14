import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EvolutionMap, type EvolutionMapProps } from './EvolutionMap';
import cssText from './index.css?inline';

let injected = false;
function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.setAttribute('data-janapada', '');
  style.textContent = cssText;
  document.head.appendChild(style);
}

const roots = new WeakMap<Element, Root>();

export function init(container: Element | string, props: EvolutionMapProps): void {
  injectStyles();
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) throw new Error(`Janapada: container not found: ${container}`);
  const root = createRoot(el);
  roots.set(el, root);
  root.render(createElement(EvolutionMap, props));
}

export function destroy(container: Element | string): void {
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) return;
  roots.get(el)?.unmount();
  roots.delete(el);
}

export type { EvolutionMapProps, GeoJSONSource, EvolutionData, EvoNode } from './EvolutionMap';
