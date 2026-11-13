# Workbench UI redesign: implementation instructions

Reference: a 1600×1000 mockup, since removed from the repo because it showed private project names.

This document tells you how to turn the current UI into the mockup. It changes layout, hierarchy and styling. It does **not** add backend features: where the mockup shows data the app may not have (token counts, context %, model name), show it only if the data already exists, otherwise leave that element out.

## 1. Principles

1. **One accent, used as a mark.** Brass (`--color-accent`) marks the current thing: the open chat, the active mode, the current turn, the Send button. Never use it for borders of boxes or for large fills.
2. **Hierarchy through weight and contrast, not capitals.** Remove spaced uppercase labels (`YOU`, `GROK`, `REPLY`, `TURN`, `OTHER`, `INDEXED`). Use sentence case at a smaller size or a dimmer color instead.
3. **Actions appear on hover.** Row actions (`+`, `…`, copy, retry) are hidden or faint until the row is hovered or focused. Keyboard focus must show them too.
4. **Icons for toggles, words for content.** Pane toggles become icons with tooltips; text is kept for things the user reads.
5. **Everything stays themeable.** Use only theme tokens (section 2). The three themes in `themes/` must all keep working.

## 2. Tokens

Add these derived tokens to `src/renderer/src/styles/globals.css` (inside `@theme`) so they follow whichever theme is active, without changing the theme JSON schema:

| Token | Value | Use |
|---|---|---|
| `--color-faint` | `color-mix(in srgb, var(--color-muted) 62%, var(--color-canvas))` | timestamps, hints, metadata |
| `--color-ink-2` | `color-mix(in srgb, var(--color-ink) 80%, var(--color-canvas))` | secondary body text, inactive names |
| `--color-hover` | `color-mix(in srgb, var(--color-raised) 55%, var(--color-sidebar))` | row hover |
| `--color-line-strong` | `color-mix(in srgb, var(--color-line) 70%, var(--color-ink) 8%)` | card outlines, selected states |
| `--color-accent-soft` | `color-mix(in srgb, var(--color-accent) 12%, transparent)` | active mode, turn chip fill |
| `--color-accent-line` | `color-mix(in srgb, var(--color-accent) 35%, transparent)` | active mode, turn chip border |
| `--color-ok` | `#7fbf8e` | idle/connected dots, success checks |

Check `--color-line-strong` against all three themes; adjust the mix if it is invisible on `warm-atelier`.

### Type scale

Use only these sizes. Remove one-off sizes as you touch each component.

| Role | Size / weight |
|---|---|
| Message body | 14.5px / 400, line-height 1.6 |
| Titles (breadcrumb, pane title) | 13px / 600 |
| Row text (projects, chats, tabs, events) | 12.5–13px / 400; active 500 |
| Meta (times, counts, hints) | 11px / 400, `tabular-nums` |
| Code, paths, branch names | `--font-mono` 11–11.5px |

### Spacing and radius

- 4px grid. Rows are 30px tall. Icon buttons 28px (24–26px inside rows), radius 7px.
- Cards and code blocks: radius 8px. Composer: 16px. User bubble: `14 14 4 14`.

## 3. Window layout

```
┌──────────── title bar 48px (spans all columns) ─────────────┐
│ sidebar 272 │ main (tabs 40 + thread + composer) │ right pane │
└──────────── status bar 28px (spans all columns) ────────────┘
```

- File: `src/renderer/src/App.tsx` (`Shell`). Keep the existing resizable widths and their `localStorage` keys for the right panes.
- **Dividers are 1px `--color-line`.** Remove the thick brass sidebar splitter. Keep the resize hit area at 6px wide but invisible. Show a 1px `--color-accent-line` only while hovering or dragging.

## 4. Title bar (new, spans the window)

Today each column has its own header. Combine them into one 48px bar, still split at the column edges so each part lines up with the column under it:

- **Over the sidebar:** traffic-light space (`--spacing-traffic`), then a sidebar-collapse icon on the right.
- **Over the main column:** breadcrumb `folder-icon  project / chat title`, with the project in `--color-muted` and the chat title in `--color-ink` 600. After it, a mono chip with the branch (or `no git`). On the right, a **segmented icon group** for the four right panes: Git, Browser, Activity, Knowledge. The open pane has a raised background and an inset `--color-line-strong` ring. Each icon has a tooltip with the name and shortcut.
- **Over the right pane:** the pane's title (13px/600), a status pill (`● Idle`, green dot; `● Working` with the accent dot pulsing), then icon buttons for Clear (trash) and Close (×).
- The whole bar is `.drag`; every control in it is `.no-drag`.

These replace the `Git / Browser / Thought process / Knowledge  Show/Hide` rows at the bottom of the sidebar (`ActivityToggle`, `BrowserToggle` and friends in `Sidebar.tsx`). **Keep pane reordering:** move `ReorderGrip` / `swapRightPanes` to dragging the icons inside the segmented group, or keep the grip in the right pane's header.

## 5. Sidebar (`Sidebar.tsx`)

Top to bottom:

1. **Search field**: 32px, `--color-surface` fill, 1px `--color-line`, search icon, placeholder "Search projects and chats", `⌘K` key hint on the right. It filters projects and chats by name.
2. **New chat** row: plus icon, "New chat", `⌘N` hint. Creates a chat in the current project.
3. **Section label "Projects"**: 11px/600, `--color-faint`, sentence case, with a `+` (new project) on the right. This replaces the "New project" text button in the header.
4. **Project row** (30px):
   - chevron (12px, faint) · **initial badge** (18px square, radius 5, first letter on a color picked from a fixed palette by hashing the project id) · name · right side: branch in mono 10.5px faint, **or** the chat count as a small pill when the project is expanded.
   - Do not show the old colored dots.
   - `+` and `…` appear **only on hover or focus**, replacing the branch text.
   - The expanded project is `--color-ink` 500; the others are `--color-ink-2`.
5. **Expanded project info line**: `● Indexed · /private/tmp` in mono 11px faint, indented to the name. The dot is green when indexed and accent (pulsing) while indexing. This replaces `INDEXED · 0`.
6. **Chats**: indented under the project with a 1px `--color-line` tree line on the left.
   - Each row shows the title and a relative time (`now`, `2m`, `1h`, `3d`) on the right.
   - **Titles:** stop showing "Grok session" for every chat. When a chat or an imported session (`syncGrokSessions` / `syncClaudeSessions` in `src/main/store.ts`) has the default title, show its first user message, cut to one line. Store it as the title when the first message is sent, unless the user renamed the chat.
   - The active chat has a raised background, an inset `--color-line-strong` ring, and a 2px brass bar on the tree line.
   - A chat that is streaming shows a small brass dot in place of the time.
   - After 5 chats, show "Show N more" in faint text.
7. **Section "Worktrees"**: projects whose folder is a git worktree (today shown as `GrokCode-0569…  grokcode/0569…`). Show them in their own group with a branch icon instead of a badge, the parent repo name in `--color-muted`, and the branch in mono. Keep the existing worktree data; this only regroups it.
8. **Footer** (border-top): 28px avatar with initials · account name and a line like "SuperGrok · Claude connected" · settings gear. This replaces the `Settings … Claude` row. Clicking the gear opens Settings as it does today.

## 6. Main column (`ChatPane.tsx`)

### Tab bar (`TabBar`)

- 40px tall, tabs sit on the bottom border. The active tab has a `--color-surface` fill, a 1px line on three sides, and joins the thread area below it (no bottom border).
- Each tab: a 6px dot (brass when active or streaming, faint otherwise), the title (cut at 240px), and × shown on the active or hovered tab.
- Remove the blue left marker. Replace the "New chat" text on the right with a `+` icon right after the last tab.

### Thread (`MessageList`)

- Thread background `--color-surface`; content column 720px wide, centered; 28px between messages.
- **Day divider** at the start of each day: "Today · 10:11 PM", 11px faint, centered between hairlines.
- **User message**: right-aligned bubble, max 560px, `--color-raised` fill, 1px `--color-line-strong`, radius `14 14 4 14`, 14.5px text. Time below it in 11px faint.
- **Assistant message**: a 28px icon tile on the left (ink fill with the agent glyph; for Claude, the Claude glyph). The header shows the agent name in 13px/600 and meta in faint (`model · duration`, only what exists). Body text is 14.5px/1.65.
- **Tool use inside a reply**: in the reply, show one pill per group of tool calls: `✓ Used browser.get_state · 2 steps · 4.1s ›`. Clicking it opens that turn in the Activity pane, or expands it in place if that pane is closed. Failed groups use `--color-danger` with ✕.
- **Reply actions** under each assistant message: copy, retry, branch (icons, faint), plus the token count if known. Faint at rest, `--color-muted` on hover. Wire them only to actions that already exist (copy, `/rewind`, etc.); leave out any that have no existing action.
- Remove the `YOU` and `GROK` labels.
- `PlanCard`, `PermissionBar` and `QuestionCard` keep their logic. Restyle them as cards: `--color-raised`, radius 8, 1px `--color-line-strong`. Their main button uses the Send button style.

### Composer (`Composer`)

- Width 720px, centered, 18px from the bottom. Card: `--color-raised`, 1px `--color-line-strong`, radius 16, shadow `0 18px 40px -18px rgba(0,0,0,.7)`.
- Placeholder: "Ask Grok anything…" (use the active agent's name). Move the `@ a file · / commands · ⌘V pastes a screenshot` hints out of the placeholder.
- Toolbar row, left to right:
  - icon buttons: attach, `@` (opens mention), `/` (opens slash menu)
  - a 1px divider
  - **mode switch** (`ModeToggle`): Ask / Auto / Plan. The active mode gets `--color-accent-soft` fill, accent text and an inset `--color-accent-line` ring.
  - agent/model chip (`AgentToggle`) with a chevron
  - spacer
  - context ring with "9% context" (only if context data exists)
  - mic (`MicIcon`)
  - **Send**: a 32px rounded-square (radius 10) in solid `--color-accent` with an ↑ arrow in `--color-accent-ink`. While streaming it becomes a Stop button (■) with the same shape. When the input is empty, lower its opacity to 0.45; never make it muddy brown.
- **Hint line** under the composer, 11px faint, centered: `↵ send · ⇧↵ new line · Esc Esc rewind · <mode hint>`. Take the mode part from `MODE_HINT`, shortened: "Tools auto-approved", "Tools wait for Allow", "Read-only until you approve".

### Empty state (`EmptyState`)

Use the same column. Show a centered agent tile, "What should we build in **{project}**?", and 3 suggestion chips in the user-bubble style, with the composer at the bottom.

## 7. Activity pane (`ActivityApp.tsx`, was "Thought process")

- Rename the pane to **Activity**. Its header lives in the title bar (section 4).
- **Filter bar** (under the title bar, 1px bottom border): a segmented control `All 6 · Tools 2 · Edits 0 · Replies 2` with counts in faint. Drop the per-turn text chips from the filter row; turns become groups (next point).
- **Turn groups**: events are grouped by turn, newest turn first and expanded; older turns are collapsed into a single card: `› Turn 1 · <prompt, one line> · 1.4s`.
  - Header: an accent chip `Turn N` (`--color-accent-soft` fill, `--color-accent-line` border; muted styling when collapsed), the prompt (12.5px/500, one line), and the total duration on the right.
- **Timeline**: each event has a 19px rounded-square node on a 1px vertical line. Draw the connector between nodes only (`.ev:not(:last-child)::before`), so it never runs past the last event. Node icon by kind (`kindLabel`):

  | Kind | Icon | Node style |
  |---|---|---|
  | plan / goal / thought | sparkle | accent |
  | tool (lookup) | search | default |
  | tool (call, success) | check | `--color-ok` |
  | tool (call, failed) / error | × | `--color-danger` |
  | write (reply) | speech bubble | default |
  | edit | pencil | default, show `+N −M` |
  | permission | shield | accent |

  Each event row has a human label ("Called `browser.get_state`", "Wrote reply"), a short detail in 12px muted below it, and on the right the duration (preferred) or the clock time.
- **Tool results**: show them in a code card with a header (`globe Result · JSON`, copy icon on the right) and light JSON syntax colors (keys blue-grey, strings green, booleans and numbers orange). Truncate to `EXCERPT_LINES` and end with a dashed-top "Show N more lines" row. This replaces the plain "Show more" text.
- Raw tool names like `select:mcp__browser__get_state` are shown as `browser.get_state` (strip `select:` and `mcp__`, and turn the `__` between server and tool into `.`).

## 8. Status bar (`StatusBar.tsx`)

28px, `--color-sidebar`, 11px muted, icons 12px faint.

- **Left:** `● Connected · grok agent` (green dot; red with "Disconnected" when the agent is down), `CodeGraph indexed`, the project path.
- **Right:** `Usage` + a 64×4px meter (accent fill) + `38% · resets 2h 14m`. This replaces the empty ring. Clicking it opens the usage popover as today. Then `⌘K Commands`.

## 9. States to cover

Each of these must look intentional in all three themes:

- hover and keyboard focus on every row and button: 2px `--color-accent-line` focus ring, offset 1px
- streaming: the tab dot pulses, the chat row shows a dot instead of the time, the Activity status pill says "Working", Send turns into Stop
- empty app (no projects), an empty project, an empty Activity pane ("Waiting for a chat")
- a long chat title or branch name: cut it with an ellipsis and never wrap; the full text goes in a `title` attribute
- narrow window: the right pane collapses at its existing `COLLAPSE_*` widths; the composer and thread shrink to `min(720px, 100% - 40px)`

## 10. Order of work

1. Tokens and type scale (`globals.css`). Check all three themes.
2. Window grid, the unified title bar, and the pane toggle group (`App.tsx`, `Sidebar.tsx`). Delete the old toggle rows.
3. Sidebar: search, project rows, chat tree, worktree section, footer. Chat titles from the first message (`store.ts`).
4. Thread and composer (`ChatPane.tsx`).
5. Activity pane (`ActivityApp.tsx`).
6. Status bar.
7. Check states (section 9).

## 11. Done when

- [ ] The running app matches the mockup at 1600×1000 with the default theme.
- [ ] No uppercase letter-spaced labels remain.
- [ ] No two chats in the sidebar read "Grok session".
- [ ] Every right pane can be opened, closed and reordered from the title bar.
- [ ] Brass appears only on the open chat, the active mode, the current turn chip, focus rings, the usage meter and Send.
- [ ] `brass-console`, `signal-night` and `warm-atelier` all render without invisible lines or unreadable text.
- [ ] After each step: run the dev app, open `http://localhost:<dev port>` in the BrowserPane via the `browser` MCP (`navigate`), call `get_state`, and compare with the mockup.
