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

export function detectLang(text: string): SupportedLang {
  const letterCount = (text.match(/\p{L}/gu) ?? []).length;
  if (letterCount < MIN_LETTER_COUNT) return "en";

  const scores = francAll(text, { only: FRANC_ALLOWLIST });
  const top = scores[0];
  if (!top || top[0] === "und") return "en";

  const eng = scores.find(([code]) => code === "eng");
  if (eng && 1 - eng[1] < MIN_CONFIDENCE_MARGIN) return "en";

  return ISO_639_3_TO_1[top[0]] ?? "en";
}
