"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Copy, Check } from "lucide-react";

export function LocalSandboxToggle() {
  const [isConnected, setIsConnected] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [copied, setCopied] = useState(false);

  // Poll connection status
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const response = await fetch("/api/local-sandbox");
        const data = await response.json();
        setIsConnected(data.connected);
      } catch {
        setIsConnected(false);
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 5000);

    return () => clearInterval(interval);
  }, []);

  const copyCommand = () => {
    const command = `npm run local-sandbox -- --auth-token YOUR_TOKEN`;
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant={isConnected ? "default" : "secondary"}>
        {isConnected ? "Local Connected" : "Cloud (E2B)"}
      </Badge>

      <Dialog open={showInstructions} onOpenChange={setShowInstructions}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            Connect Local
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connect Local Sandbox</DialogTitle>
            <DialogDescription>
              Run commands on your local machine with full network access
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <h3 className="font-semibold mb-2">Prerequisites:</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                <li>Docker installed and running</li>
                <li>Node.js installed</li>
              </ul>
            </div>

            <div>
              <h3 className="font-semibold mb-2">Steps:</h3>
              <ol className="list-decimal list-inside space-y-2 text-sm">
                <li>
                  <strong>Get your auth token:</strong>
                  <ul className="list-disc list-inside ml-6 mt-1 text-muted-foreground">
                    <li>Open Settings (gear icon in sidebar)</li>
                    <li>Go to Account tab</li>
                    <li>Find "Local Sandbox Token" section</li>
                    <li>Click "Copy" to copy your token</li>
                  </ul>
                </li>
                <li>
                  <strong>Run the client:</strong>
                  <div className="mt-2 relative">
                    <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto">
                      npm run local-sandbox -- --auth-token YOUR_TOKEN
                    </pre>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="absolute top-2 right-2"
                      onClick={copyCommand}
                    >
                      {copied ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </li>
                <li>
                  Wait for <code className="bg-muted px-1 py-0.5 rounded text-xs">Local sandbox is ready!</code> message
                </li>
                <li>
                  The badge above will show <span className="font-semibold">"Local Connected"</span> when ready
                </li>
              </ol>
            </div>

            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-3">
              <h4 className="font-semibold text-sm mb-1">Security Note:</h4>
              <p className="text-xs text-muted-foreground">
                Local mode gives the AI direct access to your network. Use with caution:
              </p>
              <ul className="list-disc list-inside text-xs text-muted-foreground mt-2 space-y-1">
                <li>Commands run in an isolated Docker container</li>
                <li>Container uses host network (can access local services)</li>
                <li>Review commands before the AI executes them</li>
                <li>Press Ctrl+C to stop the local client anytime</li>
              </ul>
            </div>

            <div>
              <h3 className="font-semibold mb-2">Advanced Options:</h3>
              <pre className="bg-muted p-3 rounded-md text-xs overflow-x-auto">
                {`# Use custom backend URL
npm run local-sandbox -- \\
  --auth-token YOUR_TOKEN \\
  --backend-url https://your-domain.com

# Use custom Docker image
npm run local-sandbox -- \\
  --auth-token YOUR_TOKEN \\
  --image kalilinux/kali-rolling`}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
