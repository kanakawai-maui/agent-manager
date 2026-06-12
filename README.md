# Agent Manager

A CLI tool (and web dashboard) for "sic"-ing agents on tasks, giving them process IDs, and having them report back — with support for hundreds of parallel workers arranged in a tree.

## Quick start

```bash
cd agent-manager
npm install
npm run build
node dist/cli.js        # interactive REPL
node dist/web-server.js # web dashboard on http://localhost:3001
```

Or skip the build step with `ts-node`:

```bash
npm run dev        # CLI REPL
npm run web:dev    # web dashboard
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI REPL  (cli.ts)                 Web Dashboard (web-server.ts)│
│   readline interface + commands      HTTP + SSE + REST API       │
│   live event output                  browser UI on :3001         │
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
│  Auto-balancing tree  (maxBranchingFactor=8, logarithmic depth) │
│  Automatic GC of inactive nodes (5-min retention, 30-s interval)│
│  Concurrency cap auto-detected from CPU count + available RAM   │
└────────────────────┬────────────────────────────────────────────┘
                     │  fork() + IPC
         ┌───────────┼───────────┐
   ┌─────▼───┐ ┌─────▼───┐ ┌────▼────┐
   │ worker  │ │ worker  │ │ worker  │   … up to N
   │ A001    │ │ A002    │ │ A003    │
   └─────────┘ └─────────┘ └─────────┘
```

Each worker is a forked Node.js process. Communication is via Node.js IPC (no sockets, no polling).

## Commands

| Command | Description |
|---|---|
| `spawn <task>` | Launch a single agent |
| `batch <n> <task>` | Launch N agents with the same task in parallel |
| `batch-file <path>` | One agent per line in a text file |
| `sic <apid> <task>` | Spawn a child agent under an existing agent |
| `status [apid]` | Status table or single-agent detail |
| `tree [apid]` | ASCII tree of all agents or a subtree |
| `logs <apid> [n]` | Last N log lines (default 20) |
| `result <apid>` | Print the completed result |
| `kill <apid>` | Kill one agent and its entire subtree |
| `killall` | Kill every agent and drain the queue |
| `stats` | Live concurrency / queue counters |
| `export [file]` | Dump all snapshots to JSON |
| `concurrency <n>` | Change the concurrency cap at runtime |
| `watch [secs]` | Auto-refresh stats + tree |
| `clear` | Clear the terminal |
| `help` | Full command reference |
| `exit` / `quit` | Graceful shutdown |

## Provider Management

The web dashboard includes a **Provider Management** interface to configure LLM providers and API keys through a GUI instead of using environment variables.

### Accessing Provider Management

1. Start the web server: `npm run web:dev` or `node dist/web-server.js`
2. Open http://localhost:3001
3. Click the **⚙️ Providers** button in the header

### Features

- **Add multiple provider configurations**: Store multiple API keys for different providers
- **Set default provider**: Mark one configuration as the default for new agents
- **Test connections**: Verify API keys work before using them
- **Edit configurations**: Update API keys, models, and endpoints
- **Secure storage**: API keys are stored locally in `provider-configs.json`

### Supported Providers

| Provider | Requires API Key | Notes |
|---|---|---|
| **OpenRouter** | Yes | Access 200+ models via unified API |
| **OpenAI** | Yes | GPT-4, GPT-4o, etc. |
| **Azure OpenAI** | Yes | Enterprise OpenAI deployments |
| **Anthropic** | Yes | Claude 3.5, Claude 3, etc. |

### Configuration File

Provider configurations are stored in `provider-configs.json` (this file is git-ignored to protect API keys).

Example configuration structure:

```json
{
  "version": "1.0",
  "configs": [
    {
      "id": "provider-1234-abcd",
      "provider": "openrouter",
      "name": "OpenRouter Default",
      "apiKey": "sk-or-v1-...",
      "model": "openai/gpt-4o",
      "isDefault": true,
      "createdAt": 1234567890000,
      "updatedAt": 1234567890000
    }
  ]
}
```

You can also manage this file manually or use the example template:

```bash
cp provider-configs.example.json provider-configs.json
# Edit provider-configs.json with your API keys
```

### API Endpoints

The provider management system exposes these REST endpoints:

- `GET /api/providers` — List available provider types
- `GET /api/provider-configs` — List configured providers (API keys masked)
- `POST /api/provider-configs` — Add a new provider configuration
- `PUT /api/provider-configs/:id` — Update a provider configuration
- `DELETE /api/provider-configs/:id` — Delete a provider configuration
- `POST /api/provider-configs/:id/test` — Test a provider connection

## Task types

The worker recognises these prefixes:

| Prefix | Behaviour |
|---|---|
| `sh: <cmd>` | Execute a shell command via `exec()` |
| `fetch: <url>` | HTTP GET a URL |
| `get: <url>` | HTTP GET a URL (alias for `fetch:`) |
| `script: <path>` | Run a local JS file with `node` |
| *(anything else)* | Routed to the configured LLM provider (see below) |

## Spawning hundreds of agents

```
agent> batch 200 sh: echo hello
Spawned 200 agents in 12ms
  First: A001  Last: A200
  Active: 50  Queued: 150
```

The first N agents start immediately (N = auto-detected concurrency cap); the rest queue. As each worker completes, the queue drains — one slot freed → one task launched, O(1).

## Sub-agents (agent spawning agents)

Agents can request sub-agents from within their own task code by sending an IPC message:

```ts
process.send({ type: 'spawn', parentApid: apid, task: 'sh: echo sub-task' });
```

You can also do it from the REPL with `sic`:

```
agent> spawn sh: echo parent task
Spawned A001: sh: echo parent task
agent> sic A001 sh: echo child task
Sic'd A002 on task under parent A001
agent> tree
└── [A001] ✅ sh: echo parent task
    └── [A002] ✅ sh: echo child task
```

When `autoBalance` is enabled (default), the tree keeps each node's child count at or below `maxBranchingFactor` (default 8) so depth stays logarithmic.

## CLI flags

```
node dist/cli.js --concurrency 200   # override the auto-detected cap
node dist/cli.js --no-color          # disable ANSI colours
```

## Web Dashboard

The web dashboard provides a browser UI with live updates via Server-Sent Events (SSE).

```bash
node dist/web-server.js                  # default port 3001
node dist/web-server.js --port 8080      # custom port
node dist/web-server.js --concurrency 20 # concurrency cap
```

### REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | All agent snapshots + stats |
| `GET` | `/api/agents/:apid` | Single agent record |
| `POST` | `/api/spawn` | `{ task, parentApid? }` → `{ apid }` |
| `POST` | `/api/batch` | `{ tasks[], parentApid? }` or `{ task, count, parentApid? }` → `{ apids, count }` |
| `DELETE` | `/api/agents/:apid` | Kill one agent and its subtree |
| `DELETE` | `/api/agents` | Kill all agents |
| `PUT` | `/api/concurrency` | `{ limit }` — change cap at runtime |
| `GET` | `/api/events` | SSE stream of live agent events |

## Integrating an LLM

Set the `LLM_PROVIDER` environment variable before starting the CLI or web server. Each provider reads its own API key from the environment.

| Provider | `LLM_PROVIDER` value | Key env var |
|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google` | `GOOGLE_API_KEY` |
| Ollama (local) | `ollama` | — |
| Azure OpenAI | `azure-openai` | `AZURE_OPENAI_API_KEY` |
| Qwen | `qwen` | `QWEN_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Dummy (testing) | `dummy` | — |

```bash
LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-4-5 node dist/cli.js
```

When `LLM_PROVIDER` is not set, the worker runs a built-in stub that simulates progress and randomly spawns sub-agents.

## File layout

```
agent-manager/
  src/
    types.ts        — Shared IPC message types + AgentRecord shape
    AgentTree.ts    — Core data structure (Map + Set + Queue + tree traversal)
    worker.ts       — Forked child process: executes tasks, streams progress
    cli.ts          — Interactive REPL + event display
    web-server.ts   — HTTP server: REST API + SSE stream + static UI
    utils.ts        — System-aware concurrency auto-detection
    providers/      — Pluggable LLM provider implementations
      index.ts          createProvider() factory + barrel export
      llm-provider.ts   LLMProvider interface + shared types
      openai.provider.ts
      anthropic.provider.ts
      google.provider.ts
      ollama.provider.ts
      azure-openai.provider.ts
      qwen.provider.ts
      dummy.provider.ts
  public/
    index.html      — Web dashboard UI
  dist/             — Compiled output (after npm run build)
  package.json
  tsconfig.json
```
