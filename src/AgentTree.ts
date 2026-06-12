/**
 * AgentTree — core data structure for the Agent Manager.
 *
 * Performance contract
 * ────────────────────
 * Operation                      Complexity
 * ─────────────────────────────  ──────────
 * insert / lookup by APID        O(1)   — Map<string, AgentRecord>
 * get ChildProcess by APID       O(1)   — Map<string, ChildProcess>
 * add / remove child pointer     O(1)   — Set<string> per record
 * enqueue task                   O(1)   — linked-list FIFO (Node<T>)
 * dequeue task                   O(1)   — linked-list FIFO
 * BFS / DFS traversal            O(n)
 * subtree kill                   O(subtree size)
 * render ASCII tree              O(n)
 * garbage collection             O(n)
 *
 * Tree balancing
 * ──────────────
 * When `autoBalance` is enabled (default), the tree maintains balance by:
 * • Limiting children per node to `maxBranchingFactor` (default 8)
 * • BFS search for available capacity in subtree when parent is full
 * • Guarantees O(log_b(N)) depth where b = branching factor
 * • Avoids linked-list degeneracy (each node having only 1 child)
 *
 * Balanced spawn has O(subtree) worst-case complexity but typically
 * short-circuits when a node with capacity is found near the root.
 *
 * Garbage collection
 * ──────────────────
 * Automatic cleanup of inactive nodes (completed, failed, killed):
 * • Configurable retention period (`gcRetentionMs`, default 5 minutes)
 * • Automatic interval-based collection (`gcIntervalMs`, default 1 minute)
 * • Bottom-up collection (children before parents)
 * • Only collects terminal subtrees (no active descendants)
 * • Manual gc() calls supported; disable auto-GC with gcIntervalMs=0
 *
 * Concurrency model
 * ─────────────────
 * • `runningCount` tracks live workers.
 * • When runningCount < concurrencyLimit, queued tasks are drained
 *   immediately (O(1) per dequeue).
 * • Batch-spawn pushes N tasks into the queue then drains up to the cap;
 *   remainder tasks stay queued and auto-drain as slots free up.
 */

import { fork, ChildProcess }   from 'child_process';
import * as path                 from 'path';
import { EventEmitter }          from 'events';
import type {
  AgentRecord,
  AgentSnapshot,
  AgentStatus,
  FromWorkerMessage,
  LogEntry,
  QueuedTask,
  ToWorkerMessage,
} from './types';

// ── Lightweight intrusive FIFO queue (O(1) enq / deq, no array shifts) ──────

interface QNode<T> { value: T; next: QNode<T> | null; }

class Queue<T> {
  private head: QNode<T> | null = null;
  private tail: QNode<T> | null = null;
  size = 0;

  enqueue(value: T): void {
    const node: QNode<T> = { value, next: null };
    if (this.tail) this.tail.next = node; else this.head = node;
    this.tail = node;
    this.size++;
  }

  dequeue(): T | undefined {
    if (!this.head) return undefined;
    const { value, next } = this.head;
    this.head = next;
    if (!this.head) this.tail = null;
    this.size--;
    return value;
  }

  isEmpty(): boolean { return this.head === null; }

  /** Non-destructive iteration for status display. */
  toArray(): T[] {
    const out: T[] = [];
    let cur = this.head;
    while (cur) { out.push(cur.value); cur = cur.next; }
    return out;
  }
}

// ── AgentTree ────────────────────────────────────────────────────────────────

export interface AgentTreeOptions {
  workerPath:       string;  // Absolute path to compiled worker JS
  concurrencyLimit: number;  // Max simultaneous live processes (default 50)
  /**
   * Maximum children per node before creating intermediate balancing nodes.
   * Set to Infinity to disable balancing. Default: 8.
   * A value of 8 keeps tree depth logarithmic: log₈(N) for N total nodes.
   */
  maxBranchingFactor: number;
  /**
   * When true, automatically rebalances on spawn if a parent exceeds
   * maxBranchingFactor. When false, children accumulate without limit.
   * Default: true.
   */
  autoBalance: boolean;
  /**
   * Retention period in milliseconds for inactive nodes (completed, failed, killed).
   * Nodes older than this are eligible for garbage collection.
   * Default: 300000 (5 minutes). Set to Infinity to disable GC.
   */
  gcRetentionMs: number;
  /**
   * Interval in milliseconds for automatic garbage collection.
   * Set to 0 to disable automatic GC (manual gc() calls only).
   * Default: 30000 (30 seconds).
   *
   * Rationale: GC is O(n) where n = total records. A 30-second interval
   * balances memory pressure against CPU overhead. For high-throughput
   * systems (>1000 nodes/sec), consider increasing to 60000 or using
   * manual gc() triggered by node completion events.
   */
  gcIntervalMs: number;
}

export type AgentTreeEvent =
  | 'spawned'   // (apid) process forked
  | 'started'   // (apid) task execution began
  | 'progress'  // (apid, data) incremental log line
  | 'completed' // (apid) finished successfully
  | 'failed'    // (apid) finished with error
  | 'killed'    // (apid) process killed
  | 'queued'    // (apid) task was queued (cap hit)
  | 'drained'   // (apid) task dequeued and spawned
  | 'gc';       // (apids[]) garbage collected nodes

export class AgentTree extends EventEmitter {
  // ── Core index: APID → record (O(1) lookup) ─────────────────────────────
  private readonly records  = new Map<string, AgentRecord>();
  // ── APID → live ChildProcess (O(1) lookup) ──────────────────────────────
  private readonly procs    = new Map<string, ChildProcess>();
  // ── Overflow queue ───────────────────────────────────────────────────────
  private readonly queue    = new Queue<QueuedTask>();

  private readonly opts:    AgentTreeOptions;
  private counter           = 0;
  private runningCount      = 0;
  private gcTimer:          ReturnType<typeof setInterval> | null = null;

  constructor(opts: Partial<AgentTreeOptions> = {}) {
    super();
    this.opts = {
      workerPath:         opts.workerPath ?? path.resolve(__dirname, 'worker.js'),
      concurrencyLimit:   opts.concurrencyLimit ?? 50,
      maxBranchingFactor: opts.maxBranchingFactor ?? 8,
      autoBalance:        opts.autoBalance ?? true,
      gcRetentionMs:      opts.gcRetentionMs ?? 5 * 60 * 1000,  // 5 minutes
      gcIntervalMs:       opts.gcIntervalMs ?? 30 * 1000,       // 30 seconds
    };
    // Allow hundreds of concurrent event-listeners without Node.js warnings.
    this.setMaxListeners(0);

    // Start automatic GC if interval is configured
    this._startGcTimer();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get concurrencyLimit() { return this.opts.concurrencyLimit; }
  set concurrencyLimit(v: number) { this.opts.concurrencyLimit = v; this._drain(); }

  get maxBranchingFactor() { return this.opts.maxBranchingFactor; }
  set maxBranchingFactor(v: number) { this.opts.maxBranchingFactor = v; }

  get autoBalance() { return this.opts.autoBalance; }
  set autoBalance(v: boolean) { this.opts.autoBalance = v; }

  get gcRetentionMs() { return this.opts.gcRetentionMs; }
  set gcRetentionMs(v: number) { this.opts.gcRetentionMs = v; }

  get gcIntervalMs() { return this.opts.gcIntervalMs; }
  set gcIntervalMs(v: number) {
    this.opts.gcIntervalMs = v;
    this._startGcTimer(); // Restart timer with new interval
  }

  get totalCount()   { return this.records.size; }
  get activeCount()  { return this.runningCount; }
  get queuedCount()  { return this.queue.size; }

  /** Spawn a single agent. Returns the new APID immediately. */
  spawn(task: string, parentApid?: string): string {
    // Determine the effective parent after balancing
    const effectiveParent = this.opts.autoBalance && parentApid
      ? this._findBalancedParent(parentApid)
      : parentApid;

    const apid = this._nextApid();
    const depth = effectiveParent ? (this._get(effectiveParent)?.depth ?? 0) + 1 : 0;

    const record: AgentRecord = {
      apid, task, depth,
      status: 'queued',
      spawnedAt: Date.now(),
      parentApid: effectiveParent,
      children: new Set(),
      logs: [],
    };
    this.records.set(apid, record);

    // Wire parent ↔ child pointer (O(1) Set.add)
    if (effectiveParent) {
      const parent = this._get(effectiveParent);
      if (parent) parent.children.add(apid);
    }

    if (this.runningCount < this.opts.concurrencyLimit) {
      this._launch(record);
    } else {
      this.emit('queued', apid);
      this.queue.enqueue({
        task,
        parentApid,
        resolve: () => {},   // APID already assigned; resolve is a no-op here
      });
      // Keep a mapping so drain knows which queued item → which apid
      record.status = 'queued';
      this._queueApidOrder.push(apid);
    }

    return apid;
  }

  /**
   * Batch-spawn N tasks in parallel (up to the concurrency cap).
   * Returns all APIDs immediately; queued ones will auto-drain.
   *
   * @param tasks   Array of task strings
   * @param parent  Optional parent APID for all tasks (fan-out from one agent)
   */
  spawnBatch(tasks: string[], parentApid?: string): string[] {
    return tasks.map(task => this.spawn(task, parentApid));
  }

  /** Kill one agent and all its descendants (subtree kill, BFS). */
  killSubtree(apid: string): string[] {
    const killed: string[] = [];
    const bfsQueue: string[] = [apid];
    while (bfsQueue.length) {
      const id = bfsQueue.shift()!;
      const rec = this._get(id);
      if (!rec) continue;
      // Push children before killing so we capture the pointer before it's gone
      for (const childId of rec.children) bfsQueue.push(childId);
      this._killOne(id);
      killed.push(id);
    }
    return killed;
  }

  /** Kill every live process and clear the queue. */
  killAll(): void {
    for (const apid of this.procs.keys()) this._killOne(apid);
    this.queue['head'] = null;
    this.queue['tail'] = null;
    (this.queue as any).size = 0;
    this._queueApidOrder.length = 0;
  }

  /**
   * Garbage collect inactive nodes (completed, failed, killed) older than
   * gcRetentionMs. Returns array of collected APIDs.
   *
   * Strategy:
   * • Only collects terminal nodes (no active descendants)
   * • Processes in order: leaves first, then parents (bottom-up)
   * • Safely unlinks from parent's children Set
   * • Emits 'gc' event with collected APIDs
   *
   * Complexity: O(n) where n = total records
   */
  gc(): string[] {
    const now = Date.now();
    const retention = this.opts.gcRetentionMs;
    if (retention === Infinity) return [];

    const collected: string[] = [];
    const inactiveStatuses: Set<AgentStatus> = new Set(['completed', 'failed', 'killed']);

    // Build list of candidates (inactive with endedAt older than retention)
    const candidates: AgentRecord[] = [];
    for (const rec of this.records.values()) {
      if (
        inactiveStatuses.has(rec.status) &&
        rec.endedAt &&
        now - rec.endedAt >= retention
      ) {
        candidates.push(rec);
      }
    }

    // Sort by depth descending (deepest first) for bottom-up cleanup
    // This ensures we clean children before parents
    candidates.sort((a, b) => b.depth - a.depth);

    for (const rec of candidates) {
      // Skip if node has active children (can't collect parents before children)
      const hasActiveChildren = Array.from(rec.children).some(childId => {
        const child = this.records.get(childId);
        return child && !inactiveStatuses.has(child.status);
      });
      if (hasActiveChildren) continue;

      // Collect any eligible children first (they should already be processed due to sort)
      // This handles edge case where children became eligible in the same GC cycle
      for (const childId of rec.children) {
        if (this.records.has(childId)) {
          // Child wasn't collected yet — skip this parent for now
          continue;
        }
      }

      // Safe to collect this node
      this._collectNode(rec.apid);
      collected.push(rec.apid);
    }

    if (collected.length > 0) {
      this.emit('gc', collected);
    }

    return collected;
  }

  /**
   * Stop automatic GC and clean up resources.
   * Call this when disposing of the AgentTree instance.
   */
  dispose(): void {
    this._stopGcTimer();
    this.killAll();
  }

  /** Return count of nodes eligible for GC (for diagnostics). */
  gcEligibleCount(): number {
    const now = Date.now();
    const retention = this.opts.gcRetentionMs;
    if (retention === Infinity) return 0;

    const inactiveStatuses: Set<AgentStatus> = new Set(['completed', 'failed', 'killed']);
    let count = 0;

    for (const rec of this.records.values()) {
      if (
        inactiveStatuses.has(rec.status) &&
        rec.endedAt &&
        now - rec.endedAt >= retention
      ) {
        // Check if all children are also inactive
        const hasActiveChildren = Array.from(rec.children).some(childId => {
          const child = this.records.get(childId);
          return child && !inactiveStatuses.has(child.status);
        });
        if (!hasActiveChildren) count++;
      }
    }

    return count;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  get(apid: string): AgentRecord | undefined { return this.records.get(apid); }

  getAll(): AgentRecord[] { return Array.from(this.records.values()); }

  getRoots(): AgentRecord[] {
    return this.getAll().filter(r => !r.parentApid);
  }

  getByStatus(status: AgentStatus): AgentRecord[] {
    return this.getAll().filter(r => r.status === status);
  }

  /** DFS collect all descendants (returns APIDs). O(subtree size). */
  subtreeApids(apid: string): string[] {
    const out: string[] = [];
    const stack: string[] = [apid];
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      const rec = this._get(id);
      if (rec) for (const c of rec.children) stack.push(c);
    }
    return out;
  }

  /**
   * Render an ASCII tree rooted at `apid` (or all roots if omitted).
   * Uses an iterative DFS with a prefix stack — no recursion overhead.
   */
  renderTree(rootApid?: string): string {
    const lines: string[] = [];

    const renderNode = (apid: string, prefix: string, isLast: boolean) => {
      const rec = this.records.get(apid);
      if (!rec) return;
      const connector = isLast ? '└── ' : '├── ';
      const statusIcon = STATUS_ICON[rec.status] ?? '?';
      lines.push(`${prefix}${connector}[${rec.apid}] ${statusIcon} ${rec.task.slice(0, 60)}`);
      const childArray = Array.from(rec.children);
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      childArray.forEach((childId, i) =>
        renderNode(childId, childPrefix, i === childArray.length - 1)
      );
    };

    if (rootApid) {
      renderNode(rootApid, '', true);
    } else {
      const roots = this.getRoots();
      roots.forEach((r, i) => renderNode(r.apid, '', i === roots.length - 1));
    }
    return lines.join('\n') || '(no agents)';
  }

  /** Return a summary stats object. */
  stats(): Record<AgentStatus | 'total' | 'queued_overflow', number> {
    const counts: Record<string, number> = { total: this.records.size, queued_overflow: this.queue.size };
    for (const rec of this.records.values()) {
      counts[rec.status] = (counts[rec.status] ?? 0) + 1;
    }
    return counts as any;
  }

  /**
   * Return tree balance diagnostics.
   * Helps identify degenerate structures (linked-lists, unbalanced fan-outs).
   */
  balanceStats(): {
    totalNodes: number;
    maxDepth: number;
    avgBranchingFactor: number;
    maxBranchingFactor: number;
    leafCount: number;
    isLinkedList: boolean;
    isBalanced: boolean;
  } {
    if (this.records.size === 0) {
      return {
        totalNodes: 0,
        maxDepth: 0,
        avgBranchingFactor: 0,
        maxBranchingFactor: 0,
        leafCount: 0,
        isLinkedList: false,
        isBalanced: true,
      };
    }

    let maxDepth = 0;
    let maxBranching = 0;
    let totalChildren = 0;
    let nodesWithChildren = 0;
    let leafCount = 0;

    for (const rec of this.records.values()) {
      maxDepth = Math.max(maxDepth, rec.depth);
      const childCount = rec.children.size;
      maxBranching = Math.max(maxBranching, childCount);

      if (childCount > 0) {
        totalChildren += childCount;
        nodesWithChildren++;
      } else {
        leafCount++;
      }
    }

    const avgBranching = nodesWithChildren > 0 ? totalChildren / nodesWithChildren : 0;

    // A linked-list is when max depth equals total nodes minus 1 and each node has at most 1 child
    const isLinkedList = this.records.size > 2 &&
      maxDepth >= this.records.size - 1 &&
      maxBranching <= 1;

    // Tree is balanced if:
    // 1. Not a linked-list
    // 2. Max branching doesn't exceed our configured limit
    // 3. Depth is within expected range: log_b(N) where b = configured branching factor
    const expectedMaxDepth = this.records.size > 1
      ? Math.ceil(Math.log(this.records.size) / Math.log(this.opts.maxBranchingFactor))
      : 0;
    const isBalanced = !isLinkedList &&
      maxBranching <= this.opts.maxBranchingFactor &&
      maxDepth <= expectedMaxDepth + 1; // Allow 1 level of slack

    return {
      totalNodes: this.records.size,
      maxDepth,
      avgBranchingFactor: Math.round(avgBranching * 100) / 100,
      maxBranchingFactor: maxBranching,
      leafCount,
      isLinkedList,
      isBalanced,
    };
  }

  /** Serialisable snapshot of one record. */
  snapshot(apid: string): AgentSnapshot | undefined {
    const rec = this.records.get(apid);
    if (!rec) return undefined;
    const { children, logs, ...rest } = rec;
    return { ...rest, children: Array.from(children), logCount: logs.length };
  }

  /** Export all snapshots as a JSON string. */
  exportJSON(): string {
    const snaps = Array.from(this.records.keys()).map(id => this.snapshot(id)!);
    return JSON.stringify(snaps, null, 2);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * APID counter → zero-padded string, e.g. "A001".
   * Switches to wider padding automatically beyond 999.
   */
  private _nextApid(): string {
    this.counter++;
    const digits = this.counter > 9999 ? 6 : this.counter > 999 ? 5 : 4;
    return 'A' + String(this.counter).padStart(digits - 1, '0');
  }

  private _get(apid: string): AgentRecord | undefined {
    return this.records.get(apid);
  }

  /** Start or restart the automatic GC timer. */
  private _startGcTimer(): void {
    this._stopGcTimer();
    if (this.opts.gcIntervalMs > 0) {
      this.gcTimer = setInterval(() => this.gc(), this.opts.gcIntervalMs);
      // Prevent the timer from keeping the process alive
      if (this.gcTimer.unref) this.gcTimer.unref();
    }
  }

  /** Stop the automatic GC timer. */
  private _stopGcTimer(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /**
   * Remove a single node from the tree.
   * Unlinks from parent's children Set but preserves parent record.
   */
  private _collectNode(apid: string): void {
    const rec = this.records.get(apid);
    if (!rec) return;

    // Unlink from parent
    if (rec.parentApid) {
      const parent = this.records.get(rec.parentApid);
      if (parent) {
        parent.children.delete(apid);
      }
    }

    // Clean up any remaining process handle (shouldn't exist for inactive nodes)
    this.procs.delete(apid);

    // Remove the record
    this.records.delete(apid);
  }

  /**
   * Find the best parent for a new node to maintain tree balance.
   *
   * Strategy:
   * 1. If the intended parent has room (< maxBranchingFactor), use it directly.
   * 2. Otherwise, BFS through the subtree to find a node with capacity.
   * 3. If all nodes are at capacity, pick the shallowest node with the fewest
   *    children (spreads load evenly, avoids linked-list degeneracy).
   *
   * This ensures:
   * - No node exceeds the branching factor (unless all descendants are full)
   * - Tree depth grows logarithmically: O(log_b(N)) where b = branching factor
   * - Avoids degenerate linked-list structures
   *
   * Complexity: O(subtree size) in worst case, but typically short-circuits
   * when a node with capacity is found near the root.
   */
  private _findBalancedParent(intendedParent: string): string {
    const maxChildren = this.opts.maxBranchingFactor;
    if (maxChildren === Infinity) return intendedParent;

    const parent = this._get(intendedParent);
    if (!parent) return intendedParent;

    // Fast path: parent has capacity
    if (parent.children.size < maxChildren) {
      return intendedParent;
    }

    // BFS to find a node with capacity, preferring shallow nodes
    const bfsQueue: string[] = [...parent.children];
    let bestCandidate: { apid: string; depth: number; childCount: number } | null = null;

    while (bfsQueue.length > 0) {
      const candidateId = bfsQueue.shift()!;
      const candidate = this._get(candidateId);
      if (!candidate) continue;

      const childCount = candidate.children.size;

      // Found a node with capacity — use it
      if (childCount < maxChildren) {
        return candidateId;
      }

      // Track the best fallback (shallowest, then fewest children)
      if (
        !bestCandidate ||
        candidate.depth < bestCandidate.depth ||
        (candidate.depth === bestCandidate.depth && childCount < bestCandidate.childCount)
      ) {
        bestCandidate = { apid: candidateId, depth: candidate.depth, childCount };
      }

      // Enqueue children for further search
      for (const childId of candidate.children) {
        bfsQueue.push(childId);
      }
    }

    // All nodes at capacity — return the best candidate (shallowest with fewest children)
    // This allows the tree to grow wider at the optimal level
    return bestCandidate?.apid ?? intendedParent;
  }

  /** Fork a worker, wire up IPC, send 'assign'. */
  private _launch(record: AgentRecord): void {
    record.status = 'spawning';
    this.runningCount++;

    const proc = fork(this.opts.workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    this.procs.set(record.apid, proc);
    if (proc.pid) record.nativePid = proc.pid;

    proc.on('message', (raw: unknown) => {
      this._handleWorkerMsg(record.apid, raw as FromWorkerMessage);
    });

    proc.on('exit', (code) => {
      // Guard against double-processing (killed branch handles its own cleanup)
      if (record.status === 'running' || record.status === 'spawning' || record.status === 'idle') {
        record.status   = 'failed';
        record.endedAt  = Date.now();
        record.error    = `Process exited unexpectedly (code ${code})`;
        this._releaseSlot(record.apid);
        this.emit('failed', record.apid);
      }
    });

    // Send task once the worker signals 'ready' (handled in _handleWorkerMsg).
    this.emit('spawned', record.apid);
  }

  private _handleWorkerMsg(apid: string, msg: FromWorkerMessage): void {
    const rec = this._get(apid);
    if (!rec) return;

    switch (msg.type) {
      case 'ready': {
        rec.status = 'idle';
        const assign: ToWorkerMessage = { type: 'assign', task: rec.task, apid };
        this.procs.get(apid)?.send(assign);
        break;
      }
      case 'started': {
        rec.status    = 'running';
        rec.startedAt = Date.now();
        this.emit('started', apid);
        break;
      }
      case 'progress': {
        const entry: LogEntry = { ts: Date.now(), data: msg.data };
        rec.logs.push(entry);
        this.emit('progress', apid, msg.data);
        break;
      }
      case 'completed': {
        rec.status     = 'completed';
        rec.endedAt    = Date.now();
        rec.result     = msg.result;
        rec.durationMs = msg.durationMs;
        this._releaseSlot(apid);
        this.emit('completed', apid);
        break;
      }
      case 'failed': {
        rec.status     = 'failed';
        rec.endedAt    = Date.now();
        rec.error      = msg.error;
        rec.durationMs = msg.durationMs;
        this._releaseSlot(apid);
        this.emit('failed', apid);
        break;
      }
      case 'spawn': {
        // A worker is requesting a sub-agent — honour it.
        this.spawn(msg.task, msg.parentApid);
        break;
      }
    }
  }

  private _killOne(apid: string): void {
    const proc = this.procs.get(apid);
    const rec  = this._get(apid);
    if (proc) {
      try { proc.send({ type: 'kill' } satisfies ToWorkerMessage); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      this.procs.delete(apid);
    }
    if (rec && rec.status !== 'killed') {
      const wasRunning = rec.status === 'running' || rec.status === 'spawning' || rec.status === 'idle';
      rec.status  = 'killed';
      rec.endedAt = Date.now();
      if (wasRunning) this._releaseSlot(apid);
    }
    this.emit('killed', apid);
  }

  /** Free a concurrency slot and drain one queued task if available. */
  private _releaseSlot(apid: string): void {
    this.procs.delete(apid);
    this.runningCount = Math.max(0, this.runningCount - 1);
    this._drain();
  }

  /** Drain the overflow queue up to the concurrency cap. */
  private _drain(): void {
    while (this.runningCount < this.opts.concurrencyLimit && !this.queue.isEmpty()) {
      const nextApid = this._queueApidOrder.shift();
      this.queue.dequeue(); // discard the QueuedTask shell (APID is already registered)
      if (!nextApid) continue;
      const rec = this._get(nextApid);
      if (!rec || rec.status !== 'queued') continue;
      this._launch(rec);
      this.emit('drained', nextApid);
    }
  }

  /**
   * Secondary FIFO that maps queue position → pre-assigned APID.
   * This lets us assign the APID *before* launch (so callers get it
   * immediately from spawn()) while still draining in insertion order.
   */
  private readonly _queueApidOrder: string[] = [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<AgentStatus, string> = {
  queued:    '⏳',
  spawning:  '🔄',
  idle:      '💤',
  running:   '🏃',
  completed: '✅',
  failed:    '❌',
  killed:    '🔪',
};
