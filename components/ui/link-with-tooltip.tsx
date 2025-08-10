import React from "react";
import { WithTooltip } from "./with-tooltip";
import { WebsiteCard } from "../messages/citation-display";

interface LinkWithTooltipProps {
  href: string;
  title?: string;
  children: React.ReactNode;
}

export const LinkWithTooltip: React.FC<LinkWithTooltipProps> = ({
  href,
  children,
}) => {
  let domain = "";
  try {
    const urlObj = new URL(href);
    domain = urlObj.hostname.replace(/^www\./, "");
  } catch {
    domain = href;
  }

  return (
    <WithTooltip
      display={<WebsiteCard url={href} domain={domain} />}
      trigger={
        <a
          href={href}
          title={href}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-foreground/20 hover:bg-foreground/30 ml-1 inline-flex size-[16px] items-center justify-center rounded-full text-[10px] no-underline"
          tabIndex={0}
          aria-label={href}
        >
          {children}
        </a>
      }
      side="top"
      delayDuration={300}
    />
  );
};
