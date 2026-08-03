/**
 * Lazy, fine-grained Shiki loader.
 *
 * Day 1 plan 5.7: syntax highlighting via shiki, a two-theme subset (one
 * light, one dark), only the languages that actually appear in this app's
 * transcripts. Shiki's default entry point bundles every grammar and theme
 * it ships; the fine-grained core API (`createHighlighterCore` plus
 * per-language/per-theme dynamic imports) is what keeps this to exactly
 * eight small WASM-free grammar modules instead of ~180.
 *
 * Loading only starts when `warmHighlighter()` is called, and that is only
 * ever called after first paint (see `Markdown.tsx`) -- cold-boot time
 * must not pay for a highlighter nobody has scrolled to yet.
 */
import type { HighlighterCore } from 'shiki/core';

/** Exactly the plan's list, nothing more. */
const LANG_LOADERS: Record<string, () => Promise<any>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
};

/** Common fence tags that mean one of the languages above. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  md: 'markdown',
};

export const LIGHT_THEME = 'github-light';
export const DARK_THEME = 'github-dark';

/** The fence tag this app knows how to highlight, or null -- callers fall back to plain text either way. */
export function normalizeLang(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (LANG_LOADERS[key]) return key;
  const aliased = LANG_ALIASES[key];
  return aliased && LANG_LOADERS[aliased] ? aliased : null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;

function load(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, wasmModule] =
        await Promise.all([
          import('shiki/core'),
          import('shiki/engine/oniguruma'),
          import('shiki/wasm'),
        ]);
      return createHighlighterCore({
        themes: [
          import('shiki/themes/github-light.mjs'),
          import('shiki/themes/github-dark.mjs'),
        ],
        langs: Object.values(LANG_LOADERS).map((loadLang) => loadLang()),
        engine: createOnigurumaEngine(wasmModule.default),
      });
    })();
  }
  return highlighterPromise;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let ready: HighlighterCore | null = null;

/** Start the load, once. Safe to call from multiple mounted code blocks -- they all share the one in-flight promise. */
export function warmHighlighter(): void {
  if (ready || highlighterPromise) return;
  void load().then((highlighter) => {
    ready = highlighter;
    for (const listener of listeners) listener();
  });
}

/** Subscribe to "the highlighter just finished loading". Fires at most once; already-ready callers should just read `getReadyHighlighter()` directly instead of subscribing. */
export function onHighlighterReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getReadyHighlighter(): HighlighterCore | null {
  return ready;
}

/** Null when the highlighter has not loaded yet, or the language is not one of the eight supported -- either way the caller's plain-text fallback is correct. */
export function highlightToHtml(
  code: string,
  lang: string,
  dark: boolean,
): string | null {
  const normalized = normalizeLang(lang);
  if (!normalized || !ready) return null;
  try {
    return ready.codeToHtml(code, {
      lang: normalized,
      theme: dark ? DARK_THEME : LIGHT_THEME,
    });
  } catch {
    return null;
  }
}
