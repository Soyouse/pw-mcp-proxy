# Contributing

Thanks for looking. This project is small on purpose (~3 000 lines, **zero runtime dependencies**)
and it is meant to run unattended for years. The rules below are what keeps it that way — they are
enforced by tests, not by review.

## Getting started

```bash
git clone https://github.com/Soyouse/pw-mcp-proxy && cd pw-mcp-proxy
npm install            # dev tooling only — the runtime has no dependencies
cp profiles.example.json profiles.json   # then edit paths
npm test               # full suite, must be green before you push
```

Node 20+. Windows, macOS and Linux are all supported and all tested in CI.

Optional, slower checks:

| Command | What it does |
|---|---|
| `npm run test:mut` | mutation testing on pure modules (threshold 94, never lowered) |
| `npm run arch` | module boundaries (`dependency-cruiser`) |
| `PW_MCP_LIVE=1 npx vitest run tests/contract-live.test.js` | runs against the real `@playwright/mcp` — downloads a real browser |

## The five rules that matter

**1. Zero runtime dependencies.** `package.json` has no `dependencies` field and must not gain one.
Dev tools (vitest, Stryker, fast-check, ast-grep) are fine.

**2. Ask what *knows*, before reaching for a timer.** Locally, the kernel already knows: a process
exited, a socket closed, a port is taken (`EADDRINUSE`). A delay used where an exact fact exists is
a bug, and `no-inference-gate` will fail your push. Every temporal call is detected by AST and must
be declared with a motive — only `distant` (no local authority to ask) and `indécidable` (the
halting problem, e.g. "is this backend frozen or just busy?") are accepted.

**3. A silence must be declared.** We do *not* require every `catch` to shout — making a failure
visible is a behaviour change, and some silences are mandatory (logging a logging failure recurses).
What is refused is the *undeclared* silence: write `catch { /* SILENCE: why */ }`, or log properly.

**4. A test that cannot fail is not a proof.** When you seal a mechanism, break it on purpose and
*check that your test goes red*, then restore. Also ask whether it discriminates **on your OS** —
we shipped a test that stayed green on Windows because the OS already did the job.

**5. Delete rather than add.** Before writing a component, ask whether the OS, the protocol or the
product already does it. We removed 1 313 lines this way, including a formally-verified lock that
should never have existed.

## Pull requests

- One concern per PR.
- The commit message explains **why**, not what — the diff already says what. If a measurement drove
  the change, put the numbers in.
- New non-trivial file ⇒ add its line to `ARBORESCENCE.md` (a gate checks both directions).
- Found a trap? Seal it with a gate in the same PR. A rule written in prose gets forgotten; a red
  test does not.

## Reporting bugs

Include your OS, Node version, the relevant part of `pw-mcp-proxy.log`, and what you expected.
⚠️ **Scrub the log first** — it contains your profile names and paths.

Security issues: see [SECURITY.md](SECURITY.md), do not open a public issue.
