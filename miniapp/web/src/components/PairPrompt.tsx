import { useState } from 'react';
import { api } from '../api';
import { storeName, storeToken } from '../standalone';
import { haptic } from '../telegram';

/**
 * Pairing an installed app that has no key in its URL.
 *
 * The Android build never needs this: the key is baked into the APK at
 * build time, so a fresh install is already paired. iPhone has no
 * equivalent, and the way iOS installs a web app makes the ordinary path
 * fail in a way that looks like a bug.
 *
 * Tapping the QR link on the phone opens the tailnet URL *in Safari*, and
 * pairing there writes the token into Safari's storage. Adding the app to
 * the Home Screen then produces something with its own separate storage,
 * launched at the manifest's `start_url` with the `#pair=` fragment
 * stripped. So the new icon opens to an app that has never seen a key, and
 * cannot be handed one, because re-scanning the QR just opens Safari
 * again. Without this screen that is a dead end.
 *
 * Accepting the whole link rather than only the key is the point. The
 * realistic way this gets across is Universal Clipboard -- copy the link
 * on the Mac, paste on the phone -- and asking someone to first edit 32
 * hex characters out of a URL would be a poor reward for that.
 */
export function PairPrompt({
  onPaired,
}: {
  onPaired: (token: string, name?: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = extractPairingKey(value);

  const submit = async () => {
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.pair(key);
      storeToken(res.token);
      if (res.name) storeName(res.name);
      haptic('success');
      onPaired(res.token, res.name);
    } catch (err) {
      haptic('error');
      const status = (err as { status?: number }).status;
      setError(
        status === 401
          ? 'That key was rejected. Generate a fresh one on your Mac.'
          : "Couldn't reach your Mac. Check it's awake and on the same tailnet.",
      );
      setBusy(false);
    }
  };

  return (
    <form
      className="pair-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        className="pair-prompt-input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        placeholder="Paste the pairing link"
        /*
         * Every one of these is off for a reason. iOS will happily
         * capitalise, autocorrect and spell-check a hex string into
         * something that no longer matches, and the failure would surface
         * as a flat rejection with no hint that the text was altered.
         */
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        inputMode="url"
        enterKeyHint="go"
        disabled={busy}
        aria-label="Pairing link or key"
      />
      <button
        type="submit"
        className="pair-prompt-go"
        disabled={!key || busy}
      >
        {busy ? 'Pairing…' : 'Pair'}
      </button>
      {error ? <p className="pair-prompt-error">{error}</p> : null}
    </form>
  );
}

/**
 * Find a pairing key in whatever got pasted.
 *
 * Handles the full link, the bare key, and the link with surrounding
 * whitespace that a copy off a terminal tends to bring with it. Returns
 * null rather than guessing when the text holds nothing key-shaped, so the
 * button stays disabled instead of sending a request that cannot succeed.
 */
export function extractPairingKey(input: string): string | null {
  const text = input.trim();
  if (!text) return null;

  // `pair=` in either a query string or a fragment.
  const tagged = /[#?&]pair=([0-9a-f]{32})\b/i.exec(text);
  if (tagged) return tagged[1].toLowerCase();

  // A bare key, possibly the only thing on the clipboard.
  const bare = /^[0-9a-f]{32}$/i.exec(text);
  if (bare) return text.toLowerCase();

  return null;
}
