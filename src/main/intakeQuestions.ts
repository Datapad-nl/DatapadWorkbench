import type { Project, UserQuestion } from '../shared/types'
import { askOnce } from './askOnce'
import type { ProjectScan } from './projectScan'

export type GeneratedIntake = {
  title: string
  questions: UserQuestion[]
}

function option(label: string, description: string): UserQuestion['options'][number] {
  return { label, description, preview: null }
}

function q(
  question: string,
  options: UserQuestion['options'],
  multiSelect = false
): UserQuestion {
  return { question, header: null, multiSelect, options }
}

export function scanDossier(project: Project, scan: ProjectScan): string {
  const lines = [
    `Name: ${project.name}`,
    `Path: ${project.path ?? '(none)'}`,
    scan.packageName ? `Package: ${scan.packageName}` : null,
    scan.kind ? `Kind: ${scan.kind}` : null,
    scan.stackLabel ? `Stack: ${scan.stackLabel}` : null,
    `Folder: ${scan.hasFolder ? (scan.empty ? 'empty' : `${scan.fileCount} source files`) : 'not attached'}`,
    scan.scripts.length ? `Scripts: ${scan.scripts.join(', ')}` : null,
    scan.notable.length ? `Notable libraries: ${scan.notable.join(', ')}` : null
  ].filter(Boolean) as string[]
  for (const finding of scan.findings) {
    lines.push(`${finding.field}: ${finding.values.join('; ')} (${finding.source})`)
  }
  if (scan.tree) {
    lines.push('Top-level:')
    lines.push(scan.tree)
  }
  if (scan.readme) {
    lines.push('README / rules excerpt:')
    lines.push(scan.readme)
  }
  return lines.join('\n')
}

function fallbackQuestions(project: Project, scan: ProjectScan): GeneratedIntake {
  const kind = scan.kind ?? ''
  if (!scan.hasFolder) {
    return {
      title: `What is ${project.name}?`,
      questions: [
        q('What should this project become?', [
          option('A product I will use myself', 'Personal tool or app'),
          option('Something a team or company will run', 'Internal or commercial'),
          option('A library or CLI others consume', 'Reusable code'),
          option('A throwaway prototype', 'Learn or spike, not keep')
        ]),
        q('What is the first real outcome you want?', [
          option('A working slice I can click or run', 'Prove the idea'),
          option('A scaffold with the right stack', 'Architecture first'),
          option('Help choosing stack and shape', 'Still deciding')
        ]),
        q('Who decides what “good” looks like?', [
          option('Just me', 'Ship what I like'),
          option('A teammate or client', 'They review'),
          option('Users I do not control', 'External audience')
        ])
      ]
    }
  }
  if (scan.empty) {
    return {
      title: `${project.name} looks empty. What are we building?`,
      questions: [
        q('What belongs in this folder?', [
          option('A new app from scratch', 'Greenfield product'),
          option('A service or API', 'No primary UI, or UI later'),
          option('A package inside a larger system', 'Library, module, worker'),
          option('I am still deciding', 'Help me choose')
        ]),
        q(`What would make the first week in ${project.name} a success?`, [
          option('Runnable hello-world on the real stack', 'Bootstrapped and building'),
          option('One user-facing flow', 'Thin vertical slice'),
          option('Docs and a plan, little code', 'Align before building')
        ]),
        q('Any stack you already refuse to leave?', [
          option('TypeScript / Node', 'Stay in JS/TS'),
          option('Python', 'Stay in Python'),
          option('Whatever fits the problem', 'No loyalty yet'),
          option('Match another repo I will point at', 'Describe in Other')
        ])
      ]
    }
  }
  if (kind === 'Desktop app') {
    return {
      title: `How should the agent work in ${project.name}?`,
      questions: [
        q('What is the live job for the agent in this desktop app?', [
          option('Ship a user-visible feature', 'New behavior in the UI'),
          option('Fix something that is already broken', 'Bug or regression'),
          option('Harden reliability and edge cases', 'Permissions, crashes, state'),
          option('Explain the architecture, then wait', 'Orientation before edits')
        ]),
        q('What is frozen unless you explicitly ask?', [
          option('The chat / agent protocol', 'Do not reinvent the session model'),
          option('The visual language / layout chrome', 'Match existing UI'),
          option('How native shells and packaging work', 'Electron/OS glue stays'),
          option('Nothing — propose changes when they are better', 'Open to refactors')
        ], true),
        q('Which machines does this need to stay real on?', [
          option('macOS is enough for now', 'Ship and test here first'),
          option('macOS, Windows, and Linux', 'Desktop-wide'),
          option('Whatever the current build already supports', 'Do not expand scope')
        ])
      ]
    }
  }
  if (kind === 'Web app') {
    return {
      title: `What still is not obvious about ${project.name}?`,
      questions: [
        q('Where is this web app in its life?', [
          option('Local only, not in front of users', 'Safe to move fast'),
          option('Staging / a small set of users', 'Careful, not sacred'),
          option('Production traffic', 'Do not break live behavior')
        ]),
        q('What should the agent do first?', [
          option('A product feature', 'User-facing change'),
          option('A bug or visual regression', 'Repair'),
          option('Performance, a11y, or polish', 'Quality'),
          option('Map the routes and data flow', 'Learn before editing')
        ]),
        q('Auth and environments — what is already decided?', [
          option('Auth is in place; do not replace it', 'Extend, do not swap'),
          option('No auth yet, and we need it', 'Design it in'),
          option('No auth, and we do not want it', 'Stay open'),
          option('I will describe the provider in Other', 'Existing vendor')
        ])
      ]
    }
  }
  if (kind === 'Native mobile app') {
    return {
      title: `How should the agent treat ${project.name}?`,
      questions: [
        q('Which platforms are in scope right now?', [
          option('iOS only', 'Android later or never'),
          option('Android only', 'iOS later or never'),
          option('iOS and Android together', 'Keep them in parity')
        ], true),
        q('What is the next real outcome?', [
          option('A screen or flow users will see', 'Feature work'),
          option('Store / device issues', 'Build, signing, native modules'),
          option('Stability after a recent change', 'Fix regressions')
        ]),
        q('Native modules and OS APIs — how careful?', [
          option('Stay in JS/Dart unless I ask', 'No surprise native code'),
          option('Native is fine when the feature needs it', 'Use the platform'),
          option('This app is mostly native already', 'Match that')
        ])
      ]
    }
  }
  if (kind === 'API / backend service') {
    return {
      title: `How should the agent change ${project.name}?`,
      questions: [
        q('Who actually calls this API?', [
          option('Our own frontend or workers', 'Internal'),
          option('Outside customers', 'Public contract'),
          option('Both', 'Compatibility matters')
        ]),
        q('What must not break?', [
          option('Existing JSON / route shapes', 'Additive changes only'),
          option('Auth and tenancy rules', 'Do not loosen access'),
          option('Nothing is sacred if a better shape is needed', 'Allowed to redesign')
        ], true),
        q('What should the agent do first?', [
          option('A new endpoint or workflow', 'Feature'),
          option('A production bug', 'Fix'),
          option('Tests and hardening', 'Safety')
        ])
      ]
    }
  }
  if (kind === 'CLI / developer tool') {
    return {
      title: `What matters for ${project.name}?`,
      questions: [
        q('How do people run this?', [
          option('Local from this repo', 'Devs only'),
          option('Installed globally / via package manager', 'Published interface'),
          option('Both', 'Keep the CLI contract clean')
        ]),
        q('Breaking the command surface —', [
          option('Never without asking', 'Flags and subcommands are a contract'),
          option('Fine during this phase', 'Still shaping it'),
          option('Prefer aliases when renaming', 'Softer migrations')
        ]),
        q('What should the agent do first?', [
          option('A new command or flag', 'Feature'),
          option('Wrong output or exit codes', 'Fix'),
          option('Help text and UX of the CLI', 'Polish')
        ])
      ]
    }
  }
  if (kind === 'Library / SDK') {
    return {
      title: `How stable is ${project.name}?`,
      questions: [
        q('Who consumes this package?', [
          option('Only this monorepo', 'Internal'),
          option('Published for others', 'Semver matters'),
          option('Not sure yet', 'Treat exports as sticky anyway')
        ]),
        q('Public API changes —', [
          option('Ask first', 'Exports are a contract'),
          option('Additive is fine, removals need a yes', 'Expand freely'),
          option('Rewrite if the design is wrong', 'No loyalty yet')
        ]),
        q('What should the agent do first?', [
          option('A capability callers need', 'Feature'),
          option('A bug in the current API', 'Fix'),
          option('Types, docs, and examples', 'Usability')
        ])
      ]
    }
  }
  return {
    title: `What should the agent know about ${project.name}?`,
    questions: [
      q('What is the current job?', [
        option('Build something new in this repo', 'Feature work'),
        option('Fix or clean up what is here', 'Repair'),
        option('Understand it before touching it', 'Orientation'),
        option('Replace a piece of it', 'Targeted rewrite')
      ]),
      q('Who is this for?', [
        option('Me', 'Personal'),
        option('A team I work with', 'Shared'),
        option('Customers or the public', 'External')
      ]),
      q('When the agent has a choice, what wins?', [
        option('Smallest diff that works', 'Surgical'),
        option('Match existing patterns even if verbose', 'Consistency'),
        option('A cleaner design if the cost is bounded', 'Judgement')
      ])
    ]
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseGenerated(raw: string): GeneratedIntake | null {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  const record = asRecord(parsed)
  const list = Array.isArray(record?.questions) ? record.questions : Array.isArray(parsed) ? parsed : null
  if (!list) return null
  const questions: UserQuestion[] = []
  for (const item of list) {
    const row = asRecord(item)
    if (!row) continue
    const question = typeof row.question === 'string' ? row.question.trim() : ''
    if (!question) continue
    const options: UserQuestion['options'] = []
    const rawOptions = Array.isArray(row.options) ? row.options : []
    for (const optionItem of rawOptions) {
      if (typeof optionItem === 'string' && optionItem.trim()) {
        options.push({ label: optionItem.trim(), description: null, preview: null })
        continue
      }
      const opt = asRecord(optionItem)
      const label = typeof opt?.label === 'string' ? opt.label.trim() : ''
      if (!label) continue
      options.push({
        label,
        description: typeof opt?.description === 'string' ? opt.description.trim() : null,
        preview: null
      })
    }
    if (options.length < 2) continue
    questions.push({
      question,
      header: typeof row.header === 'string' ? row.header.trim() : null,
      multiSelect: row.multiSelect === true || row.multi_select === true,
      options: options.slice(0, 8)
    })
  }
  if (questions.length < 2) return null
  const title =
    (typeof record?.title === 'string' && record.title.trim()) || 'A few things the repo cannot tell us'
  return { title, questions: questions.slice(0, 5) }
}

function generationPrompt(project: Project, scan: ProjectScan): string {
  return [
    'You are briefing Datapad Workbench on a software project.',
    'Facts below were extracted from the repository. Treat them as known. Do not ask the user to restate them.',
    'Write 3 to 5 multiple-choice questions that only a human can answer, specific to THIS project.',
    'Good questions: current job, who it is for, what is frozen, what “done” looks like, product-specific gaps the files cannot show (audience, live vs local, compatibility, what not to rewrite).',
    'Bad questions: what language it is, which framework, folder structure, anything already in the facts.',
    'Name concrete systems, files, or product behavior from the facts in the question text when it helps.',
    'Each question needs 2 to 6 short options with a one-line description. multiSelect true only when several can apply.',
    'Do not include an Other option. Do not use tools. Do not read files. Reply with JSON only:',
    '{"title":"short card title","questions":[{"question":"...","header":null,"multiSelect":false,"options":[{"label":"...","description":"..."}]}]}',
    '',
    scanDossier(project, scan)
  ].join('\n')
}

export async function generateIntakeQuestions(
  project: Project,
  scan: ProjectScan
): Promise<GeneratedIntake> {
  const fallback = fallbackQuestions(project, scan)
  const raw = await askOnce(project, generationPrompt(project, scan))
  if (!raw) return fallback
  return parseGenerated(raw) ?? fallback
}
