import { useState } from "react";
import { Laptop } from "lucide-react";

/**
 * Shown while the server continues a run whose computer came back (HAC-275).
 * Stop ends that continuation, whether it is still starting or running.
 */
export function LocalAutoContinueNotice({
  onStop,
}: {
  onStop: () => void | Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  return (
    <div className="mb-2 w-full">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background p-3 shadow-sm sm:flex-nowrap sm:gap-3">
        <Laptop
          size={18}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm">
          <p role="status" className="font-medium">
            Your computer is back — continuing
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The Agent checks what finished before it repeats any step.
          </p>
        </div>
        <button
          type="button"
          disabled={stopping}
          aria-busy={stopping}
          onClick={() => {
            setStopping(true);
            void Promise.resolve(onStop()).finally(() => setStopping(false));
          }}
          className="min-h-11 w-full shrink-0 rounded-full border border-border px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:min-h-9 sm:w-auto"
        >
          {stopping ? "Stopping…" : "Stop"}
        </button>
      </div>
    </div>
  );
}
