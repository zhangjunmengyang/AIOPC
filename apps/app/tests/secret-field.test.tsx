import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createRef } from "react"
import type { Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { SecretField, type SecretFieldHandle } from "../src/components/secret-field"

let createRoot: typeof import("react-dom/client")["createRoot"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  createRoot = (await import("react-dom/client")).createRoot
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
let previousAct: unknown
beforeEach(() => { previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true) })
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
})

test("the private field opts out of autofill, password managers and session capture, with no value in markup", () => {
  const html = renderToStaticMarkup(<SecretField id="key" label="API key" onSubmit={() => {}} />)
  expect(html).toContain('type="password"')
  expect(html).toContain('autoComplete="off"')
  expect(html).toContain('data-1p-ignore="true"')
  expect(html).toContain('data-private="true"')
  expect(html).toContain('data-secret-field="true"')
  expect(html).toContain("ph-no-capture")
  expect(html).not.toContain('value="')
})

test("the key is shown only while typing and asked for, hidden on blur, and cleared once taken", async () => {
  const container = document.createElement("div")
  const outside = document.createElement("button")
  document.body.append(container, outside)
  root = createRoot(container)
  const handle = createRef<SecretFieldHandle>()
  const changes: boolean[] = []
  await act(async () => root?.render(<SecretField id="key" label="API key" revealable handleRef={handle} onSubmit={() => {}} onValueChange={(has) => changes.push(has)} />))
  const input = container.querySelector("input")
  const toggle = container.querySelector("button")
  if (!input || !toggle) throw new Error("missing field")
  expect(toggle.disabled).toBe(true)

  await act(async () => {
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    setter?.call(input, "fixture-private-value")
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  expect(input.type).toBe("password")
  expect(changes).toEqual([true])
  await act(async () => toggle.click())
  expect(input.type).toBe("text")
  // Leaving the field ends the reveal.
  await act(async () => { input.blur(); outside.focus(); input.dispatchEvent(new FocusEvent("blur", { relatedTarget: outside })) })
  expect(input.type).toBe("password")

  let taken = ""
  await act(async () => { taken = handle.current?.take() ?? "" })
  expect(taken).toBe("fixture-private-value")
  expect(input.value).toBe("")
  expect(container.innerHTML).not.toContain("fixture-private-value")
})

test("the field is masked and offers to show the key while typing", () => {
  const html = renderToStaticMarkup(<SecretField id="key" label="API key" />)
  expect(html).toContain('type="password"')
  expect(html).toContain("Show while typing")
})

test("a key-file field is never drawn unmasked: a password input until the browser can mask a textarea", () => {
  const html = renderToStaticMarkup(<SecretField id="file" label="Service account key (JSON)" multiline />)
  expect(html).toContain('type="password"')
  expect(html).not.toContain("<textarea")
})
