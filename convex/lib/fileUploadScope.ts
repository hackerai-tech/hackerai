import type { UserIdentity } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";

// The supplied scope can only reject. Ownership and entitlement still come
// from the authenticated identity. Deployed clients may omit this field.
export const expectedUploadScopeValidator = v.optional(
  v.object({
    userId: v.string(),
    organizationId: v.union(v.string(), v.null()),
  }),
);

export function assertExpectedUploadScope(
  identity: UserIdentity,
  expected: Infer<typeof expectedUploadScopeValidator>,
): void {
  if (!expected) return;

  const signedOrganizationId =
    typeof identity.org_id === "string" && identity.org_id
      ? identity.org_id
      : null;
  if (
    expected.userId !== identity.subject ||
    expected.organizationId !== signedOrganizationId
  ) {
    throw new ConvexError({
      code: "UPLOAD_CONTEXT_CHANGED",
      message: "Upload interrupted. Remove and attach the file again.",
    });
  }
}
