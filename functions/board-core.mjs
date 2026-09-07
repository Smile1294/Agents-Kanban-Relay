/* The relay's logic, with the store injected.
 *
 * Each host target (the Netlify function board.mjs, the Cloudflare worker
 * worker.js, the plain-Node server server.js) supplies the real store; this
 * module runs in this repository's test suite against a fake one, so the
 * relay's behaviour — the write gate, the storage names, the orphan-tail GC,
 * the command queue — is pinned without a network or a deployed account.
 *
 * The threat model is small and worth stating:
 *
 *  - The relay stores NOTHING secret. A board's address is the sha-256 of the
 *    pairing code, and the pairing code exists only on the machine pushing and
 *    in the watcher's browser. The relay cannot be robbed for codes it never
 *    had.
 *  - Possession of a board's id grants read AND write of that board's mirror,
 *    and the ability to QUEUE commands for the pushing machine. That is the
 *    trade for having no server-side secret: the code is a single capability.
 *    The mirror is disposable; the command queue is what makes the id
 *    dangerous, so it is bounded (a handful of entries, each a bounded text)
 *    and — the load-bearing half — it is the EXTENSION that decides whether a
 *    command runs. The relay only holds them; see the extension's
 *    `remote.writes` toggle.
 *  - A board id is 24 hex chars of a sha-256 (~96 bits). Nobody guesses one;
 *    nobody can LIST the boards, because list happens under one fixed store and
 *    no endpoint enumerates ids.
 *
 * Same key rule as the extension side (`relay.ts` KEY_OK): a session key rides
 * in a blob name, so it must be safe there.
 */
export const ID_OK = /^[0-9a-f]{24}$/i
export const KEY_OK = /^[A-Za-z0-9._-]{1,80}$/
/** A command's nonce: browser-generated (a UUID), but validated like every
 *  other string an outsider sends — it is the ack handle, nothing more. */
export const NONCE_OK = /^[A-Za-z0-9._-]{1,64}$/
/** How many pending commands the relay will hold for one board. Bounded so a
 *  holder of the id cannot bloat the store; when the queue is full, later
 *  commands are refused until the extension catches up. */
export const CMD_MAX = 20
/** How long one command's text may be. A prompt is a prompt; a 2MB string is
 *  an attack on the store. */
export const CMD_TEXT_MAX = 20_000
const indexBlob = (id) => `i:${id}`
const tailBlob = (id, key) => `t:${id}:${key}`
const cmdBlob = (id) => `c:${id}`

/** The store interface this module needs (the real one has more). */
export const ok = (json) => ({ status: 200, json })
export const fail = (status, error) => ({ status, json: { ok: false, error } })

/** Read the pending command queue. Missing or unparseable reads as empty —
 *  the queue is disposable state, and a half-written blob must not wedge the
 *  relay. */
async function pendingCommands(store, id) {
  const raw = await store.get(cmdBlob(id))
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function storeCommands(store, id, cmds) {
  if (!cmds.length) await store.delete(cmdBlob(id))
  else await store.set(cmdBlob(id), JSON.stringify(cmds))
}

/** A stored index's sessions, or nothing. */
async function storedSessions(store, id) {
  const raw = await store.get(indexBlob(id))
  if (!raw) return undefined
  try {
    const idx = JSON.parse(raw)
    return idx && typeof idx === 'object' && idx.sessions && typeof idx.sessions === 'object'
      ? idx.sessions
      : undefined
  } catch {
    return undefined
  }
}

/**
 * req: {
 *   method: 'GET' | 'POST',
 *   boardId: string,        // from ?id= (GET) or the x-rc-key header (POST)
 *   key: string,            // the x-rc-key header, when there was one
 *   tailKey?: string,       // GET ?tail=<session key>
 *   cmds?: boolean,         // GET ?cmds=1 — the pending command queue
 *   body?: unknown,         // POST body, parsed
 * }
 * store: { set(k, text), get(k) -> string|null, delete(k), list({prefix}) -> {blobs:[{key}]} }
 */
export async function handle(req, store) {
  const id = req.boardId || ''
  if (!ID_OK.test(id)) return fail(400, 'not a board address')

  if (req.method === 'POST') {
    // The write gate: the id IS the credential, and it travels in x-rc-key.
    // There is no stored secret to compare against — the gate is that the
    // writer knows the id that names the board.
    if (req.key !== id) return fail(401, 'this relay only accepts a board’s own key')

    const body = req.body
    if (!body || typeof body !== 'object') return fail(400, 'expected a JSON object')

    // A command from the watcher page: queued for the pushing machine. The
    // relay stores it and nothing else — whether it runs is the extension's
    // decision, never this module's.
    if (body.kind === 'command') {
      const nonce = typeof body.nonce === 'string' ? body.nonce : ''
      if (!NONCE_OK.test(nonce)) return fail(400, 'a command needs a valid nonce')
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text || text.length > CMD_TEXT_MAX) {
        return fail(400, 'a command needs some text, at most 20000 characters')
      }
      const session = body.session
      if (session !== undefined) {
        if (typeof session !== 'string' || !KEY_OK.test(session)) return fail(400, 'not a session')
        // The command names a session the page shows, and the page shows the
        // index — a session the index does not carry can never be reached, so
        // it is a stale or hostile write, not a payload. Same rule as tails.
        const sessions = await storedSessions(store, id)
        if (!sessions) return fail(400, 'no board here yet — the extension has not pushed')
        if (!(session in sessions)) return fail(400, 'no such session on this board')
      }
      const pending = await pendingCommands(store, id)
      // The same nonce twice is a retry after a lost answer, not two commands.
      if (pending.some((c) => c && c.nonce === nonce)) return ok({ ok: true })
      if (pending.length >= CMD_MAX) {
        return fail(429, 'the command queue is full — wait for the extension to catch up')
      }
      pending.push({ nonce, text, ...(session !== undefined ? { session } : {}) })
      await storeCommands(store, id, pending)
      return ok({ ok: true })
    }

    // The extension confirms it has taken a command. Acking is the only way a
    // command leaves the queue; a lost ack means a re-delivery, which the
    // extension deduplicates by nonce.
    if (body.kind === 'ack') {
      const nonces = Array.isArray(body.nonces) ? body.nonces : []
      for (const n of nonces) {
        if (typeof n !== 'string' || !NONCE_OK.test(n)) return fail(400, 'a malformed ack')
      }
      const pending = await pendingCommands(store, id)
      const kept = pending.filter((c) => !(c && nonces.includes(c.nonce)))
      if (kept.length !== pending.length) await storeCommands(store, id, kept)
      return ok({ ok: true })
    }

    if (body.kind !== 'update') {
      return fail(400, 'expected { kind: "update" }, { kind: "command" } or { kind: "ack" }')
    }
    const idx = body.index
    if (!idx || idx.v !== 1 || !Array.isArray(idx.columns) || !idx.sessions
        || typeof idx.sessions !== 'object' || Array.isArray(idx.sessions)) {
      return fail(400, 'malformed index')
    }
    const keys = Object.keys(idx.sessions)
    for (const k of keys) {
      if (!KEY_OK.test(k)) return fail(400, 'a session key is not usable in a blob name')
    }
    const tails = Array.isArray(body.tails) ? body.tails : []
    for (const t of tails) {
      if (!t || typeof t !== 'object' || typeof t.key !== 'string' || !KEY_OK.test(t.key)
          || !Array.isArray(t.entries)) {
        return fail(400, 'a malformed tail')
      }
      // A tail whose session is not on the board is unreachable (the page only
      // fetches what the index tells it to), so it is a bug, not a payload.
      if (!keys.includes(t.key)) return fail(400, `a tail names a session the index does not: ${t.key}`)
    }
    // The index is REPLACED, each tail is REPLACED — the extension pushes whole
    // tails and the whole board picture, and the relay never merges, because a
    // merge is where a stale row survives a deletion.
    await store.set(indexBlob(id), JSON.stringify(idx))
    for (const t of tails) await store.set(tailBlob(id, t.key), JSON.stringify(t))

    // Garbage-collect the tails of sessions that left the board (archived or
    // removed): the index is the list of what exists, anything else is stale.
    const prefix = `t:${id}:`
    const { blobs } = await store.list({ prefix })
    for (const b of blobs) {
      const key = b.key.slice(prefix.length)
      if (!keys.includes(key)) await store.delete(b.key)
    }

    // Pending commands ride the answer back so a busy board picks them up on
    // its own pushes, without an extra poll. Acks arrive as their own POST
    // ({ kind: 'ack' }) — the extension acts, then acks, in that order.
    const pending = await pendingCommands(store, id)
    return ok({ ok: true, ...(pending.length ? { cmds: pending } : {}) })
  }

  if (req.method === 'GET') {
    if (req.cmds) {
      return ok({ ok: true, cmds: await pendingCommands(store, id) })
    }
    if (req.tailKey !== undefined) {
      if (!KEY_OK.test(req.tailKey)) return fail(400, 'not a session')
      const raw = await store.get(tailBlob(id, req.tailKey))
      if (!raw) return fail(404, 'no chat for this session yet')
      return ok({ ok: true, tail: JSON.parse(raw) })
    }
    const raw = await store.get(indexBlob(id))
    if (!raw) return fail(404, 'no board here yet — waiting for the first push from the extension')
    return ok({ ok: true, index: JSON.parse(raw) })
  }

  return fail(405, 'only GET and POST are served')
}
