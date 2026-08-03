/**
 * Page Peek: a live screenshot of one tab (plan 7.3).
 *
 * The image is loaded via a real URL (`api.captureUrl`), not a JSON data
 * URL held in state -- cheaper on memory, and it is what `shareToStory`
 * needs anyway (Telegram fetches the media itself; it does not accept a
 * `data:` URL, see `telegram.ts`).
 *
 * The capture timestamp is drawn ON screen deliberately: a stale
 * screenshot presented as live is a correctness bug, not a cosmetic one.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, Spinner } from './Icons';
import { api } from '../api';
import { canShareToStory, downloadFile, haptic, shareToStory } from '../telegram';
import { relativeTime } from '../utils/time';
import type { BrowserTab } from '../types';

const MIN_REFRESH_MS = 2_000;

export function PagePeek({
  tab,
  onClose,
}: {
  tab: BrowserTab;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const lastRefresh = useRef(0);

  const refresh = () => {
    const now = Date.now();
    // Mirrors the server's own 2s-per-tab floor (`CaptureGate`) so a
    // trigger-happy tap does not just draw a 429 the user has to see.
    if (now - lastRefresh.current < MIN_REFRESH_MS) return;
    lastRefresh.current = now;
    setLoading(true);
    setError(null);
    setSrc(`${api.captureUrl(tab.targetId)}&t=${now}`);
    setCapturedAt(now);
  };

  useEffect(refresh, [tab.targetId]);

  return (
    <div className="app page-peek">
      <header className="thread-header">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">{tab.title || tab.url}</span>
        </span>
      </header>

      <div className="page-peek-body">
        {error ? <p className="list-empty">{error}</p> : null}
        {loading ? (
          <p className="list-empty">
            <Spinner size={16} />
          </p>
        ) : null}
        {src ? (
          <img
            className={`page-peek-image ${zoomed ? 'is-zoomed' : ''}`}
            src={src}
            alt={tab.title || tab.url}
            style={{ touchAction: 'pinch-zoom' }}
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setError('Could not capture this tab right now.');
            }}
            onDoubleClick={() => setZoomed((prev) => !prev)}
            onContextMenu={(event) => {
              // Long-press on mobile surfaces the platform's own save-image
              // menu via the native context menu -- letting it through
              // rather than preventing it is the simplest correct "save"
              // affordance here, since `downloadFile` needs a real URL,
              // which this already is.
              if (!src) event.preventDefault();
            }}
          />
        ) : null}
      </div>

      <footer className="page-peek-footer">
        <span className="page-peek-timestamp">
          {capturedAt ? `Captured ${relativeTime(capturedAt)}` : ''}
        </span>
        <span className="page-peek-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              haptic('light');
              refresh();
            }}
            aria-label="Refresh"
          >
            {loading ? <Spinner size={15} /> : <ArrowUpRight size={16} />}
          </button>
          {src ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => downloadFile(src, `${tab.targetId}.webp`)}
              aria-label="Save"
            >
              Save
            </button>
          ) : null}
          {src && canShareToStory() ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                haptic('light');
                shareToStory(src, tab.title);
              }}
              aria-label="Share to story"
            >
              Share
            </button>
          ) : null}
        </span>
      </footer>
    </div>
  );
}
