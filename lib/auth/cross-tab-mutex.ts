/**
 * Cross-tab mutex using localStorage.
 *
 * Ensures only one tab can hold a lock at a time.
 * Uses localStorage for synchronization across tabs.
 */

type LockData = {
  tabId: string;
  timestamp: number;
};

export type CrossTabMutexOptions = {
  lockKey?: string;
  lockTimeoutMs?: number;
  onLog?: (message: string) => void;
};

const DEFAULT_LOCK_KEY = "cross-tab-mutex";
const DEFAULT_LOCK_TIMEOUT_MS = 10000;

export class CrossTabMutex {
  readonly tabId: string;
  private readonly lockKey: string;
  private readonly lockTimeoutMs: number;
  private readonly log: (message: string) => void;

  constructor(options: CrossTabMutexOptions = {}) {
    this.tabId =
      typeof crypto !== "undefined"
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);

    this.lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.log = options.onLog ?? (() => {});
  }

  /**
   * Try to acquire the lock. Returns true if acquired, false if held by another tab.
   */
  tryAcquire(): boolean {
    if (typeof localStorage === "undefined") {
      return true;
    }

    const now = Date.now();

    try {
      const existing = localStorage.getItem(this.lockKey);

      if (existing) {
        const lock: LockData = JSON.parse(existing);
        const age = now - lock.timestamp;

        if (age < this.lockTimeoutMs) {
          if (lock.tabId === this.tabId) {
            this.log("We already hold the lock");
            return true;
          }
          // this.log(`Lock held by ${lock.tabId.slice(0, 8)} (${age}ms old)`);
          return false;
        }
        this.log(`Stale lock from ${lock.tabId.slice(0, 8)}, taking over`);
      }

      const lockData: LockData = { tabId: this.tabId, timestamp: now };
      localStorage.setItem(this.lockKey, JSON.stringify(lockData));

      // Verify we got it
      const verify = localStorage.getItem(this.lockKey);
      if (verify) {
        const verifyLock: LockData = JSON.parse(verify);
        if (verifyLock.tabId === this.tabId) {
          this.log("Lock acquired");
          return true;
        }
        this.log(`Lost race to ${verifyLock.tabId.slice(0, 8)}`);
        return false;
      }

      return false;
    } catch (e) {
      this.log(`localStorage error: ${e}`);
      return true;
    }
  }

  /**
   * Release the lock if we hold it.
   */
  release(): void {
    if (typeof localStorage === "undefined") {
      return;
    }

    try {
      const existing = localStorage.getItem(this.lockKey);
      if (existing) {
        const lock: LockData = JSON.parse(existing);
        if (lock.tabId === this.tabId) {
          localStorage.removeItem(this.lockKey);
          this.log("Lock released");
        }
      }
    } catch {
      // Ignore
    }
  }

  /**
   * Wait to acquire the lock, retrying until acquired or timeout.
   * Returns true if acquired, false if timed out.
   */
  async acquireWithWait(
    timeoutMs: number = 15000,
    retryIntervalMs: number = 50,
  ): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.tryAcquire()) {
        return true;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, retryIntervalMs + (Math.random() - 0.5) * 10),
      );
    }

    this.log("Timeout waiting for lock");
    return false;
  }

  /**
   * Execute a function while holding the lock.
   * Waits for lock acquisition with timeout, then executes.
   * Returns null if lock acquisition timed out.
   */
  async withLock<T>(
    fn: () => Promise<T>,
    timeoutMs: number = 15000,
  ): Promise<T | null> {
    const acquired = await this.acquireWithWait(timeoutMs);
    if (!acquired) {
      return null;
    }

    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Force clear the lock (use for testing/debugging).
   */
  forceClear(): void {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.removeItem(this.lockKey);
    this.log("Lock force cleared");
  }
}
