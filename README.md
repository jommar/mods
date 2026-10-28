# mods

Personal Claude Code mods.

| Mod | What it does |
| --- | --- |
| [`usage-monitor`](usage-monitor/README.md) | Live token, cost and tool-call accounting for a session and every subagent: a status line, a `/usage-monitor` pane and a toast when a subagent finishes. Optionally reports to the [usage-monitor API](https://github.com/jommar/api) for history and a web dashboard. |

## Install

In a Claude Code terminal session:

```
/plugin install usage-monitor --marketplace jommar/mods
```

Answer `y` to add the marketplace, then pick a scope. The [mod's README](usage-monitor/README.md#install) has the
shell and desktop-app forms and what the install asks for.
