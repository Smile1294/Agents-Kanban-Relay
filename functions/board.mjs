/* The Netlify function for the remote board page.
 *
 * This file is the wrapper; the behaviour lives in board-core.mjs so the
 * repository's test suite can run it without a Netlify account. The store is
 * site-wide (`getStore`, not `getDeployStore`): a deploy replaces the page but
 * must not replace the board that the extension is pushing to.
 *
 * Reads are by board id (?id=<24 hex>) — the id is the capability and the page
 * derives it from the pairing code, so no session, cookie or login exists to
 * expire. Writes come from the extension with the same id in `x-rc-key`.
 *
 * Netlify cannot hold a request open, so `wait` is accepted and ignored here
 * (contract v2: `wait` is honoured only by the plain Node host). The answer
 * never carries `longPoll`, so the page falls back to timed polling.
 */
import { getStore } from '@netlify/blobs'
import { handle } from './board-core.mjs'

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

export default async (req) => {
  const store = getStore({ name: 'boards' })
  const url = new URL(req.url)
  const key = req.headers.get('x-rc-key') ?? ''
  const q = url.searchParams

  let body
  if (req.method === 'POST') {
    try { body = await req.json() } catch { body = undefined }
  }

  const since = q.get('since')
  const wait = q.get('wait')

  const out = await handle({
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
    body,
  }, store)
  return json(out.status, out.json)
}
