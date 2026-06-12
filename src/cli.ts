#!/usr/bin/env node
/**
 * Agent Manager CLI
 *
 * Interactive REPL for launching, monitoring, and managing hundreds of
 * agent worker processes arranged in a tree.
 *
 * Usage
 * ─────
 *   node dist/cli.js
 *   node dist/cli.js --concurrency 200   # raise the cap
 *   node dist/cli.js --no-color          # disable ANSI colours
 *
 * Commands (type 'help' in the REPL)
 * ───────────────────────────────────
 *   spawn  <task>               – Start one agent
 *   batch  <n> <task>           – Spawn N copies of the same task in parallel
 *   batch-file <path>           – Spawn one agent per line in a text file
 *   sic    <parent> <task>      – Spawn a child agent under <parent>
 *   status [apid]               – Show status table or one agent's details
 *   tree   [apid]               – Render the agent tree (or a subtree)
 *   logs   <apid> [tail=20]     – Print last N log lines for an agent
 *   result <apid>               – Print the result of a completed agent
 *   kill   <apid>               – Kill one agent (and its subtree)
 *   killall                     – Kill every agent
 *   stats                       – Live concurrency / queue / status counters
 *   export [file]               – Export all snapshots to JSON
 *   concurrency <n>             – Change the concurrency cap at runtime
 *   watch [interval=2]          – Auto-refresh stats every N seconds (Ctrl-C to stop)
 *   clear                       – Clear the terminal
 *   help                        – This message
 *   exit / quit                 – Shut down all agents and exit
 */

import * as readline   from 'readline';
import * as fs         from 'fs';
import * as path       from 'path';
import { AgentTree }   from './AgentTree';
import type { AgentRecord } from './types';
import { detectConcurrencyLimit, formatConcurrencyProfile } from './utils';

// ── CLI flags ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const profile = detectConcurrencyLimit();
const concurrencyCap = (() => {
  const idx = argv.indexOf('--concurrency');
  return idx !== -1 ? parseInt(argv[idx + 1], 10) || profile.cap : profile.cap;
})();
const noColor = argv.includes('--no-color');

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const C = noColor
  ? { r: (s: string) => s, g: (s: string) => s, y: (s: string) => s,
      b: (s: string) => s, m: (s: string) => s, c: (s: string) => s,
      dim: (s: string) => s, bold: (s: string) => s, reset: '' }
  : {
      r:    (s: string) => `\x1b[31m${s}\x1b[0m`,
      g:    (s: string) => `\x1b[32m${s}\x1b[0m`,
      y:    (s: string) => `\x1b[33m${s}\x1b[0m`,
      b:    (s: string) => `\x1b[34m${s}\x1b[0m`,
      m:    (s: string) => `\x1b[35m${s}\x1b[0m`,
      c:    (s: string) => `\x1b[36m${s}\x1b[0m`,
      dim:  (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
      reset: '\x1b[0m',
    };

const statusColor = (s: string) => {
  if (s === 'completed') return C.g(s);
  if (s === 'running')   return C.c(s);
  if (s === 'failed')    return C.r(s);
  if (s === 'killed')    return C.m(s);
  if (s === 'queued')    return C.y(s);
  return C.dim(s);
};

// ── Tree instance ─────────────────────────────────────────────────────────────

const tree = new AgentTree({
  workerPath:       path.resolve(__dirname, 'worker.js'),
  concurrencyLimit: concurrencyCap,
});

// ── Live event output (non-intrusive: written above the prompt line) ──────────

let watchTimer: NodeJS.Timeout | null = null;

const print = (line: string) => {
  // Erase the current prompt line, print our line, then re-draw the prompt.
  process.stdout.write(`\r\x1b[K${line}\n`);
  rl.prompt(true);
};

tree.on('spawned',   (apid: string) => print(C.dim(`  ↳ [${apid}] spawned  (pid ${tree.get(apid)?.nativePid ?? '?'})`)));
tree.on('started',   (apid: string) => print(C.c(`  ▶ [${apid}] started`)));
tree.on('progress',  (apid: string, data: string) => print(C.dim(`    [${apid}] ${data}`)));
tree.on('completed', (apid: string) => {
  const rec = tree.get(apid)!;
  print(C.g(`  ✓ [${apid}] completed in ${rec.durationMs}ms`));
});
tree.on('failed', (apid: string) => {
  const rec = tree.get(apid)!;
  print(C.r(`  ✗ [${apid}] FAILED: ${rec.error}`));
});
tree.on('killed',  (apid: string) => print(C.m(`  ✗ [${apid}] killed`)));
tree.on('queued',  (apid: string) => print(C.y(`  ⏳ [${apid}] queued (cap=${tree.concurrencyLimit})`)));
tree.on('drained', (apid: string) => print(C.dim(`  ↑ [${apid}] dequeued → spawning`)));

// ── REPL ──────────────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
  prompt: C.bold(C.b('agent> ')),
  completer: (line: string) => {
    const completions = [
      'spawn ', 'batch ', 'batch-file ', 'sic ',
      'status', 'tree', 'logs ', 'result ', 'kill ', 'killall',
      'stats', 'export', 'concurrency ', 'watch', 'clear', 'help', 'exit', 'quit',
    ];
    const hits = completions.filter(c => c.startsWith(line));
    return [hits.length ? hits : completions, line];
  },
});

console.log(C.bold('\n╔══════════════════════════════════════════════════╗'));
console.log(C.bold('║           Agent Manager  —  CLI REPL            ║'));
console.log(C.bold('╚══════════════════════════════════════════════════╝'));
console.log(`  concurrency cap: ${C.y(String(tree.concurrencyLimit))}  ${C.dim(formatConcurrencyProfile(profile))}`);
console.log(`  worker path    : ${C.dim(path.resolve(__dirname, 'worker.js'))}`);
console.log(`  type ${C.bold('help')} for commands\n`);
rl.prompt();

rl.on('line', (rawLine) => {
  const line = rawLine.trim();
  if (!line) { rl.prompt(); return; }

  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');

  try {
    dispatch(cmd.toLowerCase(), rest, arg);
  } catch (err: unknown) {
    print(C.r(`Error: ${err instanceof Error ? err.message : String(err)}`));
  }

  rl.prompt();
});

rl.on('close', () => shutdown());

// ── Command dispatcher ────────────────────────────────────────────────────────

function dispatch(cmd: string, args: string[], arg: string): void {
  switch (cmd) {

    // ── spawn <task> ──────────────────────────────────────────────────────
    case 'spawn': {
      if (!arg) { print(C.y('Usage: spawn <task>')); break; }
      const apid = tree.spawn(arg);
      print(`Spawned ${C.c(apid)}: ${arg}`);
      break;
    }

    // ── batch <n> <task> ─────────────────────────────────────────────────
    case 'batch': {
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 1) { print(C.y('Usage: batch <n> <task>')); break; }
      const task = args.slice(1).join(' ');
      if (!task) { print(C.y('Usage: batch <n> <task>')); break; }
      const t0 = Date.now();
      const apids = tree.spawnBatch(Array(n).fill(task));
      const dt = Date.now() - t0;
      print(`Spawned ${C.c(String(apids.length))} agents in ${dt}ms`);
      print(`  First: ${apids[0]}  Last: ${apids[apids.length - 1]}`);
      print(`  Active: ${tree.activeCount}  Queued: ${tree.queuedCount}`);
      break;
    }

    // ── batch-file <path> ─────────────────────────────────────────────────
    case 'batch-file': {
      const filePath = arg.trim();
      if (!filePath) { print(C.y('Usage: batch-file <path>')); break; }
      const resolved = path.resolve(process.cwd(), filePath);
      if (!fs.existsSync(resolved)) { print(C.r(`File not found: ${resolved}`)); break; }
      const tasks = fs.readFileSync(resolved, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const t0 = Date.now();
      const apids = tree.spawnBatch(tasks);
      const dt = Date.now() - t0;
      print(`Spawned ${C.c(String(apids.length))} agents from file in ${dt}ms`);
      print(`  Active: ${tree.activeCount}  Queued: ${tree.queuedCount}`);
      break;
    }

    // ── sic <parent> <task> ───────────────────────────────────────────────
    case 'sic': {
      const [parentApid, ...taskParts] = args;
      if (!parentApid || !taskParts.length) { print(C.y('Usage: sic <parent-apid> <task>')); break; }
      if (!tree.get(parentApid)) { print(C.r(`Unknown APID: ${parentApid}`)); break; }
      const childApid = tree.spawn(taskParts.join(' '), parentApid);
      print(`Sic'd ${C.c(childApid)} on task under parent ${C.c(parentApid)}`);
      break;
    }

    // ── status [apid] ─────────────────────────────────────────────────────
    case 'status': {
      if (arg) {
        const rec = tree.get(arg);
        if (!rec) { print(C.r(`Unknown APID: ${arg}`)); break; }
        printRecord(rec);
      } else {
        printStatusTable(tree.getAll());
      }
      break;
    }

    // ── tree [apid] ───────────────────────────────────────────────────────
    case 'tree': {
      const rendered = tree.renderTree(arg || undefined);
      console.log(rendered);
      break;
    }

    // ── logs <apid> [n] ───────────────────────────────────────────────────
    case 'logs': {
      const [apid, nStr] = args;
      if (!apid) { print(C.y('Usage: logs <apid> [lines=20]')); break; }
      const rec = tree.get(apid);
      if (!rec) { print(C.r(`Unknown APID: ${apid}`)); break; }
      const n = parseInt(nStr, 10) || 20;
      const entries = rec.logs.slice(-n);
      if (!entries.length) { print(C.dim('(no logs yet)')); break; }
      for (const e of entries) {
        console.log(`  ${C.dim(new Date(e.ts).toISOString())}  ${e.data}`);
      }
      break;
    }

    // ── result <apid> ─────────────────────────────────────────────────────
    case 'result': {
      const rec = tree.get(arg);
      if (!rec) { print(C.r(`Unknown APID: ${arg}`)); break; }
      if (rec.status === 'failed') {
        console.log(C.r(`[${arg}] FAILED\n${rec.error}`));
      } else if (rec.result !== undefined) {
        console.log(C.g(`[${arg}] RESULT\n`) + rec.result);
      } else {
        print(C.y(`[${arg}] not yet completed (status: ${rec.status})`));
      }
      break;
    }

    // ── kill <apid> ───────────────────────────────────────────────────────
    case 'kill': {
      if (!arg) { print(C.y('Usage: kill <apid>')); break; }
      const killed = tree.killSubtree(arg);
      print(`Killed ${C.m(String(killed.length))} agent(s): ${killed.join(', ')}`);
      break;
    }

    // ── killall ───────────────────────────────────────────────────────────
    case 'killall': {
      tree.killAll();
      print(C.m('All agents killed.'));
      break;
    }

    // ── stats ─────────────────────────────────────────────────────────────
    case 'stats': {
      printStats();
      break;
    }

    // ── export [file] ─────────────────────────────────────────────────────
    case 'export': {
      const json = tree.exportJSON();
      if (arg) {
        const dest = path.resolve(process.cwd(), arg);
        fs.writeFileSync(dest, json, 'utf8');
        print(C.g(`Exported ${tree.totalCount} agents → ${dest}`));
      } else {
        console.log(json);
      }
      break;
    }

    // ── concurrency <n> ───────────────────────────────────────────────────
    case 'concurrency': {
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 1) { print(C.y('Usage: concurrency <n>')); break; }
      tree.concurrencyLimit = n;
      print(`Concurrency cap set to ${C.y(String(n))}`);
      break;
    }

    // ── watch [interval] ─────────────────────────────────────────────────
    case 'watch': {
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; print('Watch stopped.'); break; }
      const interval = Math.max(1, parseInt(arg, 10) || 2) * 1000;
      print(C.dim(`Watching every ${interval / 1000}s — press Ctrl-C or type 'watch' again to stop`));
      watchTimer = setInterval(() => {
        process.stdout.write('\x1b[2J\x1b[H'); // clear screen
        printStats();
        console.log(tree.renderTree());
        rl.prompt(true);
      }, interval);
      break;
    }

    // ── clear ─────────────────────────────────────────────────────────────
    case 'clear': {
      process.stdout.write('\x1b[2J\x1b[H');
      break;
    }

    // ── help ──────────────────────────────────────────────────────────────
    case 'help': {
      printHelp();
      break;
    }

    // ── exit / quit ───────────────────────────────────────────────────────
    case 'exit':
    case 'quit': {
      shutdown();
      return;
    }

    default:
      print(C.y(`Unknown command: ${cmd}. Type 'help' for a list.`));
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

function printRecord(rec: AgentRecord): void {
  console.log(`
  APID      : ${C.c(rec.apid)}
  Status    : ${statusColor(rec.status)}
  Task      : ${rec.task}
  PID       : ${rec.nativePid ?? '—'}
  Parent    : ${rec.parentApid ?? '—'}
  Children  : ${Array.from(rec.children).join(', ') || '—'}
  Depth     : ${rec.depth}
  Spawned   : ${new Date(rec.spawnedAt).toISOString()}
  Started   : ${rec.startedAt ? new Date(rec.startedAt).toISOString() : '—'}
  Ended     : ${rec.endedAt   ? new Date(rec.endedAt).toISOString()   : '—'}
  Duration  : ${rec.durationMs != null ? rec.durationMs + 'ms' : '—'}
  Log lines : ${rec.logs.length}
  `.trim());
}

function printStatusTable(records: AgentRecord[]): void {
  if (!records.length) { print(C.dim('(no agents)')); return; }
  const header = C.bold(
    'APID'.padEnd(7) +
    'STATUS'.padEnd(12) +
    'DEPTH'.padEnd(7) +
    'PID'.padEnd(8) +
    'PARENT'.padEnd(8) +
    'CHILDREN'.padEnd(10) +
    'DURATION'.padEnd(10) +
    'TASK'
  );
  console.log('\n' + header);
  console.log(C.dim('─'.repeat(90)));
  for (const r of records) {
    const dur = r.durationMs != null ? r.durationMs + 'ms' : (r.startedAt ? 'running' : '—');
    const row =
      r.apid.padEnd(7) +
      statusColor(r.status).padEnd(noColor ? 12 : 12 + 9) + // pad accounts for ANSI escapes
      String(r.depth).padEnd(7) +
      String(r.nativePid ?? '—').padEnd(8) +
      (r.parentApid ?? '—').padEnd(8) +
      String(r.children.size).padEnd(10) +
      dur.padEnd(10) +
      r.task.slice(0, 50);
    console.log(row);
  }
  console.log(C.dim('─'.repeat(90)));
  console.log(`  ${records.length} agent(s)   active: ${C.c(String(tree.activeCount))}   queued: ${C.y(String(tree.queuedCount))}\n`);
}

function printStats(): void {
  const s = tree.stats();
  console.log(`
  ${C.bold('─── Agent Manager Stats ───')}
  Total agents   : ${C.bold(String(s.total ?? 0))}
  Running        : ${C.c(String(s.running ?? 0))}
  Queued (overflow): ${C.y(String(s.queued_overflow ?? 0))}
  Completed      : ${C.g(String(s.completed ?? 0))}
  Failed         : ${C.r(String(s.failed ?? 0))}
  Killed         : ${C.m(String(s.killed ?? 0))}
  Concurrency cap: ${C.y(String(tree.concurrencyLimit))}
  `.trim());
}

function printHelp(): void {
  console.log(`
  ${C.bold('Commands')}
  ────────────────────────────────────────────────────────────
  spawn  <task>              Spawn a single agent
  batch  <n> <task>          Spawn N agents with the same task (parallel)
  batch-file <path>          Spawn one agent per line in a text file
  sic    <apid> <task>       Spawn a child agent under <apid>
  status [apid]              Status table or detailed record for one agent
  tree   [apid]              ASCII tree of all agents (or subtree)
  logs   <apid> [n=20]       Last N log lines for an agent
  result <apid>              Print the result of a completed agent
  kill   <apid>              Kill agent + entire subtree
  killall                    Kill every agent and drain the queue
  stats                      Concurrency counters
  export [file]              Export all snapshots to JSON
  concurrency <n>            Change concurrency cap at runtime
  watch [seconds=2]          Auto-refresh stats+tree (run again to stop)
  clear                      Clear the terminal
  help                       This message
  exit / quit                Kill all agents and exit

  ${C.bold('Task prefixes')}
  ────────────────────────────────────────────────────────────
  sh: <command>              Run a shell command
  fetch: <url>               HTTP GET a URL
  script: <path>             Run a local JS file
  <anything else>            Generic simulated AI task
  `.trim());
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown(): void {
  if (watchTimer) clearInterval(watchTimer);
  print(C.m('\nShutting down — killing all agents…'));
  tree.killAll();
  process.exit(0);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
