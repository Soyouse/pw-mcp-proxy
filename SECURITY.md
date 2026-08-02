# Security Policy

## Reporting a vulnerability

Please use **GitHub's private vulnerability reporting** (Security → Report a vulnerability) on this
repository. Do not open a public issue for anything exploitable.

## Threat model — what this proxy is, and is not

`pw-mcp-proxy` multiplexes several MCP clients onto shared [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
servers on **one machine, for one user**. Everything it opens is local:

- **HTTP servers bind `localhost` only** — never `0.0.0.0`. `@playwright/mcp` additionally validates
  the `Host` header (anti DNS-rebinding), which is why clients must use `http://localhost:<port>/mcp`
  and never `http://127.0.0.1:<port>/mcp` (that returns `403`).
- **The daemon channel is a named pipe (Windows) or a Unix domain socket**, scoped to the current
  user. It is not reachable from the network.
- **There is no authentication** on the local endpoints, by design: they are same-user, same-host.
  Anything already running as your user can reach them — the same trust boundary as your shell.

## What we consider a vulnerability

- Reaching a proxy, daemon or browser server **from another machine**, or **as another OS user**.
- Making the daemon **spawn a process the requesting client did not specify**. The daemon's
  `validerRequete` deliberately returns only `{command, args}` and ignores any `cwd`/`env`/`shell`
  sent by a client; widening that boundary would be a vulnerability.
- **Leaking one profile's cookies or session into another.** Profile isolation (one Chrome
  `--user-data-dir` per identity) is the core security property of this project.

## What we do not consider a vulnerability

- Another process running **as you** talking to your local endpoints (see threat model).
- Browser-level issues in Chromium or `@playwright/mcp` — report those upstream.

## Handling of secrets

This repository is public and contains **no credentials**. `profiles.json` (your real profile paths
and optional alert URL) is **git-ignored**: only `profiles.example.json` is tracked. Alert URLs come
from your config or `PW_MCP_NTFY_URL` — nothing is hardcoded.

⚠️ **Your Chrome `--user-data-dir` folders contain live logins.** Keep them out of any repository,
backup or bug report.
