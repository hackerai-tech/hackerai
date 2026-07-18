import { z } from "zod";
import { CVSS31_METRIC_VALUES } from "./cvss31";

export const FINDING_PAYLOAD_MAX_BYTES = 128 * 1024;
export const FINDING_CODE_LOCATIONS_MAX = 50;

const requiredText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max.toLocaleString()} characters or fewer`);

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be ${max.toLocaleString()} characters or fewer`)
    .nullable()
    .optional()
    .transform((value) => value || undefined);

const stripBoundaryNewlines = (value: string) =>
  value.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");

const requiredCodeText = (label: string, max: number) =>
  z
    .string()
    .transform(stripBoundaryNewlines)
    .refine((value) => value.trim().length > 0, `${label} is required`)
    .refine(
      (value) => value.length <= max,
      `${label} must be ${max.toLocaleString()} characters or fewer`,
    );

const optionalCodeText = (label: string, max: number) =>
  z
    .string()
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) return undefined;
      const normalized = stripBoundaryNewlines(value);
      return normalized.trim().length > 0 ? normalized : undefined;
    })
    .refine(
      (value) => value === undefined || value.length <= max,
      `${label} must be ${max.toLocaleString()} characters or fewer`,
    );

const getLineCount = (value: string) => value.split(/\r?\n/).length;

const relativeCodePathSchema = requiredText("File", 500).superRefine(
  (path, ctx) => {
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      path.startsWith("./") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      segments.some((segment) => segment === ".." || segment === "")
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "File must be a relative repository path without traversal, empty segments, or backslashes",
      });
    }
  },
);

export const findingCodeLocationSchema = z
  .object({
    file: relativeCodePathSchema,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    snippet: optionalCodeText("Snippet", 16_000),
    label: optionalText("Label", 200),
    fix_before: optionalCodeText("Fix before", 16_000),
    fix_after: optionalCodeText("Fix after", 16_000),
  })
  .strict()
  .superRefine((location, ctx) => {
    if (location.end_line < location.start_line) {
      ctx.addIssue({
        code: "custom",
        path: ["end_line"],
        message: "End line must be greater than or equal to start line",
      });
    }
    if (Boolean(location.fix_before) !== Boolean(location.fix_after)) {
      ctx.addIssue({
        code: "custom",
        path: [location.fix_before ? "fix_after" : "fix_before"],
        message: "fix_before and fix_after must be provided together",
      });
    }
    if (
      location.fix_before &&
      getLineCount(location.fix_before) !==
        location.end_line - location.start_line + 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fix_before"],
        message:
          "fix_before must contain exactly the lines covered by start_line and end_line",
      });
    }
  });

export const cvss31BreakdownSchema = z
  .object({
    attack_vector: z.enum(CVSS31_METRIC_VALUES.attack_vector),
    attack_complexity: z.enum(CVSS31_METRIC_VALUES.attack_complexity),
    privileges_required: z.enum(CVSS31_METRIC_VALUES.privileges_required),
    user_interaction: z.enum(CVSS31_METRIC_VALUES.user_interaction),
    scope: z.enum(CVSS31_METRIC_VALUES.scope),
    confidentiality: z.enum(CVSS31_METRIC_VALUES.confidentiality),
    integrity: z.enum(CVSS31_METRIC_VALUES.integrity),
    availability: z.enum(CVSS31_METRIC_VALUES.availability),
  })
  .strict();

export const createVulnerabilityReportInputSchema = z
  .object({
    title: requiredText("Title", 200),
    description: requiredText("Description", 4_000),
    impact: requiredText("Impact", 4_000),
    target: requiredText("Target", 1_000),
    technical_analysis: requiredText("Technical analysis", 12_000),
    poc_description: requiredText("PoC description", 8_000),
    poc_script_code: requiredCodeText("PoC script/code", 32_000),
    remediation_steps: requiredText("Remediation steps", 8_000),
    evidence: requiredText("Evidence", 16_000),
    assumptions: requiredText("Assumptions", 4_000),
    fix_effort: z.enum(["trivial", "low", "medium", "high"]),
    cvss_breakdown: cvss31BreakdownSchema,
    endpoint: optionalText("Endpoint", 1_000),
    method: optionalText("Method", 32),
    cve: z
      .string()
      .trim()
      .regex(/^(?:CVE-\d{4}-\d{4,})?$/, "CVE must use CVE-YYYY-NNNN format")
      .max(32)
      .nullable()
      .optional()
      .transform((value) => value || undefined),
    cwe: z
      .string()
      .trim()
      .regex(/^(?:CWE-\d+)?$/, "CWE must use CWE-NNN format")
      .max(24)
      .nullable()
      .optional()
      .transform((value) => value || undefined),
    code_locations: z
      .array(findingCodeLocationSchema)
      .max(
        FINDING_CODE_LOCATIONS_MAX,
        `Code locations are limited to ${FINDING_CODE_LOCATIONS_MAX}`,
      )
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
  })
  .strict()
  .superRefine((input, ctx) => {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(input)).length;
    if (payloadBytes > FINDING_PAYLOAD_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `Finding payload must be ${FINDING_PAYLOAD_MAX_BYTES} bytes or smaller`,
      });
    }
  });

export type CreateVulnerabilityReportInput = z.infer<
  typeof createVulnerabilityReportInputSchema
>;
export type FindingCodeLocation = z.infer<typeof findingCodeLocationSchema>;

const normalizeFingerprintValue = (value: string | undefined): string =>
  (value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

export const createFindingDedupeKey = (
  input: Pick<
    CreateVulnerabilityReportInput,
    "target" | "endpoint" | "method" | "cwe" | "title"
  >,
): string =>
  JSON.stringify([
    normalizeFingerprintValue(input.target),
    normalizeFingerprintValue(input.endpoint),
    normalizeFingerprintValue(input.method),
    normalizeFingerprintValue(input.cwe),
    normalizeFingerprintValue(input.title),
  ]);

export const createFindingSearchText = (
  input: Pick<
    CreateVulnerabilityReportInput,
    "title" | "target" | "endpoint" | "cve" | "cwe"
  >,
): string =>
  [input.title, input.target, input.endpoint, input.cve, input.cwe]
    .filter((value): value is string => Boolean(value))
    .join(" \n")
    .slice(0, 4_000);
