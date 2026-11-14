---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Themes

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The UI's colors and fonts come from a theme file. Three built-in themes ship with the app, and users can save, import, export and delete their own. Activating a theme applies its colors to the document and adds the font stylesheet links it needs. A React provider holds the current theme and exposes it through `useTheme`. The theme editor changes colors with pickers and shows them on a live preview.

## Works with

- [[generated/concepts/Persistence Store.md|Persistence Store]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `themes.ts`: Lists, activates, saves, imports and deletes UI themes.
- `src/renderer/src/theme/`: Applies a theme file to the running interface and syncs the font stylesheet links it needs.
  - `apply.ts`: Applies a theme file to the document and syncs its font links.
  - `ThemeProvider.tsx`: React context provider holding theme state, exposed through the useTheme hook.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `ThemeEditor.tsx`: Edits theme colors with pickers and a live mock preview.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `theme.ts`: Theme file types, version, color keys and color groups.
- `themes/`: The built-in appearance themes that ship with the app, one JSON file each.
  - `brass-console.json`: Built-in theme named Brass Console.
  - `signal-night.json`: Built-in theme named Signal Night.
  - `warm-atelier.json`: Built-in theme named Warm Atelier.
