/**
 * Compare the former URL reader with the actual current tool on a frozen corpus.
 * pnpm exec tsx scripts/benchmark-url-content.ts --output-dir /path/to/new-run
 * Input: cases.json ({id,url}[]) and rubric.json ({anchors:{[id]:{text,label}[]}}).
 * Responses may contain page content; keep the output directory private/outside git.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { parseArgs } from "node:util";
import { createOpenUrlTool } from "../lib/ai/tools/open-url";
import { safeCountTokens, truncateContent } from "../lib/token-utils";
import type { ToolFailureLogEvent } from "../types";

type BenchmarkCase = { id: string; url: string };
type Anchor = { text: string; label: string };
type Row = {
  id: string;
  url: string;
  variant: "baseline" | "candidate";
  round: number;
  raw: string[];
  delivered: string[];
  statuses: number[];
  failures: ToolFailureLogEvent[];
  durationMs?: number;
  error?: string;
};

const normalize = (text: string) =>
  text
    .replace(/\\|[*`_]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .toLowerCase();

async function main() {
  const { values } = parseArgs({
    options: {
      "input-dir": { type: "string", default: "scripts/fixtures/url-content" },
      "output-dir": { type: "string" },
      rounds: { type: "string", default: "3" },
    },
  });
  if (!values["input-dir"] || !values["output-dir"])
    throw new Error("Provide --input-dir and --output-dir");
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5)
    throw new Error("rounds must be 1-5");
  process.loadEnvFile(".env.local");
  if (!process.env.JINA_API_KEY) throw new Error("JINA_API_KEY is unavailable");
  const input = path.resolve(values["input-dir"]),
    output = path.resolve(values["output-dir"]);
  await fs.mkdir(output, { recursive: true });
  const cases: BenchmarkCase[] = JSON.parse(
    await fs.readFile(path.join(input, "cases.json"), "utf8"),
  );
  const rubric: { anchors: Record<string, Anchor[]> } = JSON.parse(
    await fs.readFile(path.join(input, "rubric.json"), "utf8"),
  );
  const fetchOriginal = globalThis.fetch;
  const storage = new AsyncLocalStorage<Row>();
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await fetchOriginal(...args);
    const request = args[0];
    const url = request instanceof Request ? request.url : String(request);
    const row =
      new URL(url).hostname === "r.jina.ai" ? storage.getStore() : undefined;
    if (row) {
      row.statuses.push(response.status);
      row.raw.push(await response.clone().text());
    }
    return response;
  };
  const rows: Row[] = [];
  try {
    for (let round = 1; round <= rounds; round++) {
      let index = 0;
      await Promise.all(
        Array.from({ length: 2 }, async () => {
          while (index < cases.length) {
            const c = cases[index++];
            // Alternate request order, with no claim that either provider cache is cold.
            for (const variant of round % 2
              ? (["baseline", "candidate"] as const)
              : (["candidate", "baseline"] as const)) {
              const filename = path.join(
                output,
                `${round}-${c.id}-${variant}.json`,
              );
              try {
                rows.push(JSON.parse(await fs.readFile(filename, "utf8")));
                continue;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  throw error;
              }
              const row: Row = {
                ...c,
                variant,
                round,
                raw: [],
                delivered: [],
                statuses: [],
                failures: [],
              };
              const start = performance.now();
              await storage.run(row, async () => {
                try {
                  if (variant === "baseline") {
                    const response = await fetch(
                      `https://r.jina.ai/${encodeURIComponent(c.url)}`,
                      {
                        headers: {
                          Authorization: `Bearer ${process.env.JINA_API_KEY}`,
                          "X-Timeout": "30",
                          "X-Base": "final",
                          "X-Token-Budget": "200000",
                        },
                        signal: AbortSignal.timeout(75_000),
                      },
                    );
                    const body = await response.text();
                    row.delivered.push(
                      response.ok
                        ? truncateContent(body, undefined, 2048)
                        : `Error: HTTP ${response.status}`,
                    );
                  } else {
                    let cursor: string | undefined;
                    const tool = createOpenUrlTool({
                      onToolFailure: (event) => {
                        row.failures.push(event);
                      },
                    });
                    do {
                      const result = await tool.execute!(
                        {
                          url: c.url,
                          brief: "Read reference",
                          ...(cursor ? { cursor } : {}),
                        },
                        {
                          toolCallId: `bench-${row.delivered.length}`,
                          messages: [],
                          abortSignal: AbortSignal.timeout(75_000),
                        },
                      );
                      const text = String(result);
                      row.delivered.push(text);
                      cursor = text.match(
                        /\n\n\[More page content available\. Call open_url with the same URL and cursor="([A-Za-z0-9_-]+)" to continue\. Do not treat this partial page as complete\.\]$/,
                      )?.[1];
                      if (row.delivered.length >= 25 && cursor)
                        throw new Error("Exceeded bounded continuation count");
                    } while (cursor);
                  }
                } catch (error) {
                  row.error =
                    error instanceof Error ? error.name : "UnknownError";
                }
              });
              row.durationMs = performance.now() - start;
              const serialized = JSON.stringify(row, null, 2);
              if (serialized.includes(process.env.JINA_API_KEY!))
                throw new Error("Credential guard refused artifact write");
              await fs.writeFile(filename, serialized);
              rows.push(row);
              console.log(
                JSON.stringify({
                  id: c.id,
                  round,
                  variant,
                  ms: Math.round(row.durationMs),
                  requests: row.statuses.length,
                  windows: row.delivered.length,
                  error: row.error,
                }),
              );
            }
          }
        }),
      );
    }
  } finally {
    globalThis.fetch = fetchOriginal;
  }
  const scores = rows.map((row) => {
    const anchors = rubric.anchors[row.id] ?? [];
    const hits = (text: string) =>
      anchors
        .filter((anchor) => normalize(text).includes(normalize(anchor.text)))
        .map((a) => a.label);
    return {
      id: row.id,
      round: row.round,
      variant: row.variant,
      requests: row.statuses.length,
      windows: row.delivered.length,
      durationMs: row.durationMs,
      anchorsPossible: anchors.length,
      rawHits: hits(row.raw[0] ?? ""),
      firstWindowHits: hits(row.delivered[0] ?? ""),
      allWindowHits: hits(row.delivered.join("")),
      rawTokens: safeCountTokens(row.raw[0] ?? ""),
      deliveredTokens: row.delivered.map(safeCountTokens),
      failures: row.failures.length,
      error: row.error,
    };
  });
  await fs.writeFile(
    path.join(output, "scores.json"),
    JSON.stringify(scores, null, 2),
  );
  await fs.writeFile(
    path.join(output, "settings.json"),
    JSON.stringify(
      {
        rounds,
        input,
        startedAtNote: "Use per-row timings; reruns resume existing rows",
        candidate:
          "Actual createOpenUrlTool.execute, consecutive pages including continuation requests",
        baseline: "Former Jina headers and 2048-token head/tail truncation",
        cachePolicy:
          "Provider defaults; first requests are not guaranteed cold",
        rubricNote:
          "Frozen selected-fact recall; repeated rounds are not independent quality samples",
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Benchmark failed");
  process.exitCode = 1;
});
