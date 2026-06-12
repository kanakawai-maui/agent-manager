# Getting Started — Agent Manager

Agent Manager is a CLI tool for spawning and managing hundreds of parallel worker processes arranged in a tree. Workers report progress back in real time via IPC.

## Prerequisites

- Node.js 18+
- npm 8+

## Installation

```bash
cd agent-manager
npm install
npm run build
```

Or skip the build step with `ts-node`:

```bash
npm install
npx ts-node src/cli.ts
```

## Start the REPL

```bash
node dist/cli.js
```

You'll see a prompt:

```
agent>
```

## Your first agent

Spawn a single agent with any task string:

```
agent> spawn sh: echo hello world
  ↳ [A001] spawned  (pid 12345)
  ▶ [A001] started
    [A001] $ echo hello world
  ✓ [A001] completed in 42ms
```

Check its result:

```
agent> result A001
hello world
```

## Task prefixes

The worker routes tasks by prefix:

| Prefix | What it does |
|---|---|
| `sh: <cmd>` | Runs a shell command via `exec()` |
| `fetch: <url>` | HTTP GET a URL and returns the response body |
| `script: <path>` | Runs a local JS file with `node` |
| *(no prefix)* | Generic stub — wire in your LLM here (see below) |

## Spawning many agents at once

```
agent> batch 10 sh: echo hello
```

The first 50 agents start immediately (default cap). The rest queue and drain automatically as slots free up.

## Viewing agent state

```
agent> status          # table of all agents
agent> status A001     # detail view for one agent
agent> tree            # ASCII tree of the whole hierarchy
agent> stats           # live counters: active / queued / completed / failed
agent> logs A001       # last 20 log lines
```

## Killing agents

```
agent> kill A001       # kill A001 and all its children
agent> killall         # kill everything and drain the queue
```

## CLI flags

```bash
node dist/cli.js --concurrency 200   # raise the parallel process cap (default 50)
node dist/cli.js --no-color          # disable ANSI colours
```

## Integrating an LLM

Open `src/worker.ts` and replace the body of `runGeneric()`:

```ts
import OpenAI from 'openai';
const openai = new OpenAI(); // reads OPENAI_API_KEY from env

async function runGeneric(apid: string, task: string): Promise<string> {
  emitProgress(apid, 'Calling OpenAI…');
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: task }],
  });
  return res.choices[0].message.content ?? '';
}
```

Then rebuild: `npm run build`.

## Exporting results

```
agent> export results.json    # dump all agent snapshots to a JSON file
```

## Full command reference

Type `help` in the REPL at any time.
