import { z } from "zod";

const expenseResponse = z.object({
  errorId: z.number().int(),
  status: z.enum(["processing", "ready"]).optional(),
  cost: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional(),
});

/** Deliberately discard solution, IP and all other provider fields. */
export async function readTwoCaptchaExpense(
  apiKey: string,
  taskId: number,
): Promise<
  | { status: "ready"; costDollars: number }
  | { status: "unsolvable" | "pending" }
> {
  if (!apiKey || !Number.isSafeInteger(taskId) || taskId <= 0)
    return { status: "pending" };
  try {
    const response = await fetch("https://api.2captcha.com/getTaskResult", {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: "pending" };
    const parsed = expenseResponse.safeParse(await response.json());
    if (!parsed.success) return { status: "pending" };
    if (parsed.data.errorId === 12) return { status: "unsolvable" };
    const costDollars = Number(parsed.data.cost);
    if (
      parsed.data.errorId === 0 &&
      parsed.data.status === "ready" &&
      Number.isFinite(costDollars) &&
      costDollars >= 0 &&
      costDollars <= 1
    )
      return { status: "ready", costDollars };
  } catch {
    /* Raw provider responses and errors never enter logs or storage. */
  }
  return { status: "pending" };
}
