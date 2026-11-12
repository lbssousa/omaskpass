// Unit tests for FieldEditor.js, the typing of the dialog's read-only
// fields. Run with `node --test tests/field-editor.test.mjs` (`just test` does).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

// The file is a QML JavaScript library: drop the `.pragma` line and load
// its functions.
const source = readFileSync(new URL("../FieldEditor.js", import.meta.url), "utf8")
  .replace(/^\.pragma library$/m, "")
const FieldEditor = new Function(`${source}; return { key, compose, printable }`)()

const BACKSPACE = 0x01000003
const DELETE = 0x01000007
const SHIFT = 0x01000020
const LEFT = 0x01000012
const CONTROL = 0x04000000
const SHIFT_MOD = 0x02000000
const META = 0x10000000
const DEAD = { grave: 0x01001250, acute: 0x01001251, circumflex: 0x01001252, tilde: 0x01001253, diaeresis: 0x01001257 }

// Types a sequence of events into an empty field and returns its state.
function type(events, { secret = true, locale = "en_US", start = "" } = {}) {
  let s = { text: start, cursor: start.length, selectionStart: start.length, selectionEnd: start.length, dead: 0, secret }
  for (const e of events) {
    const ev = typeof e === "string" ? { key: e.toUpperCase().charCodeAt(0), text: e, modifiers: 0 } : { text: "", modifiers: 0, ...e }
    const r = FieldEditor.key(s, ev, locale)
    s = { ...s, text: r.text, cursor: r.cursor, selectionStart: r.cursor, selectionEnd: r.cursor, dead: r.dead }
  }
  return s
}

test("plain typing inserts at the cursor", () => {
  assert.equal(type(["a", "b", "c"]).text, "abc")
  const mid = FieldEditor.key({ text: "ac", cursor: 1, selectionStart: 1, selectionEnd: 1, dead: 0, secret: true }, { key: 66, text: "b", modifiers: 0 })
  assert.deepEqual([mid.handled, mid.text, mid.cursor], [true, "abc", 2])
})

test("typing replaces the selection", () => {
  const r = FieldEditor.key({ text: "hello", cursor: 4, selectionStart: 1, selectionEnd: 4, dead: 0, secret: true }, { key: 88, text: "x", modifiers: 0 })
  assert.deepEqual([r.text, r.cursor], ["hxo", 2])
})

test("control characters and lone surrogates are never inserted", () => {
  assert.equal(FieldEditor.printable("a\u0000b\u001bc\u007fd\u0085e"), "abcde")
  assert.equal(FieldEditor.printable("x\ud800y\udc00z"), "xyz")
  assert.equal(FieldEditor.printable("😀"), "😀")
  const r = FieldEditor.key({ text: "", cursor: 0, selectionStart: 0, selectionEnd: 0, dead: 0, secret: true }, { key: 0x01000004, text: "\r", modifiers: 0 })
  assert.equal(r.handled, false, "Enter is left to the TextInput")
})

test("Ctrl and Meta shortcuts are left to the TextInput, never typed", () => {
  for (const modifiers of [CONTROL, CONTROL | SHIFT_MOD, META]) {
    const r = FieldEditor.key({ text: "", cursor: 0, selectionStart: 0, selectionEnd: 0, dead: 0, secret: true }, { key: 86, text: "\u0016", modifiers })
    assert.deepEqual([r.handled, r.text], [false, ""])
  }
})

test("Backspace and Delete remove one code point, or the selection", () => {
  assert.equal(type(["a", "b", { key: BACKSPACE }]).text, "a")
  assert.equal(type([{ key: BACKSPACE }]).text, "")
  assert.equal(type(["a", { text: "😀", key: 0 }, { key: BACKSPACE }]).text, "a")
  const del = FieldEditor.key({ text: "a😀b", cursor: 1, selectionStart: 1, selectionEnd: 1, dead: 0, secret: true }, { key: DELETE, text: "", modifiers: 0 })
  assert.deepEqual([del.text, del.cursor], ["ab", 1])
  const sel = FieldEditor.key({ text: "hello", cursor: 1, selectionStart: 4, selectionEnd: 1, dead: 0, secret: true }, { key: BACKSPACE, text: "", modifiers: 0 })
  assert.deepEqual([sel.text, sel.cursor], ["ho", 1])
})

test("Ctrl+Backspace/Delete: everything in a secret, a word in a visible field", () => {
  const at = (text, cursor, secret, key) =>
    FieldEditor.key({ text, cursor, selectionStart: cursor, selectionEnd: cursor, dead: 0, secret }, { key, text: "", modifiers: CONTROL })
  assert.equal(at("my pass word", 12, true, BACKSPACE).text, "")
  assert.equal(at("my pass word", 12, false, BACKSPACE).text, "my pass ")
  assert.equal(at("my pass word", 3, true, DELETE).text, "my ")
  assert.equal(at("my pass word", 2, false, DELETE).text, "my word")
})

test("dead keys compose the precomposed letter", () => {
  assert.equal(type([{ key: DEAD.acute }, "a"]).text, "á")
  assert.equal(type([{ key: DEAD.tilde }, "a", { key: DEAD.tilde }, "o"]).text, "ãõ")
  assert.equal(type([{ key: DEAD.circumflex }, "e", { key: DEAD.grave }, "a", { key: DEAD.diaeresis }, "u"]).text, "êàü")
})

test("a modifier pressed after the dead key keeps it pending", () => {
  assert.equal(type([{ key: DEAD.acute }, { key: SHIFT, modifiers: SHIFT_MOD }, { key: 65, text: "A", modifiers: SHIFT_MOD }]).text, "Á")
})

test("dead key + Space, or twice, types the accent", () => {
  assert.equal(type([{ key: DEAD.acute }, " "]).text, "'")
  assert.equal(type([{ key: DEAD.diaeresis }, " "]).text, "\"")
  assert.equal(type([{ key: DEAD.tilde }, { key: DEAD.tilde }]).text, "~")
})

test("´ + c is ç in Portuguese, ć elsewhere", () => {
  assert.equal(type([{ key: DEAD.acute }, "c"], { locale: "pt_BR" }).text, "ç")
  assert.equal(type([{ key: DEAD.acute }, "C"], { locale: "pt_PT" }).text, "Ç")
  assert.equal(type([{ key: DEAD.acute }, "c"], { locale: "en_US" }).text, "ć")
})

test("a dead key with no precomposed letter is dropped", () => {
  assert.equal(type([{ key: DEAD.tilde }, "q"]).text, "q")
  assert.equal(type([{ key: DEAD.acute }, "1"]).text, "1")
})

test("Backspace or navigation cancel a pending dead key", () => {
  assert.equal(type(["x", { key: DEAD.acute }, { key: BACKSPACE }, "a"]).text, "xa")
  assert.equal(type([{ key: DEAD.acute }, { key: LEFT }, "a"]).text, "a")
})
