/**
 * Bounded stage cache.
 *
 * The pipeline keeps at most one entry per stage (the most recent fingerprint)
 * plus a global cell-count ceiling; that is enough for the interactive
 * "move one slider, recompute downstream" workflow while keeping 1024² memory
 * bounded (see the pipeline for the byte budget rationale).
 */

export class SingleStageCache<T> {
  private key = "";
  private value: T | null = null;

  get(key: string): T | null {
    if (this.value !== null && this.key === key) return this.value;
    return null;
  }

  set(key: string, value: T): void {
    this.key = key;
    this.value = value;
  }

  /** Drop the cached entry (call before allocating a replacement to cap peak memory). */
  clear(): void {
    this.key = "";
    this.value = null;
  }

  get hasValue(): boolean {
    return this.value !== null;
  }
}
