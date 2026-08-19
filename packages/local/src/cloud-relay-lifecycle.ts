export interface InProcessRelayClient {
  start(): Promise<void>;
  cleanup(options?: { terminated?: boolean }): Promise<void>;
}

export type InProcessRelayFactory<Config> = (
  config: Config,
  onFatal: (error: Error) => void,
) => InProcessRelayClient;

export const RELAY_RESTART_BASE_DELAY_MS = 250;
export const RELAY_RESTART_MAX_ATTEMPTS = 5;
const RELAY_RESTART_HEALTHY_WINDOW_MS = 30_000;

/** Serializes AWS lifecycle transitions around one in-process relay client. */
export class InProcessRelayLifecycle<Config> {
  private config: Config | null = null;
  private client: InProcessRelayClient | null = null;
  private enabled = false;
  private transition: Promise<void> = Promise.resolve();
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly createClient: InProcessRelayFactory<Config>,
    private readonly onUnexpectedExit: (error: Error) => void,
    private readonly onRestartFailed: (error: Error) => void = onUnexpectedExit,
  ) {}

  get running(): boolean {
    return this.client !== null;
  }

  run(config: Config): Promise<void> {
    this.resetRestartState();
    this.config = config;
    this.enabled = true;
    return this.enqueue(async () => {
      await this.stopCurrent(false);
      await this.startCurrent();
    });
  }

  suspend(): Promise<void> {
    this.clearRestartTimers();
    this.enabled = false;
    return this.enqueue(() => this.stopCurrent(false));
  }

  resume(): Promise<void> {
    this.resetRestartState();
    this.enabled = true;
    return this.enqueue(async () => {
      await this.stopCurrent(false);
      await this.startCurrent();
    });
  }

  terminate(): Promise<void> {
    this.clearRestartTimers();
    this.restartAttempts = 0;
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
      if (this.restartAttempts > 0) {
        this.healthyTimer = setTimeout(() => {
          this.restartAttempts = 0;
          this.healthyTimer = null;
        }, RELAY_RESTART_HEALTHY_WINDOW_MS);
        this.healthyTimer.unref?.();
      }
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
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer);
      this.healthyTimer = null;
    }
    this.onUnexpectedExit(error);
    this.scheduleRestart(error);
  }

  private scheduleRestart(lastError: Error): void {
    if (!this.enabled || !this.config || this.restartTimer) return;
    if (this.restartAttempts >= RELAY_RESTART_MAX_ATTEMPTS) {
      this.onRestartFailed(
        new Error(
          `Cloud relay restart limit reached after ${RELAY_RESTART_MAX_ATTEMPTS} attempts`,
          { cause: lastError },
        ),
      );
      return;
    }

    const delay = Math.min(
      RELAY_RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts,
      4_000,
    );
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.enabled || !this.config || this.client) return;
      void this.enqueue(() => this.startCurrent()).catch((restartError) => {
        const normalized =
          restartError instanceof Error
            ? restartError
            : new Error(String(restartError));
        this.onRestartFailed(normalized);
        this.scheduleRestart(normalized);
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthyTimer) clearTimeout(this.healthyTimer);
    this.restartTimer = null;
    this.healthyTimer = null;
  }

  private resetRestartState(): void {
    this.clearRestartTimers();
    this.restartAttempts = 0;
  }
}
