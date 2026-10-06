/**
 * Language guard for `skep task new` (PRD §14).
 *
 * The blackboard and every agent-facing string are English. The CLI rejects task bodies whose
 * letters are predominantly outside the Latin script, so a Chinese human layer must translate
 * before calling `task new`. `--allow-non-english` is the explicit override (audit text may still
 * carry `original_text`).
 */

const LETTER = /\p{L}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;

/**
 * True when more than half of the Unicode letters in `text` are not Latin.
 * Text with no letters (digits, punctuation) is treated as Latin-compatible.
 */
export function isPredominantlyNonLatin(text: string): boolean {
  const letters = text.match(LETTER);
  if (letters === null || letters.length === 0) return false;
  const latin = text.match(LATIN_LETTER);
  const latinCount = latin === null ? 0 : latin.length;
  return (letters.length - latinCount) / letters.length > 0.5;
}
