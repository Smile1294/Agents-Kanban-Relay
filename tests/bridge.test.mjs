/* The page as it actually loads: public/bridge.js first, then the real
 * public/media/board.js, in one shared DOM. The bridge defines
 * `acquireVsCodeApi()` and re-dispatches polled frames as `window` messages;
 * board.js consumes exactly that. This test wires the two together the way the
 * browser does — `window.postMessage` delivers to the message listeners board.js
 * registers — and pins the contract between them:
 *
 *   - no id → the gate draws, and the board's root text is never `undefined`
 *   - a saved id → the first GET fires, the frame is dispatched, board.js draws
 *     the session and the composer's `Split:`, `Extended`, model and agent chips
 *   - a new mv triggers `?models=1` before the frame is dispatched, so the model
 *     chip reads the catalogue's label
 *   - `postMessage` → a POST `{ kind:'msg', nonce, msg }`
 *   - `writes:false` → the READ-ONLY badge shows and a post is dropped with a toast
 *   - a `remote` dialog event draws the overlay, and answering it posts `remote.dialog`
 *   - an oversize message is refused with a toast and never posted
 *
 * fetch, localStorage, location, crypto and the timers are stubbed (timers are
 * collected, not run), so nothing here touches the network and nothing spins.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { makeNode, walk } from './dom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const bridgeSrc = await fs.readFile(path.join(ROOT, 'public', 'bridge.js'), 'utf8')
const boardSrc = await fs.readFile(path.join(ROOT, 'public', 'media', 'board.js'), 'utf8')
const sample = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts', 'sample-frame.json'), 'utf8'))

const ID = 'a'.repeat(24)
const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', context: '1M', contextTokens: 1000000, price: '$5/$25 per Mtok' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', context: '200K' },
]

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

/** A fresh chat-mode state (the composer only draws in chat view). Deep-cloned so
 *  the bridge's mutation of `frame.state.composer.models` never leaks across tests. */
const chatFrame = () => ({
  type: 'state',
  state: { ...JSON.parse(JSON.stringify(sample.state)), mode: 'chat' },
})

const resp = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

/** Let every microtask the bridge scheduled settle (its fetch chain is all
 *  already-resolved promises, so one macrotask drains it). */
const settle = () => new Promise((r) => setTimeout(r, 0))

/** Build and run the page once, returning everything a test needs to poke at. */
async function boot({ id = '', hash = '', router } = {}) {
  const root = makeNode('div')
  const body = makeNode('body')
  const listeners = []   // window 'message' listeners board.js registers
  const timers = []      // captured, never run
  const fetched = []     // { method, url, body }

  const storage = new Map()
  if (id) storage.set('agents-kanban.remote', JSON.stringify({ id }))

  const win = {
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn) },
    postMessage: (data) => { for (const fn of listeners) fn({ data }) },
    open: () => null,
  }
  win.window = win
  win.document = {
    activeElement: null,
    getElementById: (name) => {
      if (name === 'root') return root
      return walk(root).find((n) => n.id === name) ?? walk(body).find((n) => n.id === name) ?? null
    },
    createElement: (tag) => { const n = makeNode(tag); n._doc = win.document; return n },
    createTextNode: (t) => ({ textContent: t, children: [], className: '' }),
    documentElement: { dataset: { layout: 'board' } },
    body,
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener() {}, removeEventListener() {},
  }
  win.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  }
  win.location = { hash, pathname: '/', search: '', reload: () => {} }
  win.history = { replaceState() {} }
  win.crypto = globalThis.crypto
  win.TextEncoder = globalThis.TextEncoder
  win.Uint8Array = Uint8Array
  win.ArrayBuffer = ArrayBuffer
  win.fetch = (url, init = {}) => {
    const rec = { method: init.method || 'GET', url: String(url), body: init.body ? JSON.parse(init.body) : undefined }
    fetched.push(rec)
    return router ? router(rec.url, init, rec) : resp(404, { ok: false, error: 'not found' })
  }
  win.navigator = { mediaDevices: { getUserMedia: async () => { throw new Error('no mic') } } }
  win.MediaRecorder = class { start() {} stop() {} }
  win.Blob = class { constructor(parts, opts) { this.type = opts && opts.type } arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) } }
  win.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
  win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  win.clearTimeout = () => {}
  win.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  win.clearInterval = () => {}
  win.console = console
  win.Date = Date
  win.Math = Math
  win.Number = Number
  win.String = String
  win.Boolean = Boolean
  win.JSON = JSON
  win.Promise = Promise
  win.RegExp = RegExp
  win.Error = Error
  win.Set = Set
  win.Map = Map
  win.Array = Array
  win.Object = Object
  win.Intl = Intl
  win.Buffer = Buffer
  win.prompt = () => null
  win.FileReader = class {
    readAsDataURL(f) { this.result = f && f._dataUrl; if (this.result === undefined) { this.onerror?.(); return } this.onload?.() }
  }
  win.Image = class { set src(v) { this.onerror?.() } }

  vm.createContext(win)
  vm.runInContext(bridgeSrc, win, { filename: 'bridge.js' })
  vm.runInContext(boardSrc, win, { filename: 'board.js' })
  await settle()
  return { root, body, win, fetched, listeners, timers, storage }
}

const ctlLabels = (root) => walk(root)
  .filter((n) => n.className && String(n.className).split(/\s+/).includes('ctl-label'))
  .map((n) => n.textContent)

const hasToast = (body, text) => walk(body).some((n) =>
  n.className && String(n.className).includes('ak-toast') && String(n.textContent).includes(text))

/** The one message board.js posts on boot, before any frame — filter it out when
 *  asserting on a specific post. */
const postedMsg = (fetched, type) => fetched.filter((f) =>
  f.method === 'POST' && f.body && f.body.kind === 'msg' && f.body.msg && f.body.msg.type === type)

// --- no id → the gate, and never the string "undefined" -----------------------

{
  const h = await boot({})
  const gate = h.body ? walk(h.body).find((n) => n.id === 'ak-gate') : null
  ok(!!gate, 'no id → the gate renders')
  const h1 = gate && walk(gate).find((n) => n.tagName === 'h1')
  ok(!!(h1 && h1.textContent === 'Agents Kanban'), 'the gate carries the title')
  const text = h.root.textContent
  ok(typeof text === 'string' && text !== 'undefined' && !text.includes('undefined'),
    'the board root renders real text, never the string "undefined"')
  ok(text.includes('Loading sessions'), 'the board shows its loading state behind the gate')
  ok(h.fetched.length === 0, '…and nothing is fetched while there is no id')
}

// --- a saved id → first GET, frame dispatched, board.js draws -----------------

{
  const firstGet = { url: '' }
  const router = (url) => {
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    firstGet.url = firstGet.url || url
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })

  ok(firstGet.url === '/board?id=' + ID, 'the first GET is a first load — no since cursor yet')
  ok(h.fetched.some((f) => f.method === 'GET' && f.url.includes('models=1')),
    'the first frame triggers a ?models=1 fetch before dispatch')

  const labels = ctlLabels(h.root)
  ok(labels.includes('Opus 5'), 'the model chip reads the catalogue label (Opus 5), not "Model"')
  ok(labels.includes('Claude Code'), 'the agent chip reads "Claude Code"')
  ok(labels.includes('Split: Balanced'), 'the orchestration chip reads "Split: Balanced"')
  ok(labels.includes('Extended: On'), 'the thinking chip reads "Extended: On"')
  const text = h.root.textContent
  ok(text.includes('Fix the login page'), 'board.js draws the session title')
  ok(text.includes('AGENT'), 'board.js draws the composer agent badge')
}

// --- a new mv re-fetches the catalogue before the second dispatch -------------

{
  let modelsFetches = 0
  const order = []
  const router = (url) => {
    if (url.includes('models=1')) { modelsFetches++; order.push('models'); return resp(200, { ok: true, mv: 'v2', models: MODELS }) }
    order.push('board')
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  await boot({ id: ID, router })
  ok(modelsFetches === 1, 'exactly one ?models=1 fetch on the first frame')
  ok(order[order.length - 1] === 'models' && order.includes('board'),
    'the catalogue is fetched before the frame is dispatched')
}

// --- postMessage → a POST with kind:'msg', a nonce and the message -------------

{
  const router = (url, init) => {
    if (init && init.method === 'POST') return resp(200, { ok: true, writes: true })
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })
  const before = postedMsg(h.fetched, 'select').length
  h.win.acquireVsCodeApi().postMessage({ type: 'select', id: 'abc-123' })
  await settle()
  const posts = postedMsg(h.fetched, 'select')
  ok(posts.length === before + 1, 'postMessage({ type:"select" }) posts exactly one msg envelope')
  ok(posts[posts.length - 1].body.nonce && posts[posts.length - 1].body.nonce.length > 0,
    '…with a nonce')
  ok(posts[posts.length - 1].body.msg.id === 'abc-123', '…carrying the message')
}

// --- writes:false → the badge shows, and a post is dropped with a toast --------

{
  const router = (url) => {
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: false, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })
  const ro = walk(h.body).find((n) => n.className && String(n.className).includes('rc-ro'))
  ok(!!ro && ro.textContent === 'READ-ONLY', 'the READ-ONLY badge is drawn when writes is false')
  ok(ro.style.display !== 'none', '…and it is visible')

  const before = postedMsg(h.fetched, 'send').length
  h.win.acquireVsCodeApi().postMessage({ type: 'send', text: 'hi' })
  await settle()
  ok(postedMsg(h.fetched, 'send').length === before, 'a post is DROPPED while writes is false')
  ok(hasToast(h.body, 'Read-only'), '…and a read-only toast explains why')
}

// --- a remote dialog event draws the overlay; answering posts remote.dialog ----

{
  const router = (url) => {
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    return resp(200, {
      ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(),
      events: [{ type: 'remote', kind: 'dialog', id: 'd1', spec: { level: 'warning', title: 'Confirm', text: 'Delete?', choices: ['Delete', 'Cancel'] } }],
    })
  }
  const h = await boot({ id: ID, router })
  const overlay = walk(h.body).find((n) => n.className && String(n.className).includes('ak-overlay'))
  ok(!!overlay && walk(overlay).some((n) => n.tagName === 'h2' && n.textContent === 'Confirm'),
    'a remote dialog event draws the overlay with its title')

  const del = walk(overlay).find((n) => n.tagName === 'button' && n.textContent === 'Delete')
  ok(!!del, 'the overlay carries the dialog\'s choices')
  del.onclick()
  await settle()
  const answers = postedMsg(h.fetched, 'remote.dialog')
  ok(answers.length === 1 && answers[0].body.msg.id === 'd1' && answers[0].body.msg.answer === 'Delete',
    'answering the dialog posts { type:"remote.dialog", id, answer }')
}

// --- a refused action SAYS so, and is retried once ----------------------------
//
// The failure this pins: `sendEnvelope` threw its answer away — a bare
// `catch {}` on the network and no look at the status at all — so a message
// the relay refused was indistinguishable from one that ran. The board's rule
// is that an answer the user can miss, to an action they deliberately took, is
// the same class of bug as a signal that cannot say "bad". And a 500 here is
// not hypothetical: the Node host's store races answered exactly that under
// load, on the `msg` post — a button pressed on the phone that did nothing.

/** Run the timers the bridge armed, once, so a retry that waits can happen. */
const runTimers = async (h) => {
  const due = h.timers.splice(0)
  for (const t of due) t.fn()
  await settle()
  await settle()
}

{
  let attempts = 0
  const router = (url, init, rec) => {
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    // board.js posts `ready` on boot; only the click under test is counted.
    if (rec.method === 'POST' && rec.body.kind === 'msg' && rec.body.msg.type === 'select') {
      attempts++
      return attempts === 1 ? resp(500, { ok: false, error: 'the relay failed' }) : resp(200, { ok: true })
    }
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })
  h.win.acquireVsCodeApi().postMessage({ type: 'select', id: 'x' })
  await settle()
  ok(attempts === 1, 'the action is posted once')
  await runTimers(h)
  ok(attempts === 2, 'a 5xx is retried — the nonce makes the retry idempotent at the relay')
  ok(!hasToast(h.body, 'did not reach the board'),
    '…and a retry that lands says nothing: the action ran')
}

{
  const router = (url, init, rec) => {
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    if (rec.method === 'POST' && rec.body.kind === 'msg' && rec.body.msg.type === 'select') {
      return resp(500, { ok: false, error: 'the relay failed' })
    }
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })
  h.win.acquireVsCodeApi().postMessage({ type: 'select', id: 'x' })
  await settle()
  await runTimers(h)
  ok(hasToast(h.body, 'did not reach the board'),
    'an action that never lands SAYS so rather than looking like it worked')
}

{
  const router = (url, init, rec) => {
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    if (rec.method === 'POST' && rec.body.kind === 'msg' && rec.body.msg.type === 'select') {
      return resp(429, { ok: false, error: 'the message queue is full — wait for the board to catch up' })
    }
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })
  const before = postedMsg(h.fetched, 'select').length
  h.win.acquireVsCodeApi().postMessage({ type: 'select', id: 'x' })
  await settle()
  // Asserted BEFORE the timers run: a toast arms its own removal timer, and
  // running every armed timer would take the toast away with it.
  ok(hasToast(h.body, 'has not picked up your last actions'),
    'a full queue names the real cause — the board is not draining it')
  await runTimers(h)
  ok(postedMsg(h.fetched, 'select').length === before + 1,
    '…and a 4xx is NOT retried: sending it again cannot change the answer')
}

// --- an oversize message is refused with a toast, never posted -----------------

{
  const router = (url, init) => {
    if (init && init.method === 'POST') return resp(200, { ok: true, writes: true })
    if (url.includes('models=1')) return resp(200, { ok: true, mv: 'v1', models: MODELS })
    return resp(200, { ok: true, seq: 1, at: Date.now(), writes: true, mv: 'v1', frame: chatFrame(), events: [] })
  }
  const h = await boot({ id: ID, router })
  const before = postedMsg(h.fetched, 'send').length
  h.win.acquireVsCodeApi().postMessage({ type: 'send', text: 'x'.repeat(4_000_000) })
  await settle()
  ok(postedMsg(h.fetched, 'send').length === before, 'an oversize message is never posted')
  ok(hasToast(h.body, 'Too large'), '…and a too-large toast explains why')
}

console.log(fails ? `\n${fails} failure(s)` : '\nbridge: all ok')
process.exit(fails ? 1 : 0)
