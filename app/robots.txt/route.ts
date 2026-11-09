const ROBOTS_CONTENT = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /c/
Disallow: /share/
Disallow: /invite/
Disallow: /login
Disallow: /signup
Disallow: /logout
Disallow: /callback
Disallow: /desktop-login
Disallow: /desktop-callback
Disallow: /auth-error

Sitemap: https://hackerai.co/sitemap.xml
`;

export const dynamic = "force-static";

export function GET() {
  return new Response(ROBOTS_CONTENT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
