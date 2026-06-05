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

export function detectLang(text: string): SupportedLang {
  const letterCount = (text.match(/\p{L}/gu) ?? []).length;
  const scriptLang = detectByDominantScript(text, letterCount);
  if (scriptLang) return scriptLang;

  if (letterCount < MIN_LETTER_COUNT) return "en";

  const scores = francAll(text, { only: FRANC_ALLOWLIST });
  const top = scores[0];
  if (!top || top[0] === "und") return "en";

  const eng = scores.find(([code]) => code === "eng");
  if (eng && 1 - eng[1] < MIN_CONFIDENCE_MARGIN) return "en";
  if (
    eng &&
    shouldPreferEnglishForAmbiguousLatinText(text, letterCount, eng[1], top[1])
  ) {
    return "en";
  }

  return ISO_639_3_TO_1[top[0]] ?? "en";
}

function detectByDominantScript(
  text: string,
  letterCount: number,
): SupportedLang | null {
  if (letterCount === 0) return null;

  const hanCount = countMatches(text, /\p{Script=Han}/gu);
  if (hanCount / letterCount > 0.5) return "zh";

  const arabicCount = countMatches(text, /\p{Script=Arabic}/gu);
  if (arabicCount / letterCount > 0.5) return "ar";

  const cyrillicCount = countMatches(text, /\p{Script=Cyrillic}/gu);
  if (cyrillicCount / letterCount > 0.5) return "ru";

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
