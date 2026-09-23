// ---- public/lib/i18n.mjs ----
//
// The whole of this site's UI-copy translation layer. Deliberately tiny and
// DOM-free (same "pure module, no side effects beyond its own module-level
// state" posture as ./preferences.mjs) - app.js is still the only place that
// ever touches the DOM, this module just decides WHAT TEXT to show it.
//
// Each locale's actual strings live in their own file under ./locales/ (see
// locales/zh-TW.mjs, locales/en.mjs) - STRINGS below just combines them.
// Adding a third language later is: copy locales/en.mjs to
// locales/<code>.mjs, translate every value (every key STRINGS['zh-TW']
// already has), import it below and add it to STRINGS, and (if it should
// ever be auto-detected) add one more branch in detectLocale. Nothing else
// in this file, or in app.js's own calls into t()/getLocale(), needs to
// change - every caller already goes through t(), never a hardcoded
// STRINGS['zh-TW'] lookup, so a missing key in a new locale silently falls
// back to the zh-TW text (see t() below) rather than throwing or rendering
// blank.
//
// This is a Traditional-Chinese, Taiwan-based site first (see app.js's own
// top comment: 愛爾達體育台, a real Taiwanese broadcaster, is hardcoded
// domain data, not something this file translates) - zh-TW is therefore the
// fallback locale everywhere below, never zh-CN and never en.

import zhTW from './locales/zh-TW.mjs';
import en from './locales/en.mjs';

const DEFAULT_LOCALE = 'zh-TW';

export const STRINGS = { 'zh-TW': zhTW, en };

// navigator.languages (an ordered preference list) is preferred over the
// single navigator.language when a browser exposes it - a viewer whose OS
// language is English but who lists Chinese as a secondary preference (or
// vice versa) is still better served by their FIRST preference than by
// whichever single value navigator.language happens to surface. Falls back
// to zh-TW for anything neither prefix matches (a third language landing
// here before STRINGS gains its own entry, or a locale this site simply
// doesn't have copy for yet) - see this module's own top comment for why
// zh-TW, not en, is the correct "we don't recognize this" default.
export function detectLocale() {
  const candidates =
    typeof navigator !== 'undefined'
      ? [...(Array.isArray(navigator.languages) ? navigator.languages : []), navigator.language].filter(Boolean)
      : [];
  for (const raw of candidates) {
    const lang = String(raw).toLowerCase();
    if (lang.startsWith('zh')) return 'zh-TW';
    if (lang.startsWith('en')) return 'en';
  }
  return DEFAULT_LOCALE;
}

// Resolved once at module load from the browser's language preferences.
const currentLocale = detectLocale();

export function getLocale() {
  return currentLocale;
}

// `vars`, when given, fills in `{placeholder}` tokens in the resolved
// template - a small superset of the exact `t(key)` contract this module
// was specified with (STRINGS[locale]?.[key] ?? STRINGS['zh-TW'][key] ??
// key), added because so much of this app's real UI copy is a template
// ("{mins} 分鐘後", "與「{name}」{clause}") rather than a bare label. A
// placeholder with no matching entry in `vars` is left as-is rather than
// silently blanked, so a caller forgetting one is obvious in the rendered
// text rather than invisible.
export function t(key, vars) {
  const template = STRINGS[currentLocale]?.[key] ?? STRINGS[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

// The BCP-47 tag to actually pass to Intl.DateTimeFormat/<html lang> for the
// current locale - deliberately separate from the STRINGS key itself
// ('zh-TW' happens to already be a valid BCP-47 tag, but 'en' on its own
// still needs a real region for Intl to pick sensible defaults, and this is
// the one place that mapping lives rather than every caller re-deciding it).
export function dateFnsLocaleTag() {
  return currentLocale === 'en' ? 'en-US' : 'zh-Hant-TW';
}
