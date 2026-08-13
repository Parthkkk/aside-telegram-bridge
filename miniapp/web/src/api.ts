/** REST + WebSocket client. Same origin as the SPA. */
import type {
  ArtifactGroup,
  ArtifactsResponse,
  AuthResponse,
  BrowserTab,
  ChildSteps,
  CitationSource,
  Entry,
  ErrorAlert,
  MessagesResponse,
  MemoryNode,
  MiniappSettings,
  RoutineRow,
  SearchHit,
  SessionRow,
  StatusResponse,
  TabCapture,
  ThreadItem,
  ThreadResponse,
  ThreadStats,
  Todo,
  UploadedFile,
  BrowserHistoryResponse,
  OmniboxResponse,
  BrowseRecentResponse,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`${status}: ${reason}`);
    this.name = 'ApiError';
  }
}

let authToken = '';

export function setAuthToken(token: string): void {
  authToken = token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (authToken) headers.set('authorization', `Bearer ${authToken}`);

  // `same-origin` rather than the default: the server keeps a long-lived
  // HttpOnly session cookie that lets the installed app recover its token
  // after localStorage has been cleared, and the cookie only rides along if
  // credentials are asked for explicitly.
  const res = await fetch(path, { ...init, credentials: 'same-origin', headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, body.reason || body.error || res.statusText);
  }
  return body as T;
}

export const api = {
  auth: (initDataRaw: string) =>
    request<AuthResponse>('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ initDataRaw }),
    }),

  /**
   * Standalone bootstrap for the installed app.
   *
   * Same JWT spine as `auth`, different front door: there is no Telegram to
   * hand us an initData blob when the app was opened from the home screen.
   */
  pair: (key: string) =>
    request<{ token: string; name?: string; expiresIn: number }>('/api/pair', {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  /**
   * Trade the session cookie for a fresh token.
   *
   * Called at boot when the app has nothing usable in storage. A 401 here
   * is the genuine "never paired, or paired too long ago" case; anything
   * else means the token survived and the owner is not asked to re-pair.
   */
  session: () =>
    request<{ token: string; name?: string; expiresIn: number }>(
      '/api/session',
    ),

  /**
   * The Aside browser's own visit history, straight from the desktop
   * profile. Cheap enough (an indexed read of a local SQLite file) to call
   * whenever the panel opens.
   */
  browserHistory: (query = '', limit = 40, signal?: AbortSignal) =>
    request<BrowserHistoryResponse>(
      `/api/history/browser?q=${encodeURIComponent(query)}&limit=${limit}`,
      { signal },
    ),

  /**
   * Address-bar suggestions: Google's live suggestions blended with what
   * has been visited on either device.
   *
   * Called per keystroke, so the caller is expected to debounce and to
   * pass a signal. The server never fails this call for a slow upstream:
   * a suggest timeout degrades to a history-only list rather than an
   * error, because there is nothing useful a typeahead can say about a
   * network problem.
   */
  omnibox: (query: string, signal?: AbortSignal) =>
    request<OmniboxResponse>(`/api/omnibox?q=${encodeURIComponent(query)}`, {
      signal,
    }),

  /** Unified recent history across both devices. */
  browseRecent: (limit = 60, signal?: AbortSignal) =>
    request<BrowseRecentResponse>(`/api/browse/recent?limit=${limit}`, {
      signal,
    }),

  /**
   * Record a search or page open made on the phone.
   *
   * Fire-and-forget by design: this feeds the address bar's ranking, and
   * a failed write is not worth interrupting a navigation the owner has
   * already committed to.
   */
  recordVisit: (input: { kind: 'search' | 'page'; title: string; url: string }) =>
    request<{ visit: unknown }>('/api/browse/visit', {
      method: 'POST',
      body: JSON.stringify(input),
    }).catch(() => undefined),

  /**
   * Speech to text, decoded on the Mac.
   *
   * Deliberately not routed through `request`: this is multipart, not JSON,
   * and setting a content-type by hand would strip the boundary the server
   * needs to parse the body.
   */
  transcribe: async (audio: Blob, signal?: AbortSignal): Promise<string> => {
    const form = new FormData();
    // The extension is a hint for ffmpeg's sniffer, nothing more -- it probes
    // the real container regardless of what we claim here.
    form.append('audio', audio, 'recording.webm');
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch('/api/transcribe', {
      method: 'POST',
      body: form,
      headers,
      signal,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ApiError(res.status, body.reason || body.error || res.statusText);
    }
    return String(body.text || '');
  },

  sessions: (limit = 100) =>
    request<{ sessions: SessionRow[]; source: string }>(
      `/api/sessions?limit=${limit}`,
    ),

  /** Primary thread read: structured, from the daemon's own transcript. */
  thread: (sessionId: string) =>
    request<ThreadResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/thread`,
    ),

  /**
   * Raw transcript entries.
   *
   * Kept because `/api/sessions/:id/messages` is still served, but note that
   * nothing in this app calls it: rounds 1-2 polled it, and round 3 replaced
   * that with server-built thread deltas over the socket. It is a debugging
   * affordance now, not a code path.
   */
  messages: (sessionId: string, afterLine = -1) =>
    request<MessagesResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?afterLine=${afterLine}`,
    ),

  send: (
    sessionId: string,
    payload: {
      text: string;
      model?: string;
      effort?: string;
      attachments?: string[];
    },
  ) =>
    request<{ accepted: boolean; queued: number; busy: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/send`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  newSession: (payload: {
    text: string;
    model?: string;
    effort?: string;
    attachments?: string[];
    permissionMode?: string;
    finalConfirm?: boolean;
  }) =>
    request<{ sessionId: string; accepted: boolean }>('/api/sessions/new', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /**
   * Change a session's permission mode / confirm-before-acting toggle.
   *
   * The response echoes what the server now has, read back from its own
   * state, so the UI checkmarks reality rather than the request.
   * `softConfirm` says which meaning the toggle took: on a session driven
   * from a phone it is the soft protocol, never the daemon's native flag.
   */
  permission: (
    sessionId: string,
    payload: { mode?: string; finalConfirm?: boolean },
  ) =>
    request<{
      ok: boolean;
      permission: string | null;
      permissionMode: string | null;
      finalConfirm: boolean | null;
      softConfirm?: boolean;
      appliesFrom: string;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  /**
   * Start a new session that carries on from one stuck on a native
   * question.
   *
   * Nothing can answer the stuck session's prompt from here -- the daemon
   * holds it for the desktop sidepanel. So the way forward is a fresh
   * session seeded with what was asked and what the user chose. The server
   * reads the question from the transcript itself; `answer` is the only
   * part the client supplies.
   */
  recover: (
    sessionId: string,
    payload: { answer: string; model?: string; effort?: string },
  ) =>
    request<{ sessionId: string; accepted: boolean; from: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/recover`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /**
   * Delete a chat.
   *
   * Server-side this archives rather than destroys -- the daemon has no
   * destructive session verb, and archived sessions are already excluded
   * from every list this app reads, so the phone-visible effect is total.
   * Named `deleteSession` because that is what the button says and what
   * the user means; the server comment carries the nuance.
   */
  deleteSession: (sessionId: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),

  /**
   * Mute push notifications for a session. `hours` defaults to 24,
   * clamped server-side to 1..720.
   */
  mute: (sessionId: string, hours?: number) =>
    request<{ ok: boolean; mutedForHours: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/mute`,
      { method: 'POST', body: JSON.stringify(hours ? { hours } : {}) },
    ),

  /** Unmute push notifications for a session. */
  unmute: (sessionId: string) =>
    request<{ ok: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/unmute`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /**
   * Upload files. `sessionId` is optional -- the home composer has no
   * session yet, and the paths are handed back either way.
   */
  upload: async (files: File[], sessionId?: string) => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    const headers = new Headers();
    // NB: content-type is deliberately NOT set. The browser has to add the
    // multipart boundary itself, and setting it by hand breaks the parse.
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);

    const path = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/attachments`
      : '/api/attachments';
    const res = await fetch(path, { method: 'POST', body: form, headers });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new ApiError(res.status, body.reason || body.error || res.statusText);
    }
    return body as { files: UploadedFile[] };
  },

  /**
   * Stop the running turn.
   *
   * The server kills the driver child it owns, by PID. A 409 means there
   * was nothing running -- which is not an error worth surfacing, the
   * composer re-enables either way.
   */
  stop: (sessionId: string) =>
    request<{ ok: boolean; stopping: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /**
   * Answer a soft-protocol question by sending the choice as a message.
   *
   * Only ever used for `source: 'marker'` questions; a native pending tool
   * is answered from the desktop app and the card says so.
   */
  answer: (
    sessionId: string,
    payload: { header: string; label: string; model?: string; effort?: string },
  ) =>
    request<{ accepted: boolean; queued: number; busy: boolean }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/answer`,
      { method: 'POST', body: JSON.stringify(payload) },
    ),

  /**
   * Full-text search across transcript bodies on disk. The session list
   * already has a client-side filter over titles and previews; this finds
   * matches inside sessions nobody has open, which is the incremental
   * value. Requires a non-empty query (the server ignores short ones).
   */
  search: (query: string) =>
    request<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`),

  status: () => request<StatusResponse>('/api/status'),

  settings: () => request<{ settings: MiniappSettings }>('/api/settings'),

  saveSettings: (patch: Partial<MiniappSettings>) =>
    request<{ settings: MiniappSettings }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),

  /**
   * Extracted text of a PDF artifact (section 8.3).
   *
   * Same auth and same path containment as `artifactBlob`, but asks the
   * server to run `aside.pdf.read` and return plain text -- the phone
   * cannot render the binary, and a wall of raw bytes helps nobody.
   */
  pdfText: (sessionId: string, group: ArtifactGroup, path: string) =>
    request<{ text: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/pdf?group=${group}&path=${encodeURIComponent(path)}`,
    ),

  /** The session's own files, grouped into artifacts and attachments. */
  artifacts: (sessionId: string) =>
    request<ArtifactsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
    ),

  /**
   * One artifact's bytes.
   *
   * Fetched rather than linked so the bearer token stays in a header and
   * out of the DOM; `artifactUrl` below is only for handing a download to
   * the client, which cannot set headers.
   */
  artifactBlob: async (
    sessionId: string,
    group: ArtifactGroup,
    path: string,
  ): Promise<Blob> => {
    const headers = new Headers();
    if (authToken) headers.set('authorization', `Bearer ${authToken}`);
    const res = await fetch(artifactPath(sessionId, group, path), { headers });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.blob();
  },

  artifactUrl: (sessionId: string, group: ArtifactGroup, path: string) =>
    `${artifactPath(sessionId, group, path)}&token=${encodeURIComponent(authToken)}`,

  /**
   * A local image an answer points at, by absolute path.
   *
   * Carries the token in the query for the same reason `artifactUrl` does:
   * this URL goes into an `<img src>`, and a tag cannot set a header. The
   * server redacts query strings from its logs.
   */
  localFileUrl: (sessionId: string, absPath: string) =>
    `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(
      absPath,
    )}&token=${encodeURIComponent(authToken)}`,

  /**
   * This account's memory tree (plan 8.1). Read-only: the server has no
   * write route, by construction. Directories first, then files, both
   * alphabetical; only `.md`/`.markdown`/`.txt` appear.
   */
  memoryTree: () => request<{ tree: MemoryNode[] }>('/api/memory'),

  /** Raw markdown/text content of one memory page. */
  memoryFile: (relPath: string) =>
    request<{ content: string }>(
      `/api/memory/file?path=${encodeURIComponent(relPath)}`,
    ),

  /**
   * Scheduled routines (plan 8.2). Read-only at the daemon level:
   * `aside.routines` exposes `list`/`get` only, verified in the plan's
   * own section 1.4. The shape of each row is whatever the facade hands
   * back, so the caller must inspect at runtime.
   */
  routines: () => request<{ routines: RoutineRow[] }>('/api/routines'),

  // --- browser surfaces (Day 3) ---------------------------------------

  tabs: () => request<{ tabs: BrowserTab[] }>('/api/tabs'),

  openTab: (url: string) =>
    request<{ targetId: string | null; url: string }>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  closeTab: (targetId: string) =>
    request<{ closed: boolean }>(`/api/tabs/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
    }),

  /**
   * The server enforces a 2s-per-tab / 1-global-concurrent capture limit
   * and answers a violation with 429/409 (see `browser.ts`'s `CaptureGate`)
   * -- callers polling this (Watch Mode) must treat those as "skip this
   * tick", not as an error to surface.
   */
  captureTab: (targetId: string, quality = 55) =>
    request<TabCapture>(
      `/api/tabs/${encodeURIComponent(targetId)}/capture?q=${quality}`,
    ),

  snapshotTab: (targetId: string) =>
    request<{ tree: string; capturedAt: number }>(
      `/api/tabs/${encodeURIComponent(targetId)}/snapshot`,
    ),

  /**
   * A real fetchable URL for a capture, token in the query the same way
   * `artifactUrl`/`localFileUrl` do -- for an `<img src>` (cheaper than
   * holding a giant base64 string in JS memory) and for `shareToStory`,
   * which fetches media itself and does not accept a `data:` URL. Append
   * a cache-busting param yourself (e.g. `&t=${Date.now()}`) when polling
   * the same tab repeatedly, since the browser would otherwise cache the
   * first response against this URL.
   */
  captureUrl: (targetId: string, quality = 55) =>
    `/api/tabs/${encodeURIComponent(targetId)}/capture.webp?q=${quality}&token=${encodeURIComponent(authToken)}`,
};

function artifactPath(
  sessionId: string,
  group: ArtifactGroup,
  path: string,
): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/file?group=${group}&path=${encodeURIComponent(path)}`;
}

export type SocketEvent =
  | { type: 'ready' }
  | { type: 'subscribed'; sessionId: string; busy: boolean; queued: number; length: number }
  /** Replace items from `fromIndex` onward; `length` is the new total. */
  | { type: 'thread_delta'; sessionId: string; fromIndex: number; items: ThreadItem[]; length: number }
  /** Token counters and the citation catalog; moves independently of items. */
  | {
      type: 'thread_meta';
      sessionId: string;
      stats: ThreadStats;
      sources: Record<string, CitationSource>;
      todos: Todo[];
    }
  /** One subagent's own timeline, as it works. */
  | ({ type: 'subagent_delta'; sessionId: string } & ChildSteps)
  /** Provisional text off the running child's stdout. */
  | { type: 'stream_delta'; sessionId: string; text: string }
  | { type: 'entries'; sessionId: string; entries: Entry[] }
  | { type: 'turn_started'; sessionId: string; model: string; effort: string; startedAt: number }
  | {
      type: 'turn_finished';
      sessionId: string;
      exitCode: number | null;
      durationMs: number;
      error?: string;
      /** The failure as a card; drawn by `ErrorCard`. */
      alert?: ErrorAlert;
      /** The user tapped Stop. Not a failure. */
      stopped?: boolean;
      /** The driver was reaped because the session suspended on a question. */
      suspended?: boolean;
    }
  | { type: 'error'; reason: string }
  | { type: 'pong' };

/**
 * Live thread socket with reconnect.
 *
 * A reconnect resubscribes from scratch, and the server answers a fresh
 * subscribe by treating what is on disk as the baseline. Anything that
 * landed while the socket was down therefore arrives with the next change
 * or, at the latest, on the forced resync at `turn_finished` -- and
 * `resync()` is there for a client that knows it has fallen behind.
 */
export class TranscriptSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: number | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly onEvent: (event: SocketEvent) => void,
    private readonly onOpenState?: (connected: boolean) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(
      authToken,
    )}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onOpenState?.(true);
      ws.send(
        JSON.stringify({ type: 'subscribe', sessionId: this.sessionId }),
      );
    };
    ws.onmessage = (event) => {
      try {
        this.onEvent(JSON.parse(event.data) as SocketEvent);
      } catch {
        // ignore unparsable frames
      }
    };
    ws.onclose = () => {
      this.onOpenState?.(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(500 * 2 ** this.retry, 10_000);
    this.retry += 1;
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  /** Ask the server to re-send the whole thread. */
  resync(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resync' }));
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
