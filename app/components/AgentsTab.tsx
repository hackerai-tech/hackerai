"use client";

import { CloudNetworkSettings } from "./CloudNetworkSettings";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useGlobalState } from "@/app/contexts/GlobalState";
import type { QueueBehavior } from "@/types/chat";
import { SandboxSelector } from "@/app/components/SandboxSelector";
import { AgentPermissionSelector } from "@/app/components/AgentPermissionSelector";

const AgentsTab = () => {
  const {
    queueBehavior,
    setQueueBehavior,
    subscription,
    sandboxPreference,
    setSandboxPreference,
  } = useGlobalState();

  const queueBehaviorOptions: Array<{
    value: QueueBehavior;
    label: string;
  }> = [
    {
      value: "queue",
      label: "Adicionar à fila após a mensagem atual",
    },
    {
      value: "stop-and-send",
      label: "Parar e enviar agora",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Execution Environment - Available to all users */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
          <div className="flex-1">
            <div className="font-medium">Ambiente de execução padrão</div>
            <div className="text-sm text-muted-foreground">
              Escolha o ambiente sandbox padrão para o modo Agente
            </div>
          </div>
          <div className="w-full sm:w-auto">
            <SandboxSelector
              value={sandboxPreference}
              onChange={setSandboxPreference}
              disabled={false}
              size="md"
            />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
          <div className="flex-1">
            <div className="font-medium">Permissões padrão do agente</div>
            <div className="text-sm text-muted-foreground">
              Comandos e alterações de arquivos dentro do sandbox
            </div>
          </div>
          <div className="w-full sm:w-auto">
            <AgentPermissionSelector size="md" analyticsSurface="agents_tab" />
          </div>
        </div>
      </div>

      {process.env.NEXT_PUBLIC_SELF_HOSTED !== "true" &&
        subscription !== "free" && <CloudNetworkSettings />}

      {/* Queue Messages - Only show for Pro/Ultra/Team users */}
      {subscription !== "free" && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-3 border-b gap-3">
            <div className="flex-1">
              <div className="font-medium">Fila de mensagens</div>
              <div className="text-sm text-muted-foreground">
                Adjust the default behavior of sending a message while Agent is
                streaming
              </div>
            </div>
            <Select
              value={queueBehavior}
              onValueChange={(value) =>
                setQueueBehavior(value as QueueBehavior)
              }
            >
              <SelectTrigger className="w-full sm:w-auto">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {queueBehaviorOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
};

export { AgentsTab };
