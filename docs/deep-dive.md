# Deep Dive — Agent Manager Internals

This document covers the architecture, data structures, IPC protocol, and concurrency model in detail.

## File layout

```
agent-manager/
  src/
    types.ts      — IPC message types, AgentRecord, AgentSnapshot, Queue item shapes
    AgentTree.ts  — Core orchestrator: Map + Set + Queue + tree traversal
    worker.ts     — Forked child process: executes tasks, streams progress
    cli.ts        — Interactive REPL + live event output
  dist/           — Compiled JS output (after npm run build)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI REPL  (cli.ts)                                             │
│   readline interface + command dispatcher                        │
│   live event output (progress, completed, failed …)             │
└────────────────────┬────────────────────────────────────────────┘
                     │  uses
┌────────────────────▼────────────────────────────────────────────┐
│  AgentTree  (AgentTree.ts)                                       │
│                                                                  │
│  Map<APID, AgentRecord>   ← O(1) record lookup                  │
│  Map<APID, ChildProcess>  ← O(1) process handle lookup          │
│  Set<string> children     ← O(1) per-node child add/remove      │
│  Queue<QueuedTask>        ← O(1) enqueue / dequeue (linked list) │
│  depth field              ← O(1) depth check, no tree climbing  │
│                                                                  │
│  Parallel launch up to concurrencyLimit (default 50).           │
│  Overflow tasks queue; each freed slot auto-drains one task.    │
└────────────────────┬────────────────────────────────────────────┘
                     │  fork() + Node.js IPC
         ┌───────────┼───────────┐
   ┌─────▼───┐ ┌─────▼───┐ ┌────▼────┐
   │ worker  │ │ worker  │ │ worker  │   … up to N
   │ A001    │ │ A002    │ │ A003    │
   └─────────┘ └─────────┘ └─────────┘
```

Communication between the orchestrator and workers is pure Node.js IPC (`process.send` / `proc.on('message')`). No sockets, no polling.

---

## Agent lifecycle

```
spawn() called
    │
    ├─ runningCount < cap ──► _launch()
    │                              │
    │                         fork(worker.js)
    │                              │
    │                         worker sends { type: 'ready' }
    │                              │
    │                         orchestrator sends { type: 'assign', task, apid }
    │                              │
    │                         worker sends { type: 'started' }    ← status: running
    │                              │
    │                         worker sends { type: 'progress' }*  ← logs accumulate
    │                              │
    │                         worker sends { type: 'completed' }  ← status: completed
    │                          or { type: 'failed' }              ← status: failed
    │                              │
    │                         _releaseSlot() → _drain()
    │
    └─ runningCount == cap ──► queue.enqueue()                    ← status: queued
                                    │
                               auto-drained when a slot frees
```

### Status values

| Status | Meaning |
|---|---|
| `queued` | Waiting in the overflow queue |
| `spawning` | Process forked, waiting for `ready` signal |
| `idle` | Worker ready, `assign` message in flight |
| `running` | Actively executing a task |
| `completed` | Task finished successfully |
| `failed` | Task threw an error (or process exited unexpectedly) |
| `killed` | Forcibly terminated |

---

## Data structures

### AgentRecord

The central per-agent state object stored in `Map<string, AgentRecord>`:

```ts
interface AgentRecord {
  apid:        string;           // Virtual Agent Process ID, e.g. "A001"
  nativePid?:  number;           // OS PID (set after fork)
  task:        string;           // Raw task string
  status:      AgentStatus;
  spawnedAt:   number;           // Date.now() at creation
  startedAt?:  number;
  endedAt?:    number;
  durationMs?: number;
  depth:       number;           // Tree depth; root agents = 0
  logs:        LogEntry[];       // Incremental progress lines
  result?:     string;
  error?:      string;
  parentApid?: string;           // Undefined for root agents
  children:    Set<string>;      // APIDs of direct children (O(1) add/has/delete)
}
```

`children` is a `Set<string>` so add/remove/has are all O(1). At export time it is serialised to `string[]` in `AgentSnapshot`.

### APID generation

APIDs are zero-padded counters: `A001`, `A002`, …, `A0999`, `A01000`, etc. The padding width automatically grows beyond 999 and 9999 so lexicographic sort stays meaningful.

### Queue

The overflow queue is an **intrusive linked-list FIFO** (not an array):

```ts
interface QNode<T> { value: T; next: QNode<T> | null; }
```

This gives true O(1) enqueue and dequeue with no array shift cost. `Queue.toArray()` does a non-destructive walk for status display only.

---

## IPC protocol

All messages are plain JSON objects serialised by Node.js IPC.

### Orchestrator → Worker

```ts
type ToWorkerMessage =
  | { type: 'assign'; task: string; apid: string }
  | { type: 'kill' };
```

### Worker → Orchestrator

```ts
type FromWorkerMessage =
  | { type: 'ready' }
  | { type: 'started';   apid: string }
  | { type: 'progress';  apid: string; data: string }
  | { type: 'completed'; apid: string; result: string; durationMs: number }
  | { type: 'failed';    apid: string; error: string;  durationMs: number }
  | { type: 'spawn';     parentApid: string; task: string };   // sub-agent request
```

The `spawn` message is the only inbound message that triggers orchestrator-side side-effects beyond state updates — it calls `AgentTree.spawn()`, wiring the new agent as a child of the caller.

---

## Concurrency model

`runningCount` is the single counter tracking live workers. The invariant is:

```
runningCount ≤ concurrencyLimit  at all times
```

**Spawning:**
- If `runningCount < concurrencyLimit` → call `_launch()` immediately.
- Otherwise → enqueue. The APID is registered and its status set to `queued` before the function returns, so callers always get a valid APID back immediately.

**Draining (`_drain()`):**
Called after every `_releaseSlot()` (completion, failure, or kill). Dequeues one item per free slot in a tight loop:

```ts
while (runningCount < concurrencyLimit && !queue.isEmpty()) {
  const apid = queueApidOrder.shift();
  queue.dequeue();
  _launch(records.get(apid)!);
}
```

**Changing the cap at runtime:**
`set concurrencyLimit(n)` updates `opts.concurrencyLimit` then calls `_drain()`. Raising the cap immediately fills new slots from the queue. Lowering it takes effect as current workers finish (no forcible kills).

---

## Sub-agents (tree growth)

Any running worker can request a child agent:

```ts
process.send({ type: 'spawn', parentApid: apid, task: 'sh: echo sub-task' });
```

The orchestrator handles this in `_handleWorkerMsg` by calling `this.spawn(msg.task, msg.parentApid)`. The new agent's `depth` is set to `parent.depth + 1` at creation time — no tree climbing needed.

From the REPL you can do the same with `sic`:

```
agent> sic A001 fetch: https://example.com
Sic'd A002 on task under parent A001
agent> tree A001
└── [A001] ✅ sh: echo parent
    └── [A002] ✅ fetch: https://example.com
```

**Subtree kill** is a BFS from the target node — children are enqueued before the parent is killed so no pointers are lost.

---

## Performance targets

| Operation | Complexity |
|---|---|
| Insert / lookup by APID | O(1) — `Map<string, AgentRecord>` |
| Get `ChildProcess` by APID | O(1) — `Map<string, ChildProcess>` |
| Add / remove child pointer | O(1) — `Set<string>` per record |
| Enqueue task | O(1) — linked-list FIFO |
| Dequeue task | O(1) — linked-list FIFO |
| BFS / DFS traversal | O(n) |
| Subtree kill | O(subtree size) |
| Render ASCII tree | O(n) |
| Depth check | O(1) — `depth` field, no climbing |

---

## Worker task routing

The worker dispatches on task prefix with a simple regex test:

```
sh: / shell:      → exec()       60s timeout
fetch: / get: / https?: → http(s).get()  10s timeout
script:           → node "<path>"
(anything else)   → runGeneric() — replace with your LLM
```

All task runners stream incremental `progress` messages back to the orchestrator, which appends them to `AgentRecord.logs` and re-emits them as `'progress'` events for the CLI to display.

---

## Events emitted by AgentTree

`AgentTree extends EventEmitter`. The CLI subscribes to all of these:

| Event | Payload | When |
|---|---|---|
| `spawned` | `apid` | Process forked |
| `started` | `apid` | Worker began task execution |
| `progress` | `apid, data` | Incremental log line received |
| `completed` | `apid` | Task finished successfully |
| `failed` | `apid` | Task errored or process crashed |
| `killed` | `apid` | Process forcibly terminated |
| `queued` | `apid` | Task placed in overflow queue |
| `drained` | `apid` | Task dequeued and launched |

`setMaxListeners(0)` is called in the constructor so large agent counts don't trigger Node.js leak warnings.
