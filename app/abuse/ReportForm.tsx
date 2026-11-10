"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { abuseReportSchema, type AbuseReportField } from "@/lib/abuse/report";
import { HELP_CENTER_URL } from "@/lib/seo/site";
import SecurityCheck from "./SecurityCheck";

type Errors = Partial<Record<AbuseReportField, string>>;
function Field({
  name,
  label,
  hint,
  required,
  error,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={name} className="text-sm font-medium">
          {label}
        </label>
        <span className="shrink-0 text-xs text-muted-foreground">
          {required ? "Required" : "Optional"}
        </span>
      </div>
      {children}
      {hint && (
        <p
          id={`${name}-hint`}
          className="text-[13px] leading-5 text-muted-foreground"
        >
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default function ReportForm({
  available,
  siteKey,
}: {
  available: boolean;
  siteKey?: string;
}) {
  const [kind, setKind] = useState<"abuse" | "appeal">("abuse");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState("");
  const [receipt, setReceipt] = useState("");
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const failureBox = useRef<HTMLDivElement>(null);
  const attempt = useRef<{ body: string; id: string } | null>(null);
  const challenge = useRef<{ token: string; issuedAt: number } | null>(null);
  const [resetChallenge, setResetChallenge] = useState(0);
  const onToken = useCallback((token: string | null) => {
    challenge.current = token ? { token, issuedAt: Date.now() } : null;
    if (token)
      setFailure((current) =>
        current.startsWith("Complete the security check") ? "" : current,
      );
  }, []);
  useEffect(() => {
    if (receipt) resultHeading.current?.focus();
  }, [receipt]);
  useEffect(() => {
    if (failure.startsWith("Complete the security check"))
      document.getElementById("security-check")?.focus();
    else if (failure) failureBox.current?.focus();
  }, [failure]);

  const inputProps = (name: AbuseReportField) => ({
    id: name,
    name,
    "aria-invalid": Boolean(errors[name]),
    "aria-describedby":
      [
        !["sourceIp", "sourcePort", "protocol"].includes(name) &&
          `${name}-hint`,
        errors[name] && `${name}-error`,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    className: "h-11",
  });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !available) return;
    setFailure("");
    setErrors({});
    const data = new FormData(event.currentTarget);
    const fields = Object.fromEntries(data.entries());
    const time = [
      String(fields.occurredAt ?? "").trim(),
      String(fields.timezone ?? "").trim(),
    ]
      .filter(Boolean)
      .join(" · ");
    delete fields.timezone;
    const body = JSON.stringify({ ...fields, kind, occurredAt: time });
    if (attempt.current?.body !== body)
      attempt.current = { body, id: crypto.randomUUID() };
    const parsed = abuseReportSchema.safeParse({
      ...JSON.parse(body),
      submissionId: attempt.current.id,
    });
    if (!parsed.success) {
      const next: Errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as AbuseReportField;
        if (field === "description")
          next[field] = "Describe what happened using 20–6,000 characters.";
        else if (field === "email")
          next[field] = "Enter a valid email address.";
        else if (field === "target")
          next[field] = "Enter the affected domain, address, or other target.";
        else if (field !== "kind")
          next[field] = "Check this field and its length.";
      }
      setErrors(next);
      const first = Object.keys(next)[0];
      const element = form.current?.elements.namedItem(first);
      if (element instanceof HTMLElement) {
        const details = element.closest("details");
        if (details) details.open = true;
        element.focus();
      }
      return;
    }
    const token = challenge.current;
    if (!token || Date.now() - token.issuedAt > 240_000) {
      if (token) setResetChallenge((value) => value + 1);
      setFailure(
        "Complete the security check, then submit. Your details are still here.",
      );
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/abuse", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Turnstile-Token": token.token,
        },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json();
      if (
        response.ok &&
        result.received === true &&
        typeof result.reference === "string" &&
        /^AB-[a-f0-9-]{36}$/.test(result.reference)
      ) {
        setReceipt(result.reference);
        return;
      }
      // Only display our finite messages; never reflect arbitrary upstream bodies.
      if (
        result.code === "verification_failed" ||
        result.code === "verification_unavailable"
      )
        setFailure(
          "The security check did not go through or expired. Your details are still here; complete the new check, then try again.",
        );
      else if (response.status === 410) {
        attempt.current = null;
        setFailure(
          "This report's delivery window expired. Your details are still here; submit again.",
        );
      } else if (response.status === 429)
        setFailure(
          "Too many reports were submitted recently. Please try again in an hour.",
        );
      else if (response.status === 413)
        setFailure(
          "This report is too large. Please shorten the details and evidence.",
        );
      else if (response.status === 400)
        setFailure(
          "Please check your email, description, and other report details, then try again.",
        );
      else
        setFailure(
          "We could not confirm that your report was queued. Your details are still here; please retry.",
        );
    } catch {
      setFailure(
        "We could not confirm that your report was queued. Your details are still here; please retry.",
      );
    } finally {
      challenge.current = null;
      setResetChallenge((value) => value + 1);
      setPending(false);
    }
  }

  if (receipt)
    return (
      <section
        className="space-y-6 rounded-xl border border-border bg-card p-6 sm:p-8"
        aria-labelledby="report-saved"
      >
        <Check className="size-8" aria-hidden="true" />
        <div className="space-y-2">
          <h2
            ref={resultHeading}
            id="report-saved"
            tabIndex={-1}
            className="text-2xl font-medium outline-none"
          >
            Thanks. Your {kind === "appeal" ? "appeal" : "report"} was received.
          </h2>
          <p className="leading-7 text-muted-foreground">
            We may contact you if we need more information.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              setReceipt("");
              setDescription("");
              setEvidence("");
              attempt.current = null;
            }}
          >
            Submit another report
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/trust">Back to Security &amp; Trust</Link>
          </Button>
        </div>
      </section>
    );

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-busy={pending}
      className="ph-no-capture min-w-0 space-y-8"
      data-ph-no-capture
    >
      {!available && (
        <div
          role="status"
          className="rounded-lg border border-border bg-muted/40 p-4 text-sm leading-6"
        >
          The reporting form is temporarily unavailable. You can contact us
          through the{" "}
          <a href={HELP_CENTER_URL} className="underline underline-offset-4">
            Help Center
          </a>
          . Please share only the minimum details needed.
        </div>
      )}
      <fieldset disabled={pending} className="space-y-3">
        <legend className="mb-3 text-sm font-medium">
          What are you sending?
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              {
                value: "abuse",
                title: "Report misuse",
                detail:
                  "Suspected misuse of HackerAI. You do not need to own the affected system.",
              },
              {
                value: "appeal",
                title: "Appeal a decision",
                detail:
                  "Ask for another review of a restriction on an account or workspace.",
              },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${kind === option.value ? "border-foreground bg-card" : "border-border"}`}
            >
              <input
                type="radio"
                name="kind"
                value={option.value}
                checked={kind === option.value}
                onChange={() => {
                  setKind(option.value);
                  setErrors({});
                }}
                className="mt-1 size-4 accent-foreground [color-scheme:light] dark:[color-scheme:dark]"
              />
              <span>
                <span className="block text-sm font-medium">
                  {option.title}
                </span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                  {option.detail}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {Object.keys(errors).length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm"
        >
          <p className="font-medium">Please check the highlighted fields.</p>
          <ul className="mt-2 space-y-1">
            {Object.entries(errors).map(([name, message]) => (
              <li key={name}>
                <a href={`#${name}`} className="underline underline-offset-4">
                  {message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Field
        name="email"
        label="Contact email"
        required
        hint="Email for follow-up about your report. You do not need a HackerAI account."
        error={errors.email}
      >
        <Input
          {...inputProps("email")}
          type="email"
          autoComplete="email"
          maxLength={254}
          required
          disabled={pending}
        />
      </Field>
      <Field
        name="target"
        label="Affected domain, IP address, or system"
        required={kind === "abuse"}
        hint="Links and targets are not automatically opened or scanned when you submit."
        error={errors.target}
      >
        <Input
          {...inputProps("target")}
          maxLength={500}
          required={kind === "abuse"}
          disabled={pending}
          placeholder="example.net, 203.0.113.24, or another target"
        />
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          When did it happen?{" "}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Optional
          </span>
        </legend>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(100px,0.45fr)] gap-3">
          <div className="space-y-2">
            <label
              htmlFor="occurredAt"
              className="text-[13px] text-muted-foreground"
            >
              Date and time
            </label>
            <Input
              {...inputProps("occurredAt")}
              maxLength={120}
              disabled={pending}
              placeholder="Nov 7, around 14:30"
            />
          </div>
          <div className="space-y-2">
            <label
              htmlFor="timezone"
              className="text-[13px] text-muted-foreground"
            >
              Timezone
            </label>
            <Input
              id="timezone"
              name="timezone"
              maxLength={32}
              disabled={pending}
              className="h-11"
              placeholder="UTC"
              aria-describedby="occurredAt-hint"
            />
          </div>
        </div>
        <p
          id="occurredAt-hint"
          className="text-[13px] leading-5 text-muted-foreground"
        >
          Include the timezone if known. Approximate is fine; write “unknown” if
          you are not sure.
        </p>
      </fieldset>
      <Field
        name="description"
        label={
          kind === "appeal"
            ? "Why should the decision be reviewed?"
            : "What happened?"
        }
        required
        hint={
          kind === "appeal"
            ? "Explain the decision, why you think it should change, and any new information."
            : "Describe what you saw and why you think it involved HackerAI. Plain language is fine."
        }
        error={errors.description}
      >
        <Textarea
          {...inputProps("description")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-40"
          maxLength={6000}
          minLength={20}
          required
          disabled={pending}
        />
        <p className="text-right text-xs tabular-nums text-muted-foreground">
          {description.length.toLocaleString()} / 6,000
        </p>
      </Field>
      <details className="group border-y border-border py-5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>
            <span className="block text-sm font-medium">Technical details</span>
            <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">
              Optional · source address, source port, and protocol from your
              logs
            </span>
          </span>
          <ChevronDown
            className="size-4 shrink-0 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="mt-5 grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Field
            name="sourceIp"
            label="Source IP address"
            error={errors.sourceIp}
          >
            <Input
              {...inputProps("sourceIp")}
              className="h-11 font-mono"
              disabled={pending}
              maxLength={120}
              placeholder="198.51.100.17"
            />
          </Field>
          <Field
            name="sourcePort"
            label="Source port"
            error={errors.sourcePort}
          >
            <Input
              {...inputProps("sourcePort")}
              className="h-11 font-mono"
              inputMode="numeric"
              disabled={pending}
              maxLength={5}
              placeholder="51842"
            />
          </Field>
          <Field name="protocol" label="Protocol" error={errors.protocol}>
            <Input
              {...inputProps("protocol")}
              disabled={pending}
              maxLength={40}
              placeholder="TCP / HTTPS"
            />
          </Field>
        </div>
      </details>
      <Field
        name="reference"
        label="HackerAI reference"
        hint="Only if you already have one: a run, workspace, case reference, or notice from us."
        error={errors.reference}
      >
        <Input
          {...inputProps("reference")}
          maxLength={160}
          disabled={pending}
        />
      </Field>
      <Field
        name="evidence"
        label="Log excerpt or other evidence"
        hint="Plain text only, no attachments. Include just the lines that show the activity. Remove passwords, keys, tokens, and unnecessary personal data. Do not include illegal material."
        error={errors.evidence}
      >
        <Textarea
          {...inputProps("evidence")}
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          className="min-h-32 font-mono text-sm"
          maxLength={6000}
          disabled={pending}
        />
        <p className="text-right text-xs tabular-nums text-muted-foreground">
          {evidence.length.toLocaleString()} / 6,000
        </p>
      </Field>
      <div hidden aria-hidden="true">
        <label htmlFor="website">Leave blank</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <p className="text-[13px] leading-6 text-muted-foreground">
        Your report is emailed to our abuse inbox for review. We keep an
        encrypted copy temporarily for delivery. Email copies are handled under
        our{" "}
        <Link
          href="/privacy-policy"
          className="text-foreground underline underline-offset-4"
        >
          Privacy Policy
        </Link>
        .
      </p>
      {failure && (
        <div
          ref={failureBox}
          role="alert"
          tabIndex={-1}
          className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm leading-6 outline-none"
        >
          {failure}
        </div>
      )}
      {available && siteKey && (
        <SecurityCheck
          siteKey={siteKey}
          resetKey={resetChallenge}
          onToken={onToken}
        />
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Button
          type="submit"
          disabled={pending || !available}
          aria-describedby={available ? "security-check-status" : undefined}
          className="min-h-11 sm:w-auto"
        >
          {pending && (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          )}
          {pending
            ? "Submitting…"
            : failure
              ? "Try again"
              : kind === "appeal"
                ? "Submit appeal"
                : "Submit report"}
        </Button>
        <p
          role="status"
          className="text-[13px] leading-5 text-muted-foreground"
        >
          {pending
            ? "Saving your report…"
            : "You will see a confirmation here once your report is received."}
        </p>
      </div>
    </form>
  );
}
