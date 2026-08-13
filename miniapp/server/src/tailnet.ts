/**
 * The stable hostname the installed app is pinned to.
 *
 * A quick tunnel rotates its hostname on every restart, which the Telegram
 * mini app survives only because the server re-registers the new URL against
 * the bot's menu button every couple of minutes. An installed app has no such
 * escape hatch: a home-screen icon records its URL at install time and cannot
 * be told a new one. So the standalone build needs a name that never moves,
 * and that is what the tailnet provides.
 *
 * Read from the local daemon rather than written into config, because a
 * hostname copied by hand into a file is a hostname that silently disagrees
 * with reality the first time anything is renamed.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOCKET = path.join(
  os.homedir(),
  '.aside-telegram-bridge/tailscale/ts.sock',
);
const BINARY = '/opt/homebrew/bin/tailscale';

/** Re-read occasionally: the daemon may not be up yet when we first ask. */
const TTL_MS = 60_000;

let cached: string | null = null;
let checkedAt = 0;
let inFlight = false;

function refresh(): void {
  if (inFlight) return;
  if (!fs.existsSync(SOCKET) || !fs.existsSync(BINARY)) {
    cached = null;
    checkedAt = Date.now();
    return;
  }
  inFlight = true;
  execFile(
    BINARY,
    [`--socket=${SOCKET}`, 'status', '--json'],
    { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      inFlight = false;
      checkedAt = Date.now();
      if (err) {
        cached = null;
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout)) as {
          BackendState?: string;
          Self?: { DNSName?: string };
        };
        if (parsed.BackendState !== 'Running') {
          cached = null;
          return;
        }
        // MagicDNS returns a fully-qualified name with the trailing dot.
        const dns = String(parsed.Self?.DNSName || '').replace(/\.$/, '');
        cached = dns || null;
      } catch {
        cached = null;
      }
    },
  );
}

/**
 * Current tailnet hostname, or null when Tailscale is not usable.
 *
 * Synchronous by design so it can sit behind a plain getter in the route
 * layer: it hands back the last known value and kicks off a refresh in the
 * background rather than making every caller await a subprocess.
 */
export function tailnetHost(): string | null {
  if (Date.now() - checkedAt > TTL_MS) refresh();
  return cached;
}

/** Prime the cache at boot so the first request already has an answer. */
export function primeTailnetHost(): void {
  refresh();
}
