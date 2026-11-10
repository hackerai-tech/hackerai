"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  HTTP_RETEST_LIMITS,
  HTTP_RETEST_RECIPE_VERSION,
  NONREPRODUCTION_STATUSES,
  parseHttpRetestRecipe,
  type HttpRetestRecipe,
} from "@/lib/findings/http-retest";
import { cn } from "@/lib/utils";

type CheckForm = {
  json_path: string;
  type: "text" | "number" | "boolean" | "null";
  value: string;
};
type PredicateForm = { status: string; checks: CheckForm[]; contains: string };
type RequestForm = {
  label: string;
  path: string;
  credential: string;
  headers: HttpRetestRecipe["probe"]["headers"];
  predicate: PredicateForm;
};
type CredentialForm = HttpRetestRecipe["credentials"][number];
type RecipeForm = {
  title: string;
  origin: string;
  timeoutSeconds: string;
  credentials: CredentialForm[];
  baselines: RequestForm[];
  probe: RequestForm & { denied: number[] };
};

const selectClass =
  "border-input dark:bg-input/30 h-9 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

const toCheckForm = (
  check: HttpRetestRecipe["probe"]["vulnerable"]["json"][number],
): CheckForm => ({
  json_path: check.json_path,
  type:
    check.equals === null
      ? "null"
      : typeof check.equals === "number"
        ? "number"
        : typeof check.equals === "boolean"
          ? "boolean"
          : "text",
  value: check.equals === null ? "" : String(check.equals),
});

const toPredicateForm = (
  predicate: HttpRetestRecipe["probe"]["vulnerable"],
): PredicateForm => ({
  status: String(predicate.status),
  checks: predicate.json.map(toCheckForm),
  contains: predicate.body_contains.join("\n"),
});

const toRequestForm = (
  request: HttpRetestRecipe["baselines"][number] | HttpRetestRecipe["probe"],
  predicate: HttpRetestRecipe["probe"]["vulnerable"],
): RequestForm => ({
  label: request.label,
  path: request.path,
  credential: request.credential ?? "",
  headers: request.headers,
  predicate: toPredicateForm(predicate),
});

const emptyPredicate = (path = "id"): PredicateForm => ({
  status: "200",
  checks: [{ json_path: path, type: "text", value: "" }],
  contains: "",
});

const originFromTarget = (target: string) => {
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : "";
  } catch {
    return "";
  }
};

export function initialRecipeForm(
  recipe: HttpRetestRecipe | null,
  finding: { title: string; target: string },
): RecipeForm {
  if (recipe)
    return {
      title: recipe.title,
      origin: recipe.origin,
      timeoutSeconds: String(recipe.timeout_ms / 1000),
      credentials: recipe.credentials,
      baselines: recipe.baselines.map((b) => toRequestForm(b, b.expect)),
      probe: {
        ...toRequestForm(recipe.probe, recipe.probe.vulnerable),
        denied: recipe.probe.not_reproduced.statuses,
      },
    };
  return {
    title: finding.title.slice(0, 120),
    origin: originFromTarget(finding.target),
    timeoutSeconds: "8",
    credentials: [
      {
        name: "tester_token",
        label: "Tester account token",
        placement: "bearer",
      },
    ],
    baselines: [
      {
        label: "Baseline · own record",
        path: "/",
        credential: "tester_token",
        headers: [],
        predicate: emptyPredicate("owner_id"),
      },
    ],
    probe: {
      label: "Cross-account · other record",
      path: "/",
      credential: "tester_token",
      headers: [],
      predicate: emptyPredicate("owner_id"),
      denied: [403, 404],
    },
  };
}

const toEquals = (check: CheckForm) =>
  check.type === "null"
    ? null
    : check.type === "number"
      ? Number(check.value)
      : check.type === "boolean"
        ? check.value.trim() === "true"
        : check.value;

const toPredicate = (form: PredicateForm) => ({
  status: Number(form.status),
  json: form.checks
    .filter((check) => check.json_path.trim())
    .map((check) => ({
      json_path: check.json_path.trim(),
      equals: toEquals(check),
    })),
  body_contains: form.contains
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
});

const toRequest = (form: RequestForm) => ({
  label: form.label,
  method: "GET" as const,
  path: form.path.trim(),
  credential: form.credential || null,
  headers: form.headers,
});

export function recipeFromForm(form: RecipeForm) {
  return parseHttpRetestRecipe({
    version: HTTP_RETEST_RECIPE_VERSION,
    title: form.title,
    origin: form.origin.trim(),
    timeout_ms: Math.round(Number(form.timeoutSeconds) * 1000),
    credentials: form.credentials,
    baselines: form.baselines.map((baseline) => ({
      ...toRequest(baseline),
      expect: toPredicate(baseline.predicate),
    })),
    probe: {
      ...toRequest(form.probe),
      vulnerable: toPredicate(form.probe.predicate),
      not_reproduced: { statuses: form.probe.denied },
    },
  });
}

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? (
        <span className="text-xs leading-5 text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function PredicateFields({
  value,
  onChange,
  statusLabel,
}: {
  value: PredicateForm;
  onChange: (next: PredicateForm) => void;
  statusLabel: string;
}) {
  const setCheck = (index: number, patch: Partial<CheckForm>) =>
    onChange({
      ...value,
      checks: value.checks.map((check, i) =>
        i === index ? { ...check, ...patch } : check,
      ),
    });
  return (
    <div className="space-y-3">
      <Field label={statusLabel} className="max-w-32">
        <Input
          inputMode="numeric"
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value })}
        />
      </Field>
      <div className="space-y-2">
        <span className="text-xs font-medium text-foreground">
          JSON identity checks
        </span>
        {value.checks.map((check, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1fr)_2.25rem] items-center gap-2"
          >
            <Input
              aria-label="JSON field path"
              placeholder="data.owner_id"
              className="font-mono text-xs"
              value={check.json_path}
              onChange={(e) => setCheck(index, { json_path: e.target.value })}
            />
            <select
              aria-label="Value type"
              className={selectClass}
              value={check.type}
              onChange={(e) =>
                setCheck(index, { type: e.target.value as CheckForm["type"] })
              }
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
            </select>
            <Input
              aria-label="Expected value"
              placeholder={check.type === "boolean" ? "true" : "Expected value"}
              className="font-mono text-xs"
              disabled={check.type === "null"}
              value={check.value}
              onChange={(e) => setCheck(index, { value: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove check"
              onClick={() =>
                onChange({
                  ...value,
                  checks: value.checks.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        {value.checks.length < HTTP_RETEST_LIMITS.maxIdentityChecks ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() =>
              onChange({
                ...value,
                checks: [
                  ...value.checks,
                  { json_path: "", type: "text", value: "" },
                ],
              })
            }
          >
            <Plus className="size-4" aria-hidden="true" />
            Add field check
          </Button>
        ) : null}
      </div>
      <Field
        label="Response text contains (optional, one per line)"
        hint="Literal text, not a pattern. Use for non-JSON responses."
      >
        <textarea
          rows={2}
          className={cn(selectClass, "h-auto py-2 font-mono text-xs")}
          value={value.contains}
          onChange={(e) => onChange({ ...value, contains: e.target.value })}
        />
      </Field>
    </div>
  );
}

function RequestFields({
  value,
  onChange,
  credentials,
  origin,
}: {
  value: RequestForm;
  onChange: (next: RequestForm) => void;
  credentials: CredentialForm[];
  origin: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
      <Field label="Label">
        <Input
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      </Field>
      <Field label="Credential">
        <select
          className={selectClass}
          value={value.credential}
          onChange={(e) => onChange({ ...value, credential: e.target.value })}
        >
          <option value="">None</option>
          {credentials.map((credential) => (
            <option key={credential.name} value={credential.name}>
              {credential.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="GET path"
        hint={origin ? `Sent to ${origin}${value.path || "/"}` : undefined}
        className="sm:col-span-2"
      >
        <Input
          className="font-mono text-xs"
          placeholder="/api/invoices/inv_1002"
          value={value.path}
          onChange={(e) => onChange({ ...value, path: e.target.value })}
        />
      </Field>
    </div>
  );
}

export function FindingRetestRecipeEditor({
  open,
  onOpenChange,
  findingId,
  finding,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  findingId: string;
  finding: { title: string; target: string };
  current: { version: number; recipe: HttpRetestRecipe } | null;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() =>
    initialRecipeForm(current?.recipe ?? null, finding),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const parsed = recipeFromForm(form);
    if (!parsed.success) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/finding-retests", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          findingId,
          expectedVersion: current?.version ?? 0,
          recipe: parsed.recipe,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (!response.ok) {
        setError(
          response.status === 409
            ? "Someone saved a newer recipe. Close this editor and reopen it to edit the latest version."
            : (body?.message ?? "The recipe could not be saved. Try again."),
        );
        return;
      }
      onSaved();
      onOpenChange(false);
    } catch {
      setError("The recipe could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const setCredential = (index: number, patch: Partial<CredentialForm>) =>
    setForm((prev) => ({
      ...prev,
      credentials: prev.credentials.map((credential, i) =>
        i === index
          ? ({ ...credential, ...patch } as CredentialForm)
          : credential,
      ),
    }));

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain p-4 sm:max-w-2xl sm:p-6">
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader className="pr-8 text-left">
            <DialogTitle>
              {current ? "Edit HTTP retest recipe" : "Add HTTP retest recipe"}
            </DialogTitle>
            <DialogDescription>
              Baselines prove each account can read its own record. The probe
              requests another account&apos;s record. Credentials are named here
              and entered only when you run the retest.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem]">
            <Field label="Title">
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </Field>
            <Field label="Target origin" hint="Scheme, host and port only.">
              <Input
                className="font-mono text-xs"
                placeholder="https://app.example.com"
                value={form.origin}
                onChange={(e) => setForm({ ...form, origin: e.target.value })}
              />
            </Field>
            <Field label="Timeout (s)">
              <Input
                inputMode="numeric"
                value={form.timeoutSeconds}
                onChange={(e) =>
                  setForm({ ...form, timeoutSeconds: e.target.value })
                }
              />
            </Field>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-foreground">
              Runtime credentials
            </legend>
            <p className="text-xs leading-5 text-muted-foreground">
              Values are asked for at each run and never saved.
            </p>
            {form.credentials.map((credential, index) => (
              <div
                key={index}
                className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[9rem_minmax(0,1fr)_7.5rem_minmax(0,1fr)_2.25rem] sm:items-end"
              >
                <Field label="Name">
                  <Input
                    className="font-mono text-xs"
                    value={credential.name}
                    onChange={(e) =>
                      setCredential(index, { name: e.target.value })
                    }
                  />
                </Field>
                <Field label="Description">
                  <Input
                    value={credential.label}
                    onChange={(e) =>
                      setCredential(index, { label: e.target.value })
                    }
                  />
                </Field>
                <Field label="Sent as">
                  <select
                    className={selectClass}
                    value={credential.placement}
                    onChange={(e) => {
                      const placement = e.target
                        .value as CredentialForm["placement"];
                      setCredential(index, {
                        placement,
                        header_name:
                          placement === "header"
                            ? (credential.header_name ?? "X-API-Key")
                            : undefined,
                      });
                    }}
                  >
                    <option value="bearer">Bearer</option>
                    <option value="cookie">Cookie</option>
                    <option value="header">Header</option>
                  </select>
                </Field>
                <Field label="Header name">
                  <Input
                    className="font-mono text-xs"
                    disabled={credential.placement !== "header"}
                    value={credential.header_name ?? ""}
                    onChange={(e) =>
                      setCredential(index, { header_name: e.target.value })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove credential ${credential.name}`}
                  onClick={() =>
                    setForm({
                      ...form,
                      credentials: form.credentials.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            {form.credentials.length < HTTP_RETEST_LIMITS.maxCredentials ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm({
                    ...form,
                    credentials: [
                      ...form.credentials,
                      {
                        name: `account_${form.credentials.length + 1}_token`,
                        label: "Account token",
                        placement: "bearer",
                      },
                    ],
                  })
                }
              >
                <Plus className="size-4" aria-hidden="true" />
                Add credential
              </Button>
            ) : null}
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold text-foreground">
              Baseline requests
            </legend>
            {form.baselines.map((baseline, index) => (
              <div
                key={index}
                className="space-y-4 rounded-lg border border-border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Baseline {index + 1}
                  </span>
                  {form.baselines.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setForm({
                          ...form,
                          baselines: form.baselines.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                <RequestFields
                  value={baseline}
                  credentials={form.credentials}
                  origin={form.origin}
                  onChange={(next) =>
                    setForm({
                      ...form,
                      baselines: form.baselines.map((b, i) =>
                        i === index ? next : b,
                      ),
                    })
                  }
                />
                <PredicateFields
                  statusLabel="Expected status"
                  value={baseline.predicate}
                  onChange={(predicate) =>
                    setForm({
                      ...form,
                      baselines: form.baselines.map((b, i) =>
                        i === index ? { ...b, predicate } : b,
                      ),
                    })
                  }
                />
              </div>
            ))}
            {form.baselines.length < HTTP_RETEST_LIMITS.maxBaselines ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm({
                    ...form,
                    baselines: [
                      ...form.baselines,
                      {
                        label: "Baseline · own record",
                        path: "/",
                        credential: form.credentials[0]?.name ?? "",
                        headers: [],
                        predicate: emptyPredicate("owner_id"),
                      },
                    ],
                  })
                }
              >
                <Plus className="size-4" aria-hidden="true" />
                Add baseline
              </Button>
            ) : null}
          </fieldset>

          <fieldset className="space-y-4 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-semibold text-foreground">
              Probe
            </legend>
            <RequestFields
              value={form.probe}
              credentials={form.credentials}
              origin={form.origin}
              onChange={(next) =>
                setForm({ ...form, probe: { ...form.probe, ...next } })
              }
            />
            <PredicateFields
              statusLabel="Vulnerable status"
              value={form.probe.predicate}
              onChange={(predicate) =>
                setForm({ ...form, probe: { ...form.probe, predicate } })
              }
            />
            <div className="space-y-2">
              <span className="text-xs font-medium text-foreground">
                Counts as not reproduced
              </span>
              <div className="flex flex-wrap gap-3">
                {NONREPRODUCTION_STATUSES.map((status) => (
                  <label
                    key={status}
                    className="inline-flex items-center gap-2 font-mono text-xs"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-foreground"
                      checked={form.probe.denied.includes(status)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          probe: {
                            ...form.probe,
                            denied: e.target.checked
                              ? [...form.probe.denied, status]
                              : form.probe.denied.filter((s) => s !== status),
                          },
                        })
                      }
                    />
                    {status}
                  </label>
                ))}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                A 401, a redirect or any other response is skipped, never
                treated as fixed.
              </p>
            </div>
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save recipe"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
