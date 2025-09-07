"use client";

import React, { useState } from "react";
import { Settings, X, ChevronRight } from "lucide-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ManageMemoriesDialog } from "@/app/components/ManageMemoriesDialog";
import { CustomizeHackerAIDialog } from "@/app/components/CustomizeHackerAIDialog";
import { useIsMobile } from "@/hooks/use-mobile";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SettingsDialog = ({ open, onOpenChange }: SettingsDialogProps) => {
  const [activeTab, setActiveTab] = useState("Personalization");
  const [showCustomizeDialog, setShowCustomizeDialog] = useState(false);
  const [showMemoriesDialog, setShowMemoriesDialog] = useState(false);
  const isMobile = useIsMobile();

  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
  );
  const saveCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );

  const tabs = [
    { id: "Personalization", label: "Personalization", icon: Settings },
  ];

  const handleCustomInstructions = () => {
    setShowCustomizeDialog(true);
  };

  const handleManageMemories = () => {
    setShowMemoriesDialog(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="w-[380px] max-w-[98%] md:w-[95vw] md:max-w-[920px] max-h-[95%] md:h-[672px] p-0 overflow-hidden rounded-[20px]"
          showCloseButton={!isMobile}
        >
          {/* Accessibility: Always include DialogTitle */}
          <DialogTitle className="sr-only">Settings</DialogTitle>

          {isMobile && (
            <div className="relative z-10 p-0">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <h3 className="text-lg font-semibold">Settings</h3>
                <div
                  className="flex h-7 w-7 items-center justify-center cursor-pointer rounded-md hover:bg-muted"
                  onClick={() => onOpenChange(false)}
                >
                  <X className="size-5" />
                </div>
              </div>
            </div>
          )}

          <div
            className={`flex ${isMobile ? "flex-col" : "flex-row"} ${isMobile ? "h-[580px]" : "h-[672px]"} max-h-[90vh]`}
          >
            {/* Tabs */}
            <div
              className={`${isMobile ? "overflow-x-auto md:overflow-x-visible border-r pb-2 md:pb-0 relative" : "md:w-[221px] border-r"}`}
            >
              {!isMobile && (
                <div className="items-center hidden px-5 pt-5 pb-3 md:flex">
                  <div className="flex">
                    {/* Logo space - not adding logo as requested */}
                  </div>
                </div>
              )}
              <div className="relative flex w-full max-md:pe-3">
                <div className="flex-1 flex-shrink-0 flex items-start self-stretch px-3 overflow-auto w-max md:w-full pb-0 border-b md:border-b-0 md:flex-col md:gap-3 md:px-2 max-md:gap-2.5">
                  <div className="flex md:gap-0.5 gap-2.5 md:flex-col items-start self-stretch">
                    {tabs.map((tab) => {
                      const IconComponent = tab.icon;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setActiveTab(tab.id)}
                          className={`flex px-1 py-2 items-center text-sm leading-5 max-md:whitespace-nowrap md:h-8 md:gap-2 md:self-stretch md:px-4 md:rounded-lg hover:bg-muted ${
                            activeTab === tab.id
                              ? `${isMobile ? "font-medium" : "bg-muted font-medium"}`
                              : ""
                          } ${isMobile && activeTab === tab.id ? "relative" : ""}`}
                        >
                          {!isMobile && <IconComponent className="h-4 w-4" />}
                          <span className="truncate">{tab.label}</span>
                          {isMobile && activeTab === tab.id && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground"></div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Content area */}
            <div className="flex flex-col items-start self-stretch flex-1 overflow-hidden">
              {!isMobile && (
                <div className="gap-1 items-center px-6 py-5 hidden md:flex self-stretch border-b">
                  <h3 className="text-lg font-medium">{activeTab}</h3>
                </div>
              )}
              <div className="flex-1 self-stretch items-start overflow-y-auto px-4 pt-4 pb-4 md:px-6 md:pt-4">
                {activeTab === "Personalization" && (
                  <div className="space-y-6">
                    {/* Personalization Section */}
                    <div>
                      <div className="space-y-4">
                        <div
                           className="flex items-center justify-between py-3 border-b cursor-pointer hover:bg-muted/50 transition-colors rounded-md px-2 -mx-2"
                           onClick={handleCustomInstructions}
                         >
                          <div>
                            <div className="font-medium">
                              Custom instructions
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            Configure
                            <ChevronRight className="h-4 w-4" />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Memory Section */}
                    <div>
                      <h3 className="text-lg font-medium mb-4 pb-2 border-b">
                        Memory
                      </h3>
                      <div className="space-y-4">
                         <div className="flex items-center justify-between py-3 border-b">
                            <div>
                              <div className="font-medium">Enable memory</div>
                              <div className="text-sm text-muted-foreground">
                               Let HackerAI save and use memories when
                               responding.
                              </div>
                            </div>
                            <Switch
                              checked={userCustomization?.include_memory_entries ?? true}
                              onCheckedChange={(checked) => {
                                saveCustomization({
                                  include_memory_entries: checked,
                                });
                              }}
                              aria-label="Toggle memory"
                              className="dark:bg-blue-400"
                            />
                          </div>
 
                         <div className="flex items-center justify-between py-3">
                            <div>
                              <div className="font-medium">Manage memories</div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleManageMemories}
                            >
                              Manage
                            </Button>
                          </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Manage Memories Dialog */}
      <ManageMemoriesDialog
        open={showMemoriesDialog}
        onOpenChange={setShowMemoriesDialog}
      />

      {/* Customize HackerAI Dialog */}
      <CustomizeHackerAIDialog
        open={showCustomizeDialog}
        onOpenChange={setShowCustomizeDialog}
      />
    </>
  );
};

export { SettingsDialog };
