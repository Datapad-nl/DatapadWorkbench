/** Runs in the guest page via executeJavaScript. Resolves with a JSON-safe hit or null. */
export const ANNOTATE_PICKER = `(() => {
  if (window.__grokAnnotate) window.__grokAnnotate.cancel()
  return new Promise((resolve) => {
    var done = false
    var box = document.createElement('div')
    box.setAttribute('data-workbench-annotate', '1')
    box.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'border:2px solid #c4a35a',
      'background:rgba(196,163,90,0.16)',
      'box-sizing:border-box',
      'border-radius:2px',
      'display:none'
    ].join(';')
    document.documentElement.appendChild(box)

    function esc(value) {
      if (window.CSS && CSS.escape) return CSS.escape(value)
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')
    }

    function cssPath(el) {
      if (!el || el.nodeType !== 1) return ''
      if (el.id) {
        var idSel = '#' + esc(el.id)
        try {
          if (document.querySelectorAll(idSel).length === 1) return idSel
        } catch (e) {}
      }
      var parts = []
      var node = el
      while (node && node.nodeType === 1 && parts.length < 8) {
        var sel = node.tagName.toLowerCase()
        if (node.id) {
          parts.unshift('#' + esc(node.id))
          break
        }
        var parent = node.parentElement
        if (parent) {
          var same = []
          for (var i = 0; i < parent.children.length; i++) {
            if (parent.children[i].tagName === node.tagName) same.push(parent.children[i])
          }
          if (same.length > 1) {
            var idx = same.indexOf(node) + 1
            sel += ':nth-of-type(' + idx + ')'
          }
        }
        parts.unshift(sel)
        if (node === document.body || node === document.documentElement) break
        node = parent
      }
      return parts.join(' > ')
    }

    function targetFromEvent(event) {
      var el = document.elementFromPoint(event.clientX, event.clientY)
      if (!el || el === box || el.getAttribute && el.getAttribute('data-workbench-annotate')) return null
      if (el === document.documentElement || el === document.body) return el
      return el
    }

    function paint(el) {
      if (!el) {
        box.style.display = 'none'
        return
      }
      var r = el.getBoundingClientRect()
      box.style.display = 'block'
      box.style.left = Math.round(r.left) + 'px'
      box.style.top = Math.round(r.top) + 'px'
      box.style.width = Math.max(0, Math.round(r.width)) + 'px'
      box.style.height = Math.max(0, Math.round(r.height)) + 'px'
    }

    function cleanup() {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      if (box.parentNode) box.parentNode.removeChild(box)
      if (window.__grokAnnotate && window.__grokAnnotate._box === box) {
        window.__grokAnnotate = null
      }
    }

    function finish(value) {
      if (done) return
      done = true
      if (!value) cleanup()
      resolve(value)
    }

    function onMove(event) {
      paint(targetFromEvent(event))
    }

    function onDown(event) {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
    }

    function onClick(event) {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      var el = targetFromEvent(event)
      if (!el) return
      paint(el)
      box.style.borderWidth = '3px'
      box.style.background = 'rgba(196,163,90,0.28)'
      var r = el.getBoundingClientRect()
      var html = ''
      try { html = (el.outerHTML || '').slice(0, 2500) } catch (e) {}
      var text = ''
      try { text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400) } catch (e) {}
      finish({
        selector: cssPath(el),
        tag: (el.tagName || '').toLowerCase(),
        text: text,
        html: html,
        rect: {
          x: r.left,
          y: r.top,
          width: r.width,
          height: r.height
        }
      })
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
      }
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)

    window.__grokAnnotate = {
      _box: box,
      cancel: function () { finish(null) },
      cleanup: function () { cleanup() }
    }
  })
})()`

export const ANNOTATE_CANCEL = `(function(){
  if (window.__grokAnnotate) window.__grokAnnotate.cancel()
  return true
})()`

export const ANNOTATE_CLEANUP = `(function(){
  if (window.__grokAnnotate) window.__grokAnnotate.cleanup()
  return true
})()`
