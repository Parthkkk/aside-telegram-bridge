/**
 * Search: an address bar, and nothing else.
 *
 * This panel has been three different things, and the history is the
 * argument for what it is now.
 *
 * **First it scraped.** It drove the Mac's browser over the CLI, navigated
 * Google, pulled the `h3` tags out of the result page and redrew them
 * here. Three seconds a query, a progress bar narrating "waking browser /
 * searching Google / reading results" to make the wait survivable, and
 * what came back was a list of blue links with none of the surfaces that
 * are most of what a result page is.
 *
 * **Then it framed.** Google's real page, loaded from the phone with
 * `igu=1`, an undocumented parameter that makes Google drop
 * `X-Frame-Options` so the page can sit in an iframe. Fast, and the real
 * page. But `igu=1` is served **signed out**, and there is no way around
 * that: the parameter works precisely by detaching from the session. So
 * the owner got a "Sign in" button in the corner of his own search, no
 * personalisation, and a result page squeezed into whatever height was
 * left under the app's own chrome.
 *
 * **Now it hands off.** Because the thing being rebuilt here already
 * exists on the phone, correctly, signed in: Chrome. A Chrome Custom Tab
 * is not an imitation of the browser, it *is* the browser -- same engine,
 * same cookie jar, same saved passwords, same autofill -- rendered over
 * this app with a back button that returns here. There is no version of a
 * frame or a WebView that beats that, and two independent walls stop them
 * from trying: google.com refuses to be framed without `igu=1`, and Google
 * blocks account sign-in from WebView user agents as a standing policy.
 *
 * Handing off is also the only behaviour that is correct on every surface
 * this app runs on. In the Android shell it is a Custom Tab; in a plain
 * browser or the installed PWA it is `window.open`, which is a real Chrome
 * tab and therefore equally signed in. There is no longer a path through
 * this component that can produce a signed-out page.
 *
 * So the panel keeps the half that Chrome genuinely cannot do. Chrome on
 * the phone has no idea what the Mac has been browsing; this does, because
 * the server reads the desktop profile's own Chromium history. The
 * suggestion list under this box is the product. Everything below the tap
 * belongs to Chrome.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { OmniboxItem } from '../types';
import { openUrl, asUrl, prefetch } from '../utils/openUrl';
import { Clock, Globe, Search, X } from './Icons';

/**
 * A plain Google result URL.
 *
 * Deliberately carries no parameters beyond the query. `igu=1` is gone
 * because the page is no longer framed, and `hl`/`gl` are gone because
 * pinning them would override language and region preferences the
 * signed-in account already holds. What opens is exactly what would open
 * if the query had been typed into Chrome's own address bar.
 */
function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Debounce for the typeahead. Roughly one keystroke at typing speed. */
const SUGGEST_DEBOUNCE_MS = 120;

function timeAgo(ms: number): string {
  if (!ms) return '';
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** Favicon by domain, with a tinted initial as the fallback. */
function SourceMark({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !domain) {
    return (
      <span className="omni-mark omni-mark-fallback" aria-hidden>
        {(domain || '?').charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="omni-mark"
      src={`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function OmniRow({
  item,
  onPick,
}: {
  item: OmniboxItem;
  onPick: (item: OmniboxItem) => void;
}) {
  if (item.kind === 'search') {
    return (
      <button type="button" className="omni-row" onClick={() => onPick(item)}>
        <span className="omni-glyph" aria-hidden>
          {item.source === 'history' ? (
            <Clock size={15} strokeWidth={2} />
          ) : (
            <Search size={15} strokeWidth={2} />
          )}
        </span>
        <span className="omni-text">
          <span className="omni-primary">{item.text}</span>
        </span>
      </button>
    );
  }

  if (item.kind === 'url') {
    return (
      <button type="button" className="omni-row" onClick={() => onPick(item)}>
        <span className="omni-glyph" aria-hidden>
          <Globe size={15} strokeWidth={2} />
        </span>
        <span className="omni-text">
          <span className="omni-primary">{item.text}</span>
          <span className="omni-secondary">Go to site</span>
        </span>
      </button>
    );
  }

  return (
    <button type="button" className="omni-row" onClick={() => onPick(item)}>
      <SourceMark domain={item.domain} />
      <span className="omni-text">
        <span className="omni-primary">{item.title}</span>
        <span className="omni-secondary">
          {item.domain}
          {item.lastVisit ? ` · ${timeAgo(item.lastVisit)}` : ''}
          {item.source === 'phone' ? ' · phone' : ''}
        </span>
      </span>
    </button>
  );
}

export function SearchPanel({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<OmniboxItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  /*
   * Stale-response guard. The same incrementing-counter pattern the rest of
   * this codebase uses (`useThread`, `useAttachments`): a slower earlier
   * request must not overwrite a faster later one, which on a typeahead
   * shows up as the list flickering back to a previous prefix.
   */
  const seq = useRef(0);

  /* Suggestions, debounced, for as long as the panel is up. */
  useEffect(() => {
    if (!active) return;
    const mine = ++seq.current;
    const ac = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await api.omnibox(query, ac.signal);
        if (mine !== seq.current) return;
        setItems(res.items);
        /*
         * Tell Chrome where this is probably going.
         *
         * `mayLaunchUrl` lets it resolve DNS, open the socket and begin
         * fetching before the tap happens, which is most of the visible
         * latency in opening a Custom Tab. A hint with no contract: wrong
         * guesses cost a speculative request Chrome was willing to make,
         * right guesses make the tab feel instant. No-op off the shell.
         */
        const q = query.trim();
        if (q) prefetch(asUrl(q) ?? googleUrl(q));
      } catch {
        // A failed typeahead is not worth a visible error: the previous
        // list stays, and the next keystroke tries again.
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [query, active]);

  /* Opening the panel puts the cursor in the box, keyboard and all. */
  useEffect(() => {
    if (!active) return;
    // Focus after paint, or the software keyboard does not come up.
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [active]);

  /**
   * Hand a destination to the browser.
   *
   * The panel deliberately keeps its own state after this. The Custom Tab
   * animates in over it and its back button returns straight here, so what
   * should be waiting underneath is the address bar with the query still
   * in it, ready to be refined rather than retyped.
   */
  const open = useCallback(
    (url: string, label: string, kind: 'search' | 'page') => {
      // Recorded so the address bar on either device can see it. Fire and
      // forget: a navigation the owner already committed to should not wait
      // on a bookkeeping write.
      void api.recordVisit({ kind, title: label, url });
      inputRef.current?.blur();

      /*
       * One action, one destination.
       *
       * This briefly routed searches through ACTION_WEB_SEARCH to reach the
       * Google app, which removes the address bar. It also removed the
       * search: most handlers of that intent open their search UI with the
       * query pre-filled and *unsubmitted*, so the query had to be
       * confirmed a second time in another app. Trading one tap for a
       * cleaner header is a bad trade, and trading it silently is worse.
       *
       * A URL loads results. That is the whole reason to prefer it.
       */
      void openUrl(url);
    },
    [],
  );

  const runQuery = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q) return;
      // A typed destination is a destination. Only text that parses
      // strictly as one counts, so "node.js streams" stays a search.
      const direct = asUrl(q);
      if (direct) {
        open(direct, hostOf(direct) || direct, 'page');
        return;
      }
      open(googleUrl(q), q, 'search');
    },
    [open],
  );

  const pick = useCallback(
    (item: OmniboxItem) => {
      if (item.kind === 'search') {
        setQuery(item.text);
        runQuery(item.text);
        return;
      }
      if (item.kind === 'url') {
        open(item.url, hostOf(item.url) || item.text, 'page');
        return;
      }
      open(item.url, item.title || item.domain, 'page');
    },
    [open, runQuery],
  );

  return (
    <section className="browser-panel" aria-label="Search">
      <div className="browser-bar">
        <form
          className="browser-omni"
          onSubmit={(e) => {
            e.preventDefault();
            runQuery(query);
          }}
          role="search"
        >
          <Search size={16} strokeWidth={2} aria-hidden />
          <input
            ref={inputRef}
            className="browser-omni-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Google or type a link"
            type="text"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Search or enter address"
          />
          {query ? (
            <button
              type="button"
              className="browser-icon-btn browser-clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="Clear"
            >
              <X size={15} strokeWidth={2.25} />
            </button>
          ) : null}
        </form>

        <button type="button" className="browser-cancel" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="omni-sheet">
        {items.length === 0 ? (
          <p className="omni-empty">
            {query ? 'No suggestions' : 'Recent pages from your Mac show up here'}
          </p>
        ) : (
          <div className="omni-list">
            {items.map((item, i) => (
              <OmniRow
                key={(item.kind === 'search' ? item.text : item.url) + i}
                item={item}
                onPick={pick}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
