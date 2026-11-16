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
- `src/renderer/src/theme/`
  - `apply.ts`
  - `ThemeProvider.tsx`
- `src/renderer/src/components/`
  - `ThemeEditor.tsx`
- `src/shared/`
  - `theme.ts`
- `themes/`: The built-in appearance themes that ship with the app, one JSON file each.
  - `brass-console.json`: Built-in theme named Brass Console.
  - `signal-night.json`: Built-in theme named Signal Night.
  - `warm-atelier.json`: Built-in theme named Warm Atelier.
