"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTarget, inspectPage, fillAndSubmit, login, runLoginFlow } = require("../scripts/login_local");
const { writeCredentials } = require("../scripts/credential_webform");

const USER = "synthetic-user@example.invalid";
const PASSWORD = "synthetic-password-not-real";

test("local login fills both steps and returns only a status", async () => {
  let stage = "username";
  const calls = [];
  const session = {
    async evaluate(fn, payload) {
      if (fn === inspectPage) return { stage };
      assert.equal(fn, fillAndSubmit);
      calls.push(payload);
      stage = payload.kind === "username" ? "password" : "no_login_form";
      return true;
    }
  };
  const result = await runLoginFlow(session, { username: USER, password: PASSWORD });
  assert.equal(result, "session_check_required");
  assert.deepEqual(calls.map(({ kind, submit }) => ({ kind, submit })), [
    { kind: "username", submit: true }, { kind: "password", submit: true }
  ]);
  assert.equal(calls[0].value, USER);
  assert.equal(calls[1].value, PASSWORD);
  assert.equal(JSON.stringify(result).includes(PASSWORD), false);
});

test("MFA stops automatic entry and leaves verification to the user", async () => {
  const session = { evaluate: async () => ({ stage: "mfa" }) };
  assert.equal(await runLoginFlow(session, { username: USER, password: PASSWORD }), "mfa_required");
});

test("an ambiguous login form fails closed", async () => {
  const session = { evaluate: async () => ({ stage: "ambiguous_form" }) };
  await assert.rejects(runLoginFlow(session, { username: USER, password: PASSWORD }),
    (error) => error.code === "ambiguous_form");
});

test("remote browser endpoints are rejected without exposing stored credentials", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "expedia-login-test-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  writeCredentials({ username: USER, password: PASSWORD, storeDir });
  await assert.rejects(login({ storeDir, cdpBase: "http://example.invalid:9222" }), (error) => {
    assert.equal(error.code, "local_browser_required");
    assert.equal(String(error).includes(PASSWORD), false);
    assert.equal(String(error).includes(USER), false);
    return true;
  });
  assert.throws(() => createTarget("http://example.invalid:9222"), /local_browser_required/);
});

class FakeInput {
  constructor({ type, name, autocomplete }) {
    this.type = type; this.name = name; this.id = ""; this.placeholder = "";
    this.autocomplete = autocomplete; this.events = []; this.onInput = null;
  }
  set value(value) { this.savedValue = value; }
  get value() { return this.savedValue; }
  getClientRects() { return [1]; }
  getAttribute() { return null; }
  closest() { return null; }
  dispatchEvent(event) {
    this.events.push(event.type);
    if (event.type === "input" && this.onInput) this.onInput();
  }
}

function stubDom(t, { input, button }) {
  const before = {
    document: global.document,
    getComputedStyle: global.getComputedStyle,
    HTMLInputElement: global.HTMLInputElement
  };
  t.after(() => {
    global.document = before.document;
    global.getComputedStyle = before.getComputedStyle;
    global.HTMLInputElement = before.HTMLInputElement;
  });
  global.HTMLInputElement = FakeInput;
  global.getComputedStyle = () => ({ visibility: "visible", display: "block" });
  global.document = {
    location: { href: "https://www.expediapartnercentral.com/", hostname: "www.expediapartnercentral.com" },
    body: { innerText: "" },
    querySelectorAll(selector) { return selector === "input" ? [input] : [button]; }
  };
}

test("visible Expedia login field is filled using DOM events", async (t) => {
  const input = new FakeInput({ type: "email", name: "email", autocomplete: "username" });
  const button = {
    type: "submit", disabled: false, innerText: "Continue", clicked: false,
    getClientRects: () => [1], getAttribute: () => null,
    click() { this.clicked = true; }
  };
  stubDom(t, { input, button });
  assert.deepEqual(inspectPage(), { stage: "username" });
  assert.equal(await fillAndSubmit({ kind: "username", value: USER, submit: true }), true);
  assert.equal(input.value, USER);
  assert.deepEqual(input.events, ["input", "change"]);
  assert.equal(button.clicked, true);
});

test("submit button disabled until an input event enables it is clicked once enabled", async (t) => {
  const input = new FakeInput({ type: "password", name: "password", autocomplete: "current-password" });
  const button = {
    type: "submit", disabled: true, innerText: "Continue", clicked: false,
    getClientRects: () => [1], getAttribute: () => null,
    click() { this.clicked = true; }
  };
  // React-style controlled component: the page enables the button asynchronously
  // only after the password input fires an input event.
  input.onInput = () => setTimeout(() => { button.disabled = false; }, 120);
  stubDom(t, { input, button });
  assert.deepEqual(inspectPage(), { stage: "password", hasUsername: false });
  assert.equal(await fillAndSubmit({ kind: "password", value: PASSWORD, submit: true }), true);
  assert.equal(input.value, PASSWORD);
  assert.equal(button.disabled, false);
  assert.equal(button.clicked, true);
});

test("submit button that never enables fails closed without being clicked", async (t) => {
  const input = new FakeInput({ type: "password", name: "password", autocomplete: "current-password" });
  const button = {
    type: "submit", disabled: true, innerText: "Continue", clicked: false,
    getClientRects: () => [1], getAttribute: () => null,
    click() { this.clicked = true; }
  };
  stubDom(t, { input, button });
  const startedAt = Date.now();
  assert.equal(
    await fillAndSubmit({ kind: "password", value: PASSWORD, submit: true, enableTimeoutMs: 200, pollMs: 25 }),
    false
  );
  assert.equal(button.disabled, true);
  assert.equal(button.clicked, false);
  assert.equal(input.value, PASSWORD);
  assert.ok(Date.now() - startedAt < 2000);
});
