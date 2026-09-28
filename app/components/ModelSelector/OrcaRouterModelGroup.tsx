"use client";

import { useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  filterOrcaRouterModels,
  toOrcaRouterModelKey,
  type OrcaRouterModel,
} from "@/lib/ai/orcarouter/models";
import type { SelectedModel } from "@/types/chat";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import {
  MODEL_PROVIDERS_SETTINGS_TAB,
  type OrcaRouterCatalogResponse,
  type OrcaRouterConnection,
} from "@/app/hooks/useOrcaRouter";

const SEARCH_THRESHOLD = 8;

/**
 * The model options offered for the current turn: the live catalog (or the
 * verified fallback) narrowed to image-capable models when an image is
 * attached. Models without declared image input are excluded, not guessed.
 */
export function getOrcaRouterOptions(
  catalog: OrcaRouterCatalogResponse | undefined,
  hasImageAttachment: boolean,
): OrcaRouterModel[] {
  if (!catalog) return [];
  return filterOrcaRouterModels(
    catalog.models,
    hasImageAttachment ? "image-chat" : "chat",
  );
}

const SettingsLink = ({
  label,
  onClose,
}: {
  label: string;
  onClose: () => void;
}) => (
  <button
    type="button"
    onClick={() => {
      onClose();
      openSettingsDialog(MODEL_PROVIDERS_SETTINGS_TAB);
    }}
    className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
  >
    {label}
  </button>
);

export function OrcaRouterModelGroup({
  connection,
  catalog,
  isLoading,
  onRefresh,
  hasImageAttachment,
  value,
  onSelect,
  onClose,
  mobile = false,
}: {
  connection: OrcaRouterConnection | undefined;
  catalog: OrcaRouterCatalogResponse | undefined;
  isLoading: boolean;
  onRefresh: () => void;
  hasImageAttachment: boolean;
  value: SelectedModel;
  onSelect: (model: SelectedModel) => void;
  onClose: () => void;
  mobile?: boolean;
}) {
  const [query, setQuery] = useState("");
  if (!connection?.enabled) return null;

  const options = getOrcaRouterOptions(catalog, hasImageAttachment);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery
    ? options.filter((model) =>
        model.id.toLowerCase().includes(normalizedQuery),
      )
    : options;

  let body: React.ReactNode;
  if (!connection.connected) {
    body = <SettingsLink label="Connect OrcaRouter" onClose={onClose} />;
  } else if (
    connection.status === "needs_reauth" ||
    catalog?.status === "unauthorized"
  ) {
    body = <SettingsLink label="Reconnect OrcaRouter" onClose={onClose} />;
  } else if (isLoading && !catalog) {
    body = (
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading OrcaRouter models…
      </div>
    );
  } else {
    body = (
      <>
        {catalog?.status === "fallback" && (
          <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-xs text-muted-foreground">
            <span>Live catalog unavailable — showing verified defaults</span>
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh OrcaRouter models"
              className="rounded p-0.5 hover:bg-muted/50 hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
        )}
        {options.length > SEARCH_THRESHOLD && (
          <div className="px-1 pb-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search OrcaRouter models"
              aria-label="Search OrcaRouter models"
              className="h-8 text-sm"
            />
          </div>
        )}
        {options.length === 0 ? (
          <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
            {hasImageAttachment
              ? "No OrcaRouter models accept images."
              : "No OrcaRouter chat models are available."}
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="OrcaRouter models"
            className="max-h-56 overflow-y-auto"
          >
            {visible.map((model) => {
              const key = toOrcaRouterModelKey(model.id);
              const isSelected = value === key;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelect(key)}
                  className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors ${
                    mobile ? "py-2.5" : "py-1.5"
                  } ${isSelected ? "bg-accent" : "hover:bg-muted/50"}`}
                >
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      isSelected
                        ? "text-accent-foreground"
                        : "text-muted-foreground group-hover:text-foreground"
                    }`}
                  >
                    {model.id}
                  </span>
                  {isSelected ? (
                    <Check className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </>
    );
  }

  return (
    <div data-testid="orcarouter-model-group">
      <div className="my-1 border-b border-border/50" />
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1 text-xs font-medium text-muted-foreground">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/orcarouter-logo.png"
          alt=""
          width={14}
          height={14}
          className="size-3.5"
        />
        OrcaRouter
      </div>
      {body}
    </div>
  );
}
