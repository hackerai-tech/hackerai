import { francAll } from "franc-min";

export type SupportedLang =
  | "en"
  | "ru"
  | "es"
  | "zh"
  | "pt"
  | "fr"
  | "de"
  | "ar";

export const AUTH_DISCLAIMER: Record<SupportedLang, string> = {
  en: "(I have permission and am authorized to perform this pentest)",
  ru: "(У меня есть разрешение и я уполномочен проводить этот пентест)",
  es: "(Tengo permiso y estoy autorizado para realizar esta prueba de penetración)",
  zh: "（我已获得授权并有权进行此渗透测试）",
  pt: "(Tenho permissão e estou autorizado a realizar este pentest)",
  fr: "(J'ai la permission et je suis autorisé à effectuer ce pentest)",
  de: "(Ich habe die Erlaubnis und bin berechtigt, diesen Pentest durchzuführen)",
  ar: "(لدي إذن ومخوّل لإجراء اختبار الاختراق هذا)",
};

const ISO_639_3_TO_1: Record<string, SupportedLang> = {
  eng: "en",
  rus: "ru",
  spa: "es",
  cmn: "zh",
  por: "pt",
  fra: "fr",
  deu: "de",
  arb: "ar",
  ara: "ar",
};

const FRANC_ALLOWLIST = Object.keys(ISO_639_3_TO_1);

// franc-min is unreliable below ~20 letters — short English replies like
// "yes its mine" misdetect (e.g. as French). 25 lines up with the
// moderation minLength of 30 and gives franc enough signal.
const MIN_LETTER_COUNT = 25;

// francAll normalizes the top score to 1.0; runner-ups scale down. A small
// gap means the text is ambiguous (proper names like "Philip" or
// "Vladimir" score close on multiple languages' trigrams). When the top
// match doesn't clearly beat English, prefer English — it's the safe
// fallback and most users write in it.
const MIN_CONFIDENCE_MARGIN = 0.05;

const SHORT_LATIN_AMBIGUOUS_LETTER_LIMIT = 40;
const SHORT_LATIN_ENGLISH_MARGIN = 0.3;
const PLAIN_LATIN_ENGLISH_CLOSE_MARGIN = 0.1;
const DOMINANT_SCRIPT_RATIO = 0.5;

export type LanguageDetectionSelectionReason =
  | "dominant_script"
  | "short_text_default_en"
  | "franc_no_result_default_en"
  | "franc_und_default_en"
  | "english_confidence_margin_default_en"
  | "short_latin_ambiguous_default_en"
  | "plain_latin_english_close_default_en"
  | "franc_top_match"
  | "unsupported_default_en";

type ScriptName = "han" | "arabic" | "cyrillic" | "latin" | "other";

export type LanguageDetectionDiagnostics = {
  selected_language: SupportedLang;
  selection_reason: LanguageDetectionSelectionReason;
  thresholds: {
    min_letter_count: number;
    min_confidence_margin: number;
    short_latin_ambiguous_letter_limit: number;
    short_latin_english_margin: number;
    plain_latin_english_close_margin: number;
    dominant_script_ratio: number;
  };
  text: {
    char_count: number;
    trimmed_char_count: number;
    letter_count: number;
    whitespace_count: number;
    newline_count: number;
    numeric_count: number;
    punctuation_count: number;
    has_diacritics: boolean;
    has_code_fence: boolean;
    has_url_like_text: boolean;
  };
  scripts: {
    han_count: number;
    han_ratio: number;
    arabic_count: number;
    arabic_ratio: number;
    cyrillic_count: number;
    cyrillic_ratio: number;
    latin_count: number;
    latin_ratio: number;
    other_letter_count: number;
    other_letter_ratio: number;
    dominant_script: ScriptName | null;
    dominant_script_ratio: number;
  };
  franc: {
    ran: boolean;
    allowlist: string[];
    candidates: Array<{
      code: string;
      language: SupportedLang | null;
      score: number;
    }>;
    top_code?: string;
    top_language?: SupportedLang | null;
    top_score?: number;
    english_score?: number;
    normalized_english_gap?: number;
    top_score_minus_english?: number;
  };
};

export type LanguageDetectionResult = {
  language: SupportedLang;
  diagnostics: LanguageDetectionDiagnostics;
};

export function detectLang(text: string): SupportedLang {
  return detectLangWithDiagnostics(text).language;
}

export function detectLangWithDiagnostics(
  text: string,
): LanguageDetectionResult {
  const letterCount = (text.match(/\p{L}/gu) ?? []).length;
  const textDiagnostics = buildTextDiagnostics(text, letterCount);
  const scriptDiagnostics = buildScriptDiagnostics(text, letterCount);
  const baseDiagnostics = {
    thresholds: buildThresholdDiagnostics(),
    text: textDiagnostics,
    scripts: scriptDiagnostics,
    franc: buildFrancDiagnostics(),
  };

  const scriptLang = detectByDominantScript(scriptDiagnostics, letterCount);
  if (scriptLang) {
    return buildDetectionResult(scriptLang, "dominant_script", baseDiagnostics);
  }

  if (letterCount < MIN_LETTER_COUNT) {
    return buildDetectionResult("en", "short_text_default_en", baseDiagnostics);
  }

  const scores = francAll(text, { only: FRANC_ALLOWLIST });
  const francDiagnostics = buildFrancDiagnostics(scores);
  const diagnosticsWithFranc = {
    ...baseDiagnostics,
    franc: francDiagnostics,
  };
  const top = scores[0];
  if (!top) {
    return buildDetectionResult(
      "en",
      "franc_no_result_default_en",
      diagnosticsWithFranc,
    );
  }
  if (top[0] === "und") {
    return buildDetectionResult(
      "en",
      "franc_und_default_en",
      diagnosticsWithFranc,
    );
  }

  const eng = scores.find(([code]) => code === "eng");
  if (eng && 1 - eng[1] < MIN_CONFIDENCE_MARGIN) {
    return buildDetectionResult(
      "en",
      "english_confidence_margin_default_en",
      diagnosticsWithFranc,
    );
  }
  if (
    eng &&
    shouldPreferEnglishForAmbiguousLatinText(text, letterCount, eng[1], top[1])
  ) {
    return buildDetectionResult(
      "en",
      "short_latin_ambiguous_default_en",
      diagnosticsWithFranc,
    );
  }
  if (eng && shouldPreferEnglishForClosePlainLatinText(text, eng[1], top[1])) {
    return buildDetectionResult(
      "en",
      "plain_latin_english_close_default_en",
      diagnosticsWithFranc,
    );
  }

  const selectedLanguage = ISO_639_3_TO_1[top[0]];
  if (!selectedLanguage) {
    return buildDetectionResult(
      "en",
      "unsupported_default_en",
      diagnosticsWithFranc,
    );
  }

  return buildDetectionResult(
    selectedLanguage,
    "franc_top_match",
    diagnosticsWithFranc,
  );
}

function detectByDominantScript(
  scripts: LanguageDetectionDiagnostics["scripts"],
  letterCount: number,
): SupportedLang | null {
  if (letterCount === 0) return null;
  if (scripts.han_count / letterCount > DOMINANT_SCRIPT_RATIO) return "zh";
  if (scripts.arabic_count / letterCount > DOMINANT_SCRIPT_RATIO) return "ar";
  if (scripts.cyrillic_count / letterCount > DOMINANT_SCRIPT_RATIO) return "ru";

  return null;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function shouldPreferEnglishForAmbiguousLatinText(
  text: string,
  letterCount: number,
  englishScore: number,
  topScore: number,
): boolean {
  if (letterCount > SHORT_LATIN_AMBIGUOUS_LETTER_LIMIT) return false;

  const letters = text.match(/\p{L}/gu) ?? [];
  const hasLatinLetters = letters.some((letter) =>
    /\p{Script=Latin}/u.test(letter),
  );
  const hasNonLatinLetters = letters.some(
    (letter) => !/\p{Script=Latin}/u.test(letter),
  );
  const hasDiacritics = /\p{Diacritic}/u.test(text.normalize("NFD"));

  return (
    hasLatinLetters &&
    !hasNonLatinLetters &&
    !hasDiacritics &&
    topScore - englishScore <= SHORT_LATIN_ENGLISH_MARGIN
  );
}

function shouldPreferEnglishForClosePlainLatinText(
  text: string,
  englishScore: number,
  topScore: number,
): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;

  const onlyLatinLetters = letters.every((letter) =>
    /\p{Script=Latin}/u.test(letter),
  );
  const hasDiacritics = /\p{Diacritic}/u.test(text.normalize("NFD"));

  return (
    onlyLatinLetters &&
    !hasDiacritics &&
    topScore - englishScore <= PLAIN_LATIN_ENGLISH_CLOSE_MARGIN
  );
}

function buildDetectionResult(
  language: SupportedLang,
  reason: LanguageDetectionSelectionReason,
  diagnostics: Omit<
    LanguageDetectionDiagnostics,
    "selected_language" | "selection_reason"
  >,
): LanguageDetectionResult {
  return {
    language,
    diagnostics: {
      selected_language: language,
      selection_reason: reason,
      ...diagnostics,
    },
  };
}

function buildThresholdDiagnostics(): LanguageDetectionDiagnostics["thresholds"] {
  return {
    min_letter_count: MIN_LETTER_COUNT,
    min_confidence_margin: MIN_CONFIDENCE_MARGIN,
    short_latin_ambiguous_letter_limit: SHORT_LATIN_AMBIGUOUS_LETTER_LIMIT,
    short_latin_english_margin: SHORT_LATIN_ENGLISH_MARGIN,
    plain_latin_english_close_margin: PLAIN_LATIN_ENGLISH_CLOSE_MARGIN,
    dominant_script_ratio: DOMINANT_SCRIPT_RATIO,
  };
}

function buildTextDiagnostics(
  text: string,
  letterCount: number,
): LanguageDetectionDiagnostics["text"] {
  return {
    char_count: text.length,
    trimmed_char_count: text.trim().length,
    letter_count: letterCount,
    whitespace_count: countMatches(text, /\s/gu),
    newline_count: countMatches(text, /\r\n|\r|\n/gu),
    numeric_count: countMatches(text, /\p{N}/gu),
    punctuation_count: countMatches(text, /\p{P}/gu),
    has_diacritics: /\p{Diacritic}/u.test(text.normalize("NFD")),
    has_code_fence: /```/.test(text),
    has_url_like_text: /\bhttps?:\/\//i.test(text),
  };
}

function buildScriptDiagnostics(
  text: string,
  letterCount: number,
): LanguageDetectionDiagnostics["scripts"] {
  const hanCount = countMatches(text, /\p{Script=Han}/gu);
  const arabicCount = countMatches(text, /\p{Script=Arabic}/gu);
  const cyrillicCount = countMatches(text, /\p{Script=Cyrillic}/gu);
  const latinCount = countMatches(text, /\p{Script=Latin}/gu);
  const otherLetterCount = Math.max(
    letterCount - hanCount - arabicCount - cyrillicCount - latinCount,
    0,
  );
  const scriptCounts: Record<ScriptName, number> = {
    han: hanCount,
    arabic: arabicCount,
    cyrillic: cyrillicCount,
    latin: latinCount,
    other: otherLetterCount,
  };
  const dominantScript = Object.entries(scriptCounts).reduce<{
    script: ScriptName | null;
    count: number;
  }>(
    (current, [script, count]) =>
      count > current.count ? { script: script as ScriptName, count } : current,
    { script: null, count: 0 },
  );

  return {
    han_count: hanCount,
    han_ratio: ratio(hanCount, letterCount),
    arabic_count: arabicCount,
    arabic_ratio: ratio(arabicCount, letterCount),
    cyrillic_count: cyrillicCount,
    cyrillic_ratio: ratio(cyrillicCount, letterCount),
    latin_count: latinCount,
    latin_ratio: ratio(latinCount, letterCount),
    other_letter_count: otherLetterCount,
    other_letter_ratio: ratio(otherLetterCount, letterCount),
    dominant_script: dominantScript.script,
    dominant_script_ratio: ratio(dominantScript.count, letterCount),
  };
}

function buildFrancDiagnostics(
  scores: Array<[string, number]> = [],
): LanguageDetectionDiagnostics["franc"] {
  const top = scores[0];
  const english = scores.find(([code]) => code === "eng");

  return {
    ran: scores.length > 0,
    allowlist: [...FRANC_ALLOWLIST],
    candidates: scores.map(([code, score]) => ({
      code,
      language: ISO_639_3_TO_1[code] ?? null,
      score: roundScore(score),
    })),
    top_code: top?.[0],
    top_language: top ? (ISO_639_3_TO_1[top[0]] ?? null) : undefined,
    top_score: top ? roundScore(top[1]) : undefined,
    english_score: english ? roundScore(english[1]) : undefined,
    normalized_english_gap: english ? roundScore(1 - english[1]) : undefined,
    top_score_minus_english:
      top && english ? roundScore(top[1] - english[1]) : undefined,
  };
}

function ratio(count: number, total: number): number {
  if (total === 0) return 0;
  return roundScore(count / total);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
