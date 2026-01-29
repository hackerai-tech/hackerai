export interface UserCustomization {
  readonly nickname?: string;
  readonly occupation?: string;
  readonly personality?: string;
  readonly traits?: string;
  readonly additional_info?: string;
  readonly include_memory_entries?: boolean;
  readonly updated_at: number;
  readonly extra_usage_enabled?: boolean;
}

export type PersonalityType = "cynic" | "robot" | "listener" | "nerd";
