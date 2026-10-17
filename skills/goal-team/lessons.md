# goal-team seed lessons

Verified lessons from previous fixing sessions — every builder starts with these.
Promote new lessons with `goalctl lesson "<text>"` only AFTER independent verification.

## Windows traps (verified 2026-10-16/17)

- `bash` on PATH = WSL launcher (`C:\Windows\System32\bash.exe`) which mangles `\` paths
  (exit 127). Never invoke bare `bash`; use Git bash explicitly or avoid the shell entirely.
- `os.homedir()` ignores `$HOME` on Windows (uses USERPROFILE). Tests must set BOTH or use
  an explicit `GOAL_TEAM_HOME` override.
- POSIX mode constants (`S_IRWXU` etc.) are `undefined` on Windows → `chmod(0)` marks files
  READONLY. Use numeric literals (`0o644`/`0o755`).
- Windows PowerShell 5.1 `Get-Content`/`Set-Content` round-trips corrupt non-ASCII (CP1251).
  Use pwsh 7.x or bun/node file APIs.
- Git bash MSYS rewrites argv that looks like POSIX paths (`/goal…` →
  `C:/Program Files/Git/goal…`). Scope `MSYS2_ARG_CONV_EXCL='*'` to prompt-bearing calls.
- jq 1.8.x: `\b` does not match through `--arg`; unescaped `[` breaks regex compilation.
  Prefer bun for regex work — no jq dependency at all.

## bun runtime traps (verified 2026-10-17 while building goal-team)

- A script that calls `main()` without top-level `await` can exit 0 before async stdin reads
  resolve (silent no-output on Windows). Use `await main().catch(...)` for stdin-driven
  hooks/CLIs.
- Normalize spawn cwd with `path.join(dir, "..")`; string concat `dir + "/.."` yields a
  mixed-separator path that breaks child script resolution in spawned tests.
- Text files created on Windows get CRLF; regexes anchored on `\n` must tolerate `\r?\n`.
- Never chain `git commit` after a test run with `;` in one shell line — gate the commit on
  green (`if ($LASTEXITCODE -eq 0) {...}`). A chained commit once shipped a failing state.
- Id-derived file names need a DIGEST suffix: sanitize-only keys collide ("a/b" → "a_b"
  shares a file with the real "a_b", mixing two sessions' state) and raw ids in lock paths
  break ("a/b" → `locks/a/b.lock` → ENOENT). Use
  `safeKey(s).slice(0, 32) + "-" + sha1(s).slice(0, 8)` for every id-derived path.
- npm CLI shims (`backlog.ps1`/`backlog.cmd`) cannot be spawned directly — CreateProcess
  rejects script shims. On win32 resolve via `cmd.exe /d /c <tool>.cmd`; verify with the
  tool's own `--version` before trusting the integration.
- PowerShell `& ([scriptblock]::Create($cmd))` piped to a native exe never closes its
  stdin (the child hangs). To replay a configured hook command, extract the exact
  executable+args and drive them via `Bun.spawn` with `stdin: "pipe"` — the same paths,
  without the shell quirk.

## Process lessons (1.1.23 fixing session)

- Test suites must isolate state via `GOAL_TEAM_HOME`; tests must never touch live
  `~/.copilot`/`~/.goal-team` state.
- A first install into a clean profile always succeeds — the SECOND run exposes
  read-only/copy bugs. Always test the second run too.
- Count status lines with a regex over the whole output; never eyeball truncated output for
  exact numbers.
