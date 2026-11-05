import { browserContents, browserConsole, getBrowserState, requestShowBrowser, type ConsoleEntry } from './browser'
import type { BrowserState } from '../shared/types'

/** Which element a tool acts on: a number from the last snapshot, a CSS selector, or visible text. */
export type Target = { ref?: number; selector?: string; text?: string }

export type SnapshotElement = {
  ref: number
  role: string
  name: string
  value?: string
  checked?: boolean
  disabled?: boolean
  offscreen?: boolean
}

export type Snapshot = { url: string; title: string; text: string; elements: SnapshotElement[] }

const INTERACTIVE =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[contenteditable=""],[contenteditable=true]'

/**
 * Page-side helpers, run in the guest page. `find` resolves a Target the same way for every
 * tool: snapshot number, then selector, then exact visible text, then partial text.
 */
const PAGE_HELPERS = `
const INTERACTIVE = ${JSON.stringify(INTERACTIVE)};
// Fields are named by their label, never by what they hold, so a name survives typing.
const label = (el) => {
  const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  const own = el.getAttribute('aria-label') || (field ? (el.labels && el.labels[0] ? el.labels[0].innerText : '') || el.getAttribute('placeholder') : el.innerText);
  return (own || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || (el.tagName === 'INPUT' && /^(submit|button)$/i.test(el.type) ? el.value : '') || '').trim().replace(/\\s+/g, ' ');
};
const shown = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
};
const find = (t) => {
  if (t.ref != null) {
    const el = document.querySelector('[data-wb-ref="' + Number(t.ref) + '"]');
    if (!el) throw new Error('No element ' + t.ref + ' on this page. Take a new snapshot.');
    return el;
  }
  if (t.selector) {
    const el = document.querySelector(t.selector);
    if (!el) throw new Error('No element matches ' + t.selector);
    return el;
  }
  if (t.text) {
    const want = t.text.trim().toLowerCase();
    const pool = [...document.querySelectorAll(INTERACTIVE)].filter(shown);
    const names = (el) => [label(el), el.getAttribute('placeholder') || '', el.getAttribute('name') || ''].map((x) => x.trim().toLowerCase()).filter(Boolean);
    const exact = pool.find((el) => names(el).includes(want));
    if (exact) return exact;
    const partial = pool.find((el) => names(el).some((name) => name.includes(want)));
    if (partial) return partial;
    const any = [...document.querySelectorAll('body *')].find((el) => shown(el) && el.children.length === 0 && (el.textContent || '').trim().toLowerCase() === want);
    if (any) return any;
    throw new Error('Nothing on the page reads "' + t.text + '"');
  }
  throw new Error('Pass ref, selector or text');
};
`

function run<T>(body: string, arg: unknown = null): Promise<T> {
  const script = `(async (arg) => { ${PAGE_HELPERS}\n${body} })(${JSON.stringify(arg)})`
  return withTimeout(browserContents().executeJavaScript(script, true) as Promise<T>, 15_000)
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function requirePage(): void {
  const { url } = getBrowserState()
  if (!url) throw new Error('No page is open. Call navigate first.')
}

async function settle(): Promise<BrowserState> {
  await pause(250)
  const wc = browserContents()
  for (let i = 0; i < 20 && wc.isLoading(); i += 1) await pause(250)
  return getBrowserState()
}

export async function screenshot(): Promise<{ png: string; width: number; height: number }> {
  requirePage()
  if (!getBrowserState().visible) {
    requestShowBrowser()
    await pause(400)
  }
  let image = await browserContents().capturePage()
  if (image.isEmpty()) throw new Error('The BrowserPane is hidden or has no size, so there is nothing to capture.')
  // Keep the long side within 1568px: a 1280×1617 capture came back to the agent as UnknownVizError.
  const { width, height } = image.getSize()
  const scale = Math.min(1280 / width, 1568 / height, 1)
  if (scale < 1) image = image.resize({ width: Math.floor(width * scale), height: Math.floor(height * scale) })
  const size = image.getSize()
  return { png: image.toPNG().toString('base64'), width: size.width, height: size.height }
}

export async function snapshot(maxChars = 6000): Promise<Snapshot> {
  requirePage()
  return run<Snapshot>(
    `
document.querySelectorAll('[data-wb-ref]').forEach((el) => el.removeAttribute('data-wb-ref'));
const elements = [];
let n = 0;
for (const el of document.querySelectorAll(INTERACTIVE)) {
  if (!shown(el) || el.closest('[aria-hidden="true"]')) continue;
  n += 1;
  el.setAttribute('data-wb-ref', String(n));
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (['checkbox', 'radio', 'submit', 'button', 'range', 'file'].includes(type) ? type : 'textbox') : tag === 'textarea' ? 'textbox' : tag);
  const row = { ref: n, role, name: label(el).slice(0, 100) };
  if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !['checkbox', 'radio', 'submit', 'button'].includes(type)) row.value = type === 'password' ? '••••' : String(el.value).slice(0, 100);
  if (type === 'checkbox' || type === 'radio') row.checked = el.checked;
  const pressed = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || el.getAttribute('aria-selected');
  if (pressed === 'true' || pressed === 'false') row.checked = pressed === 'true';
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') row.disabled = true;
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) row.offscreen = true;
  elements.push(row);
  if (elements.length >= 300) break;
}
const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
return { url: location.href, title: document.title, text: text.length > arg ? text.slice(0, arg) + '\\n…' : text, elements };
`,
    maxChars
  )
}

export async function click(target: Target): Promise<BrowserState> {
  requirePage()
  const point = await run<{ x: number; y: number } | null>(
    `
const el = find(arg);
el.scrollIntoView({ block: 'center', inline: 'center' });
const r = el.getBoundingClientRect();
const x = r.left + r.width / 2, y = r.top + r.height / 2;
// Real mouse events reach the page only where the element is on top at that point.
const top = document.elementFromPoint(x, y);
if (top && (top === el || el.contains(top))) return { x: Math.round(x), y: Math.round(y) };
el.click();
return null;
`,
    target
  )
  const state = getBrowserState()
  if (point && state.visible) {
    const wc = browserContents()
    wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  } else if (point) {
    await run('find(arg).click(); return null;', target)
  }
  return settle()
}

export async function type(
  target: Target | null,
  text: string,
  clear: boolean
): Promise<BrowserState & { value: string | null }> {
  requirePage()
  const kind = await run<'select' | 'field' | 'editable' | 'other'>(
    `
const el = arg.target ? find(arg.target) : document.activeElement;
if (!el || el === document.body) throw new Error('No field is focused. Pass ref, selector or text.');
el.scrollIntoView({ block: 'center' });
if (el.tagName === 'SELECT') {
  const want = arg.text.trim().toLowerCase();
  const option = [...el.options].find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want);
  if (!option) throw new Error('No option "' + arg.text + '". Options: ' + [...el.options].map((o) => o.text.trim()).join(', '));
  el.value = option.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.setAttribute('data-wb-typing', '');
  return 'select';
}
document.querySelectorAll('[data-wb-typing]').forEach((node) => node.removeAttribute('data-wb-typing'));
el.setAttribute('data-wb-typing', '');
el.focus();
if (arg.clear) {
  if (typeof el.select === 'function') el.select();
  else document.execCommand('selectAll');
}
if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return 'field';
return el.isContentEditable ? 'editable' : 'other';
`,
    { target, text, clear }
  )
  if (kind !== 'select') browserContents().insertText(text)
  // insertText goes through the page's own input path, so frameworks see real input events.
  // If it did not land (some pages swallow it), set the value the way React expects.
  const value = await run<string | null>(
    `
const el = document.querySelector('[data-wb-typing]');
if (!el) return null;
el.removeAttribute('data-wb-typing');
if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return el.tagName === 'SELECT' ? el.value : (el.innerText || '').slice(0, 200);
if (!String(el.value).includes(arg.text)) {
  const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, arg.clear ? arg.text : el.value + arg.text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
return el.type === 'password' ? '••••' : String(el.value).slice(0, 200);
`,
    { target, text, clear }
  )
  return { ...(await settle()), value }
}

const KEY_NAMES: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  esc: 'Escape',
  return: 'Enter',
  ' ': 'Space',
  spacebar: 'Space'
}

type Modifier = 'shift' | 'control' | 'alt' | 'meta'
const MODIFIERS = new Set<Modifier>(['shift', 'control', 'alt', 'meta'])

export async function press(key: string, modifiers: string[] = []): Promise<BrowserState> {
  requirePage()
  const raw = key.trim()
  if (!raw) throw new Error('Pass a key, for example Enter or Escape')
  const keyCode = KEY_NAMES[raw.toLowerCase()] ?? raw
  const mods = modifiers
    .map((m) => m.toLowerCase().replace(/^(ctrl|cmd|command|option)$/, (word) => (word === 'ctrl' ? 'control' : word === 'option' ? 'alt' : 'meta')))
    .filter((m): m is Modifier => MODIFIERS.has(m as Modifier))
  const wc = browserContents()
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
  const printable = keyCode.length === 1 ? keyCode : keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : null
  if (printable && !mods.some((m) => m === 'control' || m === 'meta')) {
    wc.sendInputEvent({ type: 'char', keyCode: printable, modifiers: mods })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
  return settle()
}

export async function waitFor(
  selector: string | undefined,
  text: string | undefined,
  timeoutMs = 5000
): Promise<BrowserState & { found: boolean; waitedMs: number }> {
  requirePage()
  if (!selector && !text) throw new Error('Pass selector or text')
  const limit = Math.min(Math.max(timeoutMs, 100), 30_000)
  const started = Date.now()
  while (true) {
    const found = await run<boolean>(
      `
if (arg.selector) { const el = document.querySelector(arg.selector); if (!el || !shown(el)) return false; }
if (arg.text && !(document.body && document.body.innerText.toLowerCase().includes(arg.text.toLowerCase()))) return false;
return true;
`,
      { selector, text }
    ).catch(() => false)
    const waitedMs = Date.now() - started
    if (found || waitedMs >= limit) return { ...getBrowserState(), found, waitedMs }
    await pause(200)
  }
}

export async function evaluate(expression: string): Promise<unknown> {
  requirePage()
  // Inlined rather than eval'd, so pages whose CSP forbids eval still work.
  const script = `(async () => { const value = await (\n${expression}\n); try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return String(value); } })()`
  return withTimeout(browserContents().executeJavaScript(script, true) as Promise<unknown>, 15_000)
}

export function consoleLog(level?: string, limit = 50): ConsoleEntry[] {
  const wanted = level === 'error' ? ['error'] : level === 'warning' ? ['warning', 'error'] : null
  const rows = browserConsole().filter((row) => !wanted || wanted.includes(row.level))
  return rows.slice(-Math.min(Math.max(limit, 1), 200))
}
