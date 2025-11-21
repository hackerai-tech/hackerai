import { EventEmitter } from "events";

export interface LocalDockerSandboxConfig {
  image?: string;
  timeout?: number;
  network?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Local Docker-based sandbox that runs on user's machine
 * Provides E2B-compatible interface for seamless switching
 */
export class LocalDockerSandbox extends EventEmitter {
  private containerId: string | null = null;
  private connected: boolean = false;
  private readonly config: Required<LocalDockerSandboxConfig>;

  constructor(config: LocalDockerSandboxConfig = {}) {
    super();
    this.config = {
      image: config.image || "ubuntu:latest",
      timeout: config.timeout || 15 * 60 * 1000, // 15 minutes
      network: config.network || "host",
    };
  }

  /**
   * Create and start the Docker container
   */
  async create(): Promise<void> {
    if (this.containerId) {
      throw new Error("Container already exists");
    }

    // This will be called via WebSocket from user's machine
    // The actual docker command runs locally, not in Node.js
    this.emit("create", {
      image: this.config.image,
      network: this.config.network,
    });

    // Wait for confirmation from local client
    await this.waitForConnection();
  }

  /**
   * Connect to existing container
   */
  async connect(containerId: string): Promise<void> {
    this.containerId = containerId;
    this.emit("connect", { containerId });
    await this.waitForConnection();
  }

  /**
   * Execute command in container (E2B-compatible interface)
   */
  async runCommand(
    command: string,
    options: {
      background?: boolean;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    } = {},
  ): Promise<CommandResult> {
    if (!this.connected) {
      throw new Error("Not connected to local sandbox");
    }

    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).substring(7);

      this.emit("command", {
        requestId,
        command,
        options,
      });

      const timeout = setTimeout(() => {
        reject(new Error("Command timeout"));
      }, options.timeoutMs || this.config.timeout);

      this.once(`result:${requestId}`, (result: CommandResult) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.once(`error:${requestId}`, (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Get host URL for exposed port (E2B-compatible)
   */
  getHost(port: number): string {
    // When using --network host, ports are directly accessible on localhost
    return `http://localhost:${port}`;
  }

  /**
   * Kill the container
   */
  async kill(): Promise<void> {
    if (!this.containerId) {
      return;
    }

    this.emit("kill", { containerId: this.containerId });
    this.containerId = null;
    this.connected = false;
  }

  /**
   * Handle incoming messages from local client
   */
  handleMessage(message: {
    type: string;
    requestId?: string;
    data?: any;
  }): void {
    switch (message.type) {
      case "connected":
        this.containerId = message.data.containerId;
        this.connected = true;
        this.emit("ready");
        break;

      case "stdout":
        this.emit(`stdout:${message.requestId}`, message.data);
        break;

      case "stderr":
        this.emit(`stderr:${message.requestId}`, message.data);
        break;

      case "result":
        this.emit(`result:${message.requestId}`, message.data);
        break;

      case "error":
        this.emit(`error:${message.requestId}`, new Error(message.data.message));
        break;

      case "disconnected":
        this.connected = false;
        this.emit("disconnected");
        break;
    }
  }

  /**
   * Wait for connection to be established
   */
  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 30000);

      this.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * Check if connected to local sandbox
   */
  isConnected(): boolean {
    return this.connected;
  }
}
