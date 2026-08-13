/**
 * The app shell: a sidepanel home screen and a thread screen.
 *
 * Home is the composer card over the session list -- sending from it
 * starts a new session, which is why there is no separate new-chat
 * control. The thread screen carries the reply composer and the bottom
 * bar. Model, effort and permission controls appear on both and drive the
 * same state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SessionList } from './components/SessionList';
import { Thread } from './components/Thread';
import { Composer } from './components/Composer';
import { PermissionPicker } from './components/Pickers';
import { ModelSheet } from './components/ModelSheet';
import { CitationSheet } from './components/Citations';
import { SessionPanel } from './components/SessionPanel';
import { SettingsScreen } from './components/SettingsScreen';
import { RestCue, RestHero } from './components/Rest';
import { SearchPanel } from './components/SearchPanel';
import { useSidePager } from './hooks/useSidePager';
import { StreamFooter, estimateTokens } from './components/StreamFooter';
import { TodoSection } from './components/TodoSection';
import { ErrorCard } from './components/ErrorCard';
import { ChevronLeft, Globe, PanelRight, Search, Spinner } from './components/Icons';
import { TabDeck } from './components/TabDeck';
import { WatchModeCard } from './components/WatchMode';
import type { CitationMark } from './utils/citations';
import { api, setAuthToken } from './api';
import { resolveStandaloneAuth } from './standalone';
import { PairPrompt } from './components/PairPrompt';
import { InstallHint } from './components/InstallHint';
import { useThread } from './hooks/useThread';
import { useAttachments } from './hooks/useAttachments';
import { useDockHeight } from './hooks/useDockHeight';
import { resolvePills } from './utils/pills';
import { readLocal, writeLocal } from './utils/storage';
import {
  applyTheme,
  authenticateIfEnabled,
  backButton,
  cloudStorage,
  disableClosingConfirmation,
  enableClosingConfirmation,
  haptic,
  initTelegram,
  onThemeChanged,
  readInitData,
  readStartParam,
  stashDevInitData,
} from './telegram';
import type { SessionRow, StatusResponse } from './types';

/**
 * A thread on the navigation stack.
 *
 * `parentTitle` is set when this thread was opened from a subagent card, so
 * the header can say whose subagent it is. It comes from the caller rather
 * than from another lookup: whoever navigated here already had the title on
 * screen.
 */
interface ThreadScreenState {
  id: string;
  parentTitle?: string;
}
type AuthState =
  | { phase: 'pending' }
  | { phase: 'ready'; name?: string }
  | { phase: 'failed'; reason: string }
  /** The bearer token is minted; a biometric check the owner turned on failed or was cancelled. Recoverable -- see `retryUnlock`, never a dead end. */
  | { phase: 'locked'; name?: string };

/** A trimmed session, cached for the skeleton boot render. Never anything sensitive -- title and status only. */
interface SkeletonSession {
  id: string;
  title: string;
  status: string;
  unread: boolean;
}

const SKELETON_KEY = 'sessionSkeleton';
const BIOMETRICS_KEY = 'biometricsEnabled';

type PickerState =
  | { kind: 'none' }
  | { kind: 'model'; anchor: HTMLElement }
  | { kind: 'permission'; anchor: HTMLElement };

const PROVIDER_KEY = 'miniapp.provider';
const MODEL_KEY = 'miniapp.model';
const EFFORT_KEY = 'miniapp.effort';

/**
 * The permission menu, if /status has not answered yet.
 *
 * Hard-coded rather than left empty because these three are the daemon's
 * whole enum -- it validates against exactly this list -- so there is
 * nothing to discover and no risk of showing a mode that does not exist.
 */
const FALLBACK_PERMISSION_MENU = [
  { id: 'read-only', label: 'Read only' },
  { id: 'guard', label: 'Guard' },
  { id: 'full-access', label: 'Full access' },
];

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ phase: 'pending' });
  /**
   * The open threads, innermost last. Home is the empty stack.
   *
   * A stack rather than a single screen because a subagent card opens the
   * child's own thread, and backing out of it has to land on the parent
   * rather than on the session list.
   */
  const [stack, setStack] = useState<ThreadScreenState[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [picker, setPicker] = useState<PickerState>({ kind: 'none' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** The Settings screen, opened from the model picker's Settings row. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The tab deck, opened from the home topbar.
   *
   * Separate state from `ThreadScreen`'s own copy on purpose: the two
   * screens never coexist, and threading one flag down through props would
   * couple them for no benefit.
   */
  const [homeTabsOpen, setHomeTabsOpen] = useState(false);

  /** Sessions waiting on the user, surfaced as a badge near the topbar. */
  const waitingCount = sessions.filter((s) => s.waiting).length;

  const attachments = useAttachments();

  /**
   * The home scroller and the history block inside it.
   *
   * Home is one tall scroll: a full-viewport resting panel, then the
   * session list below it. Both refs exist so the Recents cue can drive
   * the same movement the swipe does, and so backing out of a thread
   * returns to the resting panel rather than wherever the list was left.
   */
  const homeScroll = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  /*
   * The home screen's second page. Declared up here with the other hooks
   * because the screens below return early, and a hook behind a branch is
   * a hook that changes order between renders.
   */
  const pager = useSidePager((next) => haptic(next === 1 ? 'light' : 'soft'));
  // The two elements the dock-height measurement needs: the shell it
  // writes the variable onto, and the dock it measures.
  const homeShell = useRef<HTMLDivElement>(null);
  const homeDock = useRef<HTMLElement>(null);
  useDockHeight(homeShell, homeDock);

  const scrollToHistory = useCallback(() => {
    haptic('light');
    historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // A chosen model/effort sticks across launches; until one is chosen the
  // pills mirror whatever the daemon's own default is.
  const [provider, setProvider] = useState(
    () => readLocal(PROVIDER_KEY) || '',
  );
  const [modelId, setModelId] = useState(
    () => readLocal(MODEL_KEY) || '',
  );
  const [effort, setEffort] = useState(
    () => readLocal(EFFORT_KEY) || '',
  );

  /**
   * The permission a NEW session should get.
   *
   * There is no session to write to on the home screen, so the choice is
   * held here and applied right after the CLI hands back an id -- the same
   * create-then-update shape the Python bridge uses. `null` means "leave
   * the daemon's default alone", which is the honest default.
   */
  const [newMode, setNewMode] = useState<string | null>(null);
  const [newFinalConfirm, setNewFinalConfirm] = useState<boolean | null>(null);

  /**
   * Cached titles for the FIRST frame, before auth has even resolved.
   * Read once at mount -- this is a cosmetic skeleton, not live data, so it
   * does not need to react to anything. Written in `loadSessions` below.
   */
  const [skeleton, setSkeleton] = useState<SkeletonSession[]>([]);
  useEffect(() => {
    cloudStorage.getItem(SKELETON_KEY).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setSkeleton(parsed);
      } catch {
        // stale/corrupt cache -- the real load a moment later replaces it
      }
    });
  }, []);

  /**
   * Run (or re-run) the biometric gate a successful `/api/auth` sits
   * behind, when the owner has opted in via Settings. See
   * `authenticateIfEnabled` in telegram.ts for the fail-open contract:
   * this only ever resolves `false` on an explicit, granted, failed
   * attempt -- never because the feature is unsupported or unset.
   */
  const runBiometricGate = useCallback(async (name?: string) => {
    const enabled = (await cloudStorage.getItem(BIOMETRICS_KEY)) === '1';
    const ok = await authenticateIfEnabled(enabled, 'Unlock Aside');
    setAuth(ok ? { phase: 'ready', name } : { phase: 'locked', name });
  }, []);

  // --- auth ---------------------------------------------------------------
  useEffect(() => {
    initTelegram();
    applyTheme();
    const off = onThemeChanged(applyTheme);
    stashDevInitData(location.hash);

    const raw = readInitData();
    if (raw) {
      api.auth(raw).then(
        (res) => {
          setAuthToken(res.token);
          void runBiometricGate(res.user.firstName);
        },
        (err) => setAuth({ phase: 'failed', reason: (err as Error).message }),
      );
      return off;
    }

    // No initData: this is the installed app, opened from the home screen
    // rather than launched by Telegram. Same JWT spine, different front door.
    resolveStandaloneAuth().then((result) => {
      if (result.ok) {
        setAuthToken(result.token);
        void runBiometricGate(result.name);
        return;
      }
      setAuth({
        phase: 'failed',
        reason:
          result.reason === 'pair_rejected'
            ? 'That pairing link is no longer valid. Generate a new one on your Mac and paste it below.'
            : result.reason === 'unreachable'
              ? "Can't reach your Mac. Make sure it's awake and Amphetamine is on."
              : 'Not paired yet. Paste the pairing link from your Mac below.',
      });
    });
    return off;
  }, [runBiometricGate]);

  // --- data ---------------------------------------------------------------
  const loadSessions = useCallback(async () => {
    try {
      const res = await api.sessions();
      setSessions(res.sessions);
      // Cosmetic only -- trimmed to what the skeleton actually draws, and
      // small enough to stay well under CloudStorage's 4096-char value cap.
      const cache: SkeletonSession[] = res.sessions.slice(0, 12).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        unread: s.unread,
      }));
      void cloudStorage.setItem(SKELETON_KEY, JSON.stringify(cache));
    } catch {
      // The list keeps its previous contents rather than blanking out.
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  /**
   * Delete a chat from history.
   *
   * Optimistic: the row goes the instant the request is sent, because a
   * spinner on a row the user has already decided about is just latency
   * they have to watch. `loadSessions()` reconciles either way -- on
   * success it confirms, on failure it puts the row back -- so the list
   * ends up agreeing with the server rather than with this handler.
   */
  const deleteSession = useCallback(
    async (id: string) => {
      setSessions((prev) => prev.filter((session) => session.id !== id));
      try {
        await api.deleteSession(id);
      } catch {
        // Nothing to say here; the reload below is the authority on what
        // actually still exists.
      }
      void loadSessions();
    },
    [loadSessions],
  );

  useEffect(() => {
    if (auth.phase !== 'ready') return;
    void loadSessions();
    api.status().then(setStatus, () => {});
  }, [auth.phase, loadSessions]);

  // --- navigation ---------------------------------------------------------
  const screen = stack[stack.length - 1] as ThreadScreenState | undefined;

  // Keep the home list fresh so unread dots and running spinners track the
  // browser without a manual pull.
  useEffect(() => {
    if (auth.phase !== 'ready' || screen) return;
    const timer = window.setInterval(loadSessions, 8000);
    return () => window.clearInterval(timer);
  }, [auth.phase, screen, loadSessions]);

  const openThread = useCallback(
    (next: ThreadScreenState, replace = true) => {
      setStack((prev) => (replace ? [next] : [...prev, next]));
      setDraft('');
      attachments.clear();
      // Only the root thread counts as "where you left off" -- a subagent
      // push (replace=false) is a detour, not the place cold boot should
      // land back on.
      if (replace) void cloudStorage.setItem('lastSessionId', next.id);
    },
    [attachments],
  );

  /** Back: out of a subagent to its parent, or out of the last thread home. */
  const goBack = useCallback(() => {
    setStack((prev) => prev.slice(0, -1));
    setDraft('');
    attachments.clear();
    if (stack.length <= 1) {
      void loadSessions();
      void cloudStorage.removeItem('lastSessionId');
    }
  }, [loadSessions, attachments, stack.length]);

  // Deep-link continuity: land on the specific thread a push notification
  // pointed at, else whatever thread was open last. The deep link wins
  // because a fresh notification tap is a more specific intent than "wherever
  // I left off". The ref guard prevents a double-open when both fire.
  const restoredThread = useRef(false);
  useEffect(() => {
    if (auth.phase !== 'ready' || restoredThread.current) return;
    restoredThread.current = true;
    const startParam = readStartParam();
    if (startParam && startParam.startsWith('session_')) {
      const id = startParam.slice('session_'.length);
      if (id) {
        openThread({ id });
        return;
      }
    }
    void cloudStorage.getItem('lastSessionId').then((id) => {
      if (id) openThread({ id });
    });
  }, [auth.phase, openThread]);

  useEffect(() => {
    if (!screen) return undefined;
    // show() hands back its own teardown, which both unbinds and hides.
    return backButton.show(goBack);
  }, [screen, goBack]);

  // --- pills --------------------------------------------------------------
  /**
   * An explicit local pick wins; otherwise the pills mirror the daemon's
   * own account default, so someone who has never chosen sees what the
   * browser would use. The precedence lives in `resolvePills`, which is
   * tested directly.
   */
  const pills = useMemo(
    () => resolvePills(status, { provider, modelId, effort }),
    [status, provider, modelId, effort],
  );

  const permissionMenu = status?.permissionMenu?.length
    ? status.permissionMenu
    : FALLBACK_PERMISSION_MENU;

  const pickModel = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModelId(nextModel);
    writeLocal(PROVIDER_KEY, nextProvider);
    writeLocal(MODEL_KEY, nextModel);
    haptic('select');
  };

  const pickEffort = (next: string) => {
    setEffort(next);
    writeLocal(EFFORT_KEY, next);
    haptic('select');
  };

  /** The CLI takes `provider/modelId`; a bare id means "daemon default". */
  const wireModel = () =>
    pills.provider && pills.modelId
      ? `${pills.provider}/${pills.modelId}`
      : undefined;

  // --- sending ------------------------------------------------------------
  const startSession = async () => {
    const text = draft.trim();
    const files = attachments.readyPaths();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    try {
      const res = await api.newSession({
        text,
        model: wireModel(),
        effort: pills.effortId,
        attachments: files,
        permissionMode: newMode ?? undefined,
        finalConfirm: newFinalConfirm ?? undefined,
      });
      setDraft('');
      attachments.clear();
      await loadSessions();
      openThread({ id: res.sessionId });
    } catch {
      // Surfaced as an error card once the turn reports back.
    } finally {
      setSending(false);
    }
  };

  if (auth.phase === 'pending') {
    // A skeleton from LAST session's cached titles beats a bare spinner --
    // the plan's own "never a spinner on empty" rule (9.3). Falls back to
    // the spinner on a true cold start, before anything has ever cached.
    if (skeleton.length) {
      return (
        <div className="boot boot-skeleton">
          {skeleton.map((row) => (
            <div className="boot-skeleton-row" key={row.id}>
              <span className={`boot-skeleton-dot ${row.unread ? 'is-unread' : ''}`} />
              <span className="boot-skeleton-title">{row.title}</span>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="boot">
        <Spinner size={18} />
      </div>
    );
  }
  if (auth.phase === 'failed') {
    return (
      <div className="boot">
        <p className="boot-title">Can’t sign in</p>
        <p className="boot-reason">{auth.reason}</p>
        {/*
          Offered on every failure, not only the unpaired one. A rejected
          key and an unreachable Mac both leave the owner holding a link
          that might work, and the alternative on a phone is no way
          forward at all.
        */}
        <PairPrompt
          onPaired={(token, name) => {
            setAuthToken(token);
            void runBiometricGate(name);
          }}
        />
      </div>
    );
  }
  if (auth.phase === 'locked') {
    return (
      <div className="boot">
        <p className="boot-title">Locked</p>
        <p className="boot-reason">Face ID / Touch ID didn’t confirm it was you.</p>
        <button
          type="button"
          className="boot-retry"
          onClick={() => {
            haptic('light');
            void runBiometricGate(auth.name);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const openModel = (anchor: HTMLElement) => setPicker({ kind: 'model', anchor });
  const openPermission = (anchor: HTMLElement) =>
    setPicker({ kind: 'permission', anchor });
  const closePicker = () => setPicker({ kind: 'none' });

  /**
   * The open picker, with its checkmark on whatever the *caller* is
   * currently running -- the account default on home, the session's own
   * settings inside a thread.
   */
  const renderPicker = (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    softConfirm?: boolean;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
  }) =>
    picker.kind === 'model' && status ? (
      <ModelSheet
        catalog={status.catalog}
        currentProvider={current.provider}
        currentModel={current.modelId}
        effortOptions={status.effortMenu}
        currentEffort={current.effortId}
        onPickModel={pickModel}
        onPickEffort={pickEffort}
        onClose={closePicker}
        onOpenSettings={() => {
          closePicker();
          setSettingsOpen(true);
        }}
      />
    ) : picker.kind === 'permission' ? (
      <PermissionPicker
        anchor={picker.anchor}
        options={permissionMenu}
        current={current.permissionMode}
        finalConfirm={current.finalConfirm}
        softConfirm={current.softConfirm}
        onPickMode={current.onPickMode}
        onToggleConfirm={current.onToggleConfirm}
        onClose={closePicker}
      />
    ) : null;

  // Settings is a full screen rather than a sheet: it is a destination with
  // its own back affordance, which is how Aside treats it too.
  if (settingsOpen) {
    return (
      <SettingsScreen status={status} onClose={() => setSettingsOpen(false)} />
    );
  }

  if (!screen) {
    return (
      <div
        className={`app app-home${pager.page === 1 ? ' side-open' : ''}${pager.dragging ? ' side-dragging' : ''}`}
        ref={homeShell}
        {...pager.handlers}
      >
        {/*
          Home screen only. It refers to Safari's Share button, so it
          belongs on the screen the app opens to rather than inside a
          conversation the owner has deliberately navigated into.
        */}
        <InstallHint />
        {/*
          One scroller holding two full panels. The composer is NOT in it:
          it is docked below, so the software keyboard cannot push it out
          of reach and the history genuinely scrolls up from underneath it,
          which is the whole point of the layout.
        */}
        <main className="home-scroll" ref={homeScroll}>
          <section className="home-rest">
            {/*
              Browser, not Settings.
              
              Settings used to live here AND as a row at the bottom of the
              model sheet, which is two routes to a screen visited about
              once a month -- the model sheet keeps it, since that is where
              you already are when you want it.

              The tab deck earns the slot instead. It was reachable only
              from a globe icon inside a thread header, which means it was
              invisible unless you had already opened a conversation, and
              seeing what is open on the Mac is a reason to pick the phone
              up rather than something you go looking for mid-thread.
            */}
            <div className="home-topbar">
              {waitingCount > 0 ? (
                <span className="waiting-badge" aria-label={`${waitingCount} waiting`}>{waitingCount}</span>
              ) : null}
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  haptic('light');
                  pager.open();
                }}
                aria-label="Search the web"
              >
                <Search size={19} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  haptic('light');
                  setHomeTabsOpen(true);
                }}
                aria-label="Browser tabs"
              >
                <Globe size={19} strokeWidth={1.75} />
              </button>
            </div>
            <RestHero name={auth.phase === 'ready' ? auth.name : undefined} />
            <RestCue count={sessions.length} onOpen={scrollToHistory} />
          </section>
          <section className="home-history" ref={historyRef}>
            <h2 className="home-history-head">Recents</h2>
            <SessionList
              sessions={sessions}
              onOpen={(id) => openThread({ id })}
              loading={loadingSessions}
              onDelete={deleteSession}
            />
          </section>
        </main>

        <footer className="home-dock" ref={homeDock}>
          <Composer
            variant="home"
            value={draft}
            onChange={setDraft}
            onSubmit={startSession}
            pills={pills}
            onOpenModel={openModel}
            onOpenPermission={openPermission}
            permissionMode={newMode}
            attachments={attachments.items}
            onAddFiles={(files) => attachments.add(files)}
            onRemoveAttachment={attachments.remove}
            busy={sending}
            disabled={sending}
          />
        </footer>
        {renderPicker({
          ...pills,
          permissionMode: newMode,
          finalConfirm: newFinalConfirm,
          // A session started here is a mobile session by definition.
          softConfirm: true,
          onPickMode: (id) => {
            setNewMode(id);
            haptic('light');
          },
          onToggleConfirm: (next) => {
            setNewFinalConfirm(next);
            haptic('light');
          },
        })}
        {/*
          The side page rides above the home screen rather than sharing a
          transformed track with it. A transform on a common ancestor would
          become the containing block for the docked composer and the
          sheets, which is a lot of layout risk for a panel that only ever
          needs to slide in from one edge.
        */}
        <div
          className="side-page"
          style={
            pager.dragging
              ? { transform: `translate3d(calc(100% + ${pager.offset}px), 0, 0)` }
              : undefined
          }
          aria-hidden={pager.page === 0}
        >
          <SearchPanel active={pager.page === 1} onClose={pager.close} />
        </div>
        {homeTabsOpen ? (
          <TabDeck onClose={() => setHomeTabsOpen(false)} />
        ) : null}
      </div>
    );
  }

  return (
    <ThreadScreen
      key={screen.id}
      sessionId={screen.id}
      parentTitle={screen.parentTitle}
      onBack={goBack}
      onInspectSubagent={(id, parentTitle) =>
        openThread({ id, parentTitle }, false)
      }
      onOpenRecovered={(id) => {
        void loadSessions();
        openThread({ id });
      }}
      pills={pills}
      // Whether the user has actively chosen; when they have not, the
      // thread shows the session's own model rather than the account
      // default, which is a different thing.
      hasModelOverride={Boolean(modelId)}
      hasEffortOverride={Boolean(effort)}
      draft={draft}
      setDraft={setDraft}
      attachments={attachments}
      openModel={openModel}
      openPermission={openPermission}
      renderPicker={renderPicker}
    />
  );
}

function ThreadScreen({
  sessionId,
  parentTitle,
  onBack,
  onInspectSubagent,
  onOpenRecovered,
  pills,
  hasModelOverride,
  hasEffortOverride,
  draft,
  setDraft,
  attachments,
  openModel,
  openPermission,
  renderPicker,
}: {
  sessionId: string;
  /** Set when this thread was opened from a subagent card. */
  parentTitle?: string;
  onBack: () => void;
  /** Push a child thread; the second argument is THIS thread's title. */
  onInspectSubagent: (childId: string, parentTitle: string) => void;
  /** Replace this thread with the session that continues from it. */
  onOpenRecovered: (sessionId: string) => void;
  pills: {
    provider: string;
    modelId: string;
    modelLabel: string;
    effortLabel: string;
    effortId: string;
  };
  hasModelOverride: boolean;
  hasEffortOverride: boolean;
  draft: string;
  setDraft: (value: string) => void;
  attachments: ReturnType<typeof useAttachments>;
  openModel: (anchor: HTMLElement) => void;
  openPermission: (anchor: HTMLElement) => void;
  renderPicker: (current: {
    provider: string;
    modelId: string;
    effortId: string;
    permissionMode: string | null;
    finalConfirm: boolean | null;
    softConfirm?: boolean;
    onPickMode: (id: string) => void;
    onToggleConfirm: (next: boolean) => void;
  }) => React.ReactNode;
}) {
  const thread = useThread(sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const threadShell = useRef<HTMLDivElement>(null);
  const threadDock = useRef<HTMLElement>(null);
  useDockHeight(threadShell, threadDock);
  const [sending, setSending] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tabDeckOpen, setTabDeckOpen] = useState(false);
  const [citation, setCitation] = useState<CitationMark | null>(null);
  const [recovering, setRecovering] = useState(false);

  // A stray swipe-to-close should not be able to drop a running turn.
  // Cleared unconditionally on unmount so leaving the thread never leaves
  // the confirmation dangling on some other screen.
  useEffect(() => {
    if (thread.busy) enableClosingConfirmation();
    else disableClosingConfirmation();
    return () => disableClosingConfirmation();
  }, [thread.busy]);

  /**
   * What this thread is actually running.
   *
   * Precedence: an explicit choice by the user, else the model the daemon
   * has pinned to this session, else the account default. The middle case
   * is the one that was missing -- the bar used to show the account
   * default on every session regardless of what it was really using.
   */
  const effective = {
    provider: hasModelOverride
      ? pills.provider
      : thread.model?.provider || pills.provider,
    modelId: hasModelOverride
      ? pills.modelId
      : thread.model?.modelId || pills.modelId,
    modelLabel: hasModelOverride
      ? pills.modelLabel
      : thread.model?.label || pills.modelLabel,
    effortId: hasEffortOverride
      ? pills.effortId
      : thread.model?.effort || pills.effortId,
    effortLabel: hasEffortOverride
      ? pills.effortLabel
      : thread.model?.effortLabel || pills.effortLabel,
  };

  // Stay pinned to the newest content while a turn streams, but never yank
  // the view away from someone who has scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [thread.items]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const send = async () => {
    const text = draft.trim();
    const files = attachments.ready();
    if ((!text && !files.length) || sending) return;
    setSending(true);

    // The bubble goes up before the request does. This is the fix for
    // "the message I send isn't viewable right away": nothing about the
    // send needs to have succeeded for the user to see what they typed.
    thread.addPending({
      text,
      attachments: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      at: Date.now(),
    });
    setDraft('');
    attachments.clear();
    pinned.current = true;

    try {
      // Send what the bar says. Passing the session's own model explicitly
      // keeps a continuation on the model it was already using instead of
      // silently switching it to the account default.
      await api.send(sessionId, {
        text,
        model:
          effective.provider && effective.modelId
            ? `${effective.provider}/${effective.modelId}`
            : undefined,
        effort: effective.effortId,
        attachments: files.map((f) => f.path!).filter(Boolean),
      });
    } finally {
      setSending(false);
    }
  };

  /**
   * Answer a question card by sending the chosen option as a message.
   *
   * Only soft-marker questions ever reach this: a native pending tool is
   * rendered read-only, because there is no request that can answer one.
   * The echo goes up first for the same reason `send` does it -- the tap
   * should be visible immediately.
   *
   * The echo text must match `answerMessage` in server/src/questions.ts
   * exactly: `pendingIsEchoed` retires the optimistic bubble by comparing
   * it against what the transcript ends up holding, so a format that
   * drifts from the server's leaves a ghost bubble on screen for the full
   * two-minute TTL. No leading dash -- see that function for why.
   */
  const answer = async (header: string, label: string) => {
    const text = header ? `${header}: ${label}` : label;
    thread.addPending({ text, attachments: [], at: Date.now() });
    pinned.current = true;
    await api.answer(sessionId, {
      header,
      label,
      model:
        effective.provider && effective.modelId
          ? `${effective.provider}/${effective.modelId}`
          : undefined,
      effort: effective.effortId,
    });
  };

  /**
   * Carry on from a question only the desktop could answer.
   *
   * The stuck session stays stuck -- nothing can change that -- so this
   * starts a NEW one, seeded by the server from the pending question, the
   * option just tapped, and the stuck session's own opening message. The
   * new thread replaces this one on screen, because it is where the
   * conversation actually continues.
   */
  const recover = async (label: string) => {
    const res = await api.recover(sessionId, {
      answer: label,
      model:
        effective.provider && effective.modelId
          ? `${effective.provider}/${effective.modelId}`
          : undefined,
      effort: effective.effortId,
    });
    onOpenRecovered(res.sessionId);
  };

  /**
   * The composer's own way out.
   *
   * `QuestionCard`'s "Continue in a new session" button only exists when
   * the transcript parsed a proper native-question item. A session can be
   * suspended in the daemon's own status column without one -- the driver
   * gets reaped mid tool-call and the write that would have produced a
   * clean question item never lands -- and that left the blocked banner
   * telling the user to tap a button that was not anywhere on screen. This
   * is that button, always present whenever the composer is blocked.
   */
  const recoverFromComposer = async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      await recover('');
    } catch {
      thread.refresh();
    } finally {
      setRecovering(false);
    }
  };

  const setPermission = async (patch: {
    mode?: string;
    finalConfirm?: boolean;
  }) => {
    haptic('light');
    // Optimistic, then corrected by what the daemon reports back.
    thread.applyPermission({
      permission: thread.permission,
      permissionMode: patch.mode ?? thread.permissionMode,
      finalConfirm: patch.finalConfirm ?? thread.finalConfirm,
    });
    try {
      const res = await api.permission(sessionId, patch);
      thread.applyPermission({
        permission: res.permission,
        permissionMode: res.permissionMode,
        finalConfirm: res.finalConfirm,
      });
    } catch {
      // Put the truth back: re-read rather than leaving a claim we cannot
      // stand behind on screen.
      thread.refresh();
    }
  };

  return (
    <div className="app" ref={threadShell}>
      <header className="thread-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} strokeWidth={1.75} />
        </button>
        <span className="thread-titles">
          <span className="thread-title">{thread.title}</span>
          {thread.parentId ? (
            <span className="thread-subtitle">
              {parentTitle ? `Subagent of ${parentTitle}` : 'Subagent'}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            haptic('light');
            setTabDeckOpen(true);
          }}
          aria-label="Browser tabs"
        >
          <Globe size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            haptic('light');
            setPanelOpen(true);
          }}
          aria-label="Session panel"
        >
          <PanelRight size={19} strokeWidth={1.75} />
        </button>
      </header>

      <div className="thread-scroll" ref={scroller} onScroll={onScroll}>
        <WatchModeCard sessionId={sessionId} busy={thread.busy} items={thread.items} />
        {thread.loading && thread.items.length === 0 ? (
          <p className="list-empty">Loading…</p>
        ) : null}
        {thread.error && thread.items.length === 0 ? (
          <p className="list-empty">{thread.error}</p>
        ) : null}

        <Thread
          items={thread.items}
          sessionId={sessionId}
          sources={thread.sources}
          subagentSteps={thread.subagentSteps}
          onInspectSubagent={(childId) =>
            onInspectSubagent(childId, thread.title)
          }
          onOpenCitation={setCitation}
          onAnswer={answer}
          onRecover={recover}
          busy={sending || thread.busy}
          scrollElementRef={scroller}
        />

        {/*
          The footer rides on `busy` alone now. It used to also require a
          turn start time, which the server only had once the first
          assistant record landed -- so on a slow first token it appeared
          late, and on a turn that produced none it never appeared at all.
        */}
        {thread.busy ? (
          <StreamFooter
            startedAt={thread.stats.turnStartedAt}
            tokens={
              thread.stats.turnTokens + estimateTokens(thread.streamingChars)
            }
          />
        ) : null}

        {thread.alerts.map((alert, index) => (
          <ErrorCard key={index} alert={alert} />
        ))}
      </div>

      <footer className="thread-footer" ref={threadDock}>
        <Composer
          variant="reply"
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          pills={effective}
          onOpenModel={openModel}
          onOpenPermission={openPermission}
          permissionMode={thread.permissionMode}
          attachments={attachments.items}
          onAddFiles={(files) => attachments.add(files, sessionId)}
          onRemoveAttachment={attachments.remove}
          busy={sending}
          disabled={sending}
          streaming={thread.busy}
          onStop={() => void thread.stop()}
          stopping={thread.stopping}
          context={{
            used: thread.stats.totalTokens,
            window: thread.contextWindow,
          }}
          // A suspended session accepts a send and then hangs on it
          // forever, so the composer refuses rather than jamming.
          blockedReason={
            thread.suspended
              ? thread.hasRecoverableQuestion
                ? 'Waiting on a question that can only be answered from Aside on your computer.'
                : 'This session got stuck waiting on Aside on your computer and can\u2019t pick back up. Start a new chat to keep going.'
              : null
          }
          onRecover={
            thread.suspended
              ? thread.hasRecoverableQuestion
                ? recoverFromComposer
                : onBack
              : undefined
          }
          recoverLabel={
            thread.hasRecoverableQuestion
              ? 'Continue in a new session'
              : 'Back to chats'
          }
          recovering={recovering}
          above={<TodoSection todos={thread.todos} />}
        />
      </footer>

      {panelOpen ? (
        <SessionPanel
          sessionId={sessionId}
          subagents={thread.subagents}
          todos={thread.todos}
          muted={thread.muted}
          onToggleMute={(next) => thread.setMuted(next)}
          onInspectSubagent={(childId) => {
            setPanelOpen(false);
            onInspectSubagent(childId, thread.title);
          }}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}

      {citation ? (
        <CitationSheet
          mark={citation}
          sources={thread.sources}
          onClose={() => setCitation(null)}
        />
      ) : null}

      {tabDeckOpen ? <TabDeck onClose={() => setTabDeckOpen(false)} /> : null}

      {renderPicker({
        ...effective,
        permissionMode: thread.permissionMode,
        finalConfirm: thread.finalConfirm,
        softConfirm: thread.softConfirm,
        onPickMode: (id) => void setPermission({ mode: id }),
        onToggleConfirm: (next) => void setPermission({ finalConfirm: next }),
      })}
    </div>
  );
}
