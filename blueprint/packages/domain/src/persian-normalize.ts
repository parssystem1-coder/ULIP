/**
 * Persian text normalization — FIRST-CLASS deterministic layer (ADR-019).
 *
 * Order of operations (must be applied in this order):
 *   1. Arabic → Persian character unification (ي→ی, ك→ک, ة→ه, ۀ→ه, أ/إ/ٱ→ا, آ preserved)
 *   2. Arabic-Indic → ASCII digits (۰-۹ and ٠-٩ → 0-9)
 *   3. ZWNJ (U+200C) preserved inside words; standalone ZWNJ removed
 *   4. Diacritics (tashkeel) removed
 *   5. Whitespace collapse + trim; Latin casefold
 *
 * This module is pure and deterministic — no locale-aware ICU, no network.
 * Its output is the `alias_norm` format stored in taxonomy_node_aliases /
 * location_aliases and the key derivation used for alias lookups.
 */

const ARABIC_TO_PERSIAN: Readonly<Record<string, string>> = {
  '\u064A': '\u06CC', // ي → ی  (Arabic yeh → Farsi yeh)
  '\u0649': '\u06CC', // ى → ی  (alef maksura)
  '\u0643': '\u06A9', // ك → ک  (Arabic kaf → Keheh)
  '\u0629': '\u0647', // ة → ه  (teh marbuta → heh)
  '\u06C0': '\u0647', // ۀ → ه  (heh with yeh above)
  '\u0623': '\u0627', // أ → ا
  '\u0625': '\u0627', // إ → ا
  '\u0671': '\u0627', // ٱ → ا
  '\u0624': '\u0648', // ؤ → و
  '\u0626': '\u06CC', // ئ → ی
};

const ARABIC_INDIC_DIGITS = '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669'; // ٠-٩
const EXTENDED_ARABIC_DIGITS = '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9'; // ۰-۹

const TASHKEEL =
  /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // harakat, superscripts, tatweel

const ZWNJ = '\u200C';

/** Step 1+2: character unification and digit mapping. */
export function unifyPersianCharacters(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ARABIC_TO_PERSIAN[ch] !== undefined) {
      out += ARABIC_TO_PERSIAN[ch];
    } else {
      const d = ch.codePointAt(0) ?? 0;
      const ext = EXTENDED_ARABIC_DIGITS.indexOf(ch);
      const ar = ARABIC_INDIC_DIGITS.indexOf(ch);
      out += ext >= 0 ? String(ext) : ar >= 0 ? String(ar) : ch;
    }
  }
  return out;
}

/**
 * Full normalization. ZWNJ inside Persian words is PRESERVED (نیم‌فاصله),
 * standalone ZWNJ is dropped, whitespace collapsed, Latin casefolded.
 */
export function normalizePersian(input: string): string {
  let s = unifyPersianCharacters(input);
  s = s.replace(TASHKEEL, '');
  // drop standalone ZWNJ (not surrounded by letters)
  s = s.replace(new RegExp(`${ZWNJ}(?=[A-Za-z0-9\\s])|(?<=[A-Za-z0-9\\s])${ZWNJ}`, 'g'), '');
  // collapse whitespace (incl. ZWNJ-adjacent spaces) but keep in-word ZWNJ
  s = s.replace(/[ \t\u00A0\u200F\u200E]+/g, ' ').trim();
  return s.toLowerCase();
}

/**
 * Lookup key for alias tables: normalization + ZWNJ removed entirely +
 * spaces collapsed, so 'نیم فاصله' vs 'نیم‌فاصله' collide on purpose.
 */
export function aliasKey(input: string): string {
  return normalizePersian(input).replace(new RegExp(ZWNJ, 'g'), ' ').replace(/\s+/g, ' ');
}

/** Naive script-based locale guess ('fa' vs 'en'); used for routing, never for truth. */
export function guessLocale(input: string): 'fa' | 'en' {
  const persian = input.match(/[\u0600-\u06FF]/g)?.length ?? 0;
  return persian > 0 ? 'fa' : 'en';
}
