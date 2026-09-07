/** A DOM small enough to run public/board.js in, and nothing more.
 *
 * A TRIMMED COPY of the extension repo's `test/dom.mjs` — the extension's
 * own webviews run against the same model of a browser, and the two files are
 * kept in step by hand (when the extension's copy grows, mirror the change
 * here). Only the pieces the viewer page needs are carried: makeNode,
 * matchesSelector, walk, findByTag. Keep the semantics identical — the viewer
 * test exists to catch a runtime throw that would otherwise be a blank page.
 *
 * The viewer page is the one layer with no type checking, so a runtime throw
 * there is invisible in production: the watcher just sees nothing. Running the
 * real board.js against this stub turns that into a test failure.
 */

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
