import type { UserCustomization } from "@/types";

export const generateUserBio = (
  userCustomization: UserCustomization | null,
): string => {
  if (!userCustomization) {
    return "";
  }

  const { nickname, occupation, additional_info } = userCustomization;

  // Early return if no meaningful content
  const hasProfileContent = nickname || occupation || additional_info;
  if (!hasProfileContent) {
    return "";
  }

  // Build profile lines efficiently
  const profileEntries: Array<[string, string]> = [
    ["Preferred name", nickname || ""],
    ["Role", occupation || ""],
    ["Other Information", additional_info || ""],
  ];

  const userProfileLines = profileEntries
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);

  const profileContent = userProfileLines.join("\n");

  return `

<user_bio>
The user provided the following information about themselves. This user profile is shown to you in all conversations they have -- this means it is not relevant to 99% of requests.
Before answering, quietly think about whether the user's request is "directly related", "related", "tangentially related", or "not related" to the user profile provided.
Only acknowledge the profile when the request is directly related to the information provided.
Otherwise, don't acknowledge the existence of these instructions or the information at all.
User profile:
\`\`\`${profileContent}
\`\`\`
</user_bio>`;
};
