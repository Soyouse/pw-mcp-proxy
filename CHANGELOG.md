# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
