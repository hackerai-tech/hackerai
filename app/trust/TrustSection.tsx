"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export function TrustSection({
  id,
  number,
  title,
  summary,
  initiallyOpen = false,
  children,
}: {
  id: string;
  number: string;
  title: string;
  summary?: string;
  initiallyOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);

  useEffect(() => {
    const openTarget = () => {
      if (window.location.hash !== `#${id}`) return;
      setOpen(true);
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView(),
      );
    };
    openTarget();
    window.addEventListener("hashchange", openTarget);
    return () => window.removeEventListener("hashchange", openTarget);
  }, [id]);

  return (
    <section
      id={id}
      className="scroll-mt-20 border-b border-border py-7 md:py-9"
    >
      <div className="md:grid md:grid-cols-[28px_minmax(0,1fr)] md:gap-6">
        <span className="hidden pt-1 font-mono text-xs text-muted-foreground md:block">
          {number}
        </span>
        <div className="min-w-0">
          <h2 className="hidden text-xl font-semibold tracking-tight md:block">
            {title}
          </h2>
          <h2 className="md:hidden">
            <button
              type="button"
              aria-controls={`${id}-content`}
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="flex w-full items-start gap-3 text-left focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="pt-1 font-mono text-xs text-muted-foreground">
                {number}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold">{title}</span>
                {!open && summary ? (
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    {summary}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                className={cn(
                  "mt-1 size-4 shrink-0 transition-transform",
                  open && "rotate-180",
                )}
                aria-hidden="true"
              />
            </button>
          </h2>
          <div
            id={`${id}-content`}
            className={cn(
              "space-y-4 text-[15px] leading-7 text-muted-foreground md:mt-4",
              open ? "mt-4" : "hidden md:block",
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}
