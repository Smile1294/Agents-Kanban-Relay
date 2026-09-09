/* The relay as a plain Node server — any VPS, any self-hosted box, or just
 * your own machine for testing. Zero dependencies, Node 22+.
 *
 * The whole relay is one file and one JSON store:
 *
 *   node server.js                     # serves http://localhost:8787
 *   PORT=8080 RC_DATA=/srv/board node server.js
 *
 * - The static page (public/) is served from the site root.
 * - The relay API is at /board, the same path every host serves.
 * - The store is data/store.json, written atomically (temp file + rename), so
 *   a crash mid-write cannot leave a half-written blob that wedges the relay
 *   (board-core reads a broken queue as empty, but a broken store file would
 *   take the whole board with it — hence the rename). Saves are SERIALISED and
 *   the temp file is per save: two concurrent saves wrote the same
 *   `store.json.tmp` and the first rename moved it out from under the second,
 *   so the second threw ENOENT and the request answered 500. Measured with 200
 *   concurrent posts to one board: 37 of them failed that way — and a 500 on a
 *   `msg` post is a button the user pressed on the remote page that silently
 *   did nothing.
 *
 * All behaviour lives in functions/board-core.mjs; this file is a store and a
 * transport, nothing more. Same rules as the other hosts: no stored secret,
 * the board address is the id derived from the pairing code, and messages are
 * only QUEUED here — whether they run is the extension's decision.
 *
 * This host is the one that honours contract v2's `wait`: it holds a board GET
 * open until the board's `seq` advances or the timeout, woken by an in-process
 * emitter fired on every store mutation, and every GET answer carries
 * `longPoll: true` so the page knows it may loop straight back. That is why
 * the README recommends it for a live board.
 */
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handle } from './functions/board-core.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
// PORT=0 picks an ephemeral port (the tests use this), so the fallback must
// trigger on an ABSENT variable, not a falsy one — `|| 8787` read `0` as
// unset and every test run collided with a real relay on 8787.
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787
const STORE_FILE = join(process.env.RC_DATA || join(ROOT, 'data'), 'store.json')
/** A push is bounded by the extension and the page (contract v2: one message
 *  may carry images, so 4 MB is legitimate); anything past 5 MB is not a board
 *  update. */
const BODY_MAX = 5 * 1024 * 1024

/** The exact files this server will hand out. A whitelist, so no path in a
 *  URL can walk the filesystem. */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/bridge.css': ['bridge.css', 'text/css; charset=utf-8'],
  '/bridge.js': ['bridge.js', 'text/javascript; charset=utf-8'],
  '/media/board.css': ['media/board.css', 'text/css; charset=utf-8'],
  '/media/board.js': ['media/board.js', 'text/javascript; charset=utf-8'],
  '/media/theme.css': ['media/theme.css', 'text/css; charset=utf-8'],
}

/** The in-process signal long-polls wait on. Fired on every store mutation;
 *  a waiter re-reads the board and either answers (seq advanced) or goes back
 *  to sleep until its timeout. */
const mutations = new EventEmitter()
mutations.setMaxListeners(0)

/** The file-backed store. One JSON object for the whole relay — the clock,
 *  the frame, the model catalogue, the event ring and the message queue,
 *  keyed by board id — rewritten on every mutation. */
class FileStore {
  constructor(file) {
    this.file = file
    this.data = {}
    /** The tail of the save chain. Writes are serialised because they all
     *  rewrite the SAME file from the same in-memory object: two overlapping
     *  saves is one rename racing another, and a lost update besides. */
    this.saving = Promise.resolve()
  }

  async load() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return // first run
      throw e
    }
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed
        return
      }
    } catch {
      /* fall through — the file is not what we wrote */
    }
    // A store file this server cannot read is not thrown away: it is moved
    // aside and the relay starts empty, saying so — loudly, because silently
    // losing a board is the one failure a relay must not hide.
    const aside = `${this.file}.broken-${Date.now()}`
    await rename(this.file, aside)
    console.error(`[remote] store.json was unreadable — moved it to ${aside} and started empty`)
  }

  /** Serialise the save, and give each one its own temp file.
   *
   *  Both halves are load-bearing and neither is enough alone. A shared
   *  `store.json.tmp` is what made concurrent saves throw ENOENT — the first
   *  rename takes the file the second is about to rename — and serialising
   *  without a unique name would still leave a crashed process's temp file
   *  lying where the next save wants to write. The chain never breaks on a
   *  rejection: one failed save must not wedge every write after it. */
  #save() {
    const next = this.saving.then(() => this.#write(), () => this.#write())
    this.saving = next.catch(() => {})
    return next
  }

  async #write() {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(this.data))
      await rename(tmp, this.file)
    } catch (e) {
      // A failed rename leaves the temp file behind; the store directory is
      // ours, so clean up rather than accumulating one per failure.
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }

  async set(key, text) {
    this.data[key] = text
    await this.#save()
    mutations.emit('change')
  }

  async get(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null
  }

  async delete(key) {
    if (Object.prototype.hasOwnProperty.call(this.data, key)) {
      delete this.data[key]
      await this.#save()
      mutations.emit('change')
    }
  }

  async list({ prefix }) {
    const blobs = Object.keys(this.data)
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }))
    return { blobs }
  }
}

/** Read a request body up to BODY_MAX; anything longer is refused rather than
 *  buffered. The rest is drained (not buffered) so the refusal can still be
 *  ANSWERED — destroying the socket here would leave the client hanging.
 *  Returns undefined when the body is not JSON. */
async function readBody(req) {
  const chunks = []
  let size = 0
  let tooBig = false
  for await (const chunk of req) {
    if (tooBig) continue // drain, do not buffer
    size += chunk.length
    if (size > BODY_MAX) {
      tooBig = true
      chunks.length = 0
      continue
    }
    chunks.push(chunk)
  }
  if (tooBig) throw new Error('request body too large')
  if (!chunks.length) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

const send = (res, status, text, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

const store = new FileStore(STORE_FILE)
await store.load()

/** Build the board-core request from an HTTP request. */
function relayReq(req, url, key) {
  const q = url.searchParams
  const since = q.get('since')
  const wait = q.get('wait')
  return {
    method: req.method,
    boardId: key || q.get('id') || '',
    key,
    since: since === null ? undefined : Number(since),
    wait: wait === null ? undefined : Number(wait),
    models: q.get('models') !== null,
    msgs: q.get('msgs') !== null,
    // `d=1` — the caller can apply frame patches. Opt-in, so a page built
    // against contract v2 is never handed one.
    deltas: q.get('d') === '1',
  }
}

/** A board GET answer from this host always says `longPoll: true`. */
function withLongPoll(out) {
  return { status: out.status, json: { ...out.json, longPoll: true } }
}

/** Wake on the next store mutation, or the timeout, whichever is first. */
function waitForChange(ms) {
  return new Promise((resolve) => {
    const on = () => { mutations.off('change', on); clearTimeout(t); resolve() }
    const t = setTimeout(() => { mutations.off('change', on); resolve() }, ms)
    mutations.once('change', on)
  })
}

/** Hold a board GET open until `since` advances or the timeout — the one thing
 *  this host does that the others cannot. A first load (no `since`) answers
 *  right away; a 404 waits for the first push.
 *
 *  The wait happens BETWEEN `handle()` calls and never inside one. board-core
 *  serialises requests per board id, so a held request that kept that lock
 *  would block every write to the same board for the whole 25 s — the exact
 *  opposite of what holding it is for. */
async function longPoll(req, since, waitSecs) {
  const deadline = Date.now() + waitSecs * 1000
  let out = await handle(req, store)
  if (since === undefined || (out.status === 200 && out.json.seq > since)) return out
  while (Date.now() < deadline) {
    await waitForChange(deadline - Date.now())
    out = await handle(req, store)
    if (out.status === 200 && out.json.seq > since) return out
  }
  return out
}

/**
 * Hold a `msgs=1` GET open until the queue has something in it.
 *
 * The page has long-polled for FRAMES since v2; the pushing machine polled the
 * message queue on a timer, so a tap sat in the queue for up to a full poll
 * interval before the machine even looked. Measured end to end, that was one of
 * two 0–2000 ms waits either side of the work, and together they were ~2 s of a
 * ~2.2 s round trip. This half removes one of them.
 *
 * Same shape as the board hold, and the same rule about the lock: `handle()`
 * is called, the lock is released, and only then does this wait. A queued
 * message already wakes the emitter — `writeQueue` goes through `store.set` —
 * so nothing else had to be plumbed.
 */
async function longPollMsgs(req, waitSecs) {
  const deadline = Date.now() + waitSecs * 1000
  let out = await handle(req, store)
  const empty = (o) => o.status === 200 && Array.isArray(o.json.msgs) && o.json.msgs.length === 0
  if (!empty(out)) return out
  while (Date.now() < deadline) {
    await waitForChange(deadline - Date.now())
    out = await handle(req, store)
    if (!empty(out)) return out
  }
  return out
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/board' || url.pathname === '/board/') {
      const key = String(req.headers['x-rc-key'] ?? '')
      let body
      if (req.method === 'POST') {
        try {
          body = await readBody(req)
        } catch {
          send(res, 413, JSON.stringify({ ok: false, error: 'request body too large' }))
          return
        }
      }

      if (req.method === 'GET') {
        const rreq = relayReq(req, url, key)
        const waitSecs = Number.isInteger(rreq.wait) && rreq.wait >= 1 && rreq.wait <= 25 ? rreq.wait : undefined
        const isPlainPoll = !rreq.models && !rreq.msgs

        let out
        if (waitSecs !== undefined && isPlainPoll) {
          out = await longPoll(rreq, rreq.since, waitSecs)
        } else if (waitSecs !== undefined && rreq.msgs) {
          out = await longPollMsgs(rreq, waitSecs)
        } else {
          out = await handle(rreq, store)
        }
        // Every GET answer from this host says it can hold one. That is how
        // both ends learn to loop straight back instead of waiting out a timer,
        // and why they must never assume it: the other hosts cannot.
        send(res, out.status, JSON.stringify(withLongPoll(out).json))
        return
      }

      const out = await handle({ ...relayReq(req, url, key), body }, store)
      send(res, out.status, JSON.stringify(out.json))
      return
    }
    const file = STATIC[url.pathname]
    if (file) {
      const [name, type] = file
      try {
        const raw = await readFile(join(ROOT, 'public', name))
        send(res, 200, raw, type)
      } catch {
        send(res, 404, 'not found', 'text/plain')
      }
      return
    }
    send(res, 404, 'not found', 'text/plain')
  } catch (e) {
    console.error('[remote] request failed:', e)
    send(res, 500, JSON.stringify({ ok: false, error: 'the relay failed' }))
  }
})

server.listen(PORT, () => {
  // PORT=0 picks an ephemeral port (the tests use this); log the real one so a
  // caller can parse it.
  const port = typeof server.address() === 'object' && server.address() ? server.address().port : PORT
  console.log(`[remote] relay on http://localhost:${port} — board api /board, store ${STORE_FILE}`)
})
