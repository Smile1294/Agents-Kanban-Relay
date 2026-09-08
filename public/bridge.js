/** The browser half of the remote board, over the relay.
 *
 * The page loads the extension's OWN board (media/board.js, copied verbatim).
 * That script expects to be inside a VS Code webview: `acquireVsCodeApi()` and
 * host messages arriving as `window` message events. This file IS that webview,
 * with the transport swapped for the relay's asynchronous protocol: a
 * `postMessage` becomes `POST /board { kind:'msg', nonce, msg }`, host frames
 * arrive by polling `/board` and are re-dispatched as window messages, and the
 * dialogs a webview never has to draw (quick picks, input boxes, modal
 * confirmations, toasts) are drawn here as overlays.
 *
 * No server-side secret exists, so pairing keeps the relay's model: the code is
 * typed once, `id = sha-256(code)` hex cut to 24 chars, and only `{ id }` is
 * kept. The code itself is never stored and never put in the URL.
 */
;(function () {
  'use strict'

  const STORE_KEY = 'agents-kanban.remote'
  const MSG_MAX_BYTES = 4_000_000

  // --- the pairing id ---------------------------------------------------------
  async function deriveId(code) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex.slice(0, 24)
  }

  function savedId() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
      return v && typeof v.id === 'string' && v.id ? v.id : ''
    } catch {
      return ''
    }
  }
  const saveId = (id) => localStorage.setItem(STORE_KEY, JSON.stringify({ id }))
  const forgetId = () => localStorage.removeItem(STORE_KEY)

  // `#<24hex>` in the URL hash pairs a new device without retyping the code.
  function idFromHash() {
    const m = /^#([0-9a-f]{24})$/i.exec(location.hash || '')
    return m ? m[1].toLowerCase() : ''
  }

  let id = savedId()

  // --- the page's view of the board ------------------------------------------
  let seq = null // the last seq we saw; null = first load (GET without since)
  let at = 0 // the last push timestamp; 0 = no board yet
  let seen = false // have we had a 200 answer yet?
  let writes = true // the last envelope's writes flag
  let mv = '' // the last frame's mv
  let catalogue = [] // the model catalogue, injected into frames like board.js would
  let cachedModelsMv = null // the mv of the catalogue we fetched
  let dispatchedFrame = false // has any frame been dispatched this page life?
  let longPoll = false // the last answer carried longPoll: true (Node host)
  let error = '' // the relay error text, when a poll failed
  let burstUntil = 0 // a post-send burst: poll fast until this instant
  let pollTimer = null
  let pollInFlight = false

  // --- acquireVsCodeApi ------------------------------------------------------
  const state = {}

  function postMessage(msg) {
    if (!id) return true // the gate is up; board.js's boot `ready` is dropped
    const body = { kind: 'msg', nonce: crypto.randomUUID(), msg }
    if (JSON.stringify(body).length > MSG_MAX_BYTES) {
      toast({ level: 'error', text: 'Too large for the relay (limit 4 MB) — remove an image' })
      return true
    }
    if (writes === false) {
      toast({ level: 'warning', text: 'Read-only — turn on "Allow actions from the remote page" in the extension’s Remote Control settings' })
      return true
    }
    burstUntil = Date.now() + 10_000
    nudgePoll()
    void sendEnvelope(body)
    return true
  }

  /** POST one envelope and fold its answer's `writes` back in. */
  async function sendEnvelope(body) {
    try {
      const res = await fetch('/board', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rc-key': id },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (json && typeof json.writes === 'boolean') {
        writes = json.writes
        renderStatus()
      }
    } catch {
      /* network — the poll loop surfaces it */
    }
  }

  window.acquireVsCodeApi = () => ({
    postMessage: async (msg) => {
      if (!msg || typeof msg !== 'object') return true
      const t = msg.type
      // Editor-only actions with a remote origin happen on the board's machine,
      // never here.
      if (t === 'openSettings' || t === 'focus' || t === 'openBoard' || t === 'closeBoard' || t === 'openFolder') {
        toast({ level: 'info', text: 'That happens on the board’s machine' })
        return true
      }
      // The mic belongs to THIS browser; dictation is handled below.
      if (t === 'voiceStart') { startDictation(); return true }
      if (t === 'voiceStop') { stopDictation(); return true }
      return postMessage(msg)
    },
    getState: () => state,
    setState: (s) => Object.assign(state, s),
  })

  // --- polling ---------------------------------------------------------------
  function boardUrl() {
    let u = '/board?id=' + encodeURIComponent(id)
    if (seq !== null) u += '&since=' + seq
    if (longPoll) u += '&wait=25'
    return u
  }

  function nudgePoll() {
    if (pollInFlight || !id) return
    clearTimeout(pollTimer)
    pollTimer = setTimeout(poll, 1_000)
  }

  function nextDelay() {
    if (error) return 15_000
    if (Date.now() < burstUntil) return 1_000
    const quiet = Date.now() - at
    if (quiet < 30_000) return 2_000
    if (quiet < 10 * 60_000) return 15_000
    return 60_000
  }

  function poll() {
    if (pollInFlight || !id) return
    pollInFlight = true
    void (async () => {
      let res
      try {
        res = await fetch(boardUrl())
      } catch {
        error = 'The relay did not answer — is it still running?'
        renderStatus()
        pollInFlight = false
        pollTimer = setTimeout(poll, 15_000)
        return
      }

      if (res.status === 404) {
        // No board yet — waiting for the extension's first push, not a failure.
        error = ''
        seen = false
        renderStatus()
        pollInFlight = false
        pollTimer = setTimeout(poll, nextDelay())
        return
      }

      let json = null
      try { json = await res.json() } catch { /* fall through */ }

      if (!res.ok || !json) {
        error = 'The relay answered ' + res.status
        renderStatus()
        pollInFlight = false
        pollTimer = setTimeout(poll, nextDelay())
        return
      }

      error = ''
      if (json.longPoll) longPoll = true
      seen = true
      await onAnswer(json)

      pollInFlight = false
      // A long-poll answer loops immediately (the host held it open); otherwise
      // follow the cadence.
      if (longPoll) pollTimer = setTimeout(poll, 0)
      else pollTimer = setTimeout(poll, nextDelay())
    })()
  }

  async function onAnswer(json) {
    if (typeof json.seq === 'number') seq = json.seq
    if (typeof json.at === 'number' && json.at > 0) at = json.at
    if (typeof json.writes === 'boolean') writes = json.writes
    if (typeof json.mv === 'string') mv = json.mv

    if (json.frame) {
      const frame = json.frame
      if (frame.state && frame.state.composer) {
        // Models ride separately; fetch them on the first frame of this page
        // life and whenever the catalogue's mv changes, then hand them to
        // board.js the way a full frame would (board.js keeps its catalogue
        // module-level, so a missing `models` means "the one you already have").
        if (!dispatchedFrame || cachedModelsMv !== mv) await fetchModels()
        frame.state.composer.models = catalogue
      }
      window.postMessage(frame, '*')
      dispatchedFrame = true
    }

    if (Array.isArray(json.events)) {
      for (const msg of json.events) {
        if (!msg || typeof msg.type !== 'string') continue
        if (msg.type === 'remote') onControl(msg)
        else window.postMessage(msg, '*')
      }
    }

    renderStatus()
  }

  async function fetchModels() {
    try {
      const res = await fetch('/board?id=' + encodeURIComponent(id) + '&models=1')
      if (!res.ok) return
      const json = await res.json().catch(() => null)
      if (json && Array.isArray(json.models)) {
        catalogue = json.models
        cachedModelsMv = typeof json.mv === 'string' ? json.mv : mv
      }
    } catch {
      /* leave the catalogue as it was */
    }
  }

  // --- bridge control frames -------------------------------------------------
  function onControl(frame) {
    if (frame.kind === 'toast') return toast(frame.spec)
    if (frame.kind === 'dialog') return dialog(frame.id, frame.spec)
  }

  // --- the gate --------------------------------------------------------------
  const GATE_DEFAULT = 'This board is locked with a pairing code. The code never leaves your machine — the relay only knows its hash.'

  function gateEl() { return document.getElementById('ak-gate') }

  function showGate(note) {
    if (gateEl()) {
      const p = gateEl().querySelector('p')
      if (p && note) p.textContent = note
      return
    }
    const div = document.createElement('div')
    div.id = 'ak-gate'
    const box = document.createElement('div')
    box.className = 'ak-gate-box'
    const h = document.createElement('h1')
    h.textContent = 'Agents Kanban'
    const p = document.createElement('p')
    p.textContent = note ?? GATE_DEFAULT
    const input = document.createElement('input')
    input.type = 'password'
    input.placeholder = 'Pairing code'
    input.autocomplete = 'off'
    const go = document.createElement('button')
    go.textContent = 'Open board'
    const enter = () => {
      const code = input.value.trim()
      if (!code) return
      void (async () => {
        const newId = await deriveId(code)
        saveId(newId)
        id = newId
        start()
      })()
    }
    go.addEventListener('click', enter)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter() })
    const wrong = document.createElement('button')
    wrong.className = 'ak-link'
    wrong.textContent = 'Forget this board'
    wrong.addEventListener('click', () => { forgetId(); gateEl()?.remove(); showGate() })
    box.append(h, p, input, go, wrong)
    div.append(box)
    document.body.append(div)
    input.focus()
  }

  // --- dialogs: what the webview never had to draw ---------------------------
  function dialog(id, spec) {
    const overlay = document.createElement('div')
    overlay.className = 'ak-overlay'
    const box = document.createElement('div')
    box.className = 'ak-dialog'
    const title = document.createElement('h2')
    title.textContent = spec.title ?? 'Agents Kanban'
    box.append(title)
    if (spec.text) {
      const body = document.createElement('p')
      body.className = 'ak-dialog-text'
      body.textContent = spec.text
      box.append(body)
    }
    const answer = (value) => { overlay.remove(); void postMessage({ type: 'remote.dialog', id, answer: value }) }
    overlay.addEventListener('click', (e) => { if (e.target === overlay && !spec.input) answer(null) })

    if (spec.input) {
      const input = document.createElement('input')
      input.type = spec.input.password ? 'password' : 'text'
      input.value = spec.input.value ?? ''
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') answer(input.value) })
      box.append(input)
      addButtons(box, [['OK', () => answer(input.value)], ['Cancel', () => answer(null)]])
      setTimeout(() => input.focus(), 0)
    } else if (spec.quickpick) {
      const list = document.createElement('div')
      list.className = 'ak-pick'
      const picked = new Set()
      for (const it of spec.quickpick.items) {
        if (it.kind === -1) { // Separator: label only, never selectable
          const sep = document.createElement('div')
          sep.className = 'ak-pick-sep'
          sep.textContent = it.label
          list.append(sep)
          continue
        }
        const row = document.createElement('button')
        row.className = 'ak-pick-row'
        const lab = document.createElement('span')
        lab.textContent = it.label
        row.append(lab)
        if (it.detail) {
          const det = document.createElement('span')
          det.className = 'ak-pick-detail'
          det.textContent = it.detail
          row.append(det)
        }
        if (!spec.quickpick.many) {
          row.addEventListener('click', () => answer(it.item))
        } else {
          row.addEventListener('click', () => {
            if (picked.has(it)) picked.delete(it)
            else picked.add(it)
            row.classList.toggle('ak-picked', picked.has(it))
          })
        }
        list.append(row)
      }
      box.append(list)
      if (spec.quickpick.many) {
        addButtons(box, [['OK', () => answer([...picked].map((x) => x.item))], ['Cancel', () => answer(null)]])
      }
    } else {
      addButtons(box, [
        ...(spec.choices ?? []).map((c) => [c, () => answer(c)]),
        ['Cancel', () => answer(null)],
      ])
    }
    overlay.append(box)
    document.body.append(overlay)
  }

  function addButtons(box, defs) {
    const row = document.createElement('div')
    row.className = 'ak-dialog-buttons'
    for (const [label, fn] of defs) {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', fn)
      row.append(b)
    }
    box.append(row)
  }

  function toast(spec) {
    const t = document.createElement('div')
    t.className = 'ak-toast ak-toast-' + (spec.level ?? 'info')
    const text = document.createElement('span')
    text.textContent = spec.text
    t.append(text)
    if (spec.url) {
      const open = document.createElement('button')
      open.textContent = 'Open'
      open.addEventListener('click', () => { const w = window.open(spec.url, '_blank'); if (w) w.opener = null })
      t.append(open)
    }
    document.body.append(t)
    setTimeout(() => t.remove(), 7000)
  }

  // --- dictation from THIS browser -------------------------------------------
  let recorder = null
  let mediaStream = null

  function startDictation() {
    void (async () => {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        recorder = new MediaRecorder(mediaStream)
        const chunks = []
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
        recorder.onstop = () => {
          void (async () => {
            const blob = new Blob(chunks, { type: recorder.mimeType })
            const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
            const body = { kind: 'msg', nonce: crypto.randomUUID(), msg: { type: 'voiceAudio', mediaType: recorder.mimeType, data } }
            if (JSON.stringify(body).length > MSG_MAX_BYTES) {
              toast({ level: 'error', text: 'Too large for the relay (limit 4 MB) — the recording was too long' })
            } else {
              await sendEnvelope(body)
            }
            if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null }
            recorder = null
          })()
        }
        recorder.start()
        window.postMessage({ type: 'voice', started: true }, '*')
      } catch {
        window.postMessage({ type: 'voice', started: false, error: 'Microphone unavailable' }, '*')
      }
    })()
  }

  function stopDictation() {
    if (recorder && recorder.state !== 'inactive') { recorder.stop(); return }
    window.postMessage({ type: 'voice', started: false, error: 'Nothing recording' }, '*')
  }

  function bytesToBase64(bytes) {
    const CHUNK = 0x8000
    let bin = ''
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(bin)
  }

  // --- the status strip ------------------------------------------------------
  let pillNode = null
  let roNode = null
  let errNode = null

  function ensureStatus() {
    if (document.getElementById('rc-status')) return
    const wrap = document.createElement('div')
    wrap.id = 'rc-status'

    const pill = document.createElement('span')
    pill.className = 'rc-pill'
    wrap.append(pill)
    pillNode = pill

    const ro = document.createElement('span')
    ro.className = 'rc-ro'
    ro.textContent = 'READ-ONLY'
    ro.title = 'The extension has "Allow actions from the remote page" off — this page can watch the board but not act on it.'
    wrap.append(ro)
    roNode = ro

    const forget = document.createElement('button')
    forget.className = 'rc-forget'
    forget.textContent = 'Forget this board'
    forget.addEventListener('click', () => { forgetId(); location.reload() })
    wrap.append(forget)

    const err = document.createElement('div')
    err.className = 'rc-error'
    wrap.append(err)
    errNode = err

    document.body.append(wrap)
  }

  function ageText(ms) {
    const s = Math.floor(ms / 1000)
    if (s < 2) return 'live'
    if (s < 60) return s + 's ago'
    const m = Math.floor(s / 60)
    if (m < 60) return m + 'm ago'
    return Math.floor(m / 60) + 'h ago'
  }

  function renderStatus() {
    if (!id) return
    ensureStatus()
    const age = at ? Date.now() - at : 0

    pillNode.textContent = seen
      ? (age < 30_000 ? 'live · ' + ageText(age) : ageText(age))
      : 'waiting for the board'
    pillNode.className = 'rc-pill' + (
      !seen || age < 2 * 60_000 ? ' rc-fresh' : age < 10 * 60_000 ? ' rc-stale' : ' rc-dead'
    )

    roNode.style.display = writes === false ? '' : 'none'
    errNode.textContent = error
  }

  // Repaint ages every 10 s without touching board.js's DOM.
  setInterval(() => { if (id) renderStatus() }, 10_000)

  // --- connect ---------------------------------------------------------------
  function start() {
    const g = gateEl()
    if (g) g.remove()
    renderStatus()
    poll()
  }

  const hashId = idFromHash()
  if (hashId) {
    // A shared `#<id>` pairs this device: adopt it and clear the hash.
    id = hashId
    saveId(id)
    history.replaceState(null, '', location.pathname + location.search)
  }

  if (!id) showGate()
  else start()
})()
