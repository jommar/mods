# usage-monitor (Claude Code mod)

Live token, cost and tool-call accounting for a session and every subagent it spawns.

- **Status line**: running totals for the session, updated on every model request.
- **`/usage-monitor`** opens the Usage pane: session totals (new input, cache reads and writes, output, cache-hit
  percentage, estimated cost), the main thread, each subagent (model, tokens, tool calls) and a tool-call tally.
  `/usage-monitor reset` zeroes the counters.
- **Toast** when a subagent finishes: its label, model, tool calls and tokens.

Costs are estimates: list price times tokens, with cache writes at the 5-minute rate (1.25x). A model without a
list price is counted but not priced.

The mod works on its own. **Optionally** it also reports every model request, tool call and subagent to a local
[usage-monitor API](../../api/usage-monitor/README.md), which keeps the history in SQLite and serves a web
dashboard. Reporting is **off** until you give the mod the API's socket.

## Report to the API (optional)

1. Install and start the API first: follow its [Install section](../../api/usage-monitor/README.md#install).
2. Give the mod the socket. In Claude Code open `/config` and set usage-monitor's **API socket** to the absolute
   path `/run/user/<uid>/usage-monitor.sock` (`id -u` prints your uid; `$XDG_RUNTIME_DIR` is not expanded there).
   Changing it in `/config` reloads the mod. If you edit `settings.json` by hand instead, the setting is
   `pluginConfigs["usage-monitor@inline"].options.apiSocket` (the key after the name depends on how the mod is
   loaded), and you should start a new session afterwards.
3. Check it: use the session for a moment, then open `http://127.0.0.1:7842/`, or run
   `curl --unix-socket /run/user/$(id -u)/usage-monitor.sock http://usage-monitor/api/sessions`.

To turn reporting off, clear the setting.

### What is sent

Over the local socket only; nothing leaves the machine.

| Event | Content |
| --- | --- |
| model request | model, input, output, cache-read and cache-write token counts, estimated cost (empty when the model has no list price) |
| tool call | the tool's name; never its input or output |
| subagent | its label (`type: description`, cut to 300 characters) and model |
| session start / end | the working directory (cut to 4096 characters) and whether the session ended or was cleared |

### When the API is down

The mod never waits on the API and never reports an error: the pane, the status line and the toast behave exactly as
without it. Events are queued in memory (at most 2000; the oldest are dropped first) and sent in batches of up to 500
about half a second after they happen. A failed send is retried with a delay that grows from 2 s to 60 s, a request that
takes longer than 15 s is given up on, and a batch the API rejects as invalid is dropped, not retried.

### Limits

- Events still queued when the mod reloads or the process exits are lost.
- After `/clear` the session continues under a new id without a new "session start", so its directory stays blank
  on the dashboard.
- Costs are estimates from list prices.

## Layout

```
.claude-plugin/plugin.json   manifest; the one option, apiSocket
hooks/register.tsx           the hooks: status line, /usage-monitor, toast, pane, report calls
hooks/ledger.ts              the accounting (pure functions: tokens, tools, price, formatting)
hooks/report.ts              the reporter: queue, batching, retry
tests/                       claude plugin test
types/index.d.ts             the session state the mod keeps
```

## Development

```bash
claude plugin test     ~/.claude/mods/usage-monitor     # all suites
claude plugin validate ~/.claude/mods/usage-monitor
tsc -p                 ~/.claude/mods/usage-monitor     # needs a TypeScript compiler on PATH
```

The existing behaviour (status line, pane, toast) must not change when reporting is added or changed: `tests/report.test.ts`
checks that every hook returns the same result with reporting on, off, failing and hanging.
