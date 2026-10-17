// Sidebar panel tabs over the registered panels (DESIGN §6.8 registerPanel).
import { lazy, Suspense, type ComponentType } from 'react';
import { useLocation } from 'react-router';
import { registeredPanels, useExtensionsVersion, type PanelDescriptor } from '../../extensions';
import { pathFromLocation } from '../../features/paths';
import { ErrorBoundary } from '../ErrorBoundary';

const lazyPanels = new Map<string, ComponentType<{ activePath: string | null }>>();

function panelComponent(p: PanelDescriptor): ComponentType<{ activePath: string | null }> {
  if (p.component) return p.component;
  let c = lazyPanels.get(p.id);
  if (!c) {
    c = lazy(p.load);
    lazyPanels.set(p.id, c);
  }
  return c;
}

interface Props {
  side: 'left' | 'right';
  active: string;
  onSelect(id: string): void;
}

export function PanelTabs({ side, active, onSelect }: Props) {
  useExtensionsVersion();
  const panels = registeredPanels(side);
  const activePath = pathFromLocation(useLocation().pathname);
  const current = panels.find((p) => p.id === active) ?? panels[0];
  if (!current) return null;
  const Panel = panelComponent(current);
  return (
    <div className="panel-tabs">
      {panels.length > 1 && (
        <div className="panel-tab-strip" role="tablist" aria-label={side === 'left' ? 'Left sidebar' : 'Right sidebar'}>
          {panels.map((p) => {
            const Icon = p.icon;
            const selected = p.id === current.id;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`panel-${p.id}`}
                id={`tab-${p.id}`}
                className={`panel-tab${selected ? ' is-active' : ''}`}
                title={p.title}
                aria-label={p.title}
                onClick={() => onSelect(p.id)}
              >
                <Icon size={17} aria-hidden />
              </button>
            );
          })}
        </div>
      )}
      <div className="panel-body" role="tabpanel" id={`panel-${current.id}`} aria-labelledby={`tab-${current.id}`}>
        {panels.length === 1 && <h2 className="panel-title">{current.title}</h2>}
        <ErrorBoundary label="panel">
          <Suspense fallback={<div className="panel-empty">Loading…</div>}>
            {/* Panel comes from a module-level cache keyed by panel id, so its identity is stable. */}
            {/* eslint-disable-next-line react-hooks/static-components */}
            <Panel activePath={activePath} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
