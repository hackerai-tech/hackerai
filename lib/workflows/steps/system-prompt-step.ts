import { systemPrompt } from "@/lib/system-prompt";
import type { ChatMode, SubscriptionTier } from "@/types";
import type { UserCustomization } from "@/types/user";
import type { ModelName } from "@/lib/ai/providers";

export async function systemPromptStep(args: {
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  modelName: ModelName;
  userCustomization?: UserCustomization | null;
  isTemporary?: boolean;
  sandboxContext?: string | null;
}): Promise<string> {
  "use step";
  return systemPrompt(
    args.userId,
    args.mode,
    args.subscription,
    args.modelName,
    args.userCustomization ?? null,
    args.isTemporary,
    args.sandboxContext ?? null,
  );
}
