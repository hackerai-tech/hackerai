interface UserCustomization {
  readonly nickname?: string;
  readonly occupation?: string;
  readonly personality?: string;
  readonly traits?: string;
  readonly additional_info?: string;
  readonly updated_at: number;
}

type PersonalityType = "cynic" | "robot" | "listener" | "nerd";

// Personality instruction mappings for better performance
const PERSONALITY_INSTRUCTIONS: Record<PersonalityType, string> = {
  cynic:
    "Adopt a critical and sarcastic tone. Be skeptical of claims and point out potential flaws or weaknesses in approaches.",
  robot:
    "Be efficient and blunt in your responses. Focus on facts, be direct, and avoid unnecessary pleasantries.",
  listener:
    "Be thoughtful and supportive. Ask clarifying questions and show empathy while providing guidance.",
  nerd: "Be exploratory and enthusiastic about technical details. Dive deep into explanations and share interesting technical insights.",
} as const;

export const getPersonalityInstructions = (personality?: string): string => {
  if (!personality || !(personality in PERSONALITY_INSTRUCTIONS)) {
    return "";
  }
  return PERSONALITY_INSTRUCTIONS[personality as PersonalityType];
};

export type { UserCustomization, PersonalityType };
