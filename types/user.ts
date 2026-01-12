export interface UserCustomization {
  readonly nickname?: string;
  readonly occupation?: string;
  readonly personality?: string;
  readonly traits?: string;
  readonly additional_info?: string;
  readonly include_memory_entries?: boolean;
  readonly scope_exclusions?: string;
  readonly updated_at: number;
}

export type PersonalityType = "cynic" | "robot" | "listener" | "nerd";
