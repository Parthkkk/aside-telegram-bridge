/**
 * Remote browser control, through the exact same facade every other read
 * in this server already uses (`aside repl`, via `facade.ts`). Section 7
 * of the build plan: a tab deck, page peek, and watch mode -- the one
 * capability nobody else in the category has (a real screenshot of the
 * real page on the real machine, not a diff).
 *
 * `aside repl "<js>"` spawns a fresh ~139MB binary PER CALL (see
 * `facade.ts`'s own docs) rather than holding a persistent REPL scope
 * across calls. That is what makes the "orphaned attached tab" risk in the
 * plan's risk register mostly moot here: `attachBrowserTab` only lives for
 * the lifetime of the one process that called it, and that process exits
 * the moment the script returns. There is no cross-call state to leak.
 * What IS a real risk, and what this module guards against directly, is
 * spawning too many of those 139MB processes too fast -- the plan's
 * "screenshot spam thrashes the M1 Air" risk. See `CaptureGate` below.
 */
import { FacadeCache } from './facade.js';

export class BrowserError extends Error {
  constructor(
    readonly code:
      | 'bad_url'
      | 'not_found'
      | 'rate_limited'
      | 'capture_busy'
      | 'upstream',
    message?: string,
  ) {
    super(message || code);
    this.name = 'BrowserError';
  }
}

export interface BrowserTab {
  id: string;
  targetId: string;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  faviconUrl?: string;
}

/** JS literal for a string interpolated into a repl expression. */
function lit(value: string): string {
  return JSON.stringify(value);
}

function isBrowserTab(value: unknown): value is BrowserTab {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as BrowserTab).targetId === 'string'
  );
}

/** Tab list. Cheap and read-only, so it goes through the normal TTL cache. */
export async function listTabs(cache: FacadeCache): Promise<BrowserTab[]> {
  const rows = await cache.call<unknown>(
    'browser:tabs',
    'listBrowserTabs()',
    2_000,
  );
  return Array.isArray(rows) ? rows.filter(isBrowserTab) : [];
}

/**
 * Open a URL in a new tab and hand back its targetId.
 *
 * `openTab` itself does not return a targetId (Playwright pages don't
 * carry one), so this re-lists tabs from WITHIN the same script -- one
 * process, one moment in time -- and matches on exact URL. A redirect
 * that lands somewhere else by the time `listBrowserTabs` runs would miss
 * that match; the fallback is whichever tab is now `active`, since opening
 * a tab focuses it. Best-effort, and documented as such in the return
 * type: `targetId` can be `null` on a redirect this heuristic could not
 * follow, in which case the caller should fall back to `listTabs`.
 */
export async function openNewTab(
  cache: FacadeCache,
  rawUrl: string,
): Promise<{ targetId: string | null; url: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BrowserError('bad_url', 'not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserError('bad_url', 'only http/https URLs may be opened');
  }

  const script = `(async () => {
    const p = await openTab(${lit(parsed.toString())});
    const finalUrl = p.url();
    const rows = await listBrowserTabs();
    const exact = rows.find((t) => t.url === finalUrl);
    const active = rows.find((t) => t.active);
    const match = exact || active || null;
    return { targetId: match ? match.targetId : null, url: finalUrl };
  })()`;

  const result = await cache.mutate(script);
  const record = (result || {}) as { targetId?: string | null; url?: string };
  return { targetId: record.targetId ?? null, url: record.url || parsed.toString() };
}

/** Close a tab by targetId. Returns false rather than throwing when it is already gone -- a stale Tab Deck entry closing itself is not an error. */
export async function closeTab(
  cache: FacadeCache,
  targetId: string,
): Promise<boolean> {
  const script = `(async () => {
    const rows = await listBrowserTabs();
    const target = rows.find((t) => t.targetId === ${lit(targetId)});
    if (!target) return { closed: false };
    const p = await attachBrowserTab(${lit(targetId)});
    await closeTab(p);
    return { closed: true };
  })()`;
  const result = await cache.mutate(script);
  return Boolean((result as { closed?: boolean } | null)?.closed);
}

export interface PageSnapshot {
  tree: string;
  capturedAt: number;
}

/**
 * A structured accessibility-tree read of a tab -- cheaper than a
 * screenshot and useful for "what does this page actually say" rather
 * than "what does it look like". Short TTL cache: unlike a screenshot,
 * re-reading a snapshot a few times in a row for the same tab is cheap
 * enough to memoize, and a page mid-navigation benefits from not
 * re-spawning a process for every rapid poll.
 */
export async function snapshotTab(
  cache: FacadeCache,
  targetId: string,
): Promise<PageSnapshot> {
  const script = `(async () => {
    const rows = await listBrowserTabs();
    if (!rows.find((t) => t.targetId === ${lit(targetId)})) return null;
    const p = await attachBrowserTab(${lit(targetId)});
    const s = await snapshot(p, { interactive: true });
    return { tree: s.tree };
  })()`;
  const result = await cache.call<{ tree: string } | null>(
    `browser:snapshot:${targetId}`,
    script,
    5_000,
  );
  if (!result) throw new BrowserError('not_found', 'tab not found');
  return { tree: result.tree, capturedAt: Date.now() };
}

export interface CaptureResult {
  /** Raw base64 WebP bytes -- callers decide whether to wrap as a data URL or serve as `image/webp` directly. */
  base64: string;
  url: string;
  capturedAt: number;
}

const MIN_WIDTH = 240;
const MAX_WIDTH = 1600;
const MIN_QUALITY = 10;
const MAX_QUALITY = 100;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * A live screenshot of a tab. NEVER cached -- a stale screenshot presented
 * as live is a correctness bug the plan calls out explicitly (7.3). Rate
 * limiting is the caller's job via `CaptureGate`, not this function's: it
 * always does exactly one facade call when invoked.
 *
 * Deliberately does not touch viewport size. This is the owner's REAL,
 * already-open browser window on their REAL machine -- resizing it on
 * every phone-initiated capture would be visibly disruptive on the desktop
 * they are sitting in front of. `width` only affects the client's request
 * intent (documented on the route), not anything sent to Playwright here;
 * resizing for a requested capture width is a resampling job for whoever
 * renders the WebP, not this module.
 */
export async function captureTab(
  cache: FacadeCache,
  targetId: string,
  opts: { quality?: number } = {},
): Promise<CaptureResult> {
  const quality = clamp(opts.quality ?? 55, MIN_QUALITY, MAX_QUALITY);
  const script = `(async () => {
    const rows = await listBrowserTabs();
    if (!rows.find((t) => t.targetId === ${lit(targetId)})) return null;
    const p = await attachBrowserTab(${lit(targetId)});
    const buf = await p.screenshot({ type: 'webp', quality: ${quality} });
    return { base64: buf.toString('base64'), url: p.url() };
  })()`;
  const result = await cache.mutate(script);
  const record = result as { base64?: string; url?: string } | null;
  if (!record?.base64) throw new BrowserError('not_found', 'tab not found');
  return { base64: record.base64, url: record.url || '', capturedAt: Date.now() };
}

/**
 * Enforces the plan's 7.3 capture discipline: one concurrent capture
 * GLOBALLY (every capture spawns a 139MB process; two at once is exactly
 * the thrash risk the plan names), and a 2s floor between captures of the
 * SAME tab (Watch Mode's own interval is >= 3s, so this only ever bites a
 * client polling faster than that, which is exactly what it should catch).
 *
 * A per-turn ceiling (100 captures) is a Watch Mode concept tied to a
 * running turn, not a tab -- that counter lives with whatever drives
 * Watch Mode (the route handler / a future watch-session tracker), not
 * here.
 */
export class CaptureGate {
  private lastByTab = new Map<string, number>();
  private inFlight = false;

  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    const last = this.lastByTab.get(targetId) ?? 0;
    if (this.now() - last < 2_000) {
      throw new BrowserError('rate_limited', 'capture this tab again in a moment');
    }
    if (this.inFlight) {
      throw new BrowserError('capture_busy', 'another capture is already running');
    }
    this.inFlight = true;
    try {
      const result = await fn();
      this.lastByTab.set(targetId, this.now());
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

export { MIN_WIDTH, MAX_WIDTH };
