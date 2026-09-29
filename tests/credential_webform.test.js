"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkCredentials,
  pathsFor,
  readCredentials,
  startCapture,
  writeCredentials
} = require("../scripts/credential_webform");

const SYNTHETIC_USER = "synthetic-user@example.invalid";
const SYNTHETIC_PASSWORD = "synthetic-password-not-real";

function temporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "expedia-credential-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function request(url, { method = "GET", body = "", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function formBody(url, overrides = {}) {
  const token = new URL(url).pathname.slice(1);
  return new URLSearchParams({
    token,
    username: SYNTHETIC_USER,
    password: SYNTHETIC_PASSWORD,
    confirm: SYNTHETIC_PASSWORD,
    ...overrides
  }).toString();
}

test("capture binds to loopback, uses a random token, and stores only after matching confirmation", async (t) => {
  const storeDir = temporaryStore(t);
  let openedUrl;
  const capture = startCapture({ storeDir, opener: async (url) => { openedUrl = url; } });
  while (!openedUrl) await new Promise((resolve) => setImmediate(resolve));

  const parsed = new URL(openedUrl);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.match(parsed.pathname, /^\/[A-Za-z0-9_-]{40,}$/);

  const page = await request(openedUrl);
  assert.equal(page.status, 200);
  assert.match(page.body, /name="password"/);
  assert.match(page.body, /name="confirm"/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(page.headers["cache-control"], "no-store, no-cache, must-revalidate");

  const mismatch = formBody(openedUrl, { confirm: "does-not-match" });
  const rejected = await request(openedUrl, {
    method: "POST",
    body: mismatch,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(mismatch) }
  });
  assert.equal(rejected.status, 400);
  assert.equal(checkCredentials({ storeDir }).usernameConfigured, false);

  const body = formBody(openedUrl);
  const accepted = await request(openedUrl, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await capture, { stored: true });
  assert.deepEqual(readCredentials({ storeDir }), { username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD });
  await assert.rejects(request(openedUrl));
});

test("wrong host, wrong path, wrong content type, and extra fields fail closed", async (t) => {
  const storeDir = temporaryStore(t);
  let openedUrl;
  const capture = startCapture({ storeDir, ttlMs: 1000, opener: async (url) => { openedUrl = url; } });
  while (!openedUrl) await new Promise((resolve) => setImmediate(resolve));
  const badHost = await request(openedUrl, { headers: { Host: "localhost" } });
  assert.equal(badHost.status, 404);
  const badPath = await request(new URL("/wrong", openedUrl));
  assert.equal(badPath.status, 404);
  const badType = await request(openedUrl, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
  assert.equal(badType.status, 415);
  const extra = formBody(openedUrl, { mfaCode: "123456" });
  const rejected = await request(openedUrl, {
    method: "POST", body: extra,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(extra) }
  });
  assert.equal(rejected.status, 400);
  await assert.rejects(capture, (error) => error.code === "expired");
});

test("store uses private permissions, atomic replacement, and explicit rotation", (t) => {
  const storeDir = temporaryStore(t);
  writeCredentials({ username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD, storeDir });
  assert.throws(
    () => writeCredentials({ username: "replacement.invalid", password: "replacement", storeDir }),
    (error) => error.code === "rotation_required"
  );
  assert.deepEqual(readCredentials({ storeDir }), { username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD });
  writeCredentials({ username: "replacement.invalid", password: "replacement", storeDir, replace: true });
  assert.deepEqual(readCredentials({ storeDir }), { username: "replacement.invalid", password: "replacement" });
  assert.deepEqual(fs.readdirSync(storeDir), [".credentials.json"]);
  if (process.platform !== "win32") {
    assert.equal((fs.statSync(storeDir).mode & 0o777), 0o700);
    assert.equal((fs.statSync(pathsFor(storeDir).store).mode & 0o777), 0o600);
  }
});

test("corrupt stores and active locks are refused without replacement", (t) => {
  const storeDir = temporaryStore(t);
  fs.writeFileSync(pathsFor(storeDir).store, "not-json", { mode: 0o600 });
  assert.throws(() => writeCredentials({ username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD, storeDir, replace: true }), (error) => error.code === "corrupt_store");
  assert.equal(fs.readFileSync(pathsFor(storeDir).store, "utf8"), "not-json");
  fs.unlinkSync(pathsFor(storeDir).store);
  fs.writeFileSync(pathsFor(storeDir).lock, "locked", { mode: 0o600 });
  assert.throws(() => writeCredentials({ username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD, storeDir }), (error) => error.code === "store_busy");
});

test("credential check reveals presence and permissions but no values or lengths", (t) => {
  const storeDir = temporaryStore(t);
  writeCredentials({ username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD, storeDir });
  const result = checkCredentials({ storeDir });
  const serialized = JSON.stringify(result);
  assert.equal(result.usernameConfigured, true);
  assert.equal(result.passwordConfigured, true);
  assert.equal("username" in result, false);
  assert.equal("password" in result, false);
  assert.doesNotMatch(serialized, /length/i);
  assert.doesNotMatch(serialized, new RegExp(SYNTHETIC_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, new RegExp(SYNTHETIC_PASSWORD));
});

test("errors and public operation results never contain credential values", (t) => {
  const storeDir = temporaryStore(t);
  const first = writeCredentials({ username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD, storeDir });
  assert.deepEqual(first, { stored: true, rotated: false });
  let caught;
  try {
    writeCredentials({ username: SYNTHETIC_USER, password: SYNTHETIC_PASSWORD, storeDir });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  const visible = `${caught.name} ${caught.code} ${caught.message} ${JSON.stringify(first)}`;
  assert.doesNotMatch(visible, new RegExp(SYNTHETIC_USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(visible, new RegExp(SYNTHETIC_PASSWORD));
});

test("symlinked stores are refused", { skip: process.platform === "win32" }, (t) => {
  const storeDir = temporaryStore(t);
  const target = path.join(storeDir, "target.json");
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  fs.symlinkSync(target, pathsFor(storeDir).store);
  assert.throws(() => checkCredentials({ storeDir }), (error) => error.code === "symlink_refused");
});

test("browser opener failure is sanitized and the token URL is not returned", async (t) => {
  const storeDir = temporaryStore(t);
  let privateUrl;
  await assert.rejects(
    startCapture({ storeDir, opener: async (url) => { privateUrl = url; throw new Error(`do not expose ${url}`); } }),
    (error) => error.code === "browser_open_failed" && !error.message.includes(privateUrl)
  );
});
