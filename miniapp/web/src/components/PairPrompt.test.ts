import { describe, expect, it } from 'vitest';
import { extractPairingKey } from './PairPrompt';

const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('extractPairingKey', () => {
  it('takes the key out of a full pairing link', () => {
    expect(extractPairingKey(`https://mac.tail1234.ts.net/app#pair=${KEY}`)).toBe(KEY);
  });

  it('accepts the key on its own', () => {
    expect(extractPairingKey(KEY)).toBe(KEY);
  });

  it('accepts a query-string form as well as a fragment', () => {
    expect(extractPairingKey(`https://mac.ts.net/app?pair=${KEY}`)).toBe(KEY);
  });

  // Copying off a terminal or out of a chat message routinely brings
  // whitespace with it, and a phone keyboard adds a trailing space of its own.
  it('ignores surrounding whitespace', () => {
    expect(extractPairingKey(`   ${KEY}\n`)).toBe(KEY);
  });

  // iOS autocapitalisation is disabled on the field, but a key pasted from
  // somewhere that upper-cased it should still work.
  it('normalises case', () => {
    expect(extractPairingKey(KEY.toUpperCase())).toBe(KEY);
  });

  it('returns null for text with no key in it', () => {
    expect(extractPairingKey('https://mac.ts.net/app')).toBeNull();
    expect(extractPairingKey('')).toBeNull();
    expect(extractPairingKey('   ')).toBeNull();
  });

  // Too short and too long both have to fail, or the button would enable
  // on a truncated paste and send a request that can only be rejected.
  it('rejects keys of the wrong length', () => {
    expect(extractPairingKey(KEY.slice(0, 31))).toBeNull();
    expect(extractPairingKey(KEY + 'ff')).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(extractPairingKey('z'.repeat(32))).toBeNull();
  });
});
