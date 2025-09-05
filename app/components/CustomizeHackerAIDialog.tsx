"use client";

import React, { useState, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import TextareaAutosize from "react-textarea-autosize";

interface CustomizeHackerAIDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const predefinedTraits = [
  "Methodical",
  "Detail-oriented",
  "Thorough",
  "Risk-aware",
  "Tool-savvy",
];

const personalityOptions = [
  { value: "default", label: "Default", description: "" },
  { value: "cynic", label: "Cynic", description: "Critical and sarcastic" },
  { value: "robot", label: "Robot", description: "Efficient and blunt" },
  {
    value: "listener",
    label: "Listener",
    description: "Thoughtful and supportive",
  },
  { value: "nerd", label: "Nerd", description: "Exploratory and enthusiastic" },
];

export const CustomizeHackerAIDialog = ({
  open,
  onOpenChange,
}: CustomizeHackerAIDialogProps) => {
  const [nickname, setNickname] = useState("");
  const [occupation, setOccupation] = useState("");
  const [personality, setPersonality] = useState("default");
  const [traitsText, setTraitsText] = useState("");
  const [additionalInfo, setAdditionalInfo] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const saveCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
  );

  // Load existing customization data
  useEffect(() => {
    if (userCustomization) {
      setNickname(userCustomization.nickname || "");
      setOccupation(userCustomization.occupation || "");
      setPersonality(userCustomization.personality || "default");
      setTraitsText(userCustomization.traits || "");
      setAdditionalInfo(userCustomization.additional_info || "");
    }
  }, [userCustomization]);

  const handleAddTrait = (trait: string) => {
    if (trait) {
      const currentText = traitsText.trim();
      const newText = currentText ? `${currentText}, ${trait}` : trait;
      setTraitsText(newText);
    }
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);

      await saveCustomization({
        nickname: nickname || undefined,
        occupation: occupation || undefined,
        personality: personality === "default" ? undefined : personality,
        traits: traitsText.trim() || undefined,
        additional_info: additionalInfo || undefined,
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to save customization:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    // Reset form to original values
    if (userCustomization) {
      setNickname(userCustomization.nickname || "");
      setOccupation(userCustomization.occupation || "");
      setPersonality(userCustomization.personality || "default");
      setTraitsText(userCustomization.traits || "");
      setAdditionalInfo(userCustomization.additional_info || "");
    } else {
      // Reset to empty values if no existing customization
      setNickname("");
      setOccupation("");
      setPersonality("default");
      setTraitsText("");
      setAdditionalInfo("");
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={true}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Customize HackerAI</DialogTitle>
          <DialogDescription>
            Introduce yourself to get better, more personalized responses
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-8">
          {/* Nickname */}
          <div className="space-y-3">
            <Label htmlFor="nickname">What should HackerAI call you?</Label>
            <TextareaAutosize
              id="nickname"
              placeholder="Nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              maxRows={1}
            />
          </div>

          {/* Occupation */}
          <div className="space-y-3">
            <Label htmlFor="occupation">What do you do?</Label>
            <TextareaAutosize
              id="occupation"
              placeholder="Pentester, bug bounty hunter, etc."
              value={occupation}
              onChange={(e) => setOccupation(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              maxRows={1}
            />
          </div>

          {/* Personality */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <Label className="sm:flex-shrink-0">
                What personality should HackerAI have?
              </Label>
              <Select value={personality} onValueChange={setPersonality}>
                <SelectTrigger className="w-full sm:w-auto">
                  <SelectValue placeholder="Select personality">
                    {
                      personalityOptions.find(
                        (opt) => opt.value === personality,
                      )?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {personalityOptions.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      className="flex flex-col items-start py-3"
                    >
                      <div className="flex flex-col">
                        <div className="font-medium">{option.label}</div>
                        {option.value !== "default" && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {option.description}
                          </div>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Traits */}
          <div className="space-y-4">
            <Label>What traits should HackerAI have?</Label>

            <TextareaAutosize
              placeholder="Describe or select traits"
              value={traitsText}
              onChange={(e) => setTraitsText(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              minRows={2}
              maxRows={4}
            />

            {/* Predefined traits */}
            <div className="flex flex-wrap gap-2">
              {predefinedTraits.map((trait) => (
                <button
                  key={trait}
                  type="button"
                  onClick={() => handleAddTrait(trait)}
                  className="inline-flex items-center gap-1 px-3 py-1 text-sm border rounded-full hover:bg-muted transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  {trait}
                </button>
              ))}
            </div>
          </div>

          {/* Additional Info */}
          <div className="space-y-3">
            <Label htmlFor="additional-info">
              Anything else HackerAI should know about you?
            </Label>
            <TextareaAutosize
              id="additional-info"
              placeholder="Security interests, preferred methodologies, compliance requirements"
              value={additionalInfo}
              onChange={(e) => setAdditionalInfo(e.target.value)}
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              minRows={3}
              maxRows={6}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
