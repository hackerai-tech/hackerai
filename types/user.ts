export interface UserCustomization {
  readonly nickname?: string;
  readonly occupation?: string;
  readonly personality?: string;
  readonly traits?: string;
  readonly additional_info?: string;
  readonly include_memory_entries?: boolean;
  readonly caido_enabled?: boolean;
  /** Custom Caido port for local sandbox users with an existing Caido instance (default: 48080). */
  readonly caido_port?: number;
  readonly updated_at: number;
  readonly extra_usage_enabled?: boolean;
  readonly max_mode_enabled?: boolean;
}

export type PersonalityType = "cynic" | "robot" | "listener" | "nerd";
