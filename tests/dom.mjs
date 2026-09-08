/** A DOM small enough to run public/media/board.js in, and nothing more.
 *
 * A FULL COPY of the extension repo's `test/dom.mjs`, kept in step by hand:
 * when the extension's copy grows, mirror the change here. The only adaptions
 * are the header below and the harness import — this repo has no
 * `tests/harness.mjs`, so `repoRoot` is derived locally, and the board source
 * lives at `public/media/board.js` (the synced copy) rather than `media/`.
 *
 * The webview is the one layer with no type checking, so a runtime throw there
 * is invisible: the panel simply stays blank. Running the real board.js against
 * this stub turns that into a test failure.
 *
 * Shared by the view unit test (hand-written states) and the smoke test (the
 * REAL state the host produces) — which is the pairing that matters. Either
 * alone can pass while the two sides disagree about the state's shape.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function makeNode(tag) {
  const node = {
    tagName: tag, className: '', id: null, children: [], style: {}, dataset: {},
    classList: {
      _o: null,
      add(...c) { this._o.className = [this._o.className, ...c].filter(Boolean).join(' ') },
      remove(c) { this._o.className = this._o.className.split(' ').filter((x) => x !== c).join(' ') },
      contains(c) { return this._o.className.split(' ').includes(c) },
    },
    _text: null, draggable: false, title: '', placeholder: '', value: '', rows: 0,
    // The caret. Real state, so a restore that drops it is visible to a test.
    selectionStart: undefined, selectionEnd: undefined,
    // Attributes are real state here for one reason: the live counters are
    // ticked in place by tickAges(), which finds them by `data-since`. Without
    // this the stub silently swallowed every setAttribute, so a counter could
    // stop being wired up and no test could see it.
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null },
    removeAttribute(k) { delete this.attributes[k] },
    set textContent(v) { this._text = v; this.children = [] },
    get textContent() {
      return this._text != null ? this._text : this.children.map((c) => c.textContent).join('')
    },
    append(...ns) {
      // Appending clears any text set directly, exactly as the real DOM does:
      // `n.textContent = ''` empties the node, and a child added afterwards is
      // what `textContent` then reads back. Without this the getter short
      // circuits on the empty string forever, and every test that clears a
      // container before filling it reads it as blank — which is a stub that
      // makes a WORKING view look broken.
      this._text = null
      for (const n of ns) {
        if (typeof n === 'string') {
          this.children.push({ textContent: n, children: [], className: '' })
          continue
        }
        // A real appendChild MOVES a child that is already in the tree;
        // push() would duplicate it. board.js's streaming fast path re-appends
        // its trailer nodes every frame to keep them after the new rows, so a
        // stub that duplicates here grows phantom streaming/activity columns
        // and fails every assertion about the live transcript.
        const i = this.children.indexOf(n)
        if (i >= 0) this.children.splice(i, 1)
        // Parent pointers, real state for one reason: the fast path re-appends
        // existing trailer nodes to move them to the end, and `remove()`
        // detaches a node when its stream ended. Both are invisible to a test
        // that cannot follow the tree — and a remove() that did nothing would
        // leave phantom rows in every assertion about the live transcript.
        n._parent = this
        this.children.push(n)
      }
    },
    replaceChildren(...ns) { this.children = []; this.append(...ns) },
    // Detach from the parent — a real DOM API the streaming fast path uses to
    // drop the streaming block and the placeholders when rows arrive.
    remove() {
      const p = this._parent
      if (!p) return
      const i = p.children.indexOf(this)
      if (i >= 0) p.children.splice(i, 1)
      this._parent = null
    },
    // The older spelling of `append`, and a real DOM API. settings.js uses it
    // throughout; board.js uses `append`. Both are in the stub because the
    // stub's incompleteness is meant to catch APIs that do not EXIST, not to
    // pick a house style for two files that are both correct.
    appendChild(n) { this.append(n); return n },
    // Event handlers are real state: a control whose handler was never attached
    // is a control that does nothing, and that is only visible if the stub
    // remembers them. `onclick` and `addEventListener('click')` are two
    // spellings of one thing, so they land in the same place — board.js uses
    // the first, settings.js the second, and a test should not have to know
    // which.
    //
    // EVERY type, not just click, and that is not generosity. This used to be
    // `if (type === 'click')`, so a `change` listener on a checkbox and an
    // `input` listener on a filter box were dropped in SILENCE — the stub could
    // not tell a control that was wired up from one that was not, which is
    // exactly the failure it exists to catch. Its incompleteness is meant to
    // reject APIs that do not exist, never to swallow ones that do.
    addEventListener(type, fn) { this['on' + type] = fn },
    removeEventListener() {},
    // Scroll offsets are real state too. render() rebuilds every scroll
    // container, so whether the new one is put back where the old one was is a
    // fact a test can check — and with these undefined, the arithmetic in
    // render() went NaN and silently skipped the branch under test.
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    // Just enough selector to find a node by class or attribute. render() asks
    // for `.transcript-scroll` and `[data-scroll]`; a stub that always answered
    // "nothing" made the code that restores scroll positions unreachable here.
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
    querySelectorAll(sel) { return walk(this).slice(1).filter((n) => n.tagName && matchesSelector(n, sel)) },
    getBoundingClientRect() { return { top: 0, height: 10 } },
    // The settings page's table of contents scrolls sections into view. Recorded
    // rather than omitted: a nav link whose handler is never attached is a link
    // that does nothing, which is only visible if the call lands somewhere.
    scrollIntoView(opts) { this._scrollIntoView = opts || {} },
    // Focus is real state here: render() destroys and rebuilds the composer, so
    // whether it hands focus back is a testable fact, not a detail.
    focus() { if (node._doc) node._doc.activeElement = node },
    blur() { if (node._doc && node._doc.activeElement === node) node._doc.activeElement = null },
    /* A real one MOVES the caret, and the stub's no-op hid a bug.
       `render()` restores focus to a rebuilt input; whether it also restores
       the CARET is only observable through these two properties, so a
       `setSelectionRange` that did nothing made "the caret jumped to the end"
       untestable — which is why that shipped. */
    setSelectionRange(start, end) {
      node.selectionStart = start
      node.selectionEnd = end === undefined ? start : end
    },
    _doc: null,
  }
  node.classList._o = node
  return node
}

/** One compound selector — `tag`, `.class`, `[attr]`, `[attr="v"]`, or a
 *  combination such as `div.cards[data-scroll]`. No combinators: board.js does
 *  not use any, and a stub that guessed at descendant matching would be a
 *  second DOM to keep right rather than a small one to keep honest. */
function matchesSelector(node, sel) {
  const tag = /^[a-zA-Z][\w-]*/.exec(sel)?.[0]
  if (tag && String(node.tagName).toLowerCase() !== tag.toLowerCase()) return false
  for (const m of sel.matchAll(/\.([\w-]+)/g)) {
    if (!String(node.className || '').split(/\s+/).includes(m[1])) return false
  }
  for (const m of sel.matchAll(/\[([\w-]+)(?:="?([^"\]]*)"?)?\]/g)) {
    const v = node.getAttribute ? node.getAttribute(m[1]) : null
    if (v === null) return false
    if (m[2] !== undefined && v !== m[2]) return false
  }
  return true
}

/** Every node in the tree, for tests that need to find one by tag. */
export function walk(node, out = []) {
  out.push(node)
  for (const c of node.children ?? []) if (c.children) walk(c, out)
  return out
}

/** First node with this tag, optionally narrowed by a predicate.
 *  The predicate matters for things whose only distinguishing feature is a
 *  class — a spinner is an empty <span>, so text-based assertions cannot see
 *  whether it is on screen. */
export function findByTag(root, tag, match) {
  return walk(root).find((n) => n.tagName === tag && (!match || match(n)))
}

let cachedSrc

/**
 * Pixel dimensions the stub `Image` reports for a given data URL.
 *
 * A browser gets these by decoding the bytes; there are no bytes here, so a
 * test that wants a 3000px-wide screenshot declares one with `fakeImageFile`.
 */
export const IMAGE_SIZES = new Map()

/** A stand-in for a `File` off the clipboard or a drop, with known dimensions. */
export function fakeImageFile(name, type, { width = 800, height = 600, data = 'ORIGINAL' } = {}) {
  const dataUrl = `data:${type};base64,${data}`
  IMAGE_SIZES.set(dataUrl, { width, height })
  return { name, type, _dataUrl: dataUrl }
}

export async function boardSource() {
  cachedSrc ??= await fs.readFile(path.join(repoRoot, 'public', 'media', 'board.js'), 'utf8')
  return cachedSrc
}

let cachedSettings
export async function settingsSource() {
  cachedSettings ??= await fs.readFile(path.join(repoRoot, 'media', 'settings.js'), 'utf8')
  return cachedSettings
}

/**
 * The settings page, run in the same stub DOM.
 *
 * Shares `renderBoardWith`'s context builder deliberately: the settings page is
 * another untyped webview script, and giving it a second harness is how a DOM
 * API one of them starts using gets added in one place and missed in the other.
 * The one difference is the message envelope — the settings page listens for
 * `{type:'state', state, error}` rather than the board's `{type:'state'}`.
 *
 * (Not used by the relay repo, which carries no settings page; kept because
 * this file is a faithful copy.)
 */
export async function renderSettings(state, { error } = {}) {
  const src = await settingsSource()
  const view = renderBoardWith(src, undefined)
  if (state || error) {
    for (const fn of view.listeners) fn({ data: { type: 'state', state, error } })
  }
  return view
}

/**
 * Run board.js, optionally deliver one state message, and return what it drew.
 * Throws exactly where the real webview would silently blank.
 *
 * Async only because it loads the source; `renderBoardWith` is the same thing
 * once you already have it, so a suite of straight-line assertions does not
 * have to become a suite of awaits.
 */
export async function renderBoard(state, opts = {}) {
  return renderBoardWith(await boardSource(), state, opts)
}

export function renderBoardWith(src, state, { layout = 'compact' } = {}) {
  const root = makeNode('div')
  const posted = []
  const listeners = []
  /** Timers board.js registered, held rather than run — see `setInterval`. */
  const timers = []
  const document = {
    activeElement: null,
    // Real lookup by id: the settings page's table of contents anchors sections
    // with `document.getElementById`, and a stub that answered only for 'root'
    // made every nav link a no-op that no test could see.
    getElementById: (id) => {
      if (id === 'root') return root
      return walk(root).find((n) => n.id === id) ?? null
    },
    createElement: (tag) => {
      const n = makeNode(tag)
      n._doc = document
      // A canvas is a real capability board.js uses to downscale a pasted
      // screenshot before sending it. Stubbed rather than omitted, because the
      // alternative is that the whole paste path is untestable — and a throw
      // in there is a silently blank panel.
      if (tag === 'canvas') {
        n.getContext = () => ({ drawImage() { n._drawn = true } })
        n.toDataURL = (type) => `data:${type || 'image/png'};base64,SCALED`
      }
      return n
    },
    createTextNode: (t) => ({ textContent: t, children: [], className: '' }),
    documentElement: { dataset: { layout } },
    body: makeNode('body'),
    /* `querySelectorAll` on the DOCUMENT, not only on elements.
       `tickAges()` — the function that makes the liveness age climb, which is
       the board's only honest "is it still moving" signal — finds its nodes
       with `document.querySelectorAll('[data-since]')`. The stub had the method
       on `makeNode` and not here, so the function could not run in any gate:
       the ticker was untestable and a break in it would have been invisible. */
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener() {}, removeEventListener() {},
  }
  const ctx = {
    document,
    window: { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn) } },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m) }),
    Date, Math, Number, JSON, console, Set, Array, Object, String, Map, Intl, Buffer, prompt: () => null,
    /* A CONTROLLABLE timer. `setInterval` is not a V8 intrinsic, so it is
       simply absent from a `vm` context — board.js guards on
       `typeof setInterval === 'function'`, so the ticker was never even
       registered. Collecting the callback instead of running it lets a test
       drive the clock deliberately, which is the only way to assert that an age
       climbs. */
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearInterval: () => {},
    setTimeout: (fn) => { void fn; return 0 },
    clearTimeout: () => {},
    /**
     * Just enough of the browser's image plumbing to run the attachment path.
     *
     * Both call their handlers SYNCHRONOUSLY. In a browser they are async, and
     * the difference matters for one thing only — board.js calls render() from
     * inside `onload`, so a test can assert on the result without waiting. Any
     * ordering the code depends on beyond that would be a bug in the code.
     */
    FileReader: class {
      readAsDataURL(file) {
        this.result = file && file._dataUrl
        if (this.result === undefined) { this.onerror?.(); return }
        this.onload?.()
      }
    },
    Image: class {
      set src(v) {
        const meta = IMAGE_SIZES.get(v)
        if (!meta) { this.onerror?.(); return }
        this.width = meta.width
        this.height = meta.height
        this.onload?.()
      }
    },
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx, { filename: 'board.js' })
  // A second state message is how the host talks to a board that is already on
  // screen — every agent frame is one. What survives that repaint (scroll
  // position, focus) is only testable by sending one.
  const deliver = (st) => { for (const fn of listeners) fn({ data: { type: 'state', state: st } }) }
  if (state) deliver(state)
  /** Run every registered interval callback once, as a second passing. */
  const tick = () => { for (const t of timers) t.fn() }
  return { root, posted, document, deliver, listeners, timers, tick, text: () => root.textContent }
}
