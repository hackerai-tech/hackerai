import React, { type FC, useMemo, useState } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Globe } from "lucide-react";

const getFaviconUrl = (domain: string) => {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
};

interface CitationDisplayProps {
  citations: string[];
  className?: string;
}

interface WebsiteCardProps {
  url: string;
  domain: string;
}

export const WebsiteCard: FC<WebsiteCardProps> = ({ url, domain }) => {
  const [showFallback, setShowFallback] = useState(false);
  const faviconUrl = useMemo(() => {
    try {
      const urlObj = new URL(url);
      return getFaviconUrl(urlObj.hostname);
    } catch {
      return "";
    }
  }, [url]);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block transition-transform hover:scale-[1.02] active:scale-[0.98]"
      tabIndex={0}
      aria-label={`Visit ${domain}`}
    >
      <Card className="w-[250px] shrink-0 bg-background-foreground hover:bg-accent transition-colors">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="relative size-4 overflow-hidden rounded-sm shrink-0">
              {!showFallback ? (
                <Image
                  src={faviconUrl}
                  alt={`${domain} icon`}
                  className="object-contain"
                  onError={() => setShowFallback(true)}
                  fill
                  sizes="16px"
                  // Disable optimization for small favicon images
                  unoptimized={true}
                />
              ) : (
                <div className="flex items-center justify-center w-full h-full bg-muted rounded-lg">
                  <Globe className="size-4" />
                </div>
              )}
            </div>
            <CardTitle className="text-sm truncate">{url}</CardTitle>
          </div>
          <CardDescription className="text-xs truncate">
            {domain}
          </CardDescription>
        </CardHeader>
      </Card>
    </a>
  );
};

export const CitationDisplay: FC<CitationDisplayProps> = ({
  citations,
  className,
}) => {
  const [fallbackIcons, setFallbackIcons] = useState<Record<string, boolean>>(
    {},
  );

  const websiteCards = useMemo(() => {
    return citations
      .map((url) => {
        try {
          const urlObj = new URL(url);
          return {
            url,
            domain: urlObj.hostname.replace(/^www\./, ""),
          };
        } catch {
          return null;
        }
      })
      .filter((card): card is { url: string; domain: string } => Boolean(card));
  }, [citations]);

  if (citations.length === 0) return null;

  return (
    <div className={cn("space-y-4 my-2", className)}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">
          {citations.length} Citations
        </span>
        <div className="flex -space-x-1">
          {websiteCards.slice(0, 5).map((card, i) => (
            <div
              key={`favicon-${card.domain}-${i}`}
              className="relative size-6 overflow-hidden rounded-sm"
            >
              {!fallbackIcons[card.domain] ? (
                <Image
                  src={getFaviconUrl(card.domain)}
                  alt={`${card.domain} icon`}
                  className="object-contain"
                  onError={() =>
                    setFallbackIcons((prev) => ({
                      ...prev,
                      [card.domain]: true,
                    }))
                  }
                  fill
                  sizes="24px"
                  // Disable optimization for small favicon images
                  unoptimized={true}
                />
              ) : (
                <div className="flex items-center justify-center w-full h-full">
                  <Globe className="size-4" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="relative">
        <div className="overflow-x-auto overflow-y-hidden no-scrollbar">
          <div className="flex w-max space-x-3">
            {websiteCards.map((card, i) => (
              <WebsiteCard
                key={`website-${card.domain}-${i}`}
                url={card.url}
                domain={card.domain}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
