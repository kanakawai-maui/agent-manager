/**
 * System-aware concurrency utilities
 *
 * Queries the OS at runtime to pick a sensible default concurrency cap
 * for forked Node.js worker processes.
 *
 * Heuristic
 * ──────────
 *   workerRssBytes  ≈ 40 MB per Node.js child (conservative baseline)
 *   ramSlots        = floor((freeRam * RAM_HEADROOM) / workerRssBytes)
 *   cpuSlots        = logicalCpus * CPU_MULTIPLIER
 *   default         = clamp(min(ramSlots, cpuSlots), MIN_CAP, MAX_CAP)
 *
 * These constants are intentionally conservative so the default is safe
 * across a wide range of machines without manual tuning.
 */

import * as os from 'os';

// ── Tuneable constants ────────────────────────────────────────────────────────

/** Fraction of total RAM we're willing to allocate to workers (0–1). */
const RAM_HEADROOM = 0.25;

/** Estimated RSS of a single idle Node.js child process (bytes). */
const WORKER_RSS_BYTES = 40 * 1024 * 1024; // 40 MB

/**
 * IO-bound workers (LLM calls, fetch, shell waits) can run many more
 * concurrently than CPU-bound work. This multiplier reflects that.
 */
const CPU_MULTIPLIER = 5;

/** Hard floor — never go below this regardless of RAM. */
const MIN_CAP = 4;

/** Hard ceiling — cap the auto-detected value at a sane upper bound. */
const MAX_CAP = 250;

// ── Public API ────────────────────────────────────────────────────────────────

export interface ConcurrencyProfile {
  /** The recommended concurrency cap. */
  cap: number;
  /** Number of logical CPU cores. */
  cpus: number;
  /** Total system RAM in bytes. */
  totalRam: number;
  /** Slots derived from available RAM. */
  ramSlots: number;
  /** Slots derived from CPU count × multiplier. */
  cpuSlots: number;
}

/**
 * Detect a reasonable default concurrency limit for worker processes
 * based on the machine's CPU count and total RAM.
 */
export function detectConcurrencyLimit(): ConcurrencyProfile {
  const cpus     = os.cpus().length;
  const totalRam = os.totalmem();

  const ramSlots = Math.floor((totalRam * RAM_HEADROOM) / WORKER_RSS_BYTES);
  const cpuSlots = cpus * CPU_MULTIPLIER;

  const raw = Math.min(ramSlots, cpuSlots);
  const cap = Math.max(MIN_CAP, Math.min(MAX_CAP, raw));

  return { cap, cpus, totalRam, ramSlots, cpuSlots };
}

/**
 * Format a ConcurrencyProfile as a human-readable summary line.
 *
 * Example:
 *   "auto-detected: 50  (10 CPUs × 5 = 50 cpu-slots, 34.4 GB RAM → 218 ram-slots)"
 */
export function formatConcurrencyProfile(p: ConcurrencyProfile): string {
  const gb  = (p.totalRam / 1e9).toFixed(1);
  return (
    `auto-detected: ${p.cap}` +
    `  (${p.cpus} CPUs × ${CPU_MULTIPLIER} = ${p.cpuSlots} cpu-slots,` +
    ` ${gb} GB RAM → ${p.ramSlots} ram-slots)`
  );
}
