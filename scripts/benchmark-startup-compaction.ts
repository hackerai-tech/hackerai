import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { AGENT_SUMMARIZATION_PROMPT } from "../lib/chat/summarization/prompts";

// Synthetic fixtures only: never load customer conversations into this benchmark.
config({ path: ".env.local", quiet: true });
if (!process.env.OPENROUTER_API_KEY)
  throw new Error("OPENROUTER_API_KEY is required");
mkdirSync(".artifacts/hac102", { recursive: true });
const variants = [
  {
    name: "glm-baseline",
    model: "z-ai/glm-5.3-flash",
    reasoning: { enabled: true, effort: "low" },
    prompt: AGENT_SUMMARIZATION_PROMPT,
  },
  {
    name: "deepseek-low",
    model: "deepseek/deepseek-v4-flash-0731",
    reasoning: { enabled: true, effort: "low" },
    prompt: AGENT_SUMMARIZATION_PROMPT,
  },
];
const markers = [
  "api.hac102.example",
  "Only test staging; never test production",
  "/srv/hac102",
  "term_hac102_9f1",
  "73142",
  "8127",
  "/tmp/hac102-results.jsonl",
  "replay_hac102_b7",
  "429 TOO_MANY_REQUESTS",
  "X-HAC102-Trace",
  "blue_hac102_v2",
  "resume_cursor_47",
  "/api/v2/export",
  "CVE-SYNTHETIC-102",
];
const fixture = (size: number) => {
  const history = Array.from(
    { length: size },
    (_, i) =>
      `Completed read-only check ${i}: GET /status/check-${i % 40} returned 200; no new finding. Probe batch ${Math.floor(i / 40)} reused the authenticated staging session. Response was healthy and already recorded. Do not repeat completed checks.`,
  ).join("\n");
  return `User: Assess api.hac102.example. Only test staging; never test production.\nAssistant: Workdir /srv/hac102.\n${history}\nUser: Preserve this correction: the active credential label is blue_hac102_v2, not the expired red token.\nTool: Confirmed synthetic finding CVE-SYNTHETIC-102 at /api/v2/export; audit header X-HAC102-Trace. A replay received 429 TOO_MANY_REQUESTS; reduce rate to 2 requests per second.\nTool: Background read-only validation still RUNNING; PID 73142, session term_hac102_9f1, local port 8127, output /tmp/hac102-results.jsonl. Progress 47%, cursor resume_cursor_47. No completion result exists.\nAssistant: Next inspect existing session term_hac102_9f1; do not launch another job. Resume using replay_hac102_b7 after rate limiting clears.\nUser: Stop after validating the existing finding; do not expand scope.`;
};

async function run(variant: (typeof variants)[number], size: number) {
  const name = `${size}-${variant.name}`;
  const started = performance.now();
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://hackerai.co",
          "X-Title": "HackerAI synthetic compaction benchmark",
        },
        body: JSON.stringify({
          model: variant.model,
          provider: { sort: "latency", data_collection: "deny" },
          reasoning: variant.reasoning,
          messages: [
            {
              role: "system",
              content:
                "You are HackerAI, a security assistant. Respect the user's scope and preserve ongoing work.",
            },
            { role: "user", content: fixture(size) },
            {
              role: "user",
              content:
                variant.prompt +
                "\n\nSummarize the above conversation using the structured format. Output ONLY the summary — do not continue the conversation or role-play as the assistant.",
            },
          ],
        }),
        signal: AbortSignal.timeout(240_000),
      },
    );
    const result = await response.json();
    const text = result.choices?.[0]?.message?.content ?? "";
    const missing = markers.filter((m) => !text.includes(m));
    const headers = [
      ...AGENT_SUMMARIZATION_PROMPT.matchAll(/(?:^|\n)(## [^\n]+)/g),
    ].map((m) => m[1]);
    const missingHeaders = [...new Set(headers)].filter(
      (h) => !text.includes(h),
    );
    writeFileSync(
      `.artifacts/hac102/${name}.json`,
      JSON.stringify(result, null, 2),
    );
    const stats = {
      name,
      elapsedMs: Math.round(performance.now() - started),
      status: response.status,
      model: result.model,
      provider: result.provider,
      finish: result.choices?.[0]?.finish_reason,
      usage: result.usage,
      missing,
      missingHeaders,
      runningPreserved: /running/i.test(text),
      error: result.error,
    };
    writeFileSync(
      `.artifacts/hac102/${name}-stats.json`,
      JSON.stringify(stats, null, 2),
    );
    console.log(JSON.stringify(stats));
  } catch (e) {
    console.log(
      JSON.stringify({
        name,
        elapsedMs: Math.round(performance.now() - started),
        error: String(e),
      }),
    );
  }
}
async function main() {
  for (const size of [300, 1500]) for (const v of variants) await run(v, size);
}
main();
