.pragma library
// Keyboard editing for the dialog's fields, which are read-only TextInputs.
//
// A writable TextInput reads the clipboard by itself: Qt (6.12.0, the
// release Arch ships) connects every writable field to
// QClipboard::dataChanged and calls QMimeData::text() on each change, so
// another Wayland client advertising an oversized or endless text offer
// stalls the shell as soon as the compositor hands the offer over, e.g.
// when the dialog takes keyboard focus. No paste is needed for that (fixed
// upstream in qtdeclarative bcbfae67); an explicit paste (the paste keys,
// middle click) then reads the whole offer synchronously too, with no size
// cap. `readOnly: true` turns off every one of those paths, so the fields
// stay read-only and this library does the typing: printable keys,
// Backspace/Delete (Ctrl: up to the start/end, or the previous/next word in
// a visible field) and dead keys. Navigation, selection, Enter and
// Escape are left to the TextInput and the dialog.
//
// A read-only field gets no input method events either (Qt clears
// ItemAcceptsInputMethod), which is what composes dead keys, so they're
// composed here: a dead key followed by a letter gives the precomposed
// letter (Unicode NFC), by Space or by itself the accent itself, as the
// en_US compose table does; ´ + c is ç in Portuguese locales, as in
// pt_BR's table. An input method's own scripts (CJK and others) are not
// available, as in any password field, where input methods switch off.
//
// Everything here is pure (state in, state out) so it can be unit-tested
// outside Qt: tests/field-editor.test.mjs.

var KEY_BACKSPACE = 0x01000003
var KEY_DELETE = 0x01000007
var CONTROL = 0x04000000
var META = 0x10000000

// Qt::Key_Dead_* -> [combining mark, the accent typed on its own].
var DEAD_KEYS = {
  0x01001250: ["̀", "`"],       // grave
  0x01001251: ["́", "'"],       // acute
  0x01001252: ["̂", "^"],       // circumflex
  0x01001253: ["̃", "~"],       // tilde
  0x01001254: ["̄", "¯"],  // macron
  0x01001255: ["̆", "˘"],  // breve
  0x01001256: ["̇", "˙"],  // dot above
  0x01001257: ["̈", "\""],      // diaeresis
  0x01001258: ["̊", "˚"],  // ring above
  0x01001259: ["̋", "˝"],  // double acute
  0x0100125a: ["̌", "ˇ"],  // caron
  0x0100125b: ["̧", "¸"],  // cedilla
  0x0100125c: ["̨", "˛"]   // ogonek
}
var DEAD_ACUTE = 0x01001251

// Keys that only modify the next one (Shift, AltGr, ...): they keep a
// pending dead key, so ´ then Shift+A still makes Á.
var MODIFIER_KEYS = [
  0x01000020, 0x01000021, 0x01000022, 0x01000023,  // Shift Control Meta Alt
  0x01000024, 0x01000025, 0x01000026,              // Caps/Num/Scroll Lock
  0x01000053, 0x01000054, 0x01000056, 0x01000057,  // Super, Hyper
  0x01001103, 0x0100117e, 0x01ffffff               // AltGr, Mode_switch, unknown
]

function isDeadKey(key) {
  return DEAD_KEYS.hasOwnProperty(key)
}

// Text a key may insert: no control characters (C0, DEL, C1) and no lone
// surrogates.
function printable(text) {
  var out = ""
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue
    if (c >= 0xd800 && c <= 0xdbff) {
      var next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1]
        i++
      }
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue
    out += text[i]
  }
  return out
}

// What a pending dead key and the text typed after it make.
function compose(dead, text, locale) {
  var accent = DEAD_KEYS[dead]
  if (text === " ") return accent[1]
  if (dead === DEAD_ACUTE && /^pt([_-]|$)/.test(locale || "")) {
    if (text === "c") return "ç"
    if (text === "C") return "Ç"
  }
  var first = String.fromCodePoint(text.codePointAt(0))
  var composed = (first + accent[0]).normalize("NFC")
  // No precomposed letter: the dead key is dropped, as Qt's compose does.
  if (Array.from(composed).length !== 1) return text
  return composed + text.slice(first.length)
}

// Length of the code point that ends (before) or starts (after) at `pos`.
function stepBack(text, pos) {
  if (pos >= 2) {
    var lo = text.charCodeAt(pos - 1), hi = text.charCodeAt(pos - 2)
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return 2
  }
  return pos > 0 ? 1 : 0
}

function stepForward(text, pos) {
  if (pos + 1 < text.length) {
    var hi = text.charCodeAt(pos), lo = text.charCodeAt(pos + 1)
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return 2
  }
  return pos < text.length ? 1 : 0
}

function wordStart(text, pos) {
  while (pos > 0 && /\s/.test(text[pos - 1])) pos--
  while (pos > 0 && !/\s/.test(text[pos - 1])) pos--
  return pos
}

function wordEnd(text, pos) {
  while (pos < text.length && /\s/.test(text[pos])) pos++
  while (pos < text.length && !/\s/.test(text[pos])) pos++
  return pos
}

function replace(state, from, to, insert) {
  return {
    handled: true,
    text: state.text.slice(0, from) + insert + state.text.slice(to),
    cursor: from + insert.length,
    dead: 0
  }
}

// state: { text, cursor, selectionStart, selectionEnd, dead (0 or the
//          pending Qt::Key_Dead_*), secret (bool) }
// event: { key, text, modifiers } (a QML KeyEvent works as is)
// Returns { handled, text, cursor, dead }: when handled, the caller sets
// the field's text and cursor and accepts the event; otherwise it lets the
// TextInput have the event (text and cursor are then unchanged) and keeps
// `dead`.
function key(state, event, locale) {
  var text = state.text
  var cursor = state.cursor
  var selFrom = Math.min(state.selectionStart, state.selectionEnd)
  var selTo = Math.max(state.selectionStart, state.selectionEnd)
  var hasSelection = selFrom !== selTo
  var ctrl = (event.modifiers & CONTROL) !== 0
  var unhandled = { handled: false, text: text, cursor: cursor, dead: state.dead }

  if (isDeadKey(event.key) && !ctrl) {
    // The same dead key twice types the accent; another one replaces it.
    if (state.dead === event.key) {
      return replace(state, hasSelection ? selFrom : cursor, hasSelection ? selTo : cursor, DEAD_KEYS[event.key][1])
    }
    return { handled: true, text: text, cursor: cursor, dead: event.key }
  }

  if (event.key === KEY_BACKSPACE) {
    // Backspace first cancels a pending dead key.
    if (state.dead) return { handled: true, text: text, cursor: cursor, dead: 0 }
    if (hasSelection) return replace(state, selFrom, selTo, "")
    var from = ctrl ? (state.secret ? 0 : wordStart(text, cursor)) : cursor - stepBack(text, cursor)
    return replace(state, from, cursor, "")
  }

  if (event.key === KEY_DELETE) {
    if (hasSelection) return replace(state, selFrom, selTo, "")
    var to = ctrl ? (state.secret ? text.length : wordEnd(text, cursor)) : cursor + stepForward(text, cursor)
    return replace(state, cursor, to, "")
  }

  if (MODIFIER_KEYS.indexOf(event.key) >= 0) return unhandled
  if (ctrl || (event.modifiers & META) !== 0) return unhandled

  var typed = printable(event.text || "")
  if (typed.length === 0) {
    // Navigation and the like cancel a pending dead key.
    unhandled.dead = 0
    return unhandled
  }
  if (state.dead) typed = compose(state.dead, typed, locale)
  return replace(state, hasSelection ? selFrom : cursor, hasSelection ? selTo : cursor, typed)
}
