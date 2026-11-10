"use client";

import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import type { SubscriptionTier } from "@/types";

interface PersonalizationTabProps {
  onCustomInstructions: () => void;
  onManageNotes: () => void;
  subscription?: SubscriptionTier;
}

const PersonalizationTab = ({
  onCustomInstructions,
  onManageNotes,
  subscription,
}: PersonalizationTabProps) => {
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
    {},
  );
  const saveCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );

  const predictions = useQuery(
    api.userCustomization.getPredictionPreference,
    {},
  );
  const savePredictions = useMutation(
    api.userCustomization.setPredictionPreference,
  );
  const [pendingPredictions, setPendingPredictions] = useState<boolean | null>(
    null,
  );
  const [predictionError, setPredictionError] = useState(false);
  const savingPredictions = useRef(false);
  const changePredictions = async (enabled: boolean) => {
    if (!predictions || savingPredictions.current) return;
    savingPredictions.current = true;
    setPendingPredictions(enabled);
    setPredictionError(false);
    try {
      await savePredictions({ enabled });
      captureAuthenticatedEvent("contextual_next_actions_preference_changed", {
        enabled,
        definition_version: 1,
      });
    } catch {
      setPredictionError(true);
      toast.error(
        "Couldn't save your prediction preference. Please try again.",
      );
    } finally {
      savingPredictions.current = false;
      setPendingPredictions(null);
    }
  };

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
              <div className="font-medium">Instruções personalizadas</div>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              Configurar
              <ChevronRight className="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>

      {/* Notes Section */}
      {subscription && (
        <div>
          <h3 className="text-lg font-medium mb-4 pb-2 border-b">Notas</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b">
              <div>
                <div className="font-medium">Enable notes</div>
                <div className="text-sm text-muted-foreground">
                  Let HackerAI save and use notes when responding.
                </div>
              </div>
              <Switch
                checked={userCustomization?.include_notes ?? true}
                onCheckedChange={async (checked) => {
                  try {
                    await saveCustomization({
                      include_notes: checked,
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
                <div className="font-medium">Gerenciar notas</div>
              </div>
              <Button variant="outline" size="sm" onClick={onManageNotes}>
                Gerenciar
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start justify-between gap-4 border-t pt-6 pb-3">
        <div className="min-w-0">
          <label htmlFor="show-predictions" className="font-medium">
            Show predictions
          </label>
          <p
            id="show-predictions-description"
            className="mt-1 text-sm text-muted-foreground"
          >
            Predict your next message based on the conversation.
          </p>
          <p
            id="show-predictions-status"
            role="status"
            className="mt-2 text-sm text-muted-foreground empty:mt-0"
          >
            {predictions === undefined
              ? "Loading preference…"
              : predictions === null
                ? "Sign in to manage this preference."
                : pendingPredictions !== null
                  ? "Saving…"
                  : null}
          </p>
          {predictionError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Your change wasn&apos;t saved. Please try again.
            </p>
          )}
        </div>
        <Switch
          id="show-predictions"
          className="mt-1 shrink-0 data-[state=checked]:bg-blue-600"
          aria-describedby="show-predictions-description show-predictions-status"
          checked={
            predictions ? (pendingPredictions ?? predictions.enabled) : false
          }
          disabled={!predictions || pendingPredictions !== null}
          onCheckedChange={changePredictions}
        />
      </div>
    </div>
  );
};

export { PersonalizationTab };
