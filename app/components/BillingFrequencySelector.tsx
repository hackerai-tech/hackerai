"use client";

import React from "react";

type BillingFrequency = "monthly" | "yearly";

interface BillingFrequencySelectorProps {
  value: BillingFrequency;
  onChange: (value: BillingFrequency) => void;
  isOpen?: boolean;
  className?: string;
}

const BillingFrequencySelector: React.FC<BillingFrequencySelectorProps> = ({
  value,
  onChange,
  isOpen,
  className = "",
}) => {
  const segmentedRef = React.useRef<HTMLDivElement | null>(null);
  const monthlyRef = React.useRef<HTMLLabelElement | null>(null);
  const yearlyRef = React.useRef<HTMLLabelElement | null>(null);
  const [indicatorLeft, setIndicatorLeft] = React.useState<number>(0);
  const [indicatorWidth, setIndicatorWidth] = React.useState<number>(0);

  const handleBillingChange = (next: BillingFrequency) => {
    if (next === value) return;
    onChange(next);
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next: BillingFrequency = value === "monthly" ? "yearly" : "monthly";
      onChange(next);
    }
  };

  React.useEffect(() => {
    const updateIndicator = () => {
      const target =
        value === "yearly" ? yearlyRef.current : monthlyRef.current;
      if (!target) return;
      setIndicatorLeft(target.offsetLeft);
      setIndicatorWidth(target.offsetWidth);
    };

    // Small delay to ensure DOM is rendered, especially when within a dialog
    const timer = setTimeout(updateIndicator, 10);
    return () => clearTimeout(timer);
  }, [value, isOpen]);

  React.useEffect(() => {
    const updateIndicator = () => {
      const target =
        value === "yearly" ? yearlyRef.current : monthlyRef.current;
      if (!target) return;
      setIndicatorLeft(target.offsetLeft);
      setIndicatorWidth(target.offsetWidth);
    };

    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [value]);

  return (
    <fieldset aria-label="Payment frequency">
      <div
        ref={segmentedRef}
        className={`relative inline-flex items-center rounded-full border border-border bg-background p-1 ${className}`}
        tabIndex={0}
        aria-label="Billing frequency selector"
        role="radiogroup"
        onKeyDown={handleKeyDown}
      >
        <div
          className="absolute top-1 bottom-1 rounded-full border border-border bg-muted/60 transition-all duration-300 ease-out"
          style={{ left: `${indicatorLeft}px`, width: `${indicatorWidth}px` }}
        />
        <label
          ref={monthlyRef}
          className="relative z-10 cursor-pointer select-none rounded-full"
        >
          <input
            type="radio"
            className="sr-only"
            name="billing-frequency"
            value="monthly"
            checked={value === "monthly"}
            onChange={() => handleBillingChange("monthly")}
            aria-label="Monthly billing"
          />
          <span
            className={
              value === "monthly"
                ? "flex items-center justify-center px-4 py-1.5 text-sm font-medium text-foreground"
                : "flex items-center justify-center px-4 py-1.5 text-sm text-muted-foreground"
            }
          >
            Monthly
          </span>
        </label>
        <label
          ref={yearlyRef}
          className="relative z-10 cursor-pointer select-none rounded-full"
        >
          <input
            type="radio"
            className="sr-only"
            name="billing-frequency"
            value="yearly"
            checked={value === "yearly"}
            onChange={() => handleBillingChange("yearly")}
            aria-label="Yearly billing"
          />
          <span
            className={
              value === "yearly"
                ? "flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-medium text-foreground"
                : "flex items-center justify-center gap-2 px-4 py-1.5 text-sm text-muted-foreground"
            }
          >
            Yearly
            <span className="text-[#615EEB] dark:text-[#B9B7FF] text-xs font-medium">
              Save 17%
            </span>
          </span>
        </label>
      </div>
    </fieldset>
  );
};

export default BillingFrequencySelector;
