const FALLBACK_ORGANIZATION_NAME = "Personal Workspace";
const MAX_ORGANIZATION_NAME_LENGTH = 255;

const disallowedWorkOSOrganizationNameChars = /[^\p{L}\p{N} '\-&.,()]+/gu;
const hasWorkOSOrganizationNameContent = /[\p{L}\p{N}]/u;

type OrganizationNameInput = {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

export function buildWorkOSOrganizationName({
  email,
  firstName,
  lastName,
}: OrganizationNameInput): string {
  const displayName = [firstName, lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  const emailLocalPart = email?.split("@")[0] ?? "";
  const candidate = displayName || emailLocalPart || FALLBACK_ORGANIZATION_NAME;
  const sanitized = candidate
    .replace(disallowedWorkOSOrganizationNameChars, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ORGANIZATION_NAME_LENGTH)
    .trim();

  return hasWorkOSOrganizationNameContent.test(sanitized)
    ? sanitized
    : FALLBACK_ORGANIZATION_NAME;
}
