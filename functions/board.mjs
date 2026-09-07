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

  let body
  if (req.method === 'POST') {
    try { body = await req.json() } catch { body = undefined }
  }

  const out = await handle({
    method: req.method,
    boardId: key || url.searchParams.get('id') || '',
    key,
    tailKey: url.searchParams.get('tail') || undefined,
    cmds: url.searchParams.get('cmds') !== null,
    body,
  }, store)
  return json(out.status, out.json)
}
