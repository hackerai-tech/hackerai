import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { GITHUB_URL, HELP_CENTER_URL, STATUS_PAGE_URL } from "@/lib/seo/site";

type FooterLink = { href: string; label: string; external?: boolean };

const columns: ReadonlyArray<{ title: string; links: readonly FooterLink[] }> =
  [
    {
      title: "Product",
      links: [
        { href: "/product", label: "Product" },
        { href: "/pricing", label: "Pricing" },
        { href: "/download", label: "Download" },
      ],
    },
    {
      title: "Company",
      links: [
        { href: "/trust", label: "Security & Trust" },
        { href: "/privacy-policy", label: "Privacy Policy" },
        { href: "/terms-of-service", label: "Terms of Service" },
      ],
    },
    {
      title: "Resources",
      links: [
        { href: GITHUB_URL, label: "GitHub", external: true },
        { href: HELP_CENTER_URL, label: "Help Center", external: true },
        { href: STATUS_PAGE_URL, label: "Status", external: true },
      ],
    },
  ];

const linkClassName =
  "inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function PublicSiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border/80">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label="HackerAI home"
            >
              <HackerAISVG theme="dark" scale={0.12} />
              <span className="text-lg font-semibold text-foreground">
                HackerAI
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
              An AI agent for penetration testing. Built for authorized security
              work.
            </p>
          </div>
          {columns.map((column) => (
            <nav key={column.title} aria-label={column.title}>
              <h2 className="text-sm font-medium text-foreground">
                {column.title}
              </h2>
              <ul className="mt-4 space-y-3">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className={linkClassName}
                      >
                        {link.label}
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    ) : (
                      <Link href={link.href} className={linkClassName}>
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="mt-12 border-t border-border/80 pt-6 text-xs text-muted-foreground">
          &copy; {year} HackerAI LLC
        </p>
      </div>
    </footer>
  );
}
