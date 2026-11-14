/** The tools of the Workbench's own MCP servers: `browser` drives the BrowserPane, `workbench` holds the chat tools. */

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> }

export const BROWSER_TOOLS: McpTool[] = [
  {
    name: 'get_state',
    description:
      'Get the Datapad Workbench in-app BrowserPane state: url, title, loading, visible, canGoBack, canGoForward, error. Use this after navigate to verify the page loaded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'navigate',
    description:
      'Open a URL in the Datapad Workbench BrowserPane — the in-app browser. Always use this instead of an external browser. Shows the pane if it is hidden. Use http or https only.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to load, e.g. http://localhost:3000' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'back',
    description: 'Go back in the Workbench BrowserPane history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'forward',
    description: 'Go forward in the Workbench BrowserPane history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'reload',
    description: 'Reload the current Workbench BrowserPane page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'stop',
    description: 'Stop loading the current Workbench BrowserPane page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the page open in the Workbench BrowserPane and return it as an image. Use it to see your own UI work after navigate, click or type.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'snapshot',
    description:
      'Read the page open in the BrowserPane: its visible text plus a numbered list of links, buttons and fields. Pass a number from this list as `ref` to click or type. Numbers change after every snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Cap on page text length. Default 6000.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'click',
    description:
      'Click an element in the BrowserPane page. Name it by `ref` (from snapshot), CSS `selector`, or its visible `text`. Returns the page state after the click.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element number from the last snapshot' },
        selector: { type: 'string', description: 'CSS selector' },
        text: { type: 'string', description: 'Visible text or label of the element' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description:
      'Type text into a field in the BrowserPane page. Name the field by `ref`, `selector`, or its label in `field`; leave all three out to type into the focused field. For a <select>, `text` picks the option by label or value.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        ref: { type: 'number', description: 'Field number from the last snapshot' },
        selector: { type: 'string', description: 'CSS selector of the field' },
        field: { type: 'string', description: 'Label, placeholder or name of the field' },
        clear: { type: 'boolean', description: 'Replace what the field holds instead of adding to it' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'press',
    description:
      'Press a key in the BrowserPane page, for example Enter, Escape, Tab, Backspace, ArrowDown, or a single character. Goes to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] }
        }
      },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'wait_for',
    description:
      'Wait until a CSS selector is visible, or some text appears, in the BrowserPane page. Returns found: false after the timeout instead of failing.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000, at most 30000' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'evaluate',
    description:
      'Run a JavaScript expression in the BrowserPane page and return its JSON value. Promises are awaited. For statements, wrap them: (() => { ...; return x })().',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    name: 'console',
    description:
      "Recent console messages from the BrowserPane page since it last navigated. Use it to find the page's errors.",
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'warning', 'error'], description: 'warning includes errors' },
        limit: { type: 'number', description: 'Most recent messages to return. Default 50.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'transcribe_youtube',
    description:
      'Fetch the official captions/transcript for a YouTube video. Pass a youtube.com, youtu.be, shorts, or embed URL, or an 11-character video id. Use this when the user wants a transcript, summary, or quotes from a YouTube video. Returns title, author, language, and timestamped text. Fails if the video has no captions.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'YouTube URL or video id'
        },
        lang: {
          type: 'string',
          description: 'Preferred caption language code, e.g. en. Defaults to English when available.'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  }
]

const AGENT = {
  type: 'string',
  enum: ['grok', 'claude'],
  description: 'grok for Grok Build, claude for Claude Code. Defaults to the agent set in Settings.'
}

export const WORKBENCH_TOOLS: McpTool[] = [
  {
    name: 'show_visual',
    description:
      'Show a visual inline in the chat: a chart, diagram, table or UI mock-up. Pass one self-contained HTML document. Inline <script> and <style> work; scripts and styles may also load from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com, and fonts from Google Fonts. Images must be inline: data: or blob: URLs, or inline SVG. Nothing else on the network is reachable, and the page runs in a sandbox with no storage. Use it when a picture explains the answer better than text. The user sees it in your reply where you call it.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'A complete HTML document' },
        title: { type: 'string', description: 'Short caption shown under the visual' }
      },
      required: ['html'],
      additionalProperties: false
    }
  },
  {
    name: 'delegate',
    description:
      'Hand a self-contained task to another agent in a new chat in this project, wait for it to finish, and return its final answer. The child chat shows in the sidebar so the user can follow it. The child starts with no context: put everything it needs in the brief (goal, files, what is already ruled out, the acceptance criteria its work must pass, what to return). Use it for independent work, or for a second opinion from the other agent.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The full task for the other agent' },
        agent: AGENT,
        model: {
          type: 'string',
          description:
            'Claude Code model for the child, which then runs on Claude Code: fable for a really hard task (it costs the most), opus for work that needs judgement, sonnet for routine work, haiku when a small, fast model is enough. Leave out for the model set in Settings. Settings can fix one model for every child; that one then wins.'
        },
        title: { type: 'string', description: 'Sidebar title for the child chat' },
        worktree: {
          type: 'boolean',
          description:
            'Give the child its own git worktree and branch so its edits stay apart. Removed again if the child changed nothing.'
        }
      },
      required: ['brief'],
      additionalProperties: false
    }
  },
  {
    name: 'nudge',
    description:
      'Send a follow-up message to a chat you started with delegate, wait for it to finish, and return its answer. The child keeps its context. Use it when the child stopped before its task was done, or its work did not pass your check.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id of the child, as delegate returned it' },
        message: { type: 'string', description: 'What is still missing or wrong, and what to do next' }
      },
      required: ['chat', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'list_chats',
    description: 'List the chats in this project: id, title, agent, message count, whether it is running, and its worktree branch.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'read_chat',
    description: 'Read another chat in this project. Pass its id or (part of) its title. Returns the latest messages.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id or title' },
        last: { type: 'number', description: 'How many of the latest messages to return. Default 20.' }
      },
      required: ['chat'],
      additionalProperties: false
    }
  },
  {
    name: 'start_chat',
    description:
      'Open a new chat in this project in the sidebar, optionally sending it a first message. Only when the user asks for a new chat; to get work done and hear back, use delegate.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'First message to send, if any' },
        agent: AGENT,
        title: { type: 'string', description: 'Sidebar title' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'handoff',
    description:
      'Continue this conversation in a new chat with a fresh context, when the user or Datapad Workbench asks for a handoff. The new chat gets only `summary`, saved as a handoff file, and works in the same folder on the same agent. Stop working in this chat after the call.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Markdown for an agent that has seen none of this conversation: the goal, where the work stands, decisions and why, the files that matter, what is verified and what is not, and what the user asked for that still holds'
        },
        next: { type: 'string', description: 'Unfinished work the user asked for, which the new chat starts with. Leave out when it should wait for the user' },
        title: { type: 'string', description: 'Sidebar title of the new chat; default: this chat\'s title' }
      },
      required: ['summary'],
      additionalProperties: false
    }
  }
]

/** Only a bot's own chats, outside any project, have these: they are how its unattended runs work. */
export const BOT_RUN_TOOLS: McpTool[] = [
  {
    name: 'notify',
    description:
      "Tell the user something, as a message from you in your own chat with a notification. In a scheduled run or a follow-up nobody is watching, and this is the only way the user hears from it: call it once, with a short message, when there is something new they need to know or act on, and not when there is nothing new. When the user is talking with you, just answer instead.",
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What the user needs to know: the outcome and key details, short' }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'follow_up',
    description:
      'Come back to this chat later, once, in this same session, for example to see whether something you are waiting for has happened. When the time comes you get `note` as a message and work unattended, as in a scheduled run. A chat has one follow-up; setting another replaces it. Datapad Workbench must be open; a follow-up missed while it was closed runs when it opens.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'For yourself when you come back: what to check, and why' },
        minutes: { type: 'number', description: 'Come back in this many minutes' },
        at: { type: 'string', description: 'Or come back at this local date and time, e.g. 2026-11-06T09:00' }
      },
      required: ['note'],
      additionalProperties: false
    }
  }
]

WORKBENCH_TOOLS.push(
  {
    name: 'schedule_task',
    description:
      'Run a prompt in this project later, once (at) or repeating (cron). Each schedule gets its own chat in the sidebar, and every run is a new message in that chat. Times are the user\'s local time. Datapad Workbench must be open for a run to start; a run missed while it was closed starts when it opens.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The message to send on each run. It must stand on its own.' },
        cron: {
          type: 'string',
          description: 'Five-field cron in local time, e.g. "0 9 * * 1-5" for weekdays at 9:00, or @hourly/@daily/@weekly'
        },
        at: { type: 'string', description: 'One run at this local date and time, e.g. 2026-11-06T09:00' },
        agent: AGENT,
        title: { type: 'string', description: 'Sidebar title' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'cancel_schedule',
    description: 'Stop a scheduled task. Pass its chat id or title (list_chats shows which chats have a schedule). The chat itself stays.',
    inputSchema: {
      type: 'object',
      properties: { chat: { type: 'string', description: 'Chat id or title' } },
      required: ['chat'],
      additionalProperties: false
    }
  },
  {
    name: 'link_pr',
    description:
      'Link a GitHub pull request to this chat. The chat header shows its checks and review state, and by default Datapad Workbench watches it: when checks finish, a review comes in or it is merged or closed, this chat gets a message so you can act on it. Leave pr out to use the PR of the current branch. Needs the GitHub CLI (gh), signed in.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: ['string', 'number'], description: 'PR number, URL or branch; default: the current branch\'s PR' },
        watch: { type: 'boolean', description: 'Wake this chat on changes (default true)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'pr_status',
    description: 'Checks, review state and latest reviews of the PR linked to this chat, or of another PR.',
    inputSchema: {
      type: 'object',
      properties: { pr: { type: ['string', 'number'], description: 'PR number, URL or branch; default: the linked PR' } },
      additionalProperties: false
    }
  },
  {
    name: 'unlink_pr',
    description: 'Unlink the pull request from this chat and stop watching it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'request_secret',
    description:
      'Ask the user for a secret, such as an API key, token or password, without it passing through you. The user types it into a password field in the chat; Datapad Workbench keeps it encrypted for this project and sets it as an environment variable in your shell from the next turn. You get the name only, never the value. Use it whenever you need a secret: never ask for one in a chat message. Use the variable as $NAME in commands and never print it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Environment variable name, e.g. STRIPE_SECRET_KEY' },
        reason: { type: 'string', description: 'One sentence for the user: what it is for and where to find it' }
      },
      required: ['name'],
      additionalProperties: false
    }
  }
)
