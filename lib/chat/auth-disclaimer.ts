import { franc } from "franc-min";

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

const MIN_LETTER_COUNT = 10;

export function detectLang(text: string): SupportedLang {
  const letterCount = (text.match(/\p{L}/gu) ?? []).length;
  if (letterCount < MIN_LETTER_COUNT) return "en";

  const code = franc(text, { only: FRANC_ALLOWLIST });
  return ISO_639_3_TO_1[code] ?? "en";
}
