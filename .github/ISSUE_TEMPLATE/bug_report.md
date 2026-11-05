---
name: Bug report
about: Something in nb behaves incorrectly — a wrong result, a crash, or a surprising error.
title: "bug: "
labels: bug
---

<!--
Thanks for the report! agent-notebook leans on concrete, file-cited evidence,
so a short repro with real output beats a description every time. Please keep
the fields below filled in — they are what makes a bug fast to triage.
-->

## What happened

<!-- The actual behavior: the wrong result, the error text, or the crash. -->

## What you expected

<!-- What should have happened instead. -->

## Minimal repro

<!--
The shortest sequence of `nb` commands that reproduces it, with the output.
A fresh notebook dir is ideal, e.g. NB_DIR=$(mktemp -d) nb add ...
-->

```
$ nb ...
```

## Environment

- `nb --version`:
- OS / platform (e.g. macOS 14, Ubuntu 24.04, Windows 11 WSL2):
- Node version (`node --version`):
