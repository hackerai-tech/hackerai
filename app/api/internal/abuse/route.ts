import { NextRequest, NextResponse } from "next/server";
import { authkit } from "@/lib/auth/provider";
import { randomUUID } from "node:crypto";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { abuseOperatorRequest, isAbuseOperator } from "@/lib/abuse/operator";
import { readAbuseJson, AbuseRequestError } from "@/lib/abuse/report";
import {
  decryptAbuseEvidence,
  encryptAbuseEvidence,
} from "@/lib/abuse/evidence";
import {
  executeAbuseContainment,
  prepareAbuseResolution,
  findAbuseSnapshot,
  verifyContainmentTarget,
} from "@/lib/abuse/containment";

export const runtime = "nodejs";
export const maxDuration = 300;
const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return reply({ error: "Access denied." }, 403);
  let actor: string;
  try {
    const { session } = await authkit(request);
    if (!session?.user?.id || !isAbuseOperator(session.user.id))
      return reply({ error: "Access denied." }, 403);
    actor = session.user.id;
  } catch {
    return reply({ error: "Access denied." }, 403);
  }
  try {
    const parsed = abuseOperatorRequest.safeParse(await readAbuseJson(request));
    if (!parsed.success)
      return reply(
        {
          error:
            "Check the action fields. Decisions and verified facts require 20–6,000 characters.",
        },
        400,
      );
    const input = parsed.data;
    const client = getConvexClient();
    const operator = {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      actor,
    };
    if (input.action === "list")
      return reply(
        await client.query(api.abuseCases.list, {
          ...operator,
          status: input.status,
          paginationOpts: { cursor: input.cursor, numItems: 25 },
        }),
      );
    const base = { ...operator, reference: input.reference };
    if (input.action === "read") {
      const result = await client.mutation(api.abuseCases.read, {
        ...base,
        paginationOpts: { cursor: input.cursor, numItems: 25 },
      });
      const {
        ciphertext,
        digest: _digest,
        operationToken: _token,
        ...metadata
      } = result.case;
      return reply({
        ...result,
        case: {
          ...metadata,
          report: ciphertext
            ? decryptAbuseEvidence(input.reference, ciphertext)
            : null,
        },
        events: result.events.map(({ ciphertext, ...event }) => ({
          ...event,
          detail: ciphertext
            ? decryptAbuseEvidence(input.reference, ciphertext)
            : null,
        })),
      });
    }
    const revision = { ...base, expectedRevision: input.expectedRevision };
    const decision =
      "decision" in input
        ? encryptAbuseEvidence(input.reference, { text: input.decision })
        : undefined;
    switch (input.action) {
      case "annotate":
        await client.mutation(api.abuseCases.annotate, {
          ...revision,
          kind: input.kind,
          ciphertext: decision!,
        });
        break;
      case "contain": {
        const transport = await verifyContainmentTarget(input);
        const row = await client.mutation(api.abuseCases.beginContainment, {
          ...revision,
          userId: input.userId,
          chatId: input.chatId,
          runId: input.runId,
          transport,
          preserveSnapshot: input.preserveSnapshot,
          ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
          ...(input.region ? { region: input.region } : {}),
          decision: decision!,
          operationToken: randomUUID(),
        });
        return reply(await executeAbuseContainment(row, actor));
      }
      case "retry": {
        const row = await client.mutation(api.abuseCases.retryContainment, {
          ...revision,
          operationToken: randomUUID(),
        });
        return reply(await executeAbuseContainment(row, actor));
      }
      case "stop_without_snapshot": {
        const row = await client.mutation(api.abuseCases.retryContainment, {
          ...revision,
          operationToken: randomUUID(),
          emergencyDecision: decision!,
        });
        return reply(await executeAbuseContainment(row, actor));
      }
      case "confirm_local_stop":
        await client.mutation(api.abuseCases.confirmLocalProcessStop, {
          ...revision,
          decision: decision!,
        });
        break;
      case "reconcile_snapshot": {
        const result = await client.mutation(api.abuseCases.read, {
          ...base,
          paginationOpts: { cursor: null, numItems: 1 },
        });
        if (
          !result.case.containment ||
          result.case.revision !== input.expectedRevision
        )
          throw new Error("Scope changed");
        const snapshotId = await findAbuseSnapshot(result.case.containment);
        await client.mutation(api.abuseCases.reconcileSnapshot, {
          ...revision,
          ...(snapshotId ? { snapshotId } : {}),
        });
        break;
      }
      case "resolve": {
        let expectedRevision = input.expectedRevision;
        const result = await client.mutation(api.abuseCases.read, {
          ...base,
          paginationOpts: { cursor: null, numItems: 1 },
        });
        if (result.case.revision !== expectedRevision)
          throw new Error("Scope changed");
        if (
          result.case.containment?.transport === "cloud" &&
          result.case.containment.workspaceState === "unconfirmed"
        ) {
          const row = await client.mutation(api.abuseCases.retryContainment, {
            ...revision,
            operationToken: randomUUID(),
          });
          await prepareAbuseResolution(row, actor);
          const refreshed = await client.mutation(api.abuseCases.read, {
            ...base,
            paginationOpts: { cursor: null, numItems: 1 },
          });
          expectedRevision = refreshed.case.revision;
        }
        await client.mutation(api.abuseCases.resolve, {
          ...base,
          expectedRevision,
          decision: decision!,
        });
        break;
      }
      case "hold":
        await client.mutation(api.abuseCases.setEvidenceHold, {
          ...revision,
          hold: input.hold,
          decision: decision!,
        });
        break;
      case "erase":
        return reply(
          await client.mutation(api.abuseCases.eraseEvidence, {
            ...revision,
            confirmation: input.confirmation,
          }),
        );
    }
    return reply({ saved: true });
  } catch (error) {
    if (
      error instanceof ConvexError &&
      error.data &&
      typeof error.data === "object" &&
      error.data.code === "ABUSE_ACTIVE_ROOT_CHANGED"
    )
      return reply({ code: "ABUSE_ACTIVE_ROOT_CHANGED" }, 409);
    if (error instanceof AbuseRequestError)
      return reply({ error: "The action could not be read." }, error.status);
    // Provider exceptions and Convex validation errors can include evidence. Never log or forward them.
    return reply(
      {
        error:
          "The action was not confirmed. Reload the case to inspect saved progress and its revision. Interrupted containment can be retried after its ten-minute operation lock expires; restrictions remain until explicitly resolved.",
      },
      409,
    );
  }
}
