import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { GITHUB_URL, HELP_CENTER_URL, STATUS_PAGE_URL } from "@/lib/seo/site";

const internalLinks = [
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" },
  { href: "/download", label: "Download" },
  { href: "/trust", label: "Security & Trust" },
  { href: "/privacy-policy", label: "Privacy" },
  { href: "/terms-of-service", label: "Terms" },
] as const;

const externalLinks = [
  { href: GITHUB_URL, label: "GitHub" },
  { href: HELP_CENTER_URL, label: "Help Center" },
  { href: STATUS_PAGE_URL, label: "Status" },
] as const;

export function PublicSiteFooter() {
  return (
    <footer className="border-t border-border/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-muted-foreground sm:px-6 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="font-medium text-foreground">HackerAI LLC</p>
          <p className="mt-1">AI-assisted security work for authorized use.</p>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-3" aria-label="Footer">
          {internalLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {item.label}
            </Link>
          ))}
          {externalLinks.map((item) => (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {item.label}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
