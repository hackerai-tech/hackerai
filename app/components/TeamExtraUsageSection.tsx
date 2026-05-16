"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  AdjustSpendingLimitDialog,
  AutoReloadDialog,
  BuyExtraUsageDialog,
} from "@/app/components/extra-usage";

type Member = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  monthlyLimitDollars?: number;
  monthlySpentDollars: number;
  disabled: boolean;
};

type Pool = {
  enabled: boolean;
  balanceDollars: number;
  autoReloadEnabled: boolean;
  autoReloadThresholdDollars?: number;
  autoReloadAmountDollars?: number;
  monthlyCapDollars?: number;
  monthlySpentDollars: number;
  trustCapDollars: number | null;
  trustReason: string;
  autoReloadDisabledReason?: string;
};

const getUsageColorClass = (percentage: number): string => {
  if (percentage >= 90) return "bg-red-500";
  if (percentage >= 70) return "bg-orange-500";
  return "bg-blue-500";
};

/**
 * Admin-only section inside the Team tab. Shows the team-pool balance and
 * exposes controls to fund the pool, set caps, and manage per-member limits.
 * Mirrors ExtraUsageSection's idiom; data comes from /api/team/extra-usage.
 */
export const TeamExtraUsageSection = () => {
  const [pool, setPool] = useState<Pool | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);

  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const [showSpendingLimitDialog, setShowSpendingLimitDialog] = useState(false);
  const [showAutoReloadDialog, setShowAutoReloadDialog] = useState(false);
  const [memberDialog, setMemberDialog] = useState<Member | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch("/api/team/extra-usage");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPool(data.pool);
      setMembers(data.members);
    } catch (err) {
      console.error("Failed to load team extra usage:", err);
      toast.error("Failed to load team extra usage");
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updatePool = async (
    patch: Record<string, unknown>,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch("/api/team/extra-usage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error || "Failed");
      }
      await load();
      return true;
    } catch (err) {
      console.error("Failed to update pool:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to update settings",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const updateMember = async (
    userId: string,
    patch: { monthlyLimitDollars?: number | null; disabled?: boolean },
  ): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/team/extra-usage/members/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(body.error || "Failed");
      }
      await load();
      return true;
    } catch (err) {
      console.error("Failed to update member:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to update member",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePool = async (enabled: boolean) => {
    const ok = await updatePool({ enabled });
    if (!ok) return;
    toast.success(
      enabled ? "Team extra usage enabled" : "Team extra usage disabled",
    );
  };

  const handlePurchase = async (amountDollars: number) => {
    setBusy(true);
    try {
      const res = await fetch("/api/team/extra-usage/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountDollars }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Failed to start checkout");
      }
      window.location.href = data.url;
    } catch (err) {
      console.error("Failed to start checkout:", err);
      toast.error(
        err instanceof Error ? err.message : "Failed to start checkout",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSpendingLimit = async (limitDollars: number | null) => {
    const ok = await updatePool({ monthlyCapDollars: limitDollars });
    if (!ok) return;
    setShowSpendingLimitDialog(false);
    toast.success(
      limitDollars
        ? "Team spending limit updated"
        : "Team spending limit removed",
    );
  };

  const handleSaveAutoReload = async (
    thresholdDollars: number,
    amountDollars: number,
  ) => {
    const ok = await updatePool({
      autoReloadEnabled: true,
      autoReloadThresholdDollars: thresholdDollars,
      autoReloadAmountDollars: amountDollars,
    });
    if (!ok) return;
    setShowAutoReloadDialog(false);
    toast.success("Auto-reload enabled");
  };

  const handleTurnOffAutoReload = async () => {
    const ok = await updatePool({ autoReloadEnabled: false });
    if (!ok) return;
    setShowAutoReloadDialog(false);
    toast.success("Auto-reload disabled");
  };

  if (loading) {
    return (
      <section className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">Loading team usage…</p>
      </section>
    );
  }

  if (!pool) {
    return (
      <section className="flex flex-col gap-3 items-start">
        <p className="text-sm text-muted-foreground">
          {loadError
            ? "Couldn't load team usage."
            : "No team usage data available."}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          Retry
        </Button>
      </section>
    );
  }

  const monthlyCapDollars = pool.monthlyCapDollars;
  const trustCapDollars = pool.trustCapDollars;
  const trustReason = pool.trustReason;

  const effectiveCapDollars =
    monthlyCapDollars != null && trustCapDollars != null
      ? Math.min(monthlyCapDollars, trustCapDollars)
      : (monthlyCapDollars ?? trustCapDollars);

  const isTrustCapActive =
    trustCapDollars != null &&
    trustReason !== "trusted" &&
    (monthlyCapDollars == null || trustCapDollars <= monthlyCapDollars);

  return (
    <>
      <section
        data-testid="team-extra-usage-section"
        className="flex flex-col gap-6"
      >
        <div className="w-full min-w-0 flex flex-row gap-x-8 gap-y-3 justify-between items-center">
          <div className="flex flex-col gap-1.5 min-w-0">
            <p className="text-sm font-medium">Team extra usage</p>
            <p className="text-sm text-muted-foreground">
              Fund a shared pool that any member can use when they hit the team
              subscription limit. Set per-member caps below.
            </p>
          </div>
          <Switch
            checked={pool.enabled}
            onCheckedChange={handleTogglePool}
            disabled={busy}
            aria-label="Toggle team extra usage"
          />
        </div>

        {pool.enabled && (
          <>
            {effectiveCapDollars != null && effectiveCapDollars > 0 && (
              <div className="w-full flex flex-col gap-2">
                <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center flex-wrap">
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <p className="text-sm">
                      ${pool.monthlySpentDollars.toFixed(2)} spent (team)
                    </p>
                    <p className="text-sm text-muted-foreground whitespace-nowrap">
                      Resets{" "}
                      {new Date(
                        new Date().getFullYear(),
                        new Date().getMonth() + 1,
                        1,
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 md:flex-1 md:max-w-xl">
                    <div className="flex-1">
                      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full transition-all duration-500 ${getUsageColorClass(
                            (pool.monthlySpentDollars / effectiveCapDollars) *
                              100,
                          )}`}
                          style={{
                            width: `${Math.min(100, (pool.monthlySpentDollars / effectiveCapDollars) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-nowrap text-right">
                      {Math.min(
                        100,
                        Math.round(
                          (pool.monthlySpentDollars / effectiveCapDollars) *
                            100,
                        ),
                      )}
                      % used
                    </p>
                  </div>
                </div>
                {isTrustCapActive && (
                  <p className="text-xs text-muted-foreground">
                    Your team&apos;s extra usage limit is ${trustCapDollars}
                    /month while your account builds payment history.{" "}
                    <a
                      href="mailto:support@hackerai.co"
                      className="underline underline-offset-[3px] hover:text-foreground"
                    >
                      Contact us
                    </a>{" "}
                    for a higher limit.
                  </p>
                )}
              </div>
            )}

            <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center">
              <div className="flex flex-col gap-1.5 min-w-0">
                <p className="text-sm">
                  {effectiveCapDollars != null
                    ? `$${effectiveCapDollars.toFixed(2)}`
                    : "Unlimited"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Team monthly spending limit
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSpendingLimitDialog(true)}
                disabled={busy}
                className="min-w-[5rem]"
                aria-label="Adjust team spending limit"
              >
                Adjust
              </Button>
            </div>

            <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center flex-wrap">
              <div className="flex flex-col gap-1.5 min-w-0">
                <p className="text-sm">${pool.balanceDollars.toFixed(2)}</p>
                <p className="text-sm text-muted-foreground whitespace-nowrap">
                  Current team balance
                  <span className="mx-1">·</span>
                  <button
                    type="button"
                    onClick={() => setShowAutoReloadDialog(true)}
                    className={
                      pool.autoReloadEnabled
                        ? "text-green-500 underline hover:text-green-400"
                        : "text-red-500 underline hover:text-red-400"
                    }
                    aria-label="Configure auto-reload"
                  >
                    Auto-reload {pool.autoReloadEnabled ? "on" : "off"}
                  </button>
                </p>
                {!pool.autoReloadEnabled && pool.autoReloadDisabledReason && (
                  <div
                    role="alert"
                    className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500"
                  >
                    Auto-reload was turned off because the card kept failing:{" "}
                    {pool.autoReloadDisabledReason}. Update your payment method
                    in the billing portal, then turn auto-reload back on.
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowBuyDialog(true)}
                disabled={busy}
                className="min-w-[5rem]"
                aria-label="Buy team extra usage"
              >
                Buy extra usage
              </Button>
            </div>

            {/* Per-member limits */}
            <div className="w-full flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">Member spending limits</p>
                <p className="text-sm text-muted-foreground">
                  Set a monthly cap or pause access for individual members.
                </p>
              </div>
              <div className="w-full border rounded-md divide-y">
                {members.map((m) => {
                  const displayName =
                    `${m.firstName} ${m.lastName}`.trim() || m.email;
                  return (
                    <div
                      key={m.userId}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="flex flex-col min-w-0">
                        <p className="text-sm truncate">{displayName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          ${m.monthlySpentDollars.toFixed(2)} spent
                          <span className="mx-1">·</span>
                          {m.monthlyLimitDollars != null
                            ? `$${m.monthlyLimitDollars.toFixed(2)} limit`
                            : "No member limit"}
                          {m.disabled && (
                            <>
                              <span className="mx-1">·</span>
                              <span className="text-red-500">Disabled</span>
                            </>
                          )}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setMemberDialog(m)}
                        disabled={busy}
                        aria-label={`Edit limits for ${displayName}`}
                      >
                        Edit
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </section>

      <BuyExtraUsageDialog
        open={showBuyDialog}
        onOpenChange={setShowBuyDialog}
        onPurchase={handlePurchase}
        isLoading={busy}
        title="Buy team extra usage"
        description="Fund a shared pool that team members can use when they hit the team subscription limit."
        lineItemLabel="Team extra usage"
        paymentMethodMode="checkout"
      />

      <AdjustSpendingLimitDialog
        open={showSpendingLimitDialog}
        onOpenChange={setShowSpendingLimitDialog}
        onSave={handleSaveSpendingLimit}
        isLoading={busy}
        currentLimitDollars={monthlyCapDollars ?? null}
      />

      <AutoReloadDialog
        open={showAutoReloadDialog}
        onOpenChange={setShowAutoReloadDialog}
        onSave={handleSaveAutoReload}
        onTurnOff={handleTurnOffAutoReload}
        onCancel={() => setShowAutoReloadDialog(false)}
        isLoading={busy}
        isEnabled={pool.autoReloadEnabled}
        currentThresholdDollars={pool.autoReloadThresholdDollars ?? null}
        currentAmountDollars={pool.autoReloadAmountDollars ?? null}
      />

      {memberDialog && (
        <MemberSpendLimitDialog
          member={memberDialog}
          isLoading={busy}
          onClose={() => setMemberDialog(null)}
          onSave={async (patch) => {
            const ok = await updateMember(memberDialog.userId, patch);
            if (!ok) return;
            setMemberDialog(null);
            toast.success("Member updated");
          }}
        />
      )}
    </>
  );
};

// =============================================================================
// MemberSpendLimitDialog — inline since this is its only caller.
// =============================================================================

const MemberSpendLimitDialog = ({
  member,
  isLoading,
  onClose,
  onSave,
}: {
  member: Member;
  isLoading: boolean;
  onClose: () => void;
  onSave: (patch: {
    monthlyLimitDollars?: number | null;
    disabled?: boolean;
  }) => void | Promise<void>;
}) => {
  const [limitInput, setLimitInput] = useState<string>(
    member.monthlyLimitDollars != null
      ? String(member.monthlyLimitDollars)
      : "",
  );
  const [disabled, setDisabled] = useState<boolean>(member.disabled);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = limitInput.trim();
    let monthlyLimitDollars: number | null;
    if (trimmed === "") {
      monthlyLimitDollars = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("Spending limit must be a non-negative number");
        return;
      }
      monthlyLimitDollars = parsed;
    }
    await onSave({ monthlyLimitDollars, disabled });
  };

  const displayName =
    `${member.firstName} ${member.lastName}`.trim() || member.email;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit limits for ${displayName}`}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-background rounded-lg shadow-lg p-6 w-full max-w-md flex flex-col gap-4"
      >
        <div>
          <h3 className="text-base font-medium">Edit limits — {displayName}</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Currently ${member.monthlySpentDollars.toFixed(2)} spent this month
            from the team pool.
          </p>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm">Monthly spending limit (USD)</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            value={limitInput}
            onChange={(e) => setLimitInput(e.target.value)}
            placeholder="No limit"
            disabled={isLoading}
            className="border rounded-md px-3 py-2 text-sm bg-background"
          />
          <span className="text-xs text-muted-foreground">
            Leave blank for no per-member cap.
          </span>
        </label>

        <label className="flex items-center gap-3">
          <Switch
            checked={!disabled}
            onCheckedChange={(checked) => setDisabled(!checked)}
            disabled={isLoading}
            aria-label="Allow this member to use team extra usage"
          />
          <span className="text-sm">
            {disabled
              ? "Blocked from team extra usage"
              : "Can use team extra usage"}
          </span>
        </label>

        <div className="flex justify-end gap-2 mt-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading}>
            Save
          </Button>
        </div>
      </form>
    </div>
  );
};
