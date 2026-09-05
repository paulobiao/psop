#!/usr/bin/env python3
"""Launch a lab service detached in its own session.

Usage: spawn.py <logfile> <command> [args...]

The process:
  * redirects stdout and stderr (append) to <logfile>, closes stdin;
  * calls setsid() so it becomes a session/process-group leader with no
    controlling terminal (survives the parent shell exiting, and lets the
    lab manager stop the whole tree by signalling the group);
  * exec()s the command, so the recorded PID *is* the process group id.

Environment is inherited from the caller. Secrets passed via environment
(e.g. PSOP_SPECO_PASSWORD) are never written to the log or argv.
"""
import os
import sys

if len(sys.argv) < 3:
    sys.stderr.write("spawn.py: need <logfile> <command> [args...]\n")
    sys.exit(2)

logfile = sys.argv[1]
cmd = sys.argv[2:]

fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.dup2(fd, 1)
os.dup2(fd, 2)
if fd > 2:
    os.close(fd)

devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
if devnull > 2:
    os.close(devnull)

os.setsid()

try:
    os.execvp(cmd[0], cmd)
except OSError as exc:  # pragma: no cover - surfaced via the service log
    sys.stderr.write(f"spawn.py: cannot exec {cmd[0]!r}: {exc}\n")
    sys.exit(127)
