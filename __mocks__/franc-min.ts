export const franc = (_text: string, _opts?: { only?: string[] }) => "eng";

const detectCode = (text: string) => {
  const normalized = text.toLowerCase();
  if (/hotspot password|router password/.test(normalized)) return "fra";
  if (/wifi password/.test(normalized)) return "por";
  if (/comment|accéder|mot de passe|quelqu/.test(normalized)) return "fra";
  if (/permiso|autorizado|penetraci[oó]n/.test(normalized)) return "spa";
  if (/разрешение|пентест/.test(normalized)) return "rus";
  if (/权限|授权|渗透测试/.test(normalized)) return "cmn";
  if (/permiss[aã]o|autorizado/.test(normalized)) return "por";
  if (/autorisé|permission/.test(normalized)) return "fra";
  if (/erlaubnis|berechtigt/.test(normalized)) return "deu";
  if (/إذن|مخوّل|اختبار/.test(normalized)) return "arb";
  return "eng";
};

export const francAll = (
  text: string,
  opts?: { only?: string[] },
): Array<[string, number]> => {
  const normalized = text.toLowerCase();
  const detected = detectCode(text);
  const isMisrankedEnglishQuery =
    /hotspot password|router password|wifi password/.test(normalized);
  const codes = opts?.only ?? [
    "eng",
    "rus",
    "spa",
    "cmn",
    "por",
    "fra",
    "deu",
    "arb",
  ];

  return codes
    .map(
      (code) =>
        [
          code,
          code === detected
            ? 1
            : code === "eng" && isMisrankedEnglishQuery
              ? 0.74
              : 0.1,
        ] as [string, number],
    )
    .sort((a, b) => b[1] - a[1]);
};
