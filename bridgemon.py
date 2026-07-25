#!/usr/bin/env python3
"""bridgemon -- single CLI for the Aside <-> Telegram bridge.

Deploy tooling:
  bridgemon status          show launchd state + last log lines + style
  bridgemon update          git pull (if this is a repo clone), then
                             syntax-check, restart, health-check, and
                             keep or auto-rollback bridge.py
  bridgemon rollback        force-restore the last known-good bridge.py
  bridgemon logs [n]        tail last n lines of bridge.log (default 30)
  bridgemon init            bless the current bridge.py as known-good
                             without restarting (first-time setup)

Live monitor (delegates to monitor.py, same as before):
  bridgemon watch           merged live timeline + interactive kill switch
  bridgemon watch --status  snapshot and exit
  bridgemon watch --kill    stop the bridge + any in-flight turn
  bridgemon watch --start   start the bridge

Exit codes: 0 success, 1 failure (update rolled back, or command error).
"""
import os
import py_compile
import shutil
import subprocess
import sys
import time

BRIDGE_DIR = os.path.dirname(os.path.realpath(__file__))
BRIDGE_PY = os.path.join(BRIDGE_DIR, "bridge.py")
LOG_PATH = os.path.join(BRIDGE_DIR, "bridge.log")
ERR_LOG_PATH = os.path.join(BRIDGE_DIR, "launchd.err.log")
BACKUP_DIR = os.path.join(BRIDGE_DIR, "backups")
LAST_GOOD = os.path.join(BACKUP_DIR, "last-good.py")
def _uid():
    return os.getuid()


def _label_is_loaded(label):
    """True only if launchd actually knows about this label right
    now -- a plist *file* existing on disk means nothing if it was
    never bootstrapped (or was later booted out), which is exactly
    what caused a false 'not running' / bad auto-rollback before."""
    r = subprocess.run(
        ["launchctl", "print", "gui/%d/%s" % (_uid(), label)],
        capture_output=True, text=True)
    return r.returncode == 0


def _detect_label():
    """Support both the public label (setup.py installs) and legacy
    per-user labels from older manual installs. Always trust launchd's
    live registry over plist files on disk -- a stale/unused plist
    file (e.g. left over from a reinstall, or written but never
    bootstrapped) must never be picked over the label that's actually
    running the bridge."""
    agents = os.path.expanduser("~/Library/LaunchAgents")
    candidates = ["com.aside.telegram-bridge",
                  "com.saiamartya.aside-telegram-bridge"]

    loaded = [c for c in candidates if _label_is_loaded(c)]
    if len(loaded) == 1:
        return loaded[0]
    if len(loaded) > 1:
        # both registered (e.g. mid-migration) -- prefer whichever
        # actually has a live pid, so a dead/leftover registration
        # doesn't win over the real running one.
        for c in loaded:
            r = subprocess.run(
                ["launchctl", "print", "gui/%d/%s" % (_uid(), c)],
                capture_output=True, text=True)
            if "pid = " in r.stdout:
                return c
        return loaded[0]

    # nothing loaded yet (fresh install, or bridge currently stopped) --
    # fall back to whichever plist file exists on disk so `watch --start`
    # and friends still target the right label.
    for c in candidates:
        if os.path.exists(os.path.join(agents, c + ".plist")):
            return c
    return candidates[0]


LABEL = _detect_label()

HEALTH_WAIT_S = 6
HEALTH_POLL_S = 1.5


def _launchctl(*args):
    return subprocess.run(
        ["launchctl", *args], capture_output=True, text=True
    )


def _service_target():
    return "gui/%d/%s" % (_uid(), LABEL)


def is_running():
    r = _launchctl("print", _service_target())
    if r.returncode != 0:
        return False, None
    pid = None
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("pid ="):
            pid = line.split("=")[1].strip()
    return pid is not None, pid


def tail(path, n=30):
    if not os.path.exists(path):
        return []
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        block = 4096
        data = b""
        while size > 0 and data.count(b"\n") <= n:
            step = min(block, size)
            size -= step
            f.seek(size)
            data = f.read(step) + data
    return data.decode("utf-8", "replace").splitlines()[-n:]


def kickstart_restart():
    _launchctl("kickstart", "-k", _service_target())


def cmd_status(_args):
    running, pid = is_running()
    print("service:  %s" % LABEL)
    print("running:  %s%s" % (running, (" (pid %s)" % pid) if pid else ""))
    print("last-good backup: %s"
          % ("yes" if os.path.exists(LAST_GOOD) else "none yet"))
    print()
    print("last log lines:")
    for line in tail(LOG_PATH, 8):
        print("  " + line)
    return 0


def cmd_logs(args):
    n = int(args[0]) if args else 30
    for line in tail(LOG_PATH, n):
        print(line)
    return 0


def cmd_init(_args):
    if not os.path.exists(BRIDGE_PY):
        print("bridge.py not found, nothing to bless")
        return 1
    os.makedirs(BACKUP_DIR, exist_ok=True)
    shutil.copy2(BRIDGE_PY, LAST_GOOD)
    print("blessed current bridge.py as known-good (no restart done)")
    return 0


def _syntax_check():
    try:
        py_compile.compile(BRIDGE_PY, doraise=True)
        return True, ""
    except py_compile.PyCompileError as e:
        return False, str(e)


def _size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _read_from(path, offset):
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _health_check(since_ts):
    """Poll for HEALTH_WAIT_S seconds. Healthy if the process is up,
    bridge.log shows a fresh 'bridge starting' line, and no traceback
    was appended to the err log -- both measured from byte offsets
    captured at call time, so stale pre-restart log content (e.g. a
    traceback from a *previous* failed attempt) never causes a false
    positive."""
    log_offset = _size(LOG_PATH)
    err_offset = _size(ERR_LOG_PATH)
    deadline = time.time() + HEALTH_WAIT_S
    saw_start = False
    while time.time() < deadline:
        time.sleep(HEALTH_POLL_S)
        running, _ = is_running()
        if not running:
            return False, "process not running after restart"
        if "bridge starting" in _read_from(LOG_PATH, log_offset):
            saw_start = True
        new_err = _read_from(ERR_LOG_PATH, err_offset)
        if "Traceback (most recent call last)" in new_err:
            return False, "new traceback in launchd.err.log after restart"
    if not saw_start:
        return False, "never saw a fresh 'bridge starting' log line"
    return True, "ok"


def _is_git_repo():
    return os.path.isdir(os.path.join(BRIDGE_DIR, ".git"))


def _git(*args):
    return subprocess.run(
        ["git", "-C", BRIDGE_DIR, *args], capture_output=True, text=True
    )


def _git_dirty():
    """True if any *tracked* file has uncommitted changes (staged or
    not). Ignores untracked files (config.json etc. are gitignored
    anyway)."""
    r = _git("status", "--porcelain", "--untracked-files=no")
    return bool(r.stdout.strip())


def _git_pull():
    """Pull the tracked branch if this directory is a clone of the repo.
    Returns (changed, message). Refuses to touch anything if there are
    uncommitted local edits to tracked files -- a hard reset would
    silently destroy them, which is worse than a stale update."""
    if not _is_git_repo():
        return False, "not a git checkout, skipping pull (local-only mode)"
    if _git_dirty():
        return False, (
            "uncommitted local changes to tracked files -- refusing to "
            "pull (would discard them). commit or stash first, then "
            "rerun update"
        )
    r = _git("rev-parse", "--abbrev-ref", "HEAD")
    branch = r.stdout.strip() or "main"
    before = _git("rev-parse", "HEAD").stdout.strip()
    fetch = _git("fetch", "origin", branch)
    if fetch.returncode != 0:
        return False, "git fetch failed: %s" % fetch.stderr.strip()[:200]
    target = "origin/%s" % branch
    remote_head = _git("rev-parse", target).stdout.strip()
    if before == remote_head:
        return False, "already up to date (%s)" % before[:8]
    # refuse a hard reset if it would discard real local commits --
    # e.g. work committed here but not yet pushed. Only fast-forward
    # (local HEAD must already be an ancestor of the remote branch).
    ff_check = _git("merge-base", "--is-ancestor", "HEAD", target)
    if ff_check.returncode != 0:
        ahead = _git("rev-list", "--count",
                     "%s..HEAD" % target).stdout.strip()
        return False, (
            "local HEAD has %s commit(s) not on %s -- refusing to "
            "reset (would discard them). push your local commits "
            "first, then rerun update" % (ahead or "some", target)
        )
    reset = _git("reset", "--hard", target)
    if reset.returncode != 0:
        return False, "git reset failed: %s" % reset.stderr.strip()[:200]
    after = _git("rev-parse", "HEAD").stdout.strip()
    return True, "pulled %s..%s" % (before[:8], after[:8])


def cmd_update(_args):
    pulled, pull_msg = _git_pull()
    print(pull_msg)

    if not os.path.exists(BRIDGE_PY):
        print("bridge.py not found")
        return 1

    ok, err = _syntax_check()
    if not ok:
        print("syntax check failed, not deploying:\n%s" % err)
        return 1

    os.makedirs(BACKUP_DIR, exist_ok=True)
    if not os.path.exists(LAST_GOOD):
        # first run: nothing to roll back to yet, just bless + go
        shutil.copy2(BRIDGE_PY, LAST_GOOD)

    same_as_live = (
        os.path.exists(LAST_GOOD)
        and open(BRIDGE_PY, "rb").read() == open(LAST_GOOD, "rb").read()
    )

    print("restarting bridge to apply update...")
    since = time.time()
    kickstart_restart()
    healthy, reason = _health_check(since)

    if healthy:
        ts = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(BRIDGE_PY, LAST_GOOD)
        shutil.copy2(BRIDGE_PY, os.path.join(BACKUP_DIR, "bridge-%s.py" % ts))
        _prune_backups()
        if same_as_live:
            print("update applied and healthy (no code change detected)")
        else:
            print("update applied and healthy. snapshot saved: %s"
                  % ts)
        return 0

    print("update looked unhealthy (%s) -- rolling back" % reason)
    shutil.copy2(LAST_GOOD, BRIDGE_PY)
    kickstart_restart()
    healthy2, reason2 = _health_check(time.time())
    if healthy2:
        print("rolled back to last known-good and confirmed healthy")
    else:
        print("rollback restart still unhealthy (%s) -- check logs "
              "and the launchd job by hand" % reason2)
    return 1


def cmd_rollback(_args):
    if not os.path.exists(LAST_GOOD):
        print("no last-good backup on file, nothing to roll back to")
        return 1
    shutil.copy2(LAST_GOOD, BRIDGE_PY)
    since = time.time()
    kickstart_restart()
    healthy, reason = _health_check(since)
    if healthy:
        print("rolled back to last known-good and confirmed healthy")
        return 0
    print("rolled back but health check failed (%s), check logs" % reason)
    return 1


def _prune_backups(keep=10):
    snaps = sorted(
        f for f in os.listdir(BACKUP_DIR)
        if f.startswith("bridge-") and f.endswith(".py")
    )
    for f in snaps[:-keep]:
        try:
            os.remove(os.path.join(BACKUP_DIR, f))
        except OSError:
            pass


def cmd_watch(args):
    """Delegate to the existing interactive live-monitor/kill-switch tool.
    Replaces this process so its raw-tty keybindings work normally."""
    monitor_py = os.path.join(BRIDGE_DIR, "monitor.py")
    if not os.path.exists(monitor_py):
        print("monitor.py not found next to bridgemon.py")
        return 1
    os.execvp(sys.executable, [sys.executable, monitor_py, *args])


COMMANDS = {
    "status": cmd_status,
    "update": cmd_update,
    "rollback": cmd_rollback,
    "logs": cmd_logs,
    "init": cmd_init,
    "watch": cmd_watch,
}


def main():
    args = sys.argv[1:]
    if not args or args[0] not in COMMANDS:
        print(__doc__)
        return 1
    return COMMANDS[args[0]](args[1:])


if __name__ == "__main__":
    sys.exit(main())
