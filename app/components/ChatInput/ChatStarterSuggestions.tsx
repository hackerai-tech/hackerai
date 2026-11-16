// Rendered only by the client ChatInput, so it needs no client entry directive.
import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowUpLeft,
  ChevronDown,
  Lightbulb,
  ListChecks,
  Wrench,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { subscribeAuthenticatedAnalytics } from "@/lib/analytics/client";
import {
  getChatStartersForMode,
  type ChatStarter,
  type ChatStarterId,
  type ChatStarterPresentation,
} from "@/lib/chat/starter-prompts";
import type { ChatMode } from "@/types/chat";

const TargetIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </svg>
);

const STARTER_ICONS: Partial<
  Record<ChatStarterId, (props: { className?: string }) => ReactNode>
> = {
  test_target: TargetIcon,
  fix_tool_error: ({ className }) => (
    <Wrench aria-hidden="true" strokeWidth={1.8} className={className} />
  ),
  plan_test: ({ className }) => (
    <ListChecks aria-hidden="true" strokeWidth={1.8} className={className} />
  ),
};

const StarterIcon = ({
  id,
  className,
}: {
  id: ChatStarterId;
  className?: string;
}) => {
  const Icon = STARTER_ICONS[id];
  return Icon ? <Icon className={className} /> : null;
};

type ChatStarterSuggestionsProps = {
  mode: ChatMode;
  presentation: ChatStarterPresentation;
  layout: "desktop" | "mobile";
  onSelect: (starter: ChatStarter) => void;
  onExposed: (mode: ChatMode, presentation: ChatStarterPresentation) => void;
};

export function ChatStarterSuggestions({
  mode,
  presentation,
  layout,
  onSelect,
  onExposed,
}: ChatStarterSuggestionsProps) {
  const { featured, more } = getChatStartersForMode(mode);
  const isMobile = layout === "mobile";
  const menuSelectionRef = useRef(false);

  // Record exposure only once the suggestions actually reach the screen, not
  // for a render that a restored draft replaces before paint. If analytics was
  // not ready yet, retry while still visible; the provider dedupes successes.
  useEffect(() => {
    const expose = () =>
      requestAnimationFrame(() => onExposed(mode, presentation));
    let frame = expose();
    const unsubscribe = subscribeAuthenticatedAnalytics(() => {
      cancelAnimationFrame(frame);
      frame = expose();
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, [mode, presentation, onExposed]);

  const selectFromMenu = (starter: ChatStarter) => {
    menuSelectionRef.current = true;
    onSelect(starter);
  };

  const menu = (trigger: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={isMobile ? "start" : "center"}
        sideOffset={6}
        className={cn(
          "rounded-[14px] p-1.5",
          isMobile
            ? "w-(--radix-dropdown-menu-trigger-width)"
            : "w-[min(420px,calc(100vw-2rem))]",
        )}
        onCloseAutoFocus={(event) => {
          // A selection focuses the composer; Escape still returns to the trigger.
          if (!menuSelectionRef.current) return;
          menuSelectionRef.current = false;
          event.preventDefault();
        }}
      >
        {featured.map((starter) => (
          <StarterMenuItem
            key={starter.id}
            starter={starter}
            onSelect={selectFromMenu}
            touch={isMobile}
          />
        ))}
        <DropdownMenuSeparator className="mx-1.5" />
        {more.map((starter) => (
          <StarterMenuItem
            key={starter.id}
            starter={starter}
            onSelect={selectFromMenu}
            touch={isMobile}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (presentation === "collapsed") {
    return (
      <div
        className={cn("flex justify-center", isMobile ? "pb-2" : "pt-4")}
        data-testid="chat-starters"
        data-presentation="collapsed"
      >
        {menu(
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-full pl-2.5 pr-3 text-[13px] leading-4 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted",
              isMobile ? "min-h-11" : "h-8",
            )}
          >
            <Lightbulb aria-hidden="true" className="size-3.5" />
            Examples
            <ChevronDown aria-hidden="true" className="size-3" />
          </button>,
        )}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div
        className="flex flex-col pb-2"
        data-testid="chat-starters"
        data-presentation="expanded"
      >
        <div className="flex h-9 items-center px-1 text-[13px] leading-4 text-muted-foreground">
          Start from an example
        </div>
        {featured.map((starter) => (
          <button
            key={starter.id}
            type="button"
            aria-label={`Insert example: ${starter.label}`}
            onClick={() => onSelect(starter)}
            className="flex h-12 items-center gap-3 border-t border-border/60 px-1 text-left transition-colors active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="flex w-5 shrink-0 justify-center text-muted-foreground">
              <StarterIcon id={starter.id} className="size-[17px]" />
            </span>
            <span className="min-w-0 flex-1 text-[15px] leading-[18px] text-foreground/90">
              {starter.label}
            </span>
            <span className="w-5 shrink-0 text-muted-foreground/70">
              <ArrowUpLeft aria-hidden="true" className="size-4" />
            </span>
          </button>
        ))}
        {menu(
          <button
            type="button"
            className="flex h-11 items-center gap-3 border-t border-border/60 px-1 text-left transition-colors active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[state=open]:bg-muted"
          >
            <span className="w-5 shrink-0" />
            <span className="min-w-0 flex-1 text-sm leading-[18px] text-muted-foreground">
              More examples
            </span>
            <span className="w-5 shrink-0 text-muted-foreground/70">
              <ChevronDown aria-hidden="true" className="size-4" />
            </span>
          </button>,
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 pt-4"
      data-testid="chat-starters"
      data-presentation="expanded"
    >
      {featured.map((starter) => (
        <button
          key={starter.id}
          type="button"
          aria-label={`Insert example: ${starter.label}`}
          onClick={() => onSelect(starter)}
          className="flex h-[34px] items-center gap-[7px] rounded-full border border-border pl-[11px] pr-3.5 text-sm leading-[18px] text-foreground/85 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <StarterIcon
            id={starter.id}
            className="size-[15px] shrink-0 text-muted-foreground"
          />
          {starter.label}
        </button>
      ))}
      {menu(
        <button
          type="button"
          aria-label="More examples"
          className="flex h-[34px] items-center gap-[5px] rounded-full pl-3 pr-2.5 text-sm leading-[18px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted"
        >
          More
          <ChevronDown aria-hidden="true" className="size-[13px]" />
        </button>,
      )}
    </div>
  );
}

function StarterMenuItem({
  starter,
  onSelect,
  touch,
}: {
  starter: ChatStarter;
  onSelect: (starter: ChatStarter) => void;
  touch: boolean;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(starter)}
      className={cn(
        "flex-col items-start gap-px rounded-lg px-2.5 py-2",
        touch && "min-h-11 justify-center",
      )}
    >
      <span className="text-sm leading-[18px]">{starter.label}</span>
      <span className="text-xs leading-4 text-muted-foreground">
        {starter.description}
      </span>
    </DropdownMenuItem>
  );
}
