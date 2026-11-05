# Security

## Report a vulnerability

Do not open a public issue.

Use [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability) on this repository.

This app is unofficial. Bugs in Grok Build itself belong with SpaceXAI / xAI, not here.

## What this app stores

- Settings and chat metadata live in Electron `userData/workbench`
- An API key may be stored there, or read from `XAI_API_KEY` / `grok login`
- The in-app browser uses a persistent partition under that same folder

Do not commit those files.

## Scope

In scope: this desktop app (main process, preload, renderer, bundled browser MCP).

Out of scope: the `grok` CLI, xAI APIs, and third-party MCP servers you attach.
