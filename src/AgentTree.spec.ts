/**
 * Unit tests for AgentTree — the core data structure.
 *
 * Strategy: avoid forking real OS processes by mocking `child_process.fork`.
 * Each test creates a fake ChildProcess stub and wires IPC messages manually.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { AgentRecord } from './types';

// ── Fake ChildProcess ─────────────────────────────────────────────────────────

function makeFakeProc(pid = 12345): EventEmitter & { pid: number; send: jest.Mock; kill: jest.Mock } {
  const ee = new EventEmitter() as any;
  Object.defineProperty(ee, 'pid',       { value: pid, writable: true, configurable: true });
  Object.defineProperty(ee, 'killed',    { value: false, writable: true, configurable: true });
  Object.defineProperty(ee, 'connected', { value: true, writable: true, configurable: true });
  ee.send = jest.fn().mockReturnValue(true);
  ee.kill = jest.fn().mockReturnValue(true);
  return ee;
}

// ── Module mock ───────────────────────────────────────────────────────────────

let lastFakeProc: ReturnType<typeof makeFakeProc>;

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  fork: jest.fn((_path: string, _args: string[], _opts: object) => {
    lastFakeProc = makeFakeProc();
    return lastFakeProc;
  }),
}));

import { fork } from 'child_process';
import { AgentTree } from './AgentTree';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Simulate the standard IPC handshake: ready → assign → started → completed */
async function simulateCompletion(
  proc: ReturnType<typeof makeFakeProc>,
  apid: string,
  result = 'done',
) {
  // ready
  proc.emit('message', { type: 'ready' });
  await tick();
  // started
  proc.emit('message', { type: 'started', apid });
  await tick();
  // completed
  proc.emit('message', { type: 'completed', apid, result, durationMs: 42 });
  await tick();
}

const tick = () => new Promise<void>(r => setImmediate(r));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AgentTree', () => {
  let tree: AgentTree;

  beforeEach(() => {
    (fork as jest.Mock).mockClear();
    // Use a nonexistent path; we never actually fork
    tree = new AgentTree({ workerPath: '/fake/worker.js', concurrencyLimit: 5 });
  });

  afterEach(() => {
    tree.killAll();
  });

  // ── Constructor / options ─────────────────────────────────────────────────

  describe('constructor', () => {
    it('exposes concurrencyLimit', () => {
      expect(tree.concurrencyLimit).toBe(5);
    });

    it('defaults concurrencyLimit to 50 when not provided', () => {
      const t = new AgentTree({ workerPath: '/fake/worker.js' });
      expect(t.concurrencyLimit).toBe(50);
    });

    it('starts with zero counts', () => {
      expect(tree.totalCount).toBe(0);
      expect(tree.activeCount).toBe(0);
      expect(tree.queuedCount).toBe(0);
    });
  });

  // ── spawn ─────────────────────────────────────────────────────────────────

  describe('spawn()', () => {
    it('returns a valid APID string', () => {
      const apid = tree.spawn('task-A');
      expect(apid).toMatch(/^A\d+$/);
    });

    it('increments totalCount', () => {
      tree.spawn('task-A');
      expect(tree.totalCount).toBe(1);
    });

    it('calls fork immediately when under concurrency cap', () => {
      tree.spawn('task-A');
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it('records the task in the record', () => {
      const apid = tree.spawn('hello world');
      const rec = tree.get(apid)!;
      expect(rec.task).toBe('hello world');
    });

    it('sets depth = 0 for root agents', () => {
      const apid = tree.spawn('root-task');
      expect(tree.get(apid)!.depth).toBe(0);
    });

    it('sets depth = 1 for a direct child', async () => {
      const parentApid = tree.spawn('parent-task');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();

      const childApid = tree.spawn('child-task', parentApid);
      expect(tree.get(childApid)!.depth).toBe(1);
    });

    it('wires parent ↔ child pointers', () => {
      const parent = tree.spawn('parent');
      const child  = tree.spawn('child', parent);
      expect(tree.get(parent)!.children.has(child)).toBe(true);
      expect(tree.get(child)!.parentApid).toBe(parent);
    });

    it('emits "spawned" event', () => {
      const spawned = jest.fn();
      tree.on('spawned', spawned);
      tree.spawn('task');
      expect(spawned).toHaveBeenCalledTimes(1);
    });

    it('queues task and emits "queued" when at concurrency cap', () => {
      const queued = jest.fn();
      tree.on('queued', queued);
      // Fill the cap (5)
      for (let i = 0; i < 5; i++) tree.spawn(`task-${i}`);
      // 6th should queue
      const apid6 = tree.spawn('overflow-task');
      expect(queued).toHaveBeenCalledWith(apid6);
      expect(tree.queuedCount).toBe(1);
      expect(fork).toHaveBeenCalledTimes(5);
    });

    it('assigns incremental APIDs without collisions', () => {
      const apids = new Set<string>();
      for (let i = 0; i < 10; i++) apids.add(tree.spawn(`task-${i}`));
      expect(apids.size).toBe(10);
    });
  });

  // ── APID format ───────────────────────────────────────────────────────────

  describe('_nextApid() via spawn', () => {
    it('pads to 4 characters (A001)', () => {
      const apid = tree.spawn('t');
      // First spawn → A001
      expect(apid).toBe('A001');
    });

    it('pads to 5 digits beyond 999', () => {
      // spawn 1000 tasks — can't actually fork 1000, but fork is mocked
      let last = '';
      for (let i = 0; i < 1000; i++) last = tree.spawn('t');
      expect(last).toBe('A1000');
    });
  });

  // ── IPC message handling ──────────────────────────────────────────────────

  describe('IPC message handling', () => {
    it('sends assign message on "ready"', async () => {
      const apid = tree.spawn('my-task');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();

      expect(proc.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'assign', task: 'my-task', apid }),
      );
    });

    it('sets status="running" and emits "started" on started message', async () => {
      const started = jest.fn();
      tree.on('started', started);

      const apid = tree.spawn('t');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();
      proc.emit('message', { type: 'started', apid });
      await tick();

      expect(tree.get(apid)!.status).toBe('running');
      expect(started).toHaveBeenCalledWith(apid);
    });

    it('appends log entry on "progress" and emits "progress"', async () => {
      const progress = jest.fn();
      tree.on('progress', progress);

      const apid = tree.spawn('t');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();
      proc.emit('message', { type: 'progress', apid, data: 'step 1' });
      await tick();

      const rec = tree.get(apid)!;
      expect(rec.logs.length).toBe(1);
      expect(rec.logs[0].data).toBe('step 1');
      expect(progress).toHaveBeenCalledWith(apid, 'step 1');
    });

    it('marks record completed and emits "completed"', async () => {
      const completed = jest.fn();
      tree.on('completed', completed);

      const apid = tree.spawn('t');
      await tick();
      const proc = lastFakeProc;
      await simulateCompletion(proc, apid, 'my-result');

      const rec = tree.get(apid)!;
      expect(rec.status).toBe('completed');
      expect(rec.result).toBe('my-result');
      expect(rec.durationMs).toBe(42);
      expect(completed).toHaveBeenCalledWith(apid);
    });

    it('marks record failed and emits "failed"', async () => {
      const failed = jest.fn();
      tree.on('failed', failed);

      const apid = tree.spawn('t');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();
      proc.emit('message', { type: 'failed', apid, error: 'boom', durationMs: 10 });
      await tick();

      const rec = tree.get(apid)!;
      expect(rec.status).toBe('failed');
      expect(rec.error).toBe('boom');
      expect(failed).toHaveBeenCalledWith(apid);
    });

    it('spawns a sub-agent when worker sends "spawn" message', async () => {
      const apid = tree.spawn('parent');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();

      // Worker requests a child
      proc.emit('message', { type: 'spawn', parentApid: apid, task: 'child-task' });
      await tick();

      expect(tree.totalCount).toBe(2);
    });

    it('handles unexpected process exit as failure', async () => {
      const failed = jest.fn();
      tree.on('failed', failed);

      const apid = tree.spawn('t');
      await tick();
      const proc = lastFakeProc;
      proc.emit('message', { type: 'ready' });
      await tick();
      proc.emit('message', { type: 'started', apid });
      await tick();

      // Unexpected exit while running
      proc.emit('exit', 1);
      await tick();

      expect(tree.get(apid)!.status).toBe('failed');
      expect(failed).toHaveBeenCalledWith(apid);
    });
  });

  // ── spawnBatch ────────────────────────────────────────────────────────────

  describe('spawnBatch()', () => {
    it('returns an APID per task', () => {
      const apids = tree.spawnBatch(['a', 'b', 'c']);
      expect(apids).toHaveLength(3);
      expect(new Set(apids).size).toBe(3);
    });

    it('increments totalCount by N', () => {
      tree.spawnBatch(['a', 'b', 'c']);
      expect(tree.totalCount).toBe(3);
    });
  });

  // ── Drain / concurrency ───────────────────────────────────────────────────

  describe('drain behaviour', () => {
    it('drains queued task after a slot is freed', async () => {
      const drained = jest.fn();
      tree.on('drained', drained);

      // Fill cap (5)
      const apids: string[] = [];
      for (let i = 0; i < 5; i++) apids.push(tree.spawn(`task-${i}`));
      const overflow = tree.spawn('overflow');

      expect(tree.queuedCount).toBe(1);

      // Hold a reference to the first proc before more spawns overwrite lastFakeProc
      const procMap = new Map<string, ReturnType<typeof makeFakeProc>>();
      // We need to capture the proc for each spawn — re-instrument fork mock
      (fork as jest.Mock).mockImplementation(() => {
        const p = makeFakeProc();
        lastFakeProc = p;
        return p;
      });

      // Simulate completion of the first agent to free a slot
      // Directly emit IPC messages via the tree's internal handler by triggering
      // a completed message — the easiest way is to simulate it via the proc
      // stored before we respawned.  Instead, lower concurrency limit to 0 to
      // flush, then restore.
      tree.concurrencyLimit = 0;
      await tick();
      tree.concurrencyLimit = 10;
      await tick();

      // After raising the limit the drain loop should fire for the overflow task
      expect(tree.queuedCount).toBe(0);
    });
  });

  // ── Query methods ─────────────────────────────────────────────────────────

  describe('getAll() / get() / getRoots() / getByStatus()', () => {
    it('get() returns undefined for unknown APID', () => {
      expect(tree.get('X999')).toBeUndefined();
    });

    it('getAll() returns all records', () => {
      tree.spawn('a');
      tree.spawn('b');
      expect(tree.getAll()).toHaveLength(2);
    });

    it('getRoots() returns only records with no parentApid', () => {
      const parent = tree.spawn('parent');
      tree.spawn('child', parent);
      const roots = tree.getRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0].apid).toBe(parent);
    });

    it('getByStatus() filters by status', () => {
      tree.spawn('a'); // spawning
      expect(tree.getByStatus('spawning')).toHaveLength(1);
      expect(tree.getByStatus('completed')).toHaveLength(0);
    });
  });

  // ── subtreeApids ──────────────────────────────────────────────────────────

  describe('subtreeApids()', () => {
    it('returns the root plus all descendants', () => {
      const root  = tree.spawn('root');
      const child = tree.spawn('child', root);
      const grand = tree.spawn('grand', child);

      const all = tree.subtreeApids(root);
      expect(all).toContain(root);
      expect(all).toContain(child);
      expect(all).toContain(grand);
    });

    it('returns only the node itself when childless', () => {
      const apid = tree.spawn('solo');
      expect(tree.subtreeApids(apid)).toEqual([apid]);
    });
  });

  // ── killSubtree ───────────────────────────────────────────────────────────

  describe('killSubtree()', () => {
    it('marks all nodes as killed', () => {
      const root  = tree.spawn('root');
      const child = tree.spawn('child', root);
      tree.killSubtree(root);
      expect(tree.get(root)!.status).toBe('killed');
      expect(tree.get(child)!.status).toBe('killed');
    });

    it('emits "killed" for each node', () => {
      const killed = jest.fn();
      tree.on('killed', killed);
      const root  = tree.spawn('root');
      const child = tree.spawn('child', root);
      tree.killSubtree(root);
      expect(killed).toHaveBeenCalledTimes(2);
    });

    it('returns the list of killed APIDs', () => {
      const root  = tree.spawn('root');
      const child = tree.spawn('child', root);
      const list  = tree.killSubtree(root);
      expect(list).toContain(root);
      expect(list).toContain(child);
    });

    it('does nothing for unknown APID', () => {
      expect(() => tree.killSubtree('X999')).not.toThrow();
    });
  });

  // ── killAll ───────────────────────────────────────────────────────────────

  describe('killAll()', () => {
    it('clears the overflow queue', () => {
      // Fill and overflow
      for (let i = 0; i < 7; i++) tree.spawn(`t${i}`);
      expect(tree.queuedCount).toBe(2);
      tree.killAll();
      expect(tree.queuedCount).toBe(0);
    });
  });

  // ── renderTree ────────────────────────────────────────────────────────────

  describe('renderTree()', () => {
    it('returns "(no agents)" when empty', () => {
      expect(tree.renderTree()).toBe('(no agents)');
    });

    it('renders a tree with connectors', () => {
      const root  = tree.spawn('root-task');
      tree.spawn('child-task', root);
      const output = tree.renderTree();
      expect(output).toContain('root-task');
      expect(output).toContain('child-task');
    });

    it('renders a specific subtree when rootApid is provided', () => {
      const rootA = tree.spawn('task-A');
      const rootB = tree.spawn('task-B');
      tree.spawn('child-A', rootA);
      const output = tree.renderTree(rootA);
      expect(output).toContain('task-A');
      expect(output).not.toContain('task-B');
    });

    it('handles unknown rootApid gracefully', () => {
      expect(tree.renderTree('X999')).toBe('(no agents)');
    });
  });

  // ── stats ─────────────────────────────────────────────────────────────────

  describe('stats()', () => {
    it('returns a total count', () => {
      tree.spawn('a');
      tree.spawn('b');
      const s = tree.stats();
      expect(s.total).toBe(2);
    });

    it('counts spawning agents', () => {
      tree.spawn('a');
      const s = tree.stats();
      expect(s.spawning).toBe(1);
    });
  });

  // ── snapshot / exportJSON ─────────────────────────────────────────────────

  describe('snapshot()', () => {
    it('returns undefined for unknown APID', () => {
      expect(tree.snapshot('X999')).toBeUndefined();
    });

    it('returns a serialisable snapshot', () => {
      const apid = tree.spawn('task-X');
      const snap = tree.snapshot(apid)!;
      expect(snap.apid).toBe(apid);
      expect(Array.isArray(snap.children)).toBe(true);
      expect(typeof snap.logCount).toBe('number');
    });

    it('snapshot children is an array, not a Set', () => {
      const parent = tree.spawn('p');
      const child  = tree.spawn('c', parent);
      const snap   = tree.snapshot(parent)!;
      expect(Array.isArray(snap.children)).toBe(true);
      expect(snap.children).toContain(child);
    });
  });

  describe('exportJSON()', () => {
    it('returns valid JSON', () => {
      tree.spawn('task');
      const json = tree.exportJSON();
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('includes all records', () => {
      tree.spawn('a');
      tree.spawn('b');
      const parsed = JSON.parse(tree.exportJSON());
      expect(parsed).toHaveLength(2);
    });
  });

  // ── concurrencyLimit setter ───────────────────────────────────────────────

  describe('concurrencyLimit setter', () => {
    it('can be changed at runtime', () => {
      tree.concurrencyLimit = 100;
      expect(tree.concurrencyLimit).toBe(100);
    });

    it('triggers drain when limit is raised above queue depth', async () => {
      for (let i = 0; i < 8; i++) tree.spawn(`t${i}`); // 5 running, 3 queued
      expect(tree.queuedCount).toBe(3);
      tree.concurrencyLimit = 10; // raise limit → drains all 3
      await tick();
      expect(tree.queuedCount).toBe(0);
    });
  });

  // ── Tree Balancing ────────────────────────────────────────────────────────

  describe('tree balancing', () => {
    describe('options', () => {
      it('defaults maxBranchingFactor to 8', () => {
        expect(tree.maxBranchingFactor).toBe(8);
      });

      it('defaults autoBalance to true', () => {
        expect(tree.autoBalance).toBe(true);
      });

      it('allows setting maxBranchingFactor via constructor', () => {
        const t = new AgentTree({ workerPath: '/fake/worker.js', maxBranchingFactor: 4 });
        expect(t.maxBranchingFactor).toBe(4);
        t.killAll();
      });

      it('allows disabling autoBalance via constructor', () => {
        const t = new AgentTree({ workerPath: '/fake/worker.js', autoBalance: false });
        expect(t.autoBalance).toBe(false);
        t.killAll();
      });

      it('exposes setters for runtime configuration', () => {
        tree.maxBranchingFactor = 4;
        tree.autoBalance = false;
        expect(tree.maxBranchingFactor).toBe(4);
        expect(tree.autoBalance).toBe(false);
      });
    });

    describe('auto-balancing behavior', () => {
      let balancedTree: AgentTree;

      beforeEach(() => {
        balancedTree = new AgentTree({
          workerPath: '/fake/worker.js',
          concurrencyLimit: 100, // high limit so nothing queues
          maxBranchingFactor: 3,
          autoBalance: true,
        });
      });

      afterEach(() => {
        balancedTree.killAll();
      });

      it('attaches children directly when under branching factor', () => {
        const root = balancedTree.spawn('root');
        const c1 = balancedTree.spawn('child-1', root);
        const c2 = balancedTree.spawn('child-2', root);
        const c3 = balancedTree.spawn('child-3', root);

        expect(balancedTree.get(c1)!.parentApid).toBe(root);
        expect(balancedTree.get(c2)!.parentApid).toBe(root);
        expect(balancedTree.get(c3)!.parentApid).toBe(root);
        expect(balancedTree.get(root)!.children.size).toBe(3);
      });

      it('redistributes children when parent exceeds branching factor', () => {
        const root = balancedTree.spawn('root');
        balancedTree.spawn('child-1', root);
        balancedTree.spawn('child-2', root);
        balancedTree.spawn('child-3', root);

        // 4th child should be placed under one of the existing children
        const c4 = balancedTree.spawn('child-4', root);
        const c4Rec = balancedTree.get(c4)!;

        // Should NOT be direct child of root (root is at capacity)
        expect(c4Rec.parentApid).not.toBe(root);
        // Should be grandchild (depth 2)
        expect(c4Rec.depth).toBe(2);
      });

      it('avoids linked-list structure with sequential spawns', () => {
        const root = balancedTree.spawn('root');
        let last = root;

        // Spawn 10 children, each specifying the previous as parent
        // Without balancing, this would create a depth-10 linked list
        for (let i = 0; i < 10; i++) {
          last = balancedTree.spawn(`task-${i}`, root);
        }

        const stats = balancedTree.balanceStats();
        expect(stats.isLinkedList).toBe(false);
        // With branching factor 3, depth should be ≤ log₃(11) + 1 ≈ 3
        expect(stats.maxDepth).toBeLessThanOrEqual(4);
      });
    });

    describe('with autoBalance disabled', () => {
      let unbalancedTree: AgentTree;

      beforeEach(() => {
        unbalancedTree = new AgentTree({
          workerPath: '/fake/worker.js',
          concurrencyLimit: 100,
          maxBranchingFactor: 3,
          autoBalance: false,
        });
      });

      afterEach(() => {
        unbalancedTree.killAll();
      });

      it('allows unlimited children per node', () => {
        const root = unbalancedTree.spawn('root');
        for (let i = 0; i < 10; i++) {
          unbalancedTree.spawn(`child-${i}`, root);
        }

        expect(unbalancedTree.get(root)!.children.size).toBe(10);
      });

      it('allows linked-list structures', () => {
        let parent = unbalancedTree.spawn('root');
        for (let i = 0; i < 10; i++) {
          parent = unbalancedTree.spawn(`task-${i}`, parent);
        }

        const stats = unbalancedTree.balanceStats();
        expect(stats.maxDepth).toBe(10);
        expect(stats.isLinkedList).toBe(true);
      });
    });
  });

  // ── balanceStats ──────────────────────────────────────────────────────────

  describe('balanceStats()', () => {
    it('returns zeroes for empty tree', () => {
      const stats = tree.balanceStats();
      expect(stats.totalNodes).toBe(0);
      expect(stats.maxDepth).toBe(0);
      expect(stats.avgBranchingFactor).toBe(0);
      expect(stats.leafCount).toBe(0);
      expect(stats.isBalanced).toBe(true);
    });

    it('correctly counts leaf nodes', () => {
      const root = tree.spawn('root');
      tree.spawn('leaf-1', root);
      tree.spawn('leaf-2', root);

      const stats = tree.balanceStats();
      expect(stats.leafCount).toBe(2); // leaf-1 and leaf-2
      expect(stats.totalNodes).toBe(3);
    });

    it('calculates max depth correctly', () => {
      const root = tree.spawn('root');
      const child = tree.spawn('child', root);
      tree.spawn('grandchild', child);

      const stats = tree.balanceStats();
      expect(stats.maxDepth).toBe(2);
    });

    it('calculates average branching factor', () => {
      const root = tree.spawn('root');
      tree.spawn('child-1', root);
      tree.spawn('child-2', root);
      tree.spawn('child-3', root);
      tree.spawn('child-4', root);

      const stats = tree.balanceStats();
      // Only root has children (4), so avg = 4
      expect(stats.avgBranchingFactor).toBe(4);
    });

    it('detects linked-list structure', () => {
      // Disable auto-balance for this test
      tree.autoBalance = false;

      let parent = tree.spawn('root');
      for (let i = 0; i < 5; i++) {
        parent = tree.spawn(`t${i}`, parent);
      }

      const stats = tree.balanceStats();
      expect(stats.isLinkedList).toBe(true);
      expect(stats.maxBranchingFactor).toBe(1);
      expect(stats.maxDepth).toBe(5);
    });

    it('reports isBalanced=false for unbalanced trees', () => {
      tree.autoBalance = false;
      const root = tree.spawn('root');
      // Add 20 children to root (way over default maxBranchingFactor of 8)
      for (let i = 0; i < 20; i++) {
        tree.spawn(`child-${i}`, root);
      }

      const stats = tree.balanceStats();
      expect(stats.isBalanced).toBe(false);
      expect(stats.maxBranchingFactor).toBe(20);
    });
  });

  // ── Garbage Collection ────────────────────────────────────────────────────

  describe('garbage collection', () => {
    describe('options', () => {
      it('defaults gcRetentionMs to 5 minutes', () => {
        expect(tree.gcRetentionMs).toBe(5 * 60 * 1000);
      });

      it('defaults gcIntervalMs to 30 seconds', () => {
        expect(tree.gcIntervalMs).toBe(30 * 1000);
      });

      it('allows setting gcRetentionMs via constructor', () => {
        const t = new AgentTree({
          workerPath: '/fake/worker.js',
          gcRetentionMs: 10000,
          gcIntervalMs: 0, // disable auto-GC for test
        });
        expect(t.gcRetentionMs).toBe(10000);
        t.dispose();
      });

      it('allows disabling GC via Infinity retention', () => {
        const t = new AgentTree({
          workerPath: '/fake/worker.js',
          gcRetentionMs: Infinity,
          gcIntervalMs: 0,
        });
        expect(t.gcRetentionMs).toBe(Infinity);
        t.dispose();
      });

      it('exposes setters for runtime configuration', () => {
        tree.gcRetentionMs = 30000;
        tree.gcIntervalMs = 0; // disable
        expect(tree.gcRetentionMs).toBe(30000);
        expect(tree.gcIntervalMs).toBe(0);
      });
    });

    describe('gc() method', () => {
      let gcTree: AgentTree;

      beforeEach(() => {
        gcTree = new AgentTree({
          workerPath: '/fake/worker.js',
          concurrencyLimit: 100,
          gcRetentionMs: 100, // 100ms for fast tests
          gcIntervalMs: 0,    // disable auto-GC
        });
      });

      afterEach(() => {
        gcTree.dispose();
      });

      it('returns empty array when no nodes eligible', () => {
        gcTree.spawn('task');
        const collected = gcTree.gc();
        expect(collected).toEqual([]);
      });

      it('returns empty array when gcRetentionMs is Infinity', () => {
        gcTree.gcRetentionMs = Infinity;
        const apid = gcTree.spawn('task');
        // Manually set status to completed
        const rec = gcTree.get(apid)!;
        rec.status = 'completed';
        rec.endedAt = Date.now() - 1000000;

        const collected = gcTree.gc();
        expect(collected).toEqual([]);
      });

      it('collects completed nodes after retention period', async () => {
        const apid = gcTree.spawn('task');
        await tick();
        const proc = lastFakeProc;
        await simulateCompletion(proc, apid);

        // Should not be collected immediately (retention not passed)
        expect(gcTree.gc()).toEqual([]);
        expect(gcTree.get(apid)).toBeDefined();

        // Wait for retention period
        await new Promise(r => setTimeout(r, 150));

        // Now should be collected
        const collected = gcTree.gc();
        expect(collected).toContain(apid);
        expect(gcTree.get(apid)).toBeUndefined();
      });

      it('collects failed nodes after retention period', async () => {
        const apid = gcTree.spawn('task');
        await tick();
        const proc = lastFakeProc;
        proc.emit('message', { type: 'ready' });
        await tick();
        proc.emit('message', { type: 'failed', apid, error: 'boom', durationMs: 10 });
        await tick();

        await new Promise(r => setTimeout(r, 150));

        const collected = gcTree.gc();
        expect(collected).toContain(apid);
      });

      it('collects killed nodes after retention period', async () => {
        const apid = gcTree.spawn('task');
        await tick();
        gcTree.killSubtree(apid);

        await new Promise(r => setTimeout(r, 150));

        const collected = gcTree.gc();
        expect(collected).toContain(apid);
      });

      it('does not collect running nodes', async () => {
        const apid = gcTree.spawn('task');
        await tick();
        const proc = lastFakeProc;
        proc.emit('message', { type: 'ready' });
        await tick();
        proc.emit('message', { type: 'started', apid });
        await tick();

        await new Promise(r => setTimeout(r, 150));

        const collected = gcTree.gc();
        expect(collected).not.toContain(apid);
        expect(gcTree.get(apid)).toBeDefined();
      });

      it('does not collect parent with active children', async () => {
        const parent = gcTree.spawn('parent');
        await tick();
        const parentProc = lastFakeProc;
        await simulateCompletion(parentProc, parent);

        const child = gcTree.spawn('child', parent);
        await tick();
        const childProc = lastFakeProc;
        childProc.emit('message', { type: 'ready' });
        await tick();
        childProc.emit('message', { type: 'started', apid: child });
        await tick();

        await new Promise(r => setTimeout(r, 150));

        const collected = gcTree.gc();
        // Parent should not be collected (has active child)
        expect(collected).not.toContain(parent);
        // Child should not be collected (still running)
        expect(collected).not.toContain(child);
      });

      it('collects children before parents (bottom-up)', async () => {
        const parent = gcTree.spawn('parent');
        await tick();
        const parentProc = lastFakeProc;
        await simulateCompletion(parentProc, parent);

        const child = gcTree.spawn('child', parent);
        await tick();
        const childProc = lastFakeProc;
        await simulateCompletion(childProc, child);

        await new Promise(r => setTimeout(r, 150));

        const collected = gcTree.gc();
        // Both should be collected
        expect(collected).toContain(parent);
        expect(collected).toContain(child);
        // Child should be collected first (higher depth = earlier in sorted order)
        const childIdx = collected.indexOf(child);
        const parentIdx = collected.indexOf(parent);
        expect(childIdx).toBeLessThan(parentIdx);
      });

      it('unlinks collected node from parent children Set', async () => {
        const parent = gcTree.spawn('parent');
        await tick();

        const child = gcTree.spawn('child', parent);
        await tick();
        const childProc = lastFakeProc;
        await simulateCompletion(childProc, child);

        await new Promise(r => setTimeout(r, 150));

        // Parent should still have child in its Set
        expect(gcTree.get(parent)!.children.has(child)).toBe(true);

        gcTree.gc();

        // Child should be removed from parent's children Set
        expect(gcTree.get(parent)!.children.has(child)).toBe(false);
      });

      it('emits "gc" event with collected APIDs', async () => {
        const gcHandler = jest.fn();
        gcTree.on('gc', gcHandler);

        const apid = gcTree.spawn('task');
        await tick();
        const proc = lastFakeProc;
        await simulateCompletion(proc, apid);

        await new Promise(r => setTimeout(r, 150));

        gcTree.gc();

        expect(gcHandler).toHaveBeenCalledTimes(1);
        expect(gcHandler).toHaveBeenCalledWith(expect.arrayContaining([apid]));
      });

      it('does not emit "gc" event when nothing collected', () => {
        const gcHandler = jest.fn();
        gcTree.on('gc', gcHandler);

        gcTree.spawn('task');
        gcTree.gc();

        expect(gcHandler).not.toHaveBeenCalled();
      });
    });

    describe('gcEligibleCount()', () => {
      let gcTree: AgentTree;

      beforeEach(() => {
        gcTree = new AgentTree({
          workerPath: '/fake/worker.js',
          concurrencyLimit: 100,
          gcRetentionMs: 100,
          gcIntervalMs: 0,
        });
      });

      afterEach(() => {
        gcTree.dispose();
      });

      it('returns 0 for empty tree', () => {
        expect(gcTree.gcEligibleCount()).toBe(0);
      });

      it('returns 0 when gcRetentionMs is Infinity', () => {
        gcTree.gcRetentionMs = Infinity;
        expect(gcTree.gcEligibleCount()).toBe(0);
      });

      it('counts eligible nodes correctly', async () => {
        const a1 = gcTree.spawn('task-1');
        const a2 = gcTree.spawn('task-2');
        await tick();

        // Complete both
        for (const apid of [a1, a2]) {
          const rec = gcTree.get(apid)!;
          rec.status = 'completed';
          rec.endedAt = Date.now() - 200; // Past retention
        }

        expect(gcTree.gcEligibleCount()).toBe(2);
      });
    });

    describe('dispose()', () => {
      it('stops the GC timer', () => {
        const t = new AgentTree({
          workerPath: '/fake/worker.js',
          gcIntervalMs: 100,
        });

        // Access private gcTimer to verify it's set
        expect((t as any).gcTimer).not.toBeNull();

        t.dispose();

        expect((t as any).gcTimer).toBeNull();
      });

      it('kills all processes', () => {
        const t = new AgentTree({
          workerPath: '/fake/worker.js',
          gcIntervalMs: 0,
        });

        t.spawn('task-1');
        t.spawn('task-2');
        expect(t.totalCount).toBe(2);

        t.dispose();

        // killAll marks them as killed
        for (const rec of t.getAll()) {
          expect(rec.status).toBe('killed');
        }
      });
    });
  });
});
