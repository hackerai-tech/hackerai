"use client";

import { ChevronRight } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

interface PersonalizationTabProps {
  onCustomInstructions: () => void;
  // onManageMemories: () => void;
  onManageNotes: () => void;
}

const PersonalizationTab = ({
  onCustomInstructions,
  // onManageMemories,
  onManageNotes,
}: PersonalizationTabProps) => {
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
    {},
  );
  const saveCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );

  return (
    <div className="space-y-6">
      {/* Personalization Section */}
      <div>
        <div className="space-y-4">
          <div
            className="flex items-center justify-between py-3 border-b cursor-pointer hover:bg-muted/50 transition-colors rounded-md px-2 -mx-2"
            onClick={onCustomInstructions}
          >
            <div>
              <div className="font-medium">Custom instructions</div>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              Configure
              <ChevronRight className="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>

      {/* Notes Section (formerly Memory Section) */}
      <div>
        <h3 className="text-lg font-medium mb-4 pb-2 border-b">Notes</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b">
            <div>
              <div className="font-medium">Enable notes</div>
              <div className="text-sm text-muted-foreground">
                Let HackerAI save and use notes when responding.
              </div>
            </div>
            <Switch
              checked={userCustomization?.include_memory_entries ?? true}
              onCheckedChange={async (checked) => {
                try {
                  await saveCustomization({
                    include_memory_entries: checked,
                  });
                } catch (error) {
                  console.error("Failed to save customization:", error);
                  const errorMessage =
                    error instanceof ConvexError
                      ? (error.data as { message?: string })?.message ||
                        error.message ||
                        "Failed to save customization"
                      : error instanceof Error
                        ? error.message
                        : "Failed to save customization";
                  toast.error(errorMessage);
                }
              }}
              aria-label="Toggle notes"
            />
          </div>

          <div className="flex items-center justify-between py-3">
            <div>
              <div className="font-medium">Manage notes</div>
            </div>
            {/* <Button variant="outline" size="sm" onClick={onManageMemories}>
              Manage
            </Button> */}
            <Button variant="outline" size="sm" onClick={onManageNotes}>
              Manage
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export { PersonalizationTab };
