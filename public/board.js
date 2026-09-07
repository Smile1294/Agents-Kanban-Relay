/* The remote board viewer: what the relay page shows.
 *
 * Reads the board the Agents Kanban extension pushes (see the remote/ README).
 * Same hygiene rule as the extension's own webviews: everything on this page —
 * chat rows especially — is another program's output, so nodes and text only,
 * no innerHTML, ever. The agent's answers are rendered as markdown through a
 * port of the extension's own renderer, so what the watcher sees is the same
 * rich text the extension draws, not a wall of plain text.
 *
 * Privacy without a login: the board's address is sha-256(pairing code) hex,
 * cut to 24 chars, and the relay keeps no secret of its own. The code is typed
 * once per browser, and only the derived id is kept (localStorage) — so the
 * page never holds anything the relay could be robbed for, and forgetting the
 * board is one button.
 *
 * The WRITE half: when the board's owner has remote prompts enabled, the
 * index's `writes` flag is true and this page shows a composer. A posted
 * command is a PROMPT, never a board edit: with a session it goes to that
 * session's chat, without one it starts a new session — and the board's
 * machine decides whether it runs (its own `remote.writes` toggle is the gate;
 * the composer appears exactly while that toggle is on). The relay only
 * queues the command until the extension picks it up.
 *
 * The composer can also choose the MODEL, EFFORT and THINKING a command runs
 * with — the same knobs the extension's own composer exposes. The catalogue is
 * pushed by the host in `index.composer` (model ids and labels only: no
 * providers, no keys), and the page attaches the chosen values to the command
 * it posts. When the host has not published a catalogue, the pickers simply do
 * not draw and the composer is the plain prompt box it always was.
 *
 * Polling is adaptive so the free tiers last: fast (12s) while the board is
 * moving, slow (60s) once it has been quiet — a quiet board does not need
 * watching every few seconds, and every poll is a relay invocation.
 */
const root = document.getElementById('root')
// Every host serves the relay at <site>/board: Netlify rewrites it to its
// function, the Cloudflare worker and the Node server route it directly
// (remote/README.md).
const API = '/board'
const STORAGE = 'agents-kanban.remote'
const ACTIVE_MS = 30_000 // "moving" while the last push is fresher than this
const POLL_FAST = 12_000
const POLL_SLOW = 60_000
const POLL_ERROR = 15_000
const TICK_MS = 10_000 // age repaint cadence — not a network call

const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE) || 'null') } catch { return null }
})()
let id = (saved && /^[0-9a-f]{24}$/i.test(saved.id || '')) ? saved.id : ''
let tvs = (saved && saved.tvs && typeof saved.tvs === 'object') ? saved.tvs : {}

let index = null // { at, columns, sessions, writes, composer? }
let tails = {} // session key -> { at, entries }
let openKey = '' // the session whose chat is open
let error = ''
// "No board yet" is also the honest first word on boot, before the first poll
// has even run — an id remembered from last time is not an answer from the
// relay, and claiming "did not answer" before asking would be a lie.
let waiting = !!id
let polling = false // the poll chain runs once, however it started
let pendingPoll = 0 // the re-armed poll while no board id exists — so pairing can fire it now

/* Composer state lives OUTSIDE the DOM: the page rebuilds the whole tree on
 * every poll, and a draft held in a textarea would be destroyed mid-word. The
 * same discipline as the extension's own settings page. `sel` is the model /
 * effort / thinking the user picked for their next prompt; each starts unset
 * and falls back to the host's current default, so a user who never touches a
 * picker sends exactly what the board already does. */
const drafts = { board: '', chat: {} } // 'board' or a session key -> text
const sel = { model: '', effort: '', thinking: null } // '' / null = "host default"
let menu = '' // which picker's dropdown is open: 'model' | 'effort' | ''
let sendNote = { text: '', ok: false } // the last send's outcome, shown inline

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined && text !== null) n.textContent = String(text)
  return n
}

const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation() }

const since = (at) => {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 10) return 'just now'
  if (secs < 60) return secs + 's ago'
  const mins = Math.round(secs / 60)
  if (mins < 60) return mins + 'm ago'
  const hours = Math.round(mins / 60)
  return hours < 24 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago'
}

const saveState = () => {
  try { localStorage.setItem(STORAGE, JSON.stringify({ id, tvs })) } catch { /* private mode */ }
}

/* --- pairing ---------------------------------------------------------------- */

async function boardIdOf(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

function pairScreen() {
  const box = el('section', 'pair')
  const brand = el('div', 'brand')
  brand.append(el('span', 'mark', 'A'), el('h1', '', 'Remote board'))
  box.appendChild(brand)
  box.appendChild(el('p', 'muted',
    'This page mirrors a board that the Agents Kanban extension pushes. Enter the ' +
    'pairing code you chose when you connected the relay (extension settings → ' +
    'Remote Control) to watch this board from here.'))
  const row = el('div', 'code-row')
  const input = el('input', 'code')
  input.type = 'text'
  input.placeholder = 'The pairing code'
  input.autocomplete = 'off'
  input.spellcheck = false
  row.appendChild(input)
  const err = el('p', 'error hidden', '')
  const go = el('button', 'primary', 'Watch the board')
  const watch = async () => {
    const code = input.value.trim()
    if (!code) { err.textContent = 'A pairing code is needed.'; err.classList.remove('hidden'); return }
    err.classList.add('hidden')
    try {
      id = await boardIdOf(code)
    } catch (e) {
      err.textContent = 'This browser cannot derive a board address: ' + String(e)
      err.classList.remove('hidden')
      return
    }
    tvs = {}
    openKey = ''
    // A freshly derived id has not asked the relay anything yet — the screen
    // between now and the first poll must say "waiting", not "did not answer".
    waiting = true
    saveState()
    render()
    // The boot poll re-armed itself while there was no id yet; fire it now,
    // or a freshly paired page stares at "waiting" for the whole interval.
    clearTimeout(pendingPoll)
    void poll()
    ensurePolling()
  }
  go.addEventListener('click', watch)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') watch() })
  row.append(go)
  box.append(row, err)
  // The board address is the id; a link to it skips the code on a new device.
  const m = /^#([0-9a-f]{24})$/.exec(location.hash)
  if (m) { id = m[1].toLowerCase(); waiting = true; saveState() }
  return box
}

/* --- the board -------------------------------------------------------------- */

function agentText(c) {
  const a = c.agent || {}
  if (a.kind === 'interrupted') return 'Interrupted — the machine went away'
  if (a.kind === 'queued') return 'Queued — waiting to start'
  return (a.kind || 'working') + (a.tool ? ' — ' + a.tool : '')
}

function statusRow() {
  const row = el('div', 'status')
  if (!index) {
    row.appendChild(el('span', 'dot idle'))
    row.appendChild(el('span', '', waiting
      ? 'Waiting for the first push from the extension.'
      : 'Checking the relay…'))
    return row
  }
  const dot = el('span', 'dot ok')
  dot.setAttribute('data-live-dot', String(index.at))
  row.appendChild(dot)
  const t = el('span', 'age', 'Last push ' + since(index.at))
  t.dataset.kind = 'push'
  t.setAttribute('data-at', String(index.at))
  row.appendChild(t)
  return row
}

function cardNode(key, s) {
  const n = el('button', 'card')
  n.type = 'button'
  n.title = 'Open the chat for ' + s.title
  n.appendChild(el('strong', 'card-title', s.title))
  if (s.agent) {
    const a = el('span', 'agent-line')
    a.appendChild(el('span', 'dot small ' + (s.agent.kind === 'interrupted' ? 'bad' : 'live')))
    a.appendChild(el('span', '', agentText(s)))
    n.appendChild(a)
  }
  if (s.tags && s.tags.length) {
    const tags = el('span', 'tags')
    for (const t of s.tags) tags.appendChild(el('span', 'tag', t))
    n.appendChild(tags)
  }
  const meta = el('span', 'meta age', 'updated ' + since(s.updated))
  meta.dataset.kind = 'updated'
  meta.setAttribute('data-at', String(s.updated))
  n.appendChild(meta)
  n.addEventListener('click', () => { openKey = key; render() })
  return n
}

function boardScreen() {
  const head = el('header', 'head')
  const brand = el('div', 'brand')
  brand.append(el('span', 'mark', 'A'), el('h1', '', 'Remote board'))
  head.appendChild(brand)
  const spacer = el('div', 'spacer')
  head.appendChild(spacer)
  const forget = el('button', 'ghost', 'Forget this board')
  forget.title = 'Stops this browser watching. The board stays on the relay until the extension pauses or repoints it.'
  forget.addEventListener('click', () => {
    localStorage.removeItem(STORAGE)
    location.reload()
  })
  head.appendChild(forget)
  const wrap = el('main', 'board-wrap')
  wrap.appendChild(statusRow())
  if (error) wrap.appendChild(el('p', 'error', error))

  if (!index) {
    wrap.appendChild(el('p', 'muted', waiting
      ? 'Nothing has arrived yet. Open Agents Kanban → settings → Remote Control and press "Save and connect". This page updates by itself.'
      : 'The relay did not answer. Check that the site is deployed.'))
    return [head, wrap]
  }

  const board = el('div', 'board')
  const cols = index.columns || []
  const keys = Object.keys(index.sessions || {})
  const columnFor = (cid, name, placed) => {
    const col = el('section', 'column')
    const colHead = el('div', 'column-head')
    colHead.append(el('span', 'dot'), el('span', 'col-name', name))
    colHead.append(el('span', 'col-count', String(placed.length)))
    col.appendChild(colHead)
    const list = el('div', 'cards')
    for (const key of placed) list.appendChild(cardNode(key, index.sessions[key]))
    if (!placed.length) list.appendChild(el('p', 'muted empty', 'Nothing here'))
    col.appendChild(list)
    return col
  }
  for (const c of cols) {
    board.appendChild(columnFor(c.id, c.name || c.id, keys.filter((k) => index.sessions[k].phase === c.id)))
  }
  // Cards whose phase matches no column still get a home — a phase the board
  // used to have must not make its sessions vanish from the page.
  const unplaced = keys.filter((k) => !cols.some((c) => c.id === index.sessions[k].phase))
  if (unplaced.length) board.appendChild(columnFor(null, 'Elsewhere', unplaced))
  wrap.appendChild(board)
  if (openKey) wrap.appendChild(chatPanel(openKey))
  // The write channel is drawn exactly while the HOST's toggle is on — a
  // composer that posts into a void would be a dead control.
  if (index.writes === true) {
    wrap.appendChild(composerNode({
      get: () => drafts.board,
      set: (v) => { drafts.board = v },
      focusKey: 'composer::board',
      placeholder: "Start a new session with this prompt — it runs on the board's machine",
      sendText: 'Start a session',
    }))
  }
  return [head, wrap]
}

/* --- the chat --------------------------------------------------------------- */

function chatPanel(key) {
  const s = index.sessions[key]
  const panel = el('section', 'chat')
  const head = el('div', 'chat-head')
  const back = el('button', 'ghost', '← Board')
  back.addEventListener('click', () => { openKey = ''; render() })
  head.appendChild(back)
  if (s) head.appendChild(el('strong', 'chat-title', s.title))
  panel.appendChild(head)

  const tail = tails[key]
  const body = el('div', 'entries')
  if (!tail || !tail.entries || !tail.entries.length) {
    body.appendChild(el('p', 'muted', 'No chat has arrived for this session yet.'))
  } else {
    for (const e of tail.entries) body.appendChild(entryNode(e))
  }
  panel.appendChild(body)
  if (index.writes === true) {
    panel.appendChild(composerNode({
      get: () => drafts.chat[key] || '',
      set: (v) => { drafts.chat[key] = v || '' },
      focusKey: 'composer::chat::' + key,
      placeholder: "Send a prompt to this session — it runs on the board's machine",
      sendText: 'Send',
      session: key,
    }))
  }
  return panel
}

/* --- the write channel ------------------------------------------------------ */

/* Post one command to the relay. The command is a prompt for the board's
 * machine: with `session` it goes to that session's chat, without it starts a
 * new session. The relay only queues it — whether it runs is the board
 * machine's decision, and this page offers the composer only while the index
 * says that machine has the channel on. When the host published a model
 * catalogue, the chosen model / effort / thinking ride along so the prompt runs
 * the way it would from the extension. Returns true when the relay accepted
 * the post; the caller clears the draft only then, so a failed send loses
 * nothing. */
async function sendCommand(text, session) {
  let nonce = ''
  try {
    nonce = crypto.randomUUID && crypto.randomUUID()
  } catch { /* very old browser */ }
  if (!nonce) nonce = String(Date.now()) + Math.random().toString(36).slice(2)
  const body = { kind: 'command', nonce, text }
  if (session) body.session = session
  const c = composer()
  if (c.models && c.models.length) {
    const m = chosenModel()
    if (m) body.model = m
    if (c.efforts && c.efforts.length) {
      const ef = chosenEffort()
      if (ef) body.effort = ef
    }
    if (c.thinkingSupported) body.thinking = chosenThinking() ? 'enabled' : 'disabled'
  }
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rc-key': id },
      body: JSON.stringify(body),
    })
    const answer = await res.json().catch(() => ({}))
    if (!res.ok || answer.ok === false) {
      throw new Error((answer && answer.error) || 'the relay answered ' + res.status)
    }
    sendNote = { text: 'Sent — the board picks it up on its next check.', ok: true }
    return true
  } catch (e) {
    sendNote = { text: 'Not sent: ' + (e && e.message ? e.message : e), ok: false }
    return false
  }
}

/* --- the composer ----------------------------------------------------------- */

/* The host's composer catalogue, or an empty object when the host has not
 * published one. Its shape is `{ model, effort, thinking, thinkingSupported,
 * models: [{id,label,detail?}], efforts: [{key,label}] }` — ids and labels
 * only, never a provider or a key. */
const composer = () => (index && index.composer) || {}
const models = () => composer().models || []
const efforts = () => composer().efforts || []
const chosenModel = () => sel.model || composer().model || ''
const chosenEffort = () => sel.effort || composer().effort || ''
const chosenThinking = () => (sel.thinking == null ? composer().thinking !== 'disabled' : sel.thinking)

function modelLabel(id) {
  const m = models().find((x) => x.id === id)
  return m ? m.label : (id || 'Model')
}
function effortLabel(key) {
  const e = efforts().find((x) => x.key === key)
  return e ? e.label : (key || 'Effort')
}

/* The model / effort / thinking chips above the prompt box. Drawn only when
 * the host published something to pick from — a picker full of nothing is a
 * dead control, exactly the kind this page refuses to draw. */
function pickerBar() {
  const c = composer()
  const parts = []
  if (c.models && c.models.length) parts.push(modelPicker())
  if (c.efforts && c.efforts.length) parts.push(effortPicker())
  if (c.thinkingSupported) parts.push(thinkingPicker())
  if (!parts.length) return null
  const bar = el('div', 'composer-bar')
  for (const p of parts) bar.appendChild(p)
  return bar
}

function dropdown(items, onPick, isOn) {
  const box = el('div', 'menu')
  for (const it of items) {
    const row = el('button', 'menu-item' + (isOn(it) ? ' on' : ''))
    row.type = 'button'
    row.append(el('span', 'menu-item-label', it.label))
    if (it.detail) row.append(el('span', 'menu-item-meta', it.detail))
    row.addEventListener('click', () => { onPick(it); render() })
    box.appendChild(row)
  }
  return box
}

function modelPicker() {
  const wrap = el('div', 'picker-wrap')
  const open = menu === 'model'
  const current = chosenModel()
  const btn = el('button', 'picker' + (current ? ' on' : ''), modelLabel(current))
  btn.type = 'button'
  btn.title = 'Which model runs this prompt'
  btn.addEventListener('click', () => { menu = open ? '' : 'model'; render() })
  wrap.appendChild(btn)
  if (open) {
    wrap.appendChild(dropdown(
      models().map((m) => ({ id: m.id, label: m.label, detail: m.detail })),
      (it) => { sel.model = it.id; menu = '' },
      (it) => it.id === current,
    ))
  }
  return wrap
}

function effortPicker() {
  const wrap = el('div', 'picker-wrap')
  const open = menu === 'effort'
  const current = chosenEffort()
  const btn = el('button', 'picker' + (current ? ' on' : ''), effortLabel(current))
  btn.type = 'button'
  btn.title = 'How much effort this prompt gets'
  btn.addEventListener('click', () => { menu = open ? '' : 'effort'; render() })
  wrap.appendChild(btn)
  if (open) {
    wrap.appendChild(dropdown(
      efforts().map((e) => ({ id: e.key, label: e.label })),
      (it) => { sel.effort = it.id; menu = '' },
      (it) => it.id === current,
    ))
  }
  return wrap
}

function thinkingPicker() {
  const on = chosenThinking()
  const btn = el('button', 'picker' + (on ? ' on' : ''), on ? 'Thinking: on' : 'Thinking: off')
  btn.type = 'button'
  btn.title = 'Whether this prompt thinks out loud'
  btn.addEventListener('click', () => { sel.thinking = !on; render() })
  return btn
}

/* One composer. The draft lives at module level (see `drafts`) and the
 * textarea re-renders from it on every poll, so a half-typed prompt survives
 * the rebuilds; `focusKey` is how render() hands the caret back. */
function composerNode({ get, set, focusKey, placeholder, sendText, session }) {
  const box = el('div', 'composer')
  const bar = pickerBar()
  if (bar) box.appendChild(bar)
  const ta = el('textarea', 'composer-input')
  ta.placeholder = placeholder
  ta.maxLength = 20000 // the relay's own cap (CMD_TEXT_MAX)
  ta.rows = 3
  ta.value = get()
  ta.setAttribute('data-focus', focusKey)
  ta.addEventListener('input', (e) => {
    set((e && e.target ? e.target.value : ta.value) || '')
  })
  const acts = el('div', 'composer-acts')
  const send = el('button', 'primary', sendText)
  send.type = 'button'
  send.addEventListener('click', () => {
    const text = get().trim()
    if (!text) return
    void (async () => {
      if (await sendCommand(text, session)) set('')
      render()
    })()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send.click()
    }
  })
  acts.appendChild(send)
  if (sendNote.text) {
    acts.appendChild(el('span', 'muted small composer-note' + (sendNote.ok ? '' : ' error'),
      sendNote.text))
  }
  box.append(ta, acts)
  return box
}

/* --- the transcript --------------------------------------------------------- */

const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const humanMs = (ms) => (ms < 60_000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm')

function whenSpan(at) {
  const w = el('span', 'when', timeOf(at))
  w.title = new Date(at).toLocaleString()
  return w
}

function speakerRow(who, at) {
  const line = el('div', 'who')
  line.append(el('span', 'speaker', who))
  if (at) line.append(whenSpan(at))
  return line
}

function entryNode(e) {
  const row = el('div', 'entry e-' + e.kind)
  switch (e.kind) {
    case 'prompt': {
      row.appendChild(el('span', 'who', 'You'))
      const body = el('div', 'prompt-body', e.text || '')
      if (e.images) body.appendChild(el('div', 'muted small',
        '🖼 attached ' + e.images + (e.images === 1 ? ' image' : ' images')))
      row.appendChild(body)
      return row
    }
    case 'text':
      row.appendChild(speakerRow('Agent', e.at))
      row.appendChild(renderMarkdown(e.text))
      return row
    case 'thinking': {
      row.appendChild(speakerRow('Thinking', e.at))
      const det = el('details', 'thinking')
      det.appendChild(el('summary', '', 'Thought for a moment'))
      det.appendChild(el('div', 'thinking-body', e.text || ''))
      row.appendChild(det)
      return row
    }
    case 'tool': {
      const line = el('div', 'tool-line')
      line.appendChild(el('code', '', e.name))
      line.appendChild(el('span', 'tool-status ' + (e.status === 'error' ? 'error' : e.status === 'running' ? 'running' : 'ok'),
        e.status === 'error' ? 'failed' : e.status === 'running' ? 'running' : 'done'))
      if (e.durationMs !== undefined) line.appendChild(el('span', 'muted small', '· ' + humanMs(e.durationMs)))
      line.appendChild(whenSpan(e.at))
      row.appendChild(line)
      if (e.children && e.children.length) {
        const det = el('details', 'subagent')
        const tools = e.children.filter((k) => k.kind === 'tool').length
        det.appendChild(el('summary', '',
          'Subagent · ' + e.children.length + (e.children.length === 1 ? ' step' : ' steps') +
          (tools ? ' · ' + tools + (tools === 1 ? ' tool call' : ' tool calls') : '')))
        const nest = el('div', 'subagent-body')
        for (const kid of e.children) nest.appendChild(entryNode(kid))
        det.appendChild(nest)
        row.appendChild(det)
      }
      return row
    }
    case 'phase': {
      const line = el('div', 'phase-line')
      line.append(el('span', '', e.from), el('span', 'arrow', '→'), el('span', '', e.to))
      if (e.note) line.appendChild(el('span', 'muted', ' — ' + e.note))
      row.appendChild(line)
      return row
    }
    case 'result':
      row.appendChild(el('span', 'done',
        'Done' + (e.summary ? ': ' + e.summary : '') + (e.durationMs !== undefined ? ' (' + humanMs(e.durationMs) + ')' : '')))
      return row
    case 'notice':
      row.appendChild(el('div', 'notice-body' + (e.urgency === 'blocked' ? ' blocked' : ''), e.message))
      return row
    case 'error':
      row.appendChild(el('div', 'err-body', e.message))
      return row
    default:
      row.appendChild(el('span', 'muted', '(a row this viewer does not know)'))
      return row
  }
}

/* --- markdown --------------------------------------------------------------- */

/* A port of the extension's own renderer (media/board.js): the same block and
 * inline grammar, the same nodes-and-text-only discipline. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
const SAFE_HREF = /^(https?:|mailto:)/i
const BARE_URL = /^https?:\/\/[^\s<>()[\]]+/

function renderMarkdown(text) {
  const box = el('div', 'md')
  for (const n of mdBlocks(String(text == null ? '' : text))) box.appendChild(n)
  return box
}

const isTableStart = (line, next) =>
  line.includes('|') && next != null && next.includes('|') && TABLE_SEP.test(next)
const isBlockStart = (line, next) =>
  FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next)

/** Block structure. `tight` is for list items: a lone paragraph comes back as
 *  a <span> so "- one" is an <li> with text in it, not an <li> with a <p>. */
function mdBlocks(src, tight) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    let m
    if ((m = FENCE.exec(line))) {
      const close = new RegExp('^\\s{0,3}' + m[1][0] + '{' + m[1].length + ',}\\s*$')
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
      i++ // the closing fence — or one past the end, which is the streaming case
      out.push(codeBlock(m[2], body.join('\n')))
      continue
    }
    if ((m = HEADING.exec(line))) {
      const h = el('h' + m[1].length)
      for (const n of inline(m[2])) h.appendChild(n)
      out.push(h); i++; continue
    }
    if (HR.test(line)) { out.push(el('hr')); i++; continue }
    if (QUOTE.test(line)) {
      const q = []
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { q.push(m[1]); i++ }
      const bq = el('blockquote')
      for (const n of mdBlocks(q.join('\n'))) bq.appendChild(n)
      out.push(bq); continue
    }
    if (isTableStart(line, lines[i + 1])) {
      const rows = [line]
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(lines[i++])
      out.push(table(rows)); continue
    }
    if ((m = ITEM.exec(line))) {
      const base = m[1].length
      const ordered = /\d/.test(m[2])
      const block = []
      while (i < lines.length) {
        const l = lines[i]
        const it = ITEM.exec(l)
        if (it && it[1].length <= base && /\d/.test(it[2]) !== ordered) break
        const cont = (x) => ITEM.test(x) || /^\s+\S/.test(x)
        if (cont(l)) { block.push(l); i++; continue }
        if (!l.trim() && i + 1 < lines.length && cont(lines[i + 1])) { block.push(l); i++; continue }
        break
      }
      out.push(list(block)); continue
    }
    const para = [line]
    i++
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++])
    const p = el(tight ? 'span' : 'p')
    para.forEach((l, k) => { if (k) p.appendChild(el('br')); for (const n of inline(l)) p.appendChild(n) })
    out.push(p)
  }
  return out
}

function codeBlock(lang, code) {
  const box = el('div', 'codeblock')
  const head = el('div', 'codeblock-head')
  head.appendChild(el('span', 'codeblock-lang', lang || ''))
  const copy = el('button', 'codeblock-copy', 'Copy')
  copy.type = 'button'
  copy.title = 'Copy the code'
  copy.addEventListener('click', (e) => { stop(e); copyText(code, copy) })
  head.appendChild(copy)
  const pre = el('pre')
  pre.appendChild(el('code', lang ? 'lang-' + lang : null, code))
  box.append(head, pre)
  return box
}

function copyText(text, btn) {
  const done = () => {
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => {})
    return
  }
  // No async clipboard (not a secure context): the textarea dance. Guarded —
  // the stub DOM this page is tested against has no body.
  if (!document.body) return
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  try { ta.select(); document.execCommand('copy'); done() } catch (e) { /* nothing to copy with */ }
  ta.remove()
}

function list(block) {
  const first = ITEM.exec(block[0])
  const ordered = /\d/.test(first[2])
  const root = el(ordered ? 'ol' : 'ul')
  if (ordered && parseInt(first[2], 10) > 1) root.setAttribute('start', String(parseInt(first[2], 10)))
  const base = first[1].length
  const width = base + first[2].length + 1
  const items = []
  let cur = null
  for (const l of block) {
    const m = ITEM.exec(l)
    if (m && m[1].length <= base) { cur = [m[3]]; items.push(cur) }
    else if (cur) {
      const lead = /^\s*/.exec(l)[0].length
      cur.push(l.trim() ? l.slice(Math.min(width, lead)) : '')
    }
  }
  for (const lines of items) {
    const li = el('li')
    for (const n of mdBlocks(lines.join('\n'), true)) li.appendChild(n)
    root.appendChild(li)
  }
  return root
}

function table(rows) {
  const cells = (r) => {
    let t = r.trim()
    if (t.startsWith('|')) t = t.slice(1)
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
    return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
  }
  const wrap = el('div', 'table-wrap')
  const tb = el('table')
  const thead = el('thead'), hr = el('tr')
  for (const c of cells(rows[0])) { const th = el('th'); for (const n of inline(c)) th.appendChild(n); hr.appendChild(th) }
  thead.appendChild(hr)
  const tbody = el('tbody')
  for (const r of rows.slice(1)) {
    const tr = el('tr')
    for (const c of cells(r)) { const td = el('td'); for (const n of inline(c)) td.appendChild(n); tr.appendChild(td) }
    tbody.appendChild(tr)
  }
  tb.append(thead, tbody)
  wrap.appendChild(tb)
  return wrap
}

/** Inline markdown → an array of nodes. Text is accumulated and emitted as
 *  text nodes; only the markers below ever become elements. */
function inline(str) {
  const out = []
  let buf = ''
  const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = '' } }
  const MARKS = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']]
  let i = 0
  const n = str.length
  while (i < n) {
    const ch = str[i]
    if (ch === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!~|>]/.test(str[i + 1])) { buf += str[i + 1]; i += 2; continue }
    if (ch === '`') {
      const run = /^`+/.exec(str.slice(i))[0]
      let end = str.indexOf(run, i + run.length)
      while (end !== -1 && str[end + run.length] === '`') end = str.indexOf(run, end + 1)
      if (end !== -1) {
        flush()
        out.push(el('code', null, str.slice(i + run.length, end).replace(/^ (.*[^ ].*) $/, '$1')))
        i = end + run.length
        continue
      }
      buf += run; i += run.length; continue
    }
    if (ch === '[') {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(str.slice(i))
      if (m) {
        flush()
        if (SAFE_HREF.test(m[2])) { const a = el('a'); a.href = m[2]; for (const n of inline(m[1])) a.appendChild(n); out.push(a) }
        else { for (const n of inline(m[1])) out.push(n) }
        i += m[0].length
        continue
      }
    }
    if (ch === 'h' && (str.startsWith('http://', i) || str.startsWith('https://', i)) && (i === 0 || /[\s(\["'<]/.test(str[i - 1]))) {
      // Match first, and fall through to the literal-text path when there is
      // nothing to link — an unlinkable scheme must render as the characters
      // the agent actually wrote, not throw. (A bare scheme once unwound the
      // whole transcript to a blank panel.)
      const um = BARE_URL.exec(str.slice(i))
      if (um) {
        const url = um[0].replace(/[.,;:!?'"]+$/, '')
        flush()
        const a = el('a', null, url); a.href = url
        out.push(a)
        i += url.length
        continue
      }
    }
    let matched = false
    for (const [mark, tag] of MARKS) {
      if (!str.startsWith(mark, i)) continue
      const prev = i ? str[i - 1] : ''
      const next = str[i + mark.length]
      if (!next || /\s/.test(next)) break
      if (mark[0] === '_' && /\w/.test(prev)) break
      let j = str.indexOf(mark, i + mark.length)
      while (j !== -1) {
        const before = str[j - 1], after = str[j + mark.length]
        if (!/\s/.test(before) && !(mark[0] === '_' && after && /\w/.test(after))) break
        j = str.indexOf(mark, j + 1)
      }
      if (j !== -1) {
        flush()
        const e = el(tag)
        for (const n of inline(str.slice(i + mark.length, j))) e.appendChild(n)
        out.push(e)
        i = j + mark.length
        matched = true
      }
      break
    }
    if (matched) continue
    buf += ch; i++
  }
  flush()
  return out
}

/* --- polling ---------------------------------------------------------------- */

async function poll() {
  if (!id) {
    // No board address yet — the pairing screen will set one. The chain must
    // re-arm anyway: the boot poll runs BEFORE a typed code exists, and if it
    // died here, pairing on the page would never be polled. A hash link needs
    // no special case because it sets the id before the first poll runs.
    pendingPoll = setTimeout(poll, POLL_ERROR)
    return
  }
  let next = POLL_ERROR
  error = ''
  try {
    const res = await fetch(API + '?id=' + encodeURIComponent(id))
    if (res.status === 404) {
      waiting = true
      index = null
      render()
      next = POLL_ERROR
    } else if (!res.ok) {
      error = 'The relay answered ' + res.status + '.'
      render()
    } else {
      const { index: fresh } = await res.json()
      waiting = false
      index = fresh
      // Fetch the tails the index says changed since this browser last looked.
      const freshTvs = {}
      for (const key of Object.keys(fresh.sessions)) {
        const tv = fresh.sessions[key].tv
        freshTvs[key] = tv
        if ((tvs[key] || 0) !== tv) await fetchTail(key)
      }
      // Sessions that left the board leave with their chats.
      for (const key of Object.keys(tails)) {
        if (!(key in fresh.sessions)) delete tails[key]
      }
      tvs = freshTvs
      saveState()
      next = Date.now() - fresh.at < ACTIVE_MS ? POLL_FAST : POLL_SLOW
      render()
    }
  } catch (e) {
    error = 'Could not reach the relay: ' + (e && e.message ? e.message : e)
    render()
  }
  setTimeout(poll, next)
}

/** Start the poll chain exactly once. Pairing happens after boot, so the
 *  first `poll()` may have returned before an id existed. */
function ensurePolling() {
  if (polling) return
  polling = true
  poll()
}

async function fetchTail(key) {
  try {
    const res = await fetch(API + '?id=' + encodeURIComponent(id) + '&tail=' + encodeURIComponent(key))
    if (!res.ok) return
    const { tail } = await res.json()
    if (tail && Array.isArray(tail.entries)) tails[key] = tail
  } catch {
    // A tail that fails to load is retried on the next poll: the index still
    // says its tv is newer than what this browser holds.
  }
}

/* --- render + the age tick -------------------------------------------------- */

function render() {
  // The whole tree is replaced on every poll, so a focused input would be
  // destroyed mid-word. `data-focus` marks the inputs that survive — the
  // composer textareas — and the caret is handed back here.
  const active = document.activeElement
  const focusKey = active && active.getAttribute ? active.getAttribute('data-focus') : null
  const caret = active && typeof active.selectionStart === 'number'
    ? { start: active.selectionStart, end: active.selectionEnd }
    : null
  // Both screens RETURN what render draws. A screen that drew into the root
  // itself and returned nothing once replaced the whole page with the text
  // node "undefined" — render() draws whatever it is given, and `undefined`
  // stringifies. The one rule: these builders never touch the root.
  const nodes = id ? boardScreen() : [pairScreen()]
  root.replaceChildren(...nodes)
  if (focusKey) {
    const next = root.querySelector('[data-focus="' + focusKey + '"]')
    if (next) {
      next.focus()
      if (caret && typeof next.selectionStart === 'number') {
        try { next.selectionStart = caret.start; next.selectionEnd = caret.end } catch { /* not focusable */ }
      }
    }
  }
}

// Between polls the ages would lie still. "Never show a signal that cannot say
// bad": a machine that stopped pushing must read as stopped, not frozen mid-
// "live". These repaints touch only the age text and the live dot — never the
// chat scroll position.
function tick() {
  const now = Date.now()
  for (const n of root.querySelectorAll('.age')) {
    const at = Number(n.getAttribute('data-at'))
    if (!Number.isFinite(at)) continue
    n.textContent = (n.dataset.kind === 'push' ? 'Last push ' : 'updated ') + since(at)
    if (n.dataset.kind === 'push') {
      const dot = root.querySelector('[data-live-dot]')
      if (dot) dot.className = 'dot ' + (now - at < 120_000 ? 'ok' : now - at < 600_000 ? 'warn' : 'bad')
    }
  }
}

render()
setInterval(tick, TICK_MS)
ensurePolling()
