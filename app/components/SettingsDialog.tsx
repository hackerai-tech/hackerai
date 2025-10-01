"use client";

import React, { useState } from "react";
import { Settings, X, Shield, CircleUserRound, Database } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ManageMemoriesDialog } from "@/app/components/ManageMemoriesDialog";
import { CustomizeHackerAIDialog } from "@/app/components/CustomizeHackerAIDialog";
import { SecurityTab } from "@/app/components/SecurityTab";
import { PersonalizationTab } from "@/app/components/PersonalizationTab";
import { AccountTab } from "@/app/components/AccountTab";
import { DataControlsTab } from "@/app/components/DataControlsTab";
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

  const tabs = [
    { id: "Personalization", label: "Personalization", icon: Settings },
    { id: "Security", label: "Security", icon: Shield },
    { id: "Data controls", label: "Data controls", icon: Database },
    { id: "Account", label: "Account", icon: CircleUserRound },
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
            className={`flex ${isMobile ? "flex-col" : "flex-row"} ${isMobile ? "h-[80dvh]" : "h-[672px]"} max-h-[90vh] min-h-0`}
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
                          className={`group flex items-center gap-1.5 px-1 py-2 text-sm leading-5 max-md:whitespace-nowrap md:h-12 md:gap-2.5 md:self-stretch md:px-4 md:rounded-lg hover:bg-muted transition-colors ${
                            activeTab === tab.id
                              ? `${isMobile ? "font-medium" : "bg-muted font-medium"}`
                              : ""
                          } ${isMobile && activeTab === tab.id ? "relative" : ""}`}
                        >
                          {!isMobile && (
                            <div className="flex items-center justify-center">
                              <IconComponent className="h-5 w-5" />
                            </div>
                          )}
                          <div className="flex min-w-0 grow items-center">
                            <div className="truncate">{tab.label}</div>
                          </div>
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
            <div className="flex flex-col items-start self-stretch flex-1 overflow-hidden min-h-0">
              {!isMobile && (
                <div className="gap-1 items-center px-6 py-5 hidden md:flex self-stretch border-b">
                  <h3 className="text-lg font-medium">{activeTab}</h3>
                </div>
              )}
              <div className="flex-1 self-stretch items-start overflow-y-auto px-4 pt-4 pb-4 md:px-6 md:pt-4 min-h-0">
                {activeTab === "Personalization" && (
                  <PersonalizationTab
                    onCustomInstructions={handleCustomInstructions}
                    onManageMemories={handleManageMemories}
                  />
                )}

                {activeTab === "Security" && <SecurityTab />}

                {activeTab === "Data controls" && <DataControlsTab />}

                {activeTab === "Account" && <AccountTab />}
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
