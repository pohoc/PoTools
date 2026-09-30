/**
 * Locale resolution for engine and transport failures.
 *
 * The engine reports failures as `{ code, message, hintKey? }`. `hintKey` is an
 * explicit message-table key added by the layer that raised the error, while
 * `message` is human text authored in the engine's default language (Chinese).
 */

/** A failure in the shape the engine, worker and transport all report. */
export interface LocalizableError {
  message: string;
  code?: string;
  /** Explicit message-table key; wins over everything else. */
  hintKey?: string;
}

const CJK = /[\u3400-\u9fff]/;

/**
 * The host's path guard refusal, e.g.
 * `path_not_authorized: /etc/passwd` followed by the granted directories.
 */
const PATH_DENIAL = /^path_not_authorized:\s*([^\n]+)/;

/**
 * Resolves failure text for display in the active locale.
 *
 * Preference order:
 *  1. `hintKey` — specific and already translated.
 *  2. the raw message when it contains no CJK: it is locale-neutral or authored
 *     in English (`Invalid JSON: …`), and keeping its specificity beats replacing
 *     it with a generic translation.
 *  3. `error.<code>` — the tables cover the engine's closed set of error codes,
 *     so a Chinese-only message becomes a generic but translated one.
 *  4. the raw message as a last resort.
 *
 * Existence is tested by identity: `t` returns the key unchanged when the table
 * has no entry. That is what lets this replace the hand-maintained key allowlist
 * that used to live in `ToolPage`, so new engine error codes only need an
 * `error.<code>` entry to be translated.
 */
export function localizedErrorText(error: LocalizableError, t: (key: string) => string): string {
  if (error.hintKey) {
    const hinted = t(error.hintKey);
    if (hinted !== error.hintKey) return hinted;
  }
  // A path-guard refusal names the offending path, which is the actionable part,
  // so translate the sentence and keep the path rather than discarding both.
  const denial = PATH_DENIAL.exec(error.message);
  if (denial) return `${t('error.pathNotAuthorized')}${denial[1]}`;
  if (!CJK.test(error.message)) return error.message;
  if (error.code) {
    const genericKey = `error.${error.code}`;
    const generic = t(genericKey);
    if (generic !== genericKey) return generic;
  }
  return error.message;
}
