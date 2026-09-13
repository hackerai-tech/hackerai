/**
 * Bounded live OCR comparison using synthetic screenshots only.
 * Run: NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/benchmark-vision-recovery.ts
 * Reads only OPENROUTER_API_KEY from the environment or this checkout's .env.local.
 * Writes synthetic answers and aggregate scores to a new temporary directory.
 * This checks OCR preservation, not general visual reasoning or the app UI.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { getSharp } from "next/dist/server/image-optimizer";
import type { UIMessage } from "ai";

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    process.env.OPENROUTER_API_KEY = parse(readFileSync(".env.local"))[
      "OPENROUTER_API_KEY"
    ];
  }
  if (!process.env.OPENROUTER_API_KEY)
    throw new Error("Missing OpenRouter key");
  // Load the provider only after supplying its key. No other service is used.
  const { generateText, convertToModelMessages } = await import("ai");
  const { myProvider } = await import("../lib/ai/providers");
  const { describeImageAttachmentsWithAuxiliaryVision } =
    await import("../lib/chat/auxiliary-vision");
  const { getProviderUsageRawModelCost } =
    await import("../lib/provider-usage-cost");
  const output = mkdtempSync(join(tmpdir(), "hackerai-vision-recovery-"));
  // Use the image dependency already owned by the installed Next.js version.
  const sharp = getSharp(undefined, undefined);
  const fixtures = await Promise.all(
    Array.from({ length: 23 }, async (_, i) => {
      const label = `R${String(i + 1).padStart(2, "0")}`;
      const code = createHash("sha256")
        .update(`hac106-fixture-${i}`)
        .digest("hex")
        .slice(0, 8)
        .toUpperCase();
      const png = await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><rect width="900" height="300" fill="#ffffff"/><g font-family="monospace" font-size="40" fill="#111111"><text x="30" y="65">Synthetic diagnostic screenshot</text><text x="30" y="140">CASE: ${label}</text><text x="30" y="205">CODE: ${code}</text><text x="30" y="270">HTTP: 403</text></g></svg>`,
        ),
      )
        .png()
        .toBuffer();
      writeFileSync(join(output, `${label}.png`), png);
      return {
        label,
        code,
        url: `data:image/png;base64,${png.toString("base64")}`,
      };
    }),
  );
  const history: UIMessage[] = fixtures.map(({ label, url }) => ({
    id: label,
    role: "user",
    parts: [
      { type: "file", filename: `${label}.png`, mediaType: "image/png", url },
    ],
  }));
  const prompt =
    "Read the CASE and CODE fields in every screenshot. Return one line per screenshot as CASE|CODE, sorted by CASE. Preserve exact characters. If illegible, say UNKNOWN. No commentary.";
  const scores: Record<string, unknown>[] = [];
  const deadline = AbortSignal.timeout(10 * 60_000);
  let totalReportedCost = 0;
  async function score(
    name: string,
    model: string,
    messages: UIMessage[],
    count: number,
  ) {
    if (totalReportedCost >= 1)
      throw new Error("Benchmark reached its reported-cost budget");
    const start = performance.now();
    try {
      const result = await generateText({
        model: myProvider.languageModel(model),
        messages: await convertToModelMessages([
          ...messages.slice(0, count),
          {
            id: "question",
            role: "user",
            parts: [{ type: "text", text: prompt }],
          },
        ]),
        temperature: 0,
        maxOutputTokens: 8_192,
        maxRetries: 0,
        abortSignal: deadline,
        timeout: 60_000,
        providerOptions: {
          openrouter: {
            ...(model !== "model-glm-5.3-flash" && {
              reasoning: { enabled: true, effort: "high" },
            }),
            provider: { sort: "latency", data_collection: "deny" },
          },
        },
      });
      const cost = getProviderUsageRawModelCost(result.usage.raw);
      totalReportedCost += cost ?? 0;
      const correct = fixtures
        .slice(0, count)
        .filter(({ label, code }) =>
          result.text
            .split("\n")
            .some((line) => line.includes(label) && line.includes(code)),
        ).length;
      scores.push({
        name,
        requestedModel: model,
        servedModel: result.response.modelId,
        count,
        correct,
        elapsedMs: Math.round(performance.now() - start),
        cost,
        finishReason: result.finishReason,
      });
      writeFileSync(join(output, `${name}.txt`), result.text);
    } catch (error) {
      scores.push({
        name,
        count,
        elapsedMs: Math.round(performance.now() - start),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    console.log(JSON.stringify(scores.at(-1)));
  }
  for (const count of [1, 11, 23]) {
    await score(`glm-${count}`, "model-glm-5.3-flash", history, count);
    await score(
      `deepseek-${count}`,
      "model-deepseek-v4-flash-vision",
      history,
      count,
    );
  }
  const start = performance.now();
  let recoveryCost = 0;
  try {
    const recovered = await describeImageAttachmentsWithAuxiliaryVision({
      messages: history,
      abortSignal: deadline,
      onCost: (cost) => {
        recoveryCost += cost;
        totalReportedCost += cost;
      },
    });
    const correct = fixtures.filter(({ label, code }, index) =>
      recovered[index].parts.some(
        (part) =>
          part.type === "text" &&
          part.text.includes(label) &&
          part.text.includes(code),
      ),
    ).length;
    scores.push({
      name: "recovery-23",
      count: 23,
      correct,
      elapsedMs: Math.round(performance.now() - start),
      cost: recoveryCost,
    });
    writeFileSync(
      join(output, "recovered.json"),
      JSON.stringify(recovered, null, 2),
    );
    console.log(JSON.stringify(scores.at(-1)));
    for (const count of [1, 11, 23]) {
      await score(
        `recovered-answer-${count}`,
        "model-deepseek-v4-flash-0731",
        recovered,
        count,
      );
    }
  } catch (error) {
    scores.push({
      name: "recovery-23",
      count: 23,
      elapsedMs: Math.round(performance.now() - start),
      cost: recoveryCost,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    console.log(JSON.stringify(scores.at(-1)));
  }
  writeFileSync(
    join(output, "scores.json"),
    JSON.stringify({ scores, totalReportedCost }, null, 2),
  );
  console.log(JSON.stringify({ output, totalReportedCost }));
  if (scores.some((score) => score.errorName || score.correct !== score.count))
    process.exitCode = 1;
}

main().catch((error) => {
  // Never serialize provider request bodies, response metadata, or credentials.
  console.error(
    JSON.stringify({
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  process.exitCode = 1;
});
