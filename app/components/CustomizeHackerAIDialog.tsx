"use client";

import { useState, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import TextareaAutosize from "react-textarea-autosize";

interface CustomizeHackerAIDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const CustomizeHackerAIDialog = ({
  open,
  onOpenChange,
}: CustomizeHackerAIDialogProps) => {
  const [nickname, setNickname] = useState("");
  const [occupation, setOccupation] = useState("");
  const [additionalInfo, setAdditionalInfo] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const MAX_CHAR_LIMIT = 1500;

  const isNicknameOverLimit = nickname.length > MAX_CHAR_LIMIT;
  const isOccupationOverLimit = occupation.length > MAX_CHAR_LIMIT;
  const isAdditionalInfoOverLimit = additionalInfo.length > MAX_CHAR_LIMIT;

  const saveCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
    open ? {} : "skip",
  );

  // Load existing customization data
  useEffect(() => {
    if (userCustomization) {
      setNickname(userCustomization.nickname || "");
      setOccupation(userCustomization.occupation || "");
      setAdditionalInfo(userCustomization.additional_info || "");
    }
  }, [userCustomization]);

  const handleSave = async () => {
    // Check for character limit violations
    if (
      isNicknameOverLimit ||
      isOccupationOverLimit ||
      isAdditionalInfoOverLimit
    ) {
      return; // Don't save if any field exceeds the limit
    }

    try {
      setIsSaving(true);

      await saveCustomization({
        nickname: nickname || undefined,
        occupation: occupation || undefined,
        additional_info: additionalInfo || undefined,
      });
      onOpenChange(false);
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
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    // Reset form to original values
    if (userCustomization) {
      setNickname(userCustomization.nickname || "");
      setOccupation(userCustomization.occupation || "");
      setAdditionalInfo(userCustomization.additional_info || "");
    } else {
      // Reset to empty values if no existing customization
      setNickname("");
      setOccupation("");
      setAdditionalInfo("");
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={true}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Personalization</DialogTitle>
          <DialogDescription>
            Introduce yourself to get better, more personalized responses
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pb-3">
          <div className="space-y-5 pb-3">
            {/* Nickname */}
            <div className="flex flex-col gap-2 px-1">
              <Label htmlFor="nickname">What should HackerAI call you?</Label>
              <TextareaAutosize
                id="nickname"
                placeholder="Nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className={`flex w-full rounded-md border ${isNicknameOverLimit ? "border-red-500" : "border-input"} bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none`}
                maxRows={1}
              />
              {isNicknameOverLimit && (
                <div className="text-xs text-red-500 mt-1">
                  {nickname.length}/{MAX_CHAR_LIMIT} characters
                </div>
              )}
            </div>

            {/* Occupation */}
            <div className="flex flex-col gap-2 px-1">
              <Label htmlFor="occupation">What do you do?</Label>
              <TextareaAutosize
                id="occupation"
                placeholder="Pentester, bug bounty hunter, etc."
                value={occupation}
                onChange={(e) => setOccupation(e.target.value)}
                className={`flex w-full rounded-md border ${isOccupationOverLimit ? "border-red-500" : "border-input"} bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none`}
                maxRows={1}
              />
              {isOccupationOverLimit && (
                <div className="text-xs text-red-500 mt-1">
                  {occupation.length}/{MAX_CHAR_LIMIT} characters
                </div>
              )}
            </div>

            {/* Additional Info */}
            <div className="flex flex-col gap-3 px-1">
              <Label htmlFor="additional-info">
                Anything else HackerAI should know about you?
              </Label>
              <TextareaAutosize
                id="additional-info"
                placeholder="Security interests, preferred methodologies, compliance requirements"
                value={additionalInfo}
                onChange={(e) => setAdditionalInfo(e.target.value)}
                className={`flex w-full rounded-md border ${isAdditionalInfoOverLimit ? "border-red-500" : "border-input"} bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none`}
                minRows={3}
                maxRows={6}
              />
              {isAdditionalInfoOverLimit && (
                <div className="text-xs text-red-500 mt-1">
                  {additionalInfo.length}/{MAX_CHAR_LIMIT} characters
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="flex-row justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              isSaving ||
              isNicknameOverLimit ||
              isOccupationOverLimit ||
              isAdditionalInfoOverLimit
            }
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
