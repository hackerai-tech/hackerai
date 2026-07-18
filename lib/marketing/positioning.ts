export const PUBLIC_POSITIONING = {
  eyebrow: "AI hacking assistant for security research",
  headline: "You hack. HackerAI goes deeper.",
  description:
    "From first question to working proof: analyze code, research attack paths, run terminal and browser tools, validate exploits, automate workflows, and document findings—with an AI security copilot that follows your lead.",
  audience:
    "Built for individual operators—ethical hackers, pentesters, security researchers, students, and technical builders—testing systems they own or are authorized to assess.",
  footerBoundary:
    "Authorized targets only. Model-provider policies and abuse controls still apply.",
  boundary:
    "HackerAI goes deep on authorized security work: reconnaissance, code review, exploit development, validation, remediation, and reporting. It is not a “jailbroken,” “unrestricted,” or anything-goes chatbot. Provider policies, abuse controls, usage limits, and technical constraints still apply; no plan guarantees an answer to every request.",
  pricingBoundary:
    "Plans expand model access, tools, and usage; they do not bypass provider policies or abuse controls. No plan guarantees every request will be answered.",
} as const;

export const PUBLIC_METADATA = {
  title: "HackerAI — AI-Powered Penetration Testing Assistant",
  description:
    "AI hacking assistant for pentesting and security research. Analyze code, run tools, validate exploits, and report findings in cloud or local sandboxes.",
} as const;

export const PUBLIC_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://hackerai.co/#website",
      url: "https://hackerai.co/",
      name: "HackerAI",
      alternateName: "Hacker AI",
    },
    {
      "@type": "WebApplication",
      "@id": "https://hackerai.co/#application",
      url: "https://hackerai.co/",
      name: "HackerAI",
      description: PUBLIC_METADATA.description,
      applicationCategory: "SecurityApplication",
      operatingSystem: "Web, macOS, Windows, Linux, iOS, Android",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  ],
} as const;
