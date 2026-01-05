"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { X, Minus, Plus, Loader2 } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpgrade } from "../hooks/useUpgrade";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "../contexts/GlobalState";
import UpgradeConfirmationDialog from "./UpgradeConfirmationDialog";
import { PRICING } from "@/lib/pricing/features";

interface TeamPricingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialSeats?: number;
  initialPlan?: "monthly" | "yearly";
}

const TeamPricingDialog: React.FC<TeamPricingDialogProps> = ({
  isOpen,
  onClose,
  initialSeats = 5,
  initialPlan = "monthly",
}) => {
  const { user } = useAuth();
  const { subscription } = useGlobalState();
  const { upgradeLoading, upgradeError, handleUpgrade, setUpgradeError } =
    useUpgrade();
  const [billingPeriod, setBillingPeriod] = React.useState<
    "monthly" | "yearly"
  >(initialPlan);
  const [seats, setSeats] = React.useState(initialSeats);
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [showUpgradeConfirmation, setShowUpgradeConfirmation] =
    React.useState(false);
  const [targetPlanForConfirmation, setTargetPlanForConfirmation] =
    React.useState<string>("");

  const formatNumber = (num: number) => {
    return num.toLocaleString("en-US");
  };

  const pricePerSeat = billingPeriod === "yearly" ? 33 : 40;
  const minSeats = 2;
  const maxSeats = 999;

  const handleSeatsChange = (value: string) => {
    const num = parseInt(value) || minSeats;
    setSeats(Math.min(Math.max(num, minSeats), maxSeats));
  };

  const handleDecrementSeats = () => {
    setSeats((prev) => Math.max(prev - 1, minSeats));
  };

  const handleIncrementSeats = () => {
    setSeats((prev) => Math.min(prev + 1, maxSeats));
  };

  const totalPrice = seats * pricePerSeat;
  const fullPrice = billingPeriod === "yearly" ? seats * 40 * 12 : totalPrice;
  const discount = billingPeriod === "yearly" ? fullPrice - seats * 33 * 12 : 0;
  const discountPercentage = 17;

  const handleContinue = async () => {
    if (!user) {
      setUpgradeError("Please sign in to upgrade");
      return;
    }

    const planKey =
      billingPeriod === "yearly" ? "team-yearly-plan" : "team-monthly-plan";

    // For Pro users: show confirmation dialog with proration preview
    if (subscription === "pro") {
      setTargetPlanForConfirmation(planKey);
      setShowUpgradeConfirmation(true);
      return;
    }

    // For free users: proceed to checkout
    await handleUpgrade(planKey, undefined, seats, subscription);
  };

  const handleCloseConfirmation = () => {
    setShowUpgradeConfirmation(false);
    setTargetPlanForConfirmation("");
  };

  // Sync state with URL (only after initial state is loaded from URL/props)
  React.useEffect(() => {
    if (!isOpen || !isInitialized) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("numSeats", seats.toString());
    url.searchParams.set(
      "selectedPlan",
      billingPeriod === "yearly" ? "yearly" : "monthly",
    );
    url.hash = "team-pricing-seat-selection";
    window.history.replaceState({}, "", url.toString());
  }, [isOpen, seats, billingPeriod, isInitialized]);

  // Initialize from URL params or props when dialog opens
  React.useEffect(() => {
    if (isOpen && !isInitialized) {
      const url = new URL(window.location.href);
      const urlSeats = url.searchParams.get("numSeats");
      const urlPlan = url.searchParams.get("selectedPlan");

      if (urlSeats) {
        const num = parseInt(urlSeats);
        if (!isNaN(num)) {
          setSeats(Math.min(Math.max(num, minSeats), maxSeats));
        }
      } else {
        setSeats(initialSeats);
      }

      if (urlPlan === "yearly" || urlPlan === "monthly") {
        setBillingPeriod(urlPlan);
      } else {
        setBillingPeriod(initialPlan);
      }

      setIsInitialized(true);
    } else if (!isOpen && isInitialized) {
      // Clean up URL when dialog closes
      const url = new URL(window.location.href);
      url.searchParams.delete("numSeats");
      url.searchParams.delete("selectedPlan");
      url.hash = "";
      window.history.replaceState({}, "", url.toString());
      setIsInitialized(false);
    }
  }, [isOpen, isInitialized, initialSeats, initialPlan, minSeats, maxSeats]);

  return (
    <>
      <UpgradeConfirmationDialog
        isOpen={showUpgradeConfirmation}
        onClose={handleCloseConfirmation}
        planName="Team"
        price={
          billingPeriod === "yearly"
            ? PRICING.team.yearly
            : PRICING.team.monthly
        }
        targetPlan={targetPlanForConfirmation}
        quantity={seats}
      />
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent
          className="!max-w-none !w-screen !h-screen !max-h-none !m-0 !rounded-none !inset-0 !translate-x-0 !translate-y-0 !top-0 !left-0 overflow-y-auto"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Team Pricing</DialogTitle>
          <div className="h-full w-full overflow-y-auto">
            {/* Mobile View */}
            <div className="md:hidden relative flex min-h-[100dvh] w-full justify-center overflow-y-auto pt-4">
              <div className="flex w-full max-w-full flex-none items-center justify-center [@media(min-width:450px)]:max-w-[380px]">
                <div className="flex w-full flex-col gap-6 [@media(min-width:450px)]:px-4">
                  <div className="flex flex-col gap-4 text-center">
                    <div className="text-3xl font-normal">
                      Set up your Business plan
                    </div>
                    <div className="text-muted-foreground">
                      Minimum 2 seats. Add and reassign seats at anytime
                    </div>
                    {subscription === "pro" && (
                      <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-2">
                        Your remaining Pro subscription time will be credited
                        toward Team
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col gap-6">
                    <div className="mb-3 flex w-full flex-col">
                      <Label
                        htmlFor="seats"
                        className="mb-1 flex text-base font-medium"
                      >
                        Seats
                      </Label>
                      <div className="relative flex items-center">
                        <Input
                          id="seats"
                          type="number"
                          min={minSeats}
                          max={maxSeats}
                          value={seats}
                          onChange={(e) => handleSeatsChange(e.target.value)}
                          className="h-12 w-full rounded-full border border-border ps-5 pe-20 text-sm focus:border-foreground focus:ring-foreground"
                        />
                        <div className="absolute end-2 flex gap-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full border-none hover:bg-muted"
                            onClick={handleDecrementSeats}
                            disabled={seats <= minSeats}
                          >
                            <Minus className="h-5 w-5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full border-none hover:bg-muted"
                            onClick={handleIncrementSeats}
                            disabled={seats >= maxSeats}
                          >
                            <Plus className="h-5 w-5" />
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="font-medium">Plan Summary</label>
                      <div className="flex flex-col gap-6 rounded-3xl border border-border p-5">
                        <div
                          role="group"
                          className="bg-muted cursor-pointer rounded-full p-1 select-none"
                          tabIndex={0}
                        >
                          <div className="relative grid h-full grid-cols-2 gap-1">
                            <div className="relative z-10 h-full px-3 text-center font-medium py-1.5 text-sm">
                              <button
                                type="button"
                                onClick={() => setBillingPeriod("yearly")}
                                className={`box-content h-full w-full ${
                                  billingPeriod === "yearly"
                                    ? "text-foreground"
                                    : "text-muted-foreground"
                                }`}
                              >
                                <div className="flex flex-wrap justify-center gap-1 text-center">
                                  Yearly
                                  <span className="text-[#10A37F]">
                                    ({discountPercentage}% off)
                                  </span>
                                </div>
                              </button>
                              {billingPeriod === "yearly" && (
                                <div className="bg-background absolute inset-0 -z-10 box-content h-full rounded-full shadow-sm" />
                              )}
                            </div>
                            <div className="relative z-10 h-full px-3 text-center font-medium py-1.5 text-sm">
                              <button
                                type="button"
                                onClick={() => setBillingPeriod("monthly")}
                                className={`box-content h-full w-full ${
                                  billingPeriod === "monthly"
                                    ? "text-foreground"
                                    : "text-muted-foreground"
                                }`}
                              >
                                Monthly
                              </button>
                              {billingPeriod === "monthly" && (
                                <div className="bg-background absolute inset-0 -z-10 box-content h-full rounded-full shadow-sm" />
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex grow flex-col text-sm">
                          <div className="text-muted-foreground flex w-full justify-between text-sm">
                            <div className="flex">HackerAI Team</div>
                            <div className="flex">
                              ${formatNumber(fullPrice)}
                            </div>
                          </div>
                          <div className="text-muted-foreground/70 flex w-full justify-between text-xs">
                            <div className="flex">
                              {seats} users
                              {billingPeriod === "yearly" ? " x 12 months" : ""}
                            </div>
                            <div className="flex">
                              $
                              {formatNumber(
                                billingPeriod === "yearly"
                                  ? 40 * 12
                                  : pricePerSeat,
                              )}
                              /seat
                            </div>
                          </div>

                          {billingPeriod === "yearly" && discount > 0 && (
                            <>
                              <div className="text-muted-foreground flex w-full justify-between text-sm mt-3">
                                <div className="flex">Discount</div>
                                <div className="flex font-medium text-[#10A37F]">
                                  -${formatNumber(discount)}
                                </div>
                              </div>
                              <div className="text-muted-foreground/70 text-xs">
                                Yearly (-{discountPercentage}%)
                              </div>
                            </>
                          )}

                          <hr className="border-border my-3" />

                          <div className="flex w-full justify-between text-base font-medium">
                            <div className="flex">Today&apos;s total</div>
                            <div className="flex">
                              USD $
                              {formatNumber(
                                billingPeriod === "yearly"
                                  ? seats * 33 * 12
                                  : totalPrice,
                              )}
                            </div>
                          </div>

                          <div className="text-muted-foreground/70 mt-2 text-xs">
                            Billed{" "}
                            {billingPeriod === "monthly" ? "monthly" : "yearly"}{" "}
                            starting today
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {upgradeError && (
                    <div className="mt-4 text-sm text-red-500">
                      {upgradeError}
                    </div>
                  )}

                  <div className="flex flex-col gap-3 pb-10">
                    <Button
                      onClick={handleContinue}
                      disabled={upgradeLoading}
                      className="w-full rounded-xl bg-[#10A37F] hover:bg-[#0d8f6f] text-white"
                      size="lg"
                    >
                      {upgradeLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        "Continue to billing"
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={onClose}
                      disabled={upgradeLoading}
                      className="w-full rounded-xl"
                      size="lg"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {/* Desktop View */}
            <div className="hidden md:grid grid-flow-row grid-cols-1 md:h-full md:grid-cols-2">
              {/* Left Column - Plan Selection */}
              <div className="flex-column col-span-1 flex justify-center p-5">
                <div className="flex w-full max-w-[400px] flex-col items-center md:max-w-[600px]">
                  <button
                    onClick={onClose}
                    className="text-foreground self-start mt-8 mb-6 opacity-50 transition hover:opacity-75 md:fixed md:start-4 md:top-4 md:mt-0"
                  >
                    <X className="h-6 w-6" />
                  </button>

                  <div className="mb-8 text-3xl font-medium md:mt-[120px]">
                    Pick your plan
                  </div>

                  {subscription === "pro" && (
                    <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-2 mb-6 text-center">
                      Your remaining Pro subscription time will be credited
                      toward Team
                    </div>
                  )}

                  <RadioGroup
                    value={billingPeriod}
                    onValueChange={(value: string) =>
                      setBillingPeriod(value as "monthly" | "yearly")
                    }
                    className="col-span-3 mb-6 grid w-full gap-4 md:col-span-2 md:grid-cols-2"
                  >
                    {/* Yearly Plan */}
                    <div className="relative">
                      <Badge className="absolute start-3 top-0 -translate-y-1/2 px-2 py-1 text-xs font-medium rounded-xl bg-[#10A37F] text-white border-none z-10">
                        Save {discountPercentage}%
                      </Badge>
                      <label
                        htmlFor="yearly"
                        className={`relative flex cursor-pointer flex-col rounded-xl p-5 text-start align-top transition-[border-color] duration-100 hover:border-foreground md:min-h-[300px] ${
                          billingPeriod === "yearly"
                            ? "border-2 border-foreground"
                            : "m-[1px] border border-border"
                        }`}
                      >
                        <div className="flex w-full items-center justify-between">
                          <div className="text-xl font-medium">Yearly</div>
                          <RadioGroupItem value="yearly" id="yearly" />
                        </div>
                        <div className="flex flex-col gap-3 text-muted-foreground text-sm mt-3">
                          <div>
                            <p className="text-foreground">
                              USD $33{" "}
                              <s className="text-muted-foreground">$40</s>
                            </p>
                            <p>per user/month</p>
                          </div>
                          <ul className="ms-3 list-disc">
                            <li className="marker:text-muted-foreground mb-2">
                              Billed yearly
                            </li>
                            <li className="marker:text-muted-foreground mb-2">
                              Minimum 2 users
                            </li>
                            <li className="marker:text-muted-foreground mb-2">
                              Add and reassign users as needed
                            </li>
                          </ul>
                        </div>
                      </label>
                    </div>

                    {/* Monthly Plan */}
                    <label
                      htmlFor="monthly"
                      className={`relative flex cursor-pointer flex-col rounded-xl p-5 text-start align-top transition-[border-color] duration-100 hover:border-foreground md:min-h-[300px] ${
                        billingPeriod === "monthly"
                          ? "border-2 border-foreground"
                          : "m-[1px] border border-border"
                      }`}
                    >
                      <div className="flex w-full items-center justify-between">
                        <div className="text-xl font-medium">Monthly</div>
                        <RadioGroupItem value="monthly" id="monthly" />
                      </div>
                      <div className="flex flex-col gap-3 text-muted-foreground text-sm mt-3">
                        <div>
                          <p className="text-foreground">USD $40</p>
                          <p>per user/month</p>
                        </div>
                        <ul className="ms-3 list-disc">
                          <li className="marker:text-muted-foreground mb-2">
                            Billed monthly
                          </li>
                          <li className="marker:text-muted-foreground mb-2">
                            Minimum 2 users
                          </li>
                          <li className="marker:text-muted-foreground mb-2">
                            Add or remove users as needed
                          </li>
                        </ul>
                      </div>
                    </label>
                  </RadioGroup>

                  <div className="mb-3 flex w-full flex-col">
                    <Label
                      htmlFor="seats-desktop"
                      className="mb-1 flex text-base font-medium"
                    >
                      Users
                    </Label>
                    <div className="relative flex items-center gap-3">
                      <Input
                        id="seats-desktop"
                        type="number"
                        min={minSeats}
                        max={maxSeats}
                        value={seats}
                        onChange={(e) => handleSeatsChange(e.target.value)}
                        className="h-12 w-full rounded-lg border border-border px-5 text-sm focus:border-foreground focus:ring-foreground"
                      />
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-12 w-12 rounded-lg"
                          onClick={handleDecrementSeats}
                          disabled={seats <= minSeats}
                        >
                          <Minus className="h-5 w-5" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-12 w-12 rounded-lg"
                          onClick={handleIncrementSeats}
                          disabled={seats >= maxSeats}
                        >
                          <Plus className="h-5 w-5" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="text-muted-foreground self-start text-xs">
                    Add more seats at any time. Minimum of {minSeats} seats.
                  </div>
                </div>
              </div>

              {/* Right Column - Summary */}
              <div className="col-span-3 flex h-full flex-col items-center overflow-hidden p-6 md:col-span-1 md:shadow-lg">
                <div className="flex w-full max-w-[400px] flex-col md:mt-[120px]">
                  <p className="mb-8 text-xl font-medium">Summary</p>

                  <div className="flex grow flex-col text-sm">
                    <div className="text-muted-foreground flex w-full justify-between text-sm">
                      <div className="flex">HackerAI Team</div>
                      <div className="flex">${formatNumber(fullPrice)}</div>
                    </div>
                    <div className="text-muted-foreground/70 flex w-full justify-between text-xs">
                      <div className="flex">{seats} users</div>
                      <div className="flex">
                        $
                        {formatNumber(
                          billingPeriod === "yearly" ? 40 * 12 : pricePerSeat,
                        )}
                        /seat
                      </div>
                    </div>

                    {billingPeriod === "yearly" && discount > 0 && (
                      <div className="text-muted-foreground flex w-full justify-between text-sm mt-2">
                        <div className="flex">Discount</div>
                        <div className="flex">-${formatNumber(discount)}</div>
                      </div>
                    )}
                    {billingPeriod === "yearly" && discount > 0 && (
                      <div className="text-muted-foreground/70 flex w-full justify-between text-xs">
                        <div className="flex">
                          Yearly (-{discountPercentage}%)
                        </div>
                      </div>
                    )}

                    <hr className="border-border my-3" />

                    <div className="flex w-full justify-between text-base font-medium">
                      <div className="flex">Today&apos;s total</div>
                      <div className="flex">
                        USD $
                        {formatNumber(
                          billingPeriod === "yearly"
                            ? seats * 33 * 12
                            : totalPrice,
                        )}
                      </div>
                    </div>

                    <div className="text-muted-foreground/70 mt-2 text-xs">
                      Billed{" "}
                      {billingPeriod === "monthly" ? "monthly" : "yearly"}{" "}
                      starting today
                    </div>
                  </div>

                  {upgradeError && (
                    <div className="mt-4 text-sm text-red-500">
                      {upgradeError}
                    </div>
                  )}

                  <Button
                    onClick={handleContinue}
                    disabled={upgradeLoading}
                    className="mt-8 w-full rounded-xl bg-[#10A37F] hover:bg-[#0d8f6f] text-white"
                    size="lg"
                  >
                    {upgradeLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      "Continue to billing"
                    )}
                  </Button>

                  <Button
                    variant="ghost"
                    onClick={onClose}
                    disabled={upgradeLoading}
                    className="mt-4 w-full rounded-xl"
                    size="lg"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TeamPricingDialog;
