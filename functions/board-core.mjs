/* The relay's logic, with the store injected.
 *
 * Each host target (the Netlify function board.mjs, the Cloudflare worker
 * worker.js, the plain-Node server server.js) supplies the real store; this
 * module runs in this repository's test suite against a fake one, so the
 * relay's behaviour — the write gate, the storage names, the clock, the frame,
 * the event ring and the message queue — is pinned without a network or a
 * deployed account.
 *
 * Contract v2: the relay no longer builds a redacted card index. It carries
 * the extension's OWN board webview. The extension pushes the frames it would
 * post to that webview (`{ type:'state', state }`, with `state.composer.models`
 * already split out), plus the model catalogue separately, and it pushes
 * host→page events; the page queues the webview messages it would post back.
 * The relay stores all of it and nothing else. Whether a queued message RUNS
 * is the extension's decision (`remote.writes`), never this module's.
 *
 * The threat model is unchanged and worth stating:
 *
 *  - The relay stores NOTHING secret. A board's address is the sha-256 of the
 *    pairing code, and the pairing code exists only on the machine pushing and
 *    in the watcher's browser. The relay cannot be robbed for codes it never
 *    had.
 *  - Possession of a board's id grants read AND write of that board's mirror,
 *    and the ability to QUEUE messages for the pushing machine. That is the
 *    trade for having no server-side secret: the id is a single capability.
 *    The mirror is disposable; the message queue is what makes the id
 *    dangerous, so it is bounded (a handful of entries, each a bounded JSON)
 *    and — the load-bearing half — it is the EXTENSION that decides whether a
 *    message runs. The relay only holds them.
 *  - A board id is 24 hex chars of a sha-256 (~96 bits). Nobody guesses one;
 *    nobody can LIST the boards, because list happens under one fixed store and
 *    no endpoint enumerates ids.
 */

export const ID_OK = /^[0-9a-f]{24}$/i
/** A message's nonce: browser-generated (a UUID), but validated like every
 *  other string an outsider sends — it is the ack handle, nothing more. */
export const NONCE_OK = /^[A-Za-z0-9._-]{1,64}$/
/** A webview message's `type`. Board messages and the two bridge messages
 *  (`remote.dialog`, `voiceAudio`) are all one leading letter then a short
 *  dotted path — never an arbitrary string the host would have to interpret. */
export const TYPE_OK = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/
/** How many queued webview messages the relay will hold for one board. Bounded
 *  so a holder of the id cannot bloat the store; when the queue is full, later
 *  messages are refused until the extension catches up. */
export const MSG_MAX = 40
/** How large one message's serialised JSON may be. A message may carry images,
 *  so this is megabytes, not characters — but it is still a bound. */
export const MSG_MAX_BYTES = 4_000_000
/** How large a pushed frame's serialised JSON may be. */
export const FRAME_MAX_BYTES = 4_000_000
/** How many host→page events the ring retains, oldest dropped. */
export const EVENTS_MAX = 50
/**
 * How many frame PATCHES the ring retains, oldest dropped.
 *
 * A page that has fallen further behind than this gets the composed frame
 * instead — always available, because the relay composes every patch onto the
 * frame it stores rather than only logging them. That is the property that
 * makes patches safe: there is no state in which the relay can only offer a
 * page fragments it cannot place.
 */
export const DELTAS_MAX = 40
/** The one API path every host serves (also the route each host routes). */
export const FN_PATH = '/board'

/**
 * One board's requests, serialised.
 *
 * Every branch below is a read-modify-write across `await` points — read the
 * clock, bump `seq`, write it back; read the queue, push, write it back — and a
 * host that serves requests concurrently interleaves them. Measured on the Node
 * host with 200 concurrent posts to one board: 40 messages reached the queue,
 * 3 were answered `200`, and the clock's `seq` collided so a stored frame was
 * filed under a number a watching page had already passed — which is a page
 * that never sees that frame again. The relay is the one place both ends agree
 * on what `seq` means, so a lost increment is not a slow board, it is a board
 * that stops.
 *
 * Per BOARD, not global: two boards share nothing, and one board's slow write
 * must not hold up another's poll. In-process only — Netlify and the Worker run
 * many instances and this cannot promise anything across them — which is why it
 * is a mutex and not the correctness argument: it makes the single-process host
 * (the recommended one, and the only one that long-polls) actually correct, and
 * costs the others nothing.
 */
const chains = new Map()

function serialise(id, fn) {
  const prev = chains.get(id) ?? Promise.resolve()
  // The chain never breaks on a rejection, or one failed request wedges every
  // later request for that board: `then(fn, fn)` runs the next request whether
  // the previous one resolved or threw.
  const next = prev.then(fn, fn)
  // What the NEXT request chains off is `link`, not `next` — a settled link,
  // never a rejected one. It is also what the map holds, so the identity check
  // below is against the value actually stored: comparing against `next` would
  // never match and the map would grow for the life of the process.
  const link = next.then(() => {}, () => {})
  chains.set(id, link)
  void link.then(() => { if (chains.get(id) === link) chains.delete(id) })
  return next
}

/** The storage blobs, keyed by board id. Small clock first — every GET reads
 *  it before anything else, so a cheap poll costs one read. */
const clockBlob = (id) => `s:${id}`
const frameBlob = (id) => `f:${id}`
const deltasBlob = (id) => `d:${id}`
const modelsBlob = (id) => `m:${id}`
const eventsBlob = (id) => `e:${id}`
const queueBlob = (id) => `q:${id}`

/** The store interface this module needs (the real one has more). */
export const ok = (json) => ({ status: 200, json })
export const fail = (status, error) => ({ status, json: { ok: false, error } })

/** A fresh clock — the state of a board nothing has been pushed to yet. */
const emptyClock = () => ({ seq: 0, at: 0, writes: false, mv: '', viewerAt: 0, frameSeq: 0 })

/** The patch ring — `[{ seq, base, patch }]`, oldest first. Missing = empty. */
async function readDeltas(store, id) {
  const parsed = await readJson(store, deltasBlob(id))
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Compose a patch onto the frame the relay is holding.
 *
 * The ONLY thing this module knows about a board's shape, and deliberately the
 * smallest thing that works: `state` is the whole board minus its transcript,
 * and `rows` replaces the transcript from `from` onwards. 97% of a frame is
 * that transcript and it is almost entirely immutable — Claude Code fixes
 * history when a run starts and appends after it — so re-sending it on every
 * push was 8.7 MB a minute out of the machine and the same into every phone.
 *
 * Composing HERE rather than only logging the patch is what keeps the relay
 * honest: the stored frame is always a complete board, so a page that joins
 * mid-stream, or has fallen past the ring, gets one — it is never handed
 * fragments it cannot place. The mirror of this function is `applyPatch` in
 * `public/bridge.js`; `tests/handler.test.mjs` drives both over the same
 * inputs and fails if they disagree.
 */
export function composePatch(frame, patch) {
  const prev = frame && frame.state ? frame.state : null
  if (!prev || !patch || typeof patch !== 'object' || !patch.state) return null
  const state = { ...patch.state }
  const rows = patch.rows
  if (rows) {
    if (!Array.isArray(rows.rows) || !Number.isInteger(rows.from) || rows.from < 0) return null
    const base = Array.isArray(prev.transcript) ? prev.transcript : []
    if (rows.from > base.length) return null
    state.transcript = base.slice(0, rows.from).concat(rows.rows)
  } else if (Array.isArray(prev.transcript)) {
    state.transcript = prev.transcript
  }
  return { type: 'state', state }
}

/** Read a JSON blob, or null. A half-written or unparseable blob reads as
 *  absent — every one of these is disposable state, and a broken blob must not
 *  wedge the relay. */
async function readJson(store, key) {
  const raw = await store.get(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** The board's clock. Missing reads as a fresh clock (a GET on a board that has
 *  never been pushed is the caller's 404, not a throw). */
async function readClock(store, id) {
  return (await readJson(store, clockBlob(id))) || null
}

async function writeClock(store, id, clock) {
  await store.set(clockBlob(id), JSON.stringify(clock))
}

/** The event ring — `[{ seq, msg }]`, oldest first. Missing reads as empty. */
async function readEvents(store, id) {
  const parsed = await readJson(store, eventsBlob(id))
  return Array.isArray(parsed) ? parsed : []
}

/** The message queue — `[{ nonce, at, msg }]`, FIFO. Missing reads as empty. */
async function readQueue(store, id) {
  const parsed = await readJson(store, queueBlob(id))
  return Array.isArray(parsed) ? parsed : []
}

async function writeQueue(store, id, queue) {
  if (!queue.length) await store.delete(queueBlob(id))
  else await store.set(queueBlob(id), JSON.stringify(queue))
}

/** How large a JSON body serialises to, guarded — an unstringifiable body is
 *  refused on the shape checks before this is reached, but never throws. */
function jsonBytes(body) {
  try {
    return JSON.stringify(body).length
  } catch {
    return 0
  }
}

/**
 * req: {
 *   method: 'GET' | 'POST',
 *   boardId: string,     // from ?id= (GET) or the x-rc-key header (POST)
 *   key: string,         // the x-rc-key header, when there was one
 *   since?: number,      // GET ?since=<seq>
 *   models?: boolean,    // GET ?models=1
 *   msgs?: boolean,      // GET ?msgs=1
 *   wait?: number,       // GET ?wait=<secs> — honoured by the Node host only
 *   body?: unknown,      // POST body, parsed
 * }
 * store: { set(k, text), get(k) -> string|null, delete(k) }
 */
export async function handle(req, store) {
  const id = req.boardId || ''
  if (!ID_OK.test(id)) return fail(400, 'not a board address')
  return serialise(id, () => route(req, id, store))
}

async function route(req, id, store) {
  if (req.method === 'POST') {
    // The write gate: the id IS the credential, and it travels in x-rc-key.
    // There is no stored secret to compare against — the gate is that the
    // writer knows the id that names the board.
    if (req.key !== id) return fail(401, 'this relay only accepts a board’s own key')

    const body = req.body
    if (!body || typeof body !== 'object') return fail(400, 'expected a JSON object')

    if (body.kind === 'frame') return postFrame(store, id, body)
    if (body.kind === 'event') return postEvent(store, id, body)
    if (body.kind === 'msg') return postMsg(store, id, body)
    if (body.kind === 'ack') return postAck(store, id, body)
    // Anything else — including the OLD `update` and `command` kinds — is a
    // v1 caller talking to a v2 relay.
    return fail(400, 'this relay speaks contract v2 — update the extension')
  }

  if (req.method === 'GET') {
    if (req.models) return getModels(store, id)
    if (req.msgs) return getMsgs(store, id)
    const since = Number.isFinite(req.since) ? req.since : undefined
    return getBoard(store, id, since, req.deltas === true)
  }

  return fail(405, 'only GET and POST are served')
}

/* --- POST: the frame ------------------------------------------------------- */

/** `{ kind:'frame', at, writes, mv, state?, models? }` — REPLACES the latest
 *  frame (state absent = heartbeat: `at` only), stores the model catalogue when
 *  `models` is present, and answers with the pending message queue so a busy
 *  board picks messages up on its own pushes. */
async function postFrame(store, id, body) {
  if (jsonBytes(body) > FRAME_MAX_BYTES) {
    return fail(413, 'the frame is larger than the relay accepts')
  }
  const writes = body.writes === true
  const mv = typeof body.mv === 'string' ? body.mv : ''
  const at = Number.isFinite(body.at) ? body.at : Date.now()
  const hasState = body.state !== undefined && body.state !== null
  const hasPatch = body.patch !== undefined && body.patch !== null
  const hasModels = body.models !== undefined && body.models !== null

  const clock = (await readClock(store, id)) || emptyClock()
  // `patches` is how the pusher LEARNS this relay speaks them — it never
  // assumes, because a v2 relay handed a patch would store nothing and the
  // board would silently stop moving. Always answered, on every frame POST.
  const answer = { ok: true, patches: true, mv, viewerAt: clock.viewerAt }
  let needFrame = false

  if (hasState) {
    const frame = { type: 'state', state: body.state }
    clock.seq += 1
    clock.frameSeq = clock.seq
    await store.set(frameBlob(id), JSON.stringify({ seq: clock.seq, frame }))
    // A whole state RESETS the ring: every retained patch describes a chain
    // that no longer leads anywhere, and a page holding one of them would
    // splice it into a board it was never built against.
    await store.delete(deltasBlob(id))
  } else if (hasPatch) {
    // A patch is only applied to the frame it names. Anything else — the relay
    // restarted, another writer got in first, this end lost track — and the
    // honest answer is "send me a frame", never a best guess.
    const held = await readJson(store, frameBlob(id))
    const composed = held && body.patch.base === clock.frameSeq
      ? composePatch(held.frame, body.patch)
      : null
    if (!composed) {
      needFrame = true
    } else {
      clock.seq += 1
      const base = clock.frameSeq
      clock.frameSeq = clock.seq
      await store.set(frameBlob(id), JSON.stringify({ seq: clock.seq, frame: composed }))
      // The patch is kept as well as composed, so a page that is only a few
      // frames behind can be sent the rows rather than the board.
      const ring = await readDeltas(store, id)
      ring.push({ seq: clock.seq, base, patch: body.patch })
      while (ring.length > DELTAS_MAX) ring.shift()
      await store.set(deltasBlob(id), JSON.stringify(ring))
    }
  }

  if (hasModels) {
    await store.set(modelsBlob(id), JSON.stringify({ mv, models: body.models }))
  }
  clock.at = at
  clock.writes = writes
  clock.mv = mv
  await writeClock(store, id, clock)

  answer.viewerAt = clock.viewerAt
  answer.frameSeq = clock.frameSeq
  if (needFrame) answer.needFrame = true
  answer.msgs = await readQueue(store, id)
  return ok(answer)
}

/* --- POST: the host→page events -------------------------------------------- */

/** `{ kind:'event', events:[msg, ...] }` — appends host-to-page events, each
 *  with a `type` matching typeOk, dropping the oldest past eventsMax. */
async function postEvent(store, id, body) {
  const events = Array.isArray(body.events) ? body.events : []
  for (const msg of events) {
    if (!msg || typeof msg !== 'object') return fail(400, 'an event must be an object')
    if (typeof msg.type !== 'string' || !TYPE_OK.test(msg.type)) {
      return fail(400, 'an event needs a valid type')
    }
  }

  const clock = (await readClock(store, id)) || emptyClock()
  if (!events.length) return ok({ ok: true, seq: clock.seq })

  const ring = await readEvents(store, id)
  for (const msg of events) {
    clock.seq += 1
    ring.push({ seq: clock.seq, msg })
  }
  while (ring.length > EVENTS_MAX) ring.shift()
  await store.set(eventsBlob(id), JSON.stringify(ring))
  await writeClock(store, id, clock)
  return ok({ ok: true, seq: clock.seq })
}

/* --- POST: the page→host message queue ------------------------------------- */

/** `{ kind:'msg', nonce, msg }` — queues one webview message for the pushing
 *  machine. The same nonce twice is a retry, not a duplicate; a full queue is
 *  429; whether the message runs is the extension's decision. */
async function postMsg(store, id, body) {
  const nonce = typeof body.nonce === 'string' ? body.nonce : ''
  if (!NONCE_OK.test(nonce)) return fail(400, 'a message needs a valid nonce')
  const msg = body.msg
  if (!msg || typeof msg !== 'object') return fail(400, 'a message must be an object')
  if (typeof msg.type !== 'string' || !TYPE_OK.test(msg.type)) {
    return fail(400, 'a message needs a valid type')
  }
  if (jsonBytes(body) > MSG_MAX_BYTES) {
    return fail(413, 'too large for the relay')
  }

  const queue = await readQueue(store, id)
  if (queue.some((q) => q && q.nonce === nonce)) return ok({ ok: true })
  if (queue.length >= MSG_MAX) {
    return fail(429, 'the message queue is full — wait for the board to catch up')
  }
  queue.push({ nonce, at: Date.now(), msg })
  await writeQueue(store, id, queue)
  return ok({ ok: true })
}

/* --- POST: the ack --------------------------------------------------------- */

/** `{ kind:'ack', nonces[] }` — removes acked messages. Acking is the only way
 *  a message leaves the queue; a lost ack means a re-delivery, which the
 *  extension deduplicates by nonce (at-least-once). */
async function postAck(store, id, body) {
  const nonces = Array.isArray(body.nonces) ? body.nonces : []
  for (const n of nonces) {
    if (typeof n !== 'string' || !NONCE_OK.test(n)) return fail(400, 'a malformed ack')
  }
  const queue = await readQueue(store, id)
  const kept = queue.filter((q) => !(q && nonces.includes(q.nonce)))
  if (kept.length !== queue.length) await writeQueue(store, id, kept)
  return ok({ ok: true })
}

/* --- GET: the board -------------------------------------------------------- */

/** The board read. `since` drives the cheap poll: an unchanged clock answers
 *  without touching the frame blob; otherwise the frame rides along only when
 *  it is newer than `since`, and events newer than `since` (with `gap` when
 *  the caller is older than the retained ring). A GET with `since` also counts
 *  as viewer presence, throttled to one clock write per 20 s. */
async function getBoard(store, id, since, wantsDeltas) {
  const clock = await readClock(store, id)
  if (!clock) return fail(404, 'no board here yet — waiting for the first push from the extension')

  const base = { ok: true, seq: clock.seq, at: clock.at, writes: clock.writes, mv: clock.mv }

  if (since === undefined) {
    // First load: the whole picture — the latest COMPOSED frame, no events
    // (they are new only from the caller's cursor, and there is none yet).
    // Never patches: a caller with no cursor has nothing to apply them to.
    let frame = null
    const raw = await store.get(frameBlob(id))
    if (raw) {
      const parsed = await readJson(store, frameBlob(id))
      frame = parsed && parsed.frame ? parsed.frame : null
    }
    return ok({ ...base, frame, events: [] })
  }

  // Viewer presence, throttled: read, compare, conditional write. A clock
  // write per poll would be a bug on every host.
  if (Date.now() - (clock.viewerAt || 0) >= 20_000) {
    clock.viewerAt = Date.now()
    await writeClock(store, id, clock)
  }

  if (clock.seq === since) {
    // The cheap poll: nothing changed, so the frame blob is not read at all.
    return ok({ ...base, events: [] })
  }

  const ring = await readEvents(store, id)
  let events = []
  let gap = false
  if (ring.length && since < ring[0].seq) {
    // The caller is older than the oldest retained event: return everything
    // retained and say so, rather than silently dropping what fell off.
    events = ring.map((e) => e.msg)
    gap = true
  } else {
    events = ring.filter((e) => e.seq > since).map((e) => e.msg)
  }

  let frame = null
  let deltas = null
  if (clock.frameSeq > since) {
    // A caller that says it can apply patches gets them when the chain from
    // its own cursor is complete — `ring[start].base <= since` is the proof:
    // that patch's base frame is one the caller has already seen, and the
    // entries after it are chained. Anything less and it gets the whole frame,
    // which the relay always holds because it composes as it stores.
    if (wantsDeltas) {
      const ring = await readDeltas(store, id)
      const start = ring.findIndex((d) => d.seq > since)
      if (start >= 0 && ring[start].base <= since) {
        deltas = ring.slice(start).map((d) => d.patch)
      }
    }
    if (!deltas) {
      const parsed = await readJson(store, frameBlob(id))
      frame = parsed && parsed.frame ? parsed.frame : null
    }
  }

  return ok({
    ...base,
    ...(deltas ? { deltas } : { frame }),
    events,
    ...(gap ? { gap: true } : {}),
  })
}

/* --- GET: the model catalogue and the queue -------------------------------- */

/** `?models=1` — the catalogue the extension split out of the frame, with the
 *  `mv` that names which version it is. 404 until one has been pushed. */
async function getModels(store, id) {
  const parsed = await readJson(store, modelsBlob(id))
  if (!parsed || !Array.isArray(parsed.models)) return fail(404, 'no model catalogue here yet')
  return ok({ ok: true, mv: parsed.mv, models: parsed.models })
}

/** `?msgs=1` — the pending page→host queue, and when a viewer last looked. */
async function getMsgs(store, id) {
  const msgs = await readQueue(store, id)
  const clock = await readClock(store, id)
  return ok({ ok: true, msgs, viewerAt: clock ? clock.viewerAt : 0 })
}
