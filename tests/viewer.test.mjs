/* Runs public/board.js — the relay's viewer page — against a stub DOM.
 *
 * The stub (dom.mjs in this folder) is a trimmed copy of the one the
 * extension's own webviews run against, so both sides of the wire are tested
 * against the same model of a browser.
 *
 * This page had NO rendering gate while every piece of the relay behind it
 * was tested, and the bug that shipped was exactly the class of thing only a
 * DOM gate can see: `boardScreen()` drew into the root itself and returned
 * nothing, `render()` drew whatever it returned, and `undefined` stringifies
 * — so the moment a board id existed (a pairing code entered, or a link with
 * the hash), the whole page was replaced by the text node "undefined".
 * Reported as "when I try to access the remote board I just get undefined".
 * Every assertion here starts with the rule the fix encodes: the root's text
 * must never BE the string "undefined".
 *
 * The relay is stubbed at `fetch`; the page's real boot sequence — render,
 * then the poll chain — runs against it, and the poll timers are collected
 * so a test can drive a second poll without waiting on a real clock.
 */
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import vm from 'node:vm'
import { findByTag, makeNode, walk } from './dom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = await fs.readFile(path.join(HERE, '..', 'public', 'board.js'), 'utf8')

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** The index a relay with one board and one session would serve. */
const INDEX = {
  v: 1, at: Date.now(),
  columns: [{ id: 'backlog', name: 'Backlog' }, { id: 'complete', name: 'Complete' }],
  sessions: {
    'abc-123': {
      key: 'abc-123', title: 'Fix the login page', phase: 'backlog',
      tags: ['auth'], archived: false, updated: Date.now(), tv: 0,
    },
  },
  writes: false,
}

/**
 * Boot the page fresh: the same stub DOM the webview tests use, plus the
 * browser bits this page needs that those do not — localStorage, location,
 * fetch, crypto and TextEncoder. `fetchImpl` answers the relay API; the poll
 * timers are collected into `timeouts` so a test can drive later polls.
 */
async function boot({ hash = '', saved = null, fetchImpl }) {
  const root = makeNode('main')
  const timeouts = []
  const intervals = []
  const calls = []
  const storage = {}
  const document = {
    activeElement: null,
    getElementById: (id) => (id === 'root' ? root : walk(root).find((n) => n.id === id) ?? null),
    createElement: (tag) => {
      const n = makeNode(tag)
      n._doc = document
      return n
    },
    createTextNode: (t) => ({ textContent: t, children: [], className: '' }),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener() {}, removeEventListener() {},
  }
  const ctx = {
    document,
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v) },
      removeItem: (k) => { delete storage[k] },
    },
    location: { hash, reload() {} },
    crypto: {
      subtle: {
        // The typed-code path derives the board address from this digest.
        // 24 bytes of 0xab read back as the id 'abab…ab'.
        digest: async () => new Uint8Array(24).fill(0xab).buffer,
      },
    },
    TextEncoder,
    // Collected, not run: the poll chain must be driven by the test.
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    // The fetch answers are relay-shaped: { status, ok, json() }. The URLs
    // are recorded — when the first poll fires is a fact a test asserts on.
    fetch: async (url, opts) => {
      calls.push(url)
      const answer = await fetchImpl(url, opts)
      return {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        json: async () => answer.body,
      }
    },
    Date, Math, Number, JSON, console, Set, Array, Object, String, Map, Intl, Error, Promise,
    encodeURIComponent, decodeURIComponent,
  }
  if (saved !== null) storage['agents-kanban.remote'] = JSON.stringify(saved)
  vm.createContext(ctx)
  vm.runInContext(SRC, ctx, { filename: 'public/board.js' })
  /** Let the boot poll chain (async fetch → render) settle. */
  const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
  await flush()
  const text = () => root.textContent
  return { root, document, timeouts, calls, text, flush, storage }
}

// 1. No board id: the pairing screen, and certainly not "undefined".
{
  const v = await boot({ fetchImpl: async () => ({ status: 404, body: { ok: false, error: 'x' } }) })
  ok(v.text().includes('Remote board'), 'no id: the pairing screen renders')
  ok(v.text().includes('pairing code'), 'no id: it asks for the pairing code')
  ok(v.text().trim() !== 'undefined', 'no id: the page is never the text "undefined"')
}

// 2. A typed pairing code → the board view, waiting for the first push. The
//    boot poll ran before the code existed, so the chain must re-arm itself
//    (it died there once, and a paired page polled nothing, ever).
{
  const v = await boot({ fetchImpl: async () => ({ status: 404, body: { ok: false, error: 'x' } }) })
  const input = findByTag(v.root, 'input')
  input.value = 'some-code'
  const go = findByTag(v.root, 'button', (n) => n.textContent.includes('Watch the board'))
  go.addEventListener('click', go.onclick) // the stub folds both spellings into one
  go.onclick()
  await v.flush()
  ok(v.text().includes('Waiting for the first push'), 'typed code: the board view appears')
  // Pairing fires the poll immediately — the id here is sha-256('some-code')
  // as the stubbed digest reports it: 24 bytes of 0xab.
  ok(v.calls.some((u) => u.includes('?id=abababababababababababab')),
    'typed code: the first poll fires on pairing, not after the error interval')
  for (const t of v.timeouts.splice(0)) t.fn() // the re-armed poll fires
  await v.flush()
  ok(v.text().includes('Waiting for the first push'), 'typed code: the poll chain survived pairing')
  ok(v.text().trim() !== 'undefined', 'typed code: the page is never the text "undefined"')
}

// 3. A hash link straight into a board the relay has not heard of yet.
{
  const v = await boot({
    hash: '#0123456789abcdef01234567',
    fetchImpl: async () => ({ status: 404, body: { ok: false, error: 'x' } }),
  })
  ok(v.text().includes('Waiting for the first push'), 'hash link: waiting state before the first push')
  ok(v.text().trim() !== 'undefined', 'hash link: the page is never the text "undefined"')
}

// 4. The relay answers with a board: columns, cards, and a live readout.
{
  const v = await boot({
    hash: '#0123456789abcdef01234567',
    fetchImpl: async (url) => url.includes('&tail=')
      ? { status: 200, body: { ok: true, tail: { entries: [] } } }
      : { status: 200, body: { ok: true, index: INDEX } },
  })
  ok(v.text().includes('Backlog') && v.text().includes('Complete'), 'board renders the columns')
  ok(v.text().includes('Fix the login page'), 'board renders the session card')
  ok(v.text().includes('Last push'), 'board shows the live readout')
  ok(v.text().trim() !== 'undefined', 'board: the page is never the text "undefined"')
  // The write composer appears exactly while the host's toggle is on.
  ok(!findByTag(v.root, 'textarea'), 'writes off: no composer is drawn')
}

// 5. The host's write channel on → the composer appears.
{
  const v = await boot({
    hash: '#0123456789abcdef01234567',
    fetchImpl: async (url) => url.includes('&tail=')
      ? { status: 200, body: { ok: true, tail: { entries: [] } } }
      : { status: 200, body: { ok: true, index: { ...INDEX, writes: true } } },
  })
  const ta = findByTag(v.root, 'textarea')
  ok(!!ta, 'writes on: the composer is drawn')
  ok(ta.placeholder.includes("the board's machine"), 'writes on: the composer says where it runs')
  ok(v.text().trim() !== 'undefined', 'writes on: the page is never the text "undefined"')
}

// 6. A later poll that goes from "no board" to "board" must re-render the
//    real screen — every poll calls render(), and a screen that drew into the
//    root instead of returning its nodes breaks on the very first one.
{
  let first = true
  const v = await boot({
    hash: '#0123456789abcdef01234567',
    fetchImpl: async (url) => {
      if (first) { first = false; return { status: 404, body: { ok: false, error: 'x' } } }
      return url.includes('&tail=')
        ? { status: 200, body: { ok: true, tail: { entries: [] } } }
        : { status: 200, body: { ok: true, index: INDEX } }
    },
  })
  ok(v.text().includes('Waiting for the first push'), 'repoll: first poll waits')
  for (const t of v.timeouts.splice(0)) t.fn() // the poll chain re-arms itself
  await v.flush()
  ok(v.text().includes('Fix the login page'), 'repoll: a later poll renders the board')
  ok(v.text().trim() !== 'undefined', 'repoll: the page is never the text "undefined"')
}

// 7. The host's model catalogue → the composer's pickers appear.
{
  const composer = {
    model: 'claude-opus-5', effort: 'high', thinking: 'enabled', thinkingSupported: true,
    models: [
      { id: 'claude-opus-5', label: 'Opus 5', detail: '200K' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', detail: '200K' },
    ],
    efforts: [{ key: 'low', label: 'Low' }, { key: 'high', label: 'High' }],
  }
  const v = await boot({
    hash: '#0123456789abcdef01234567',
    fetchImpl: async (url) => url.includes('&tail=')
      ? { status: 200, body: { ok: true, tail: { entries: [] } } }
      : { status: 200, body: { ok: true, index: { ...INDEX, writes: true, composer } } },
  })
  ok(!!findByTag(v.root, 'button', (n) => (n.textContent || '').includes('Opus 5')),
    'model picker: the chip shows the host default model by label')
  ok(!!findByTag(v.root, 'button', (n) => (n.textContent || '').includes('High')),
    'effort picker: the chip shows the host default effort by label')
  ok(!!findByTag(v.root, 'button', (n) => (n.textContent || '').includes('Thinking')),
    'thinking picker: the toggle chip renders when the host supports it')
  ok(v.text().trim() !== 'undefined', 'composer: the page is never the text "undefined"')
}

// 8. The agent's answer renders as markdown, not a wall of plain text.
{
  const v = await boot({
    hash: '#0123456789abcdef01234567',
    fetchImpl: async (url) => url.includes('&tail=')
      ? {
          status: 200,
          body: {
            ok: true,
            tail: {
              key: 'abc-123', at: Date.now(),
              entries: [
                { kind: 'prompt', at: 1000, text: 'do the thing' },
                { kind: 'text', at: 1100, text: '# Answer\n\nSome **bold**, `code`, and a [link](https://example.com)\n\n- one\n- two\n\n```js\nconst x = 1\n```' },
                { kind: 'tool', at: 1200, name: 'Bash', status: 'ok', durationMs: 3000 },
                { kind: 'result', at: 1300, summary: 'done', durationMs: 5000 },
              ],
            },
          },
        }
      : { status: 200, body: { ok: true, index: { ...INDEX, sessions: { 'abc-123': { ...INDEX.sessions['abc-123'], tv: 1 } } } } },
  })
  // Open the chat: click the session's card, which sets openKey and re-renders.
  const card = findByTag(v.root, 'button', (n) => (n.title || '').includes('Open the chat'))
  card.onclick()
  await v.flush()
  ok(v.text().includes('You') && v.text().includes('do the thing'), 'markdown: the prompt bubble renders')
  ok(v.text().includes('Answer'), 'markdown: a heading renders')
  ok(v.text().includes('bold'), 'markdown: bold inline renders as its text')
  ok(!!findByTag(v.root, 'pre'), 'markdown: a fenced code block becomes a <pre>')
  ok(v.text().includes('const x = 1'), 'markdown: the code block keeps its code')
  ok(v.text().includes('one') && v.text().includes('two'), 'markdown: a list renders')
  ok(v.text().includes('Bash') && v.text().includes('done'), 'transcript: tool and result rows render')
  ok(v.text().trim() !== 'undefined', 'markdown: the page is never the text "undefined"')
}

if (fails) {
  console.error(`\n${fails} viewer assertion(s) failed`)
  process.exit(1)
}
console.log('\nviewer page renders — no "undefined" states')
