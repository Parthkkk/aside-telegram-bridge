/**
 * The Tab Deck: every open tab on the Mac, from the phone (plan 7.2).
 *
 * Nobody else in the category shows you the browser at all -- Claude Code,
 * Codex, Jules, Devin, OpenHands all top out at a diff. This is the
 * capability the whole Day 3 plan leads with, so it stays close to what it
 * actually is: a live list of `listBrowserTabs()`, grouped by window
 * because that call already hands back `windowId` for free.
 */
import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { PagePeek } from './PagePeek';
import { ArrowUp, Globe, Spinner, X } from './Icons';
import { api } from '../api';
import { haptic, showConfirm } from '../telegram';
import type { BrowserTab } from '../types';

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function TabDeck({ onClose }: { onClose: () => void }) {
  const [tabs, setTabs] = useState<BrowserTab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [opening, setOpening] = useState(false);
  const [peeking, setPeeking] = useState<BrowserTab | null>(null);

  const load = () => {
    api.tabs().then(
      (res) => setTabs(res.tabs),
      (err) => setError((err as Error).message),
    );
  };

  useEffect(load, []);

  const openUrl = async () => {
    const raw = urlInput.trim();
    if (!raw) return;
    // A bare phrase like "espn" is not a URL -- the paste-and-go field is
    // for going somewhere specific, not for searching, so it gets an
    // https:// prefix rather than silently failing `new URL()` server-side.
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    haptic('light');
    setOpening(true);
    try {
      await api.openTab(withScheme);
      setUrlInput('');
      haptic('success');
      load();
    } catch {
      haptic('error');
    } finally {
      setOpening(false);
    }
  };

  const closeTab = async (tab: BrowserTab) => {
    const ok = await showConfirm(`Close "${tab.title || hostname(tab.url)}"?`);
    if (!ok) return;
    haptic('medium');
    setTabs((prev) => prev?.filter((t) => t.targetId !== tab.targetId) ?? null);
    try {
      await api.closeTab(tab.targetId);
    } catch {
      load(); // put the truth back if the close didn't actually happen
    }
  };

  if (peeking) {
    return (
      <PagePeek
        tab={peeking}
        onClose={() => setPeeking(null)}
      />
    );
  }

  const groups = new Map<number, BrowserTab[]>();
  for (const tab of tabs ?? []) {
    const list = groups.get(tab.windowId) ?? [];
    list.push(tab);
    groups.set(tab.windowId, list);
  }

  return (
    <Sheet side="bottom" title="Browser" subtitle="Open tabs on your Mac" onClose={onClose}>
      <form
        className="tab-deck-go"
        onSubmit={(event) => {
          event.preventDefault();
          void openUrl();
        }}
      >
        <input
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          placeholder="Open a URL"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="submit" disabled={opening || !urlInput.trim()} aria-label="Open">
          {opening ? <Spinner size={14} /> : <ArrowUp size={16} />}
        </button>
      </form>

      {error ? <p className="list-empty">{error}</p> : null}
      {!tabs && !error ? (
        <p className="list-empty">
          <Spinner size={14} /> Loading…
        </p>
      ) : null}
      {tabs && tabs.length === 0 ? <p className="list-empty">No open tabs.</p> : null}

      {[...groups.entries()].map(([windowId, list]) => (
        <div className="tab-deck-window" key={windowId}>
          <h3 className="tab-deck-window-head">Window</h3>
          {list.map((tab) => (
            <div className="tab-deck-row" key={tab.targetId}>
              <button
                type="button"
                className="tab-deck-row-main"
                onClick={() => {
                  haptic('light');
                  setPeeking(tab);
                }}
              >
                {tab.faviconUrl ? (
                  <img className="tab-deck-favicon" src={tab.faviconUrl} alt="" />
                ) : (
                  <Globe size={14} strokeWidth={1.75} />
                )}
                <span className="tab-deck-titles">
                  <span className="tab-deck-title">{tab.title || hostname(tab.url)}</span>
                  <span className="tab-deck-host">{hostname(tab.url)}</span>
                </span>
                {tab.active ? <span className="tab-deck-active">Active</span> : null}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Close tab"
                onClick={() => void closeTab(tab)}
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </Sheet>
  );
}
