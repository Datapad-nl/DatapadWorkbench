# Security

## Report a vulnerability

Do not open a public issue.

Use [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/privately-reporting-a-security-vulnerability) on this repository.

This app is unofficial. Bugs in Grok Build itself belong with SpaceXAI / xAI, not here.

## What this app stores

- Settings and chat metadata live in Electron `userData/workbench`
- An API key may be stored there, encrypted with the system keychain, or read from `XAI_API_KEY` / `grok login`
- Secrets you give an agent are stored there in `secrets.json`, encrypted with the system keychain. An agent gets them as environment variables of its shell, and any program running as your user can read a process's environment
- The in-app browser uses a persistent partition under that same folder

Do not commit those files.

## Scope

In scope: this desktop app (main process, preload, renderer, the Workbench MCP servers it serves to its agents).

Out of scope: the `grok` CLI, xAI APIs, and third-party MCP servers you attach.
