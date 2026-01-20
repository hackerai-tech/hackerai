import { tool } from "ai";
import { z } from "zod";
import { truncateContent } from "@/lib/token-utils";

/**
 * Open URL tool using Jina AI for content retrieval
 * Retrieves and returns the full contents of a webpage
 */
export const createOpenUrlTool = () => {
  return tool({
    description: `Retrieve the full contents of a specific webpage by URL.

<instructions>
- Use to fetch and read a specific webpage, usually obtained from a prior search
- URLs must be valid and publicly accessible
- Prioritize cybersecurity-relevant information: CVEs, CVSS scores, exploits, PoCs, security tools, and pentest methodologies
- Include specific versions, configurations, and technical details; cite reliable sources (NIST, OWASP, CVE databases)
</instructions>`,
    inputSchema: z.object({
      url: z.string().describe("The URL to open and retrieve content from"),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this command needs to be run and how it contributes to the goal.",
        ),
    }),
    execute: async ({ url }: { url: string }, { abortSignal }) => {
      try {
        // Construct the Jina AI reader URL with proper encoding
        const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;

        // Make the request to Jina AI reader
        const response = await fetch(jinaUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${process.env.JINA_API_KEY}`,
            "X-Timeout": "30",
            "X-Base": "final",
            "X-Token-Budget": "200000",
          },
          signal: abortSignal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          return `Error: HTTP ${response.status} - ${errorBody}`;
        }

        const content = await response.text();
        const truncated = truncateContent(content, undefined, 2048);

        return truncated;
      } catch (error) {
        // Handle abort errors gracefully without logging
        if (error instanceof Error && error.name === "AbortError") {
          return "Error: Operation aborted";
        }
        console.error("Open URL tool error:", error);
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return `Error opening URL: ${errorMessage}`;
      }
    },
  });
};
