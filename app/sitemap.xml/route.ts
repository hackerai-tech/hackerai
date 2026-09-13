import { PUBLIC_PAGE_LAST_MODIFIED, SITE_URL } from "@/lib/seo/site";

const PUBLIC_URLS = [
  { path: "/", lastModified: PUBLIC_PAGE_LAST_MODIFIED.home },
  { path: "/product", lastModified: PUBLIC_PAGE_LAST_MODIFIED.product },
  { path: "/pricing", lastModified: PUBLIC_PAGE_LAST_MODIFIED.pricing },
  { path: "/download", lastModified: PUBLIC_PAGE_LAST_MODIFIED.download },
  { path: "/trust", lastModified: PUBLIC_PAGE_LAST_MODIFIED.trust },
  {
    path: "/privacy-policy",
    lastModified: PUBLIC_PAGE_LAST_MODIFIED.privacy,
  },
  {
    path: "/terms-of-service",
    lastModified: PUBLIC_PAGE_LAST_MODIFIED.terms,
  },
] as const;

const SITEMAP_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PUBLIC_URLS.map(
  ({ path, lastModified }) =>
    `  <url><loc>${SITE_URL}${path}</loc><lastmod>${lastModified}</lastmod></url>`,
).join("\n")}
</urlset>
`;

export const dynamic = "force-static";

export function GET() {
  return new Response(SITEMAP_CONTENT, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
