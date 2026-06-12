/**
 * Shared type definitions for the Agent Manager system.
 * Workers and the orchestrator communicate via IPC using these message shapes.
 *
 * Design goals
 * ────────────
 * • O(1) APID → record lookup  (Map<string, AgentRecord>)
 * • O(1) APID → ChildProcess   (Map<string, ChildProcess>)
 * • Parent/child pointers embedded in records so any tree traversal is
 *   a simple pointer-follow, never a linear scan.
 * • Queue-based overflow: tasks pile into a typed FIFO when the running
 *   count hits the concurrency cap; draining is O(1) dequeue per slot freed.
 * • Depth field enables constant-time depth checks without tree climbing.
 */

export type AgentStatus =
  | 'queued'      // Waiting in the overflow queue (concurrency cap hit)
  | 'spawning'    // Process forked, waiting for 'ready' signal
  | 'idle'        // Process ready, task assignment in-flight
  | 'running'     // Actively executing a task
  | 'completed'   // Task finished successfully
  | 'failed'      // Task threw an error
  | 'killed';     // Forcibly terminated

export interface LogEntry {
  /** high-res monotonic timestamp (process.hrtime.bigint, stored as number for JSON compat) */
  ts: number;
  data: string;
}

export interface AgentRecord {
  /** Virtual Agent Process ID, e.g. "A001" */
  apid: string;
  /** OS-level process ID (available once forked) */
  nativePid?: number;
  /** The raw task string */
  task: string;
  status: AgentStatus;
  spawnedAt: number;       // Date.now()
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** Depth in the agent tree (root agents = 0) */
  depth: number;
  logs: LogEntry[];
  result?: string;
  error?: string;
  /** APID of parent agent; undefined for root-level agents */
  parentApid?: string;
  /**
   * APIDs of direct-child agents.
   * Stored as a Set in runtime; serialised as an array for JSON export.
   * Using a Set gives O(1) add/has/delete instead of O(n) array scans.
   */
  children: Set<string>;
}

/** Lightweight serialisable version used in JSON export / status snapshots. */
export interface AgentSnapshot extends Omit<AgentRecord, 'children' | 'logs'> {
  children: string[];
  logCount: number;
}

// ── Queue item ────────────────────────────────────────────────────────────────

export interface QueuedTask {
  task: string;
  /** If set, the spawned agent will be a child of this APID */
  parentApid?: string;
  /** Resolve called with the new APID once the task is dequeued + spawned */
  resolve: (apid: string) => void;
}

// ── Messages: Orchestrator → Worker ─────────────────────────────────────────

export type ToWorkerMessage =
  | { type: 'assign'; task: string; apid: string }
  | { type: 'kill' };

// ── Messages: Worker → Orchestrator ─────────────────────────────────────────

export type FromWorkerMessage =
  | { type: 'ready' }
  | { type: 'started';   apid: string }
  | { type: 'progress';  apid: string; data: string }
  | { type: 'completed'; apid: string; result: string; durationMs: number }
  | { type: 'failed';    apid: string; error: string;  durationMs: number }
  /**
   * A running agent can ask the orchestrator to spawn a sub-agent.
   * The child inherits the caller's apid as parentApid.
   */
  | { type: 'spawn';     parentApid: string; task: string };
