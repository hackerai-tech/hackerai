export interface InProcessRelayClient {
  start(): Promise<void>;
  cleanup(options?: { terminated?: boolean }): Promise<void>;
}

export type InProcessRelayFactory<Config> = (
  config: Config,
  onFatal: (error: Error) => void,
) => InProcessRelayClient;

/** Serializes AWS lifecycle transitions around one in-process relay client. */
export class InProcessRelayLifecycle<Config> {
  private config: Config | null = null;
  private client: InProcessRelayClient | null = null;
  private enabled = false;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly createClient: InProcessRelayFactory<Config>,
    private readonly onUnexpectedExit: (error: Error) => void,
    private readonly onRestartFailed: (error: Error) => void = onUnexpectedExit,
  ) {}

  get running(): boolean {
    return this.client !== null;
  }

  run(config: Config): Promise<void> {
    this.config = config;
    this.enabled = true;
    return this.enqueue(async () => {
      await this.stopCurrent(false);
      await this.startCurrent();
    });
  }

  suspend(): Promise<void> {
    this.enabled = false;
    return this.enqueue(() => this.stopCurrent(false));
  }

  resume(): Promise<void> {
    this.enabled = true;
    return this.enqueue(async () => {
      await this.stopCurrent(false);
      await this.startCurrent();
    });
  }

  terminate(): Promise<void> {
    this.enabled = false;
    this.config = null;
    return this.enqueue(() => this.stopCurrent(true));
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.then(operation, operation);
    this.transition = result.catch(() => undefined);
    return result;
  }

  private async startCurrent(): Promise<void> {
    if (!this.enabled || !this.config) {
      throw new Error("Cloud sandbox is not bootstrapped");
    }
    let client!: InProcessRelayClient;
    client = this.createClient(this.config, (error) => {
      void this.handleFatal(client, error);
    });
    this.client = client;
    try {
      await client.start();
    } catch (error) {
      if (this.client === client) this.client = null;
      await client.cleanup();
      throw error;
    }
  }

  private async stopCurrent(terminated: boolean): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.cleanup({ terminated });
    } catch (error) {
      // Retain the cleanup handle so an AWS lifecycle-hook retry cannot report
      // success while the original process trees are still running.
      if (this.client === null) this.client = client;
      throw error;
    }
  }

  private handleFatal(client: InProcessRelayClient, error: Error): void {
    if (this.client !== client) return;
    this.client = null;
    this.onUnexpectedExit(error);
    if (!this.enabled || !this.config) return;
    void this.enqueue(() => this.startCurrent()).catch((restartError) => {
      this.onRestartFailed(
        restartError instanceof Error
          ? restartError
          : new Error(String(restartError)),
      );
    });
  }
}
