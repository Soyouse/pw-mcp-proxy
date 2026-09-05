# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — instance cleanup on POSIX waited for the wrong fact (2026-09-05)
- Found by the nightly live suite on Ubuntu, reproduced on a Linux host: Playwright starts Chrome in
  its own process group, so killing the guard's group leaves Chrome alive for ~0.5 s; it then shuts
  down cleanly and writes into its `--user-data-dir` **after** the daemon had renamed, snapshotted
  and removed the instance directory (POSIX has no file locks to stop the rename). Result: a ghost
  instance directory left forever and a snapshot taken before Chrome's final flush. Windows hid the
  defect through its file locks.
- `attendreLibre` now lists the processes whose command line names the instance directory (pure
  `tenantsDuDossier`, token-bounded so `live-1` never matches `live-10`), asks the kernel PID by PID
  whether they are still alive, and only renames once they are all gone. Same single declared delay.

### Changed — config hot-reload driven by kernel events (2026-09-05)
- `profiles.json` is now watched with `fs.watch` on its **parent directory** (inode caveat from the
  Node docs: an atomic save replaces the file's inode and silently kills a watch placed on the file)
  instead of `fs.watchFile` polling every second for the life of every proxy.
- **The content decides, never the event**: a sha256 of the bytes is compared with what is loaded.
  Duplicate events, a `null` filename, an antivirus touching the file, or a half-written file
  (invalid JSON) change nothing; the write that completes triggers the reload. A config the manager
  rejects keeps the old one and is judged again on the next wake-up.
- One declared delay only: re-reading when another process holds the file (`EBUSY`/`EPERM`/…,
  schedule `[100, 500, 2000]` ms), with an alert when exhausted. Falls back to polling, loudly, when
  the OS cannot deliver events (NFS/SMB). New pure module `config-watch-pure.js` under mutation.

### Changed — one instance per client (2026-09-05, ADR 0002)
- **No more shared server.** Every MCP client gets its own `@playwright/mcp` server, its own Chrome
  and its own throwaway profile directory. Measured on the real binary: with
  `--shared-browser-context`, agent B's navigation replaced agent A's page. The flag is now
  forbidden by a static AST gate (`rules/no-forbidden-flag.yml`).
- **Identity = a snapshot of the Chrome user data directory without caches**, kept in a capped
  store (`identityStore`: per-identity cap, total cap, retention). Materialized into a fresh
  instance directory for each client, saved back atomically (rename) when the client leaves
  (`persist: true`). Cookie-only files are not enough: Google sessions are device-bound (DBSC) —
  cookies alone died within 10 min in our measurement, the directory snapshot survived.
- **`PW_MCP_PROFILE`** pins a proxy to a profile at boot (unknown name = named refusal). Several
  MCP entries pinned on several profiles = several parallel agents.
- **`storage` capability is always on** (identity export/import tools); `proxyServer` per profile
  → `--proxy-server`; `--allowed-hosts` is never passed (the MCP layer compares the full
  `host:port` and its default is already right).
- **`maxBrowsers` now counts live instances** (= browsers), whatever the profile.
- **Loopback resilience on Windows**: libuv does not retransmit SYNs to 127.x; the HTTP transport
  now keeps connections alive and replays a failed `connect` on the kernel's own schedule
  (1 s, 2 s). Optional `bindHost`/`bindHostInterface` (never routable, validated against the OS
  interfaces).
- Janitor: instance directories are ours (prefix), orphaned ones are purged when no daemon lives;
  the identity store is never touched by the janitor.
- `contract-live` rewritten: two independent instances, identity round-trip, 5 s heartbeat
  (+ negative check), a **detectability sentinel** (`--isolated` must stay detected as private
  browsing by `detectincognitojs@1.9.0`, a persistent profile must not), run under `xvfb-run`
  in the nightly workflow. `profiles.example.json` pins `@playwright/mcp@0.0.80`.
- Tools: `tools/migrer-identite.mjs` (v1 directory → identity store), `tools/basculer-v2.mjs`
  (config v1 → v2, stops the old daemon), `tools/capture-contrat.mjs` (contract derived from `--help`).

### Added
- **Single daemon holding all shared servers.** The number of open sockets on its channel *is* the
  client count — an exact fact from the kernel, released even on `kill -9`.
- **`child-guard`**: every browser server runs under a guard tied to the daemon by a pipe. If the
  daemon dies for any reason, the kernel closes the pipe, the guard sees EOF and stops the server.
  Orphaned browsers holding a `--user-data-dir` forever are now impossible by construction.
- **`maxBrowsers`** (optional, absent = unlimited): refuses a new profile with a named error;
  it never evicts a running one.
- Integration suite now runs as a **matrix over both transports** (stdio and http).
- Static gates: declared silences, arborescence coverage, allocation/bind host coherence,
  test timeout vs readiness budget.

### Changed
- Readiness budget `20s → 90s`, anchored on systemd's `DefaultTimeoutStartSec`. A slow start on a
  busy machine is not a failure; process death is still detected immediately and ends the wait.

### Fixed
- **Ports were allocated on the wrong address family.** `localhost` is not `127.0.0.1`: on a
  dual-stack host it resolves to `::1` first. Ports were reserved on IPv4 while the server bound
  IPv6, producing "server alive but silent" failures long blamed on machine load.
- Config hot-reload had no effect in http mode: the proxy kept its daemon connection, so the daemon
  handed back the same server with the old arguments.
- A daemon that never served a profile stayed alive forever.
- A failed kill after an aborted start was swallowed, silently leaking a server.

### Removed
- File registry, launch lock, heartbeats, TTL, reaper, process identity and the TLA+ lock spec —
  all made pointless by kernel ref-counting. **−1313 lines (−31%).**
