export const FINDING_CATEGORIES = [
  "access_control",
  "authentication_session",
  "injection",
  "cross_site_scripting",
  "request_forgery",
  "file_path_access",
  "data_exposure",
  "cryptography_secrets",
  "parsing_deserialization",
  "security_misconfiguration",
  "denial_of_service",
  "business_logic",
  "other",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  access_control: "Access Control / IDOR",
  authentication_session: "Authentication / Session",
  injection: "Injection",
  cross_site_scripting: "Cross-site Scripting",
  request_forgery: "Request Forgery",
  file_path_access: "File / Path Access",
  data_exposure: "Data Exposure",
  cryptography_secrets: "Cryptography / Secrets",
  parsing_deserialization: "Parsing / Deserialization",
  security_misconfiguration: "Security Misconfiguration",
  denial_of_service: "Denial of Service",
  business_logic: "Business Logic",
  other: "Other",
};

const CWE_CATEGORIES: ReadonlyArray<
  readonly [ReadonlySet<number>, FindingCategory]
> = [
  [new Set([79, 80, 83, 87, 116]), "cross_site_scripting"],
  [new Set([918, 352]), "request_forgery"],
  [new Set([22, 23, 35, 36, 59, 73, 434]), "file_path_access"],
  [new Set([264, 269, 284, 285, 566, 639, 862, 863]), "access_control"],
  [
    new Set([287, 288, 290, 294, 295, 306, 307, 384, 521, 613, 640]),
    "authentication_session",
  ],
  [
    new Set([
      74, 75, 77, 78, 88, 89, 90, 91, 93, 94, 95, 96, 99, 564, 917, 943, 1336,
    ]),
    "injection",
  ],
  [new Set([200, 201, 203, 209, 359, 532, 538]), "data_exposure"],
  [
    new Set([
      259, 311, 312, 319, 321, 322, 326, 327, 328, 330, 331, 338, 347, 798,
    ]),
    "cryptography_secrets",
  ],
  [new Set([502, 611]), "parsing_deserialization"],
  [new Set([16, 276, 489, 756]), "security_misconfiguration"],
  [
    new Set([400, 401, 404, 405, 406, 407, 409, 770, 789, 835]),
    "denial_of_service",
  ],
  [new Set([840, 841]), "business_logic"],
];

const TITLE_PATTERNS: ReadonlyArray<readonly [RegExp, FindingCategory]> = [
  [/\b(?:xss|cross[- ]site scripting)\b/i, "cross_site_scripting"],
  [/\b(?:ssrf|csrf|request forgery)\b/i, "request_forgery"],
  [
    /\b(?:idor|access control|authorization|privilege escalation|tenant isolation)\b/i,
    "access_control",
  ],
  [
    /\b(?:authentication|session fixation|session hijack|account takeover|login bypass)\b/i,
    "authentication_session",
  ],
  [
    /\b(?:sql|nosql|command|code|template|ldap|xpath) injection\b/i,
    "injection",
  ],
  [
    /\b(?:path traversal|directory traversal|arbitrary file|file upload)\b/i,
    "file_path_access",
  ],
  [/\b(?:xxe|deserializ|parser)\b/i, "parsing_deserialization"],
  [
    /\b(?:secret|credential|private key|weak crypt|cleartext|hardcoded password)\b/i,
    "cryptography_secrets",
  ],
  [
    /\b(?:information disclosure|data exposure|sensitive data|data leak)\b/i,
    "data_exposure",
  ],
  [/\b(?:denial of service|resource exhaustion|redos)\b/i, "denial_of_service"],
  [/\b(?:business logic|race condition)\b/i, "business_logic"],
  [
    /\b(?:misconfiguration|debug mode|default configuration)\b/i,
    "security_misconfiguration",
  ],
];

export const deriveFindingCategory = ({
  cwe,
  title,
}: {
  cwe?: string;
  title: string;
}): FindingCategory => {
  const cweNumber = cwe ? Number(cwe.replace(/^CWE-/i, "")) : Number.NaN;
  if (Number.isInteger(cweNumber)) {
    for (const [cwes, category] of CWE_CATEGORIES) {
      if (cwes.has(cweNumber)) return category;
    }
  }

  for (const [pattern, category] of TITLE_PATTERNS) {
    if (pattern.test(title)) return category;
  }

  return "other";
};
