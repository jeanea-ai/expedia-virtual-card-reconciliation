#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
const MAX_CREDENTIAL_BYTES = 1024;
const STORE_VERSION = 1;

class CredentialSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialSetupError";
    this.code = code;
  }
}

function defaultStoreDir() {
  return process.env.EXPEDIA_EVC_CONFIG_DIR ||
    path.join(os.homedir(), ".openclaw", "workspace-main", "expedia-vc");
}

function pathsFor(storeDir = defaultStoreDir()) {
  return {
    directory: path.resolve(storeDir),
    store: path.resolve(storeDir, ".credentials.json"),
    lock: path.resolve(storeDir, ".credentials.lock")
  };
}

function refuseSymlink(target, label, allowMissing = true) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new CredentialSetupError("symlink_refused", `${label} must not be a symbolic link`);
    }
  } catch (error) {
    if (error.code === "ENOENT" && allowMissing) return;
    throw error;
  }
}

function ensurePrivateDirectory(directory) {
  const parent = path.dirname(directory);
  refuseSymlink(parent, "Credential store parent", true);
  refuseSymlink(directory, "Credential store directory", true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  refuseSymlink(directory, "Credential store directory", false);
  fs.chmodSync(directory, 0o700);
}

function readStore(storePath) {
  refuseSymlink(storePath, "Credential store", true);
  if (!fs.existsSync(storePath)) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    throw new CredentialSetupError("corrupt_store", "Credential store is unreadable or corrupt; refusing to replace it");
  }
  const valid = value && value.version === STORE_VERSION &&
    typeof value.username === "string" && value.username.length > 0 &&
    typeof value.password === "string" && value.password.length > 0 &&
    typeof value.updatedAt === "string" &&
    Object.keys(value).every((key) => ["version", "username", "password", "updatedAt"].includes(key));
  if (!valid) {
    throw new CredentialSetupError("corrupt_store", "Credential store has an invalid structure; refusing to replace it");
  }
  return value;
}

function withLock(lockPath, action) {
  refuseSymlink(lockPath, "Credential store lock", true);
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new CredentialSetupError("store_busy", "Credential store is locked by another operation");
    }
    throw error;
  }
  try {
    fs.chmodSync(lockPath, 0o600);
    return action();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function writeCredentials({ username, password, replace = false, storeDir = defaultStoreDir() }) {
  if (typeof username !== "string" || !username || Buffer.byteLength(username) > MAX_CREDENTIAL_BYTES ||
      typeof password !== "string" || !password || Buffer.byteLength(password) > MAX_CREDENTIAL_BYTES) {
    throw new CredentialSetupError("invalid_credential", "Credential fields are missing or exceed the allowed size");
  }
  const locations = pathsFor(storeDir);
  ensurePrivateDirectory(locations.directory);
  return withLock(locations.lock, () => {
    const current = readStore(locations.store);
    if (current && !replace) {
      throw new CredentialSetupError("rotation_required", "Credentials already exist; use the explicit rotation option to replace them");
    }
    const payload = JSON.stringify({ version: STORE_VERSION, username, password, updatedAt: new Date().toISOString() });
    const temporary = path.join(locations.directory, `.credentials.${crypto.randomBytes(12).toString("hex")}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, payload, { encoding: "utf8" });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.chmodSync(temporary, 0o600);
      refuseSymlink(locations.store, "Credential store", true);
      fs.renameSync(temporary, locations.store);
      fs.chmodSync(locations.store, 0o600);
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
    }
    return { stored: true, rotated: Boolean(current) };
  });
}

function readCredentials({ storeDir = defaultStoreDir() } = {}) {
  const locations = pathsFor(storeDir);
  refuseSymlink(locations.directory, "Credential store directory", true);
  const store = readStore(locations.store);
  if (!store) throw new CredentialSetupError("not_configured", "Expedia credentials are not configured");
  return { username: store.username, password: store.password };
}

function permissionMode(target) {
  return (fs.statSync(target).mode & 0o777).toString(8).padStart(3, "0");
}

function checkCredentials({ storeDir = defaultStoreDir() } = {}) {
  const locations = pathsFor(storeDir);
  refuseSymlink(locations.directory, "Credential store directory", true);
  refuseSymlink(locations.store, "Credential store", true);
  if (!fs.existsSync(locations.store)) {
    return { backend: "local_file", usernameConfigured: false, passwordConfigured: false, permissionsOk: false };
  }
  readStore(locations.store);
  const directoryMode = permissionMode(locations.directory);
  const fileMode = permissionMode(locations.store);
  return {
    backend: "local_file",
    usernameConfigured: true,
    passwordConfigured: true,
    directoryMode,
    fileMode,
    permissionsOk: process.platform === "win32" || (directoryMode === "700" && fileMode === "600")
  };
}

function removeCredentials({ storeDir = defaultStoreDir() } = {}) {
  const locations = pathsFor(storeDir);
  ensurePrivateDirectory(locations.directory);
  return withLock(locations.lock, () => {
    refuseSymlink(locations.store, "Credential store", true);
    if (!fs.existsSync(locations.store)) return { removed: false };
    readStore(locations.store);
    fs.unlinkSync(locations.store);
    return { removed: true };
  });
}

function securityHeaders(response) {
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function page(token, message = "") {
  const notice = message ? `<p role="alert">${message}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Expedia credential setup</title><style>body{font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}label{display:block;margin-top:1rem}input{box-sizing:border-box;width:100%;padding:.7rem}button{margin-top:1.25rem;padding:.7rem 1rem}small{display:block;margin-top:1rem;color:#444}</style></head><body><h1>Expedia credential setup</h1><p>Saved locally for this workspace. Do not enter MFA or recovery codes.</p>${notice}<form method="post" action="/${token}" autocomplete="off"><input type="hidden" name="token" value="${token}"><label>Expedia username<input name="username" autocomplete="username" required maxlength="1024"></label><label>Password<input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label><label>Confirm password<input type="password" name="confirm" autocomplete="current-password" required maxlength="1024"></label><button type="submit">Save securely</button></form><small>This one-use page expires automatically.</small></body></html>`;
}

function tokenMatches(submitted, expected) {
  const left = Buffer.from(submitted);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function openSharedBrowser(url, cdpBase = process.env.KOLO_BROWSER_CDP_URL || "http://127.0.0.1:9222") {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(`${cdpBase.replace(/\/$/, "")}/json/new?${url}`);
    const request = http.request(endpoint, { method: "PUT" }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode >= 200 && response.statusCode < 300
        ? resolve()
        : reject(new CredentialSetupError("browser_open_failed", "Could not open the credential form in the shared browser")));
    });
    request.on("error", () => reject(new CredentialSetupError("browser_open_failed", "Could not open the credential form in the shared browser")));
    request.end();
  });
}

function startCapture(options = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const storeDir = options.storeDir || defaultStoreDir();
  const replace = options.replace === true;
  const opener = options.opener || openSharedBrowser;
  let used = false;
  let expiresAt;
  let timer;

  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer);
      server.close(() => error ? reject(error) : resolve(result));
    };
    const server = http.createServer((request, response) => {
      securityHeaders(response);
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== expectedHost || request.url !== `/${token}` || used || Date.now() >= expiresAt) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page(token));
        return;
      }
      if (request.method !== "POST" || !String(request.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
        response.writeHead(415, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unsupported request");
        return;
      }
      let size = 0;
      const chunks = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        if (size > MAX_BODY_BYTES) return;
        const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const submittedToken = fields.get("token") || "";
        const username = fields.get("username") || "";
        const password = fields.get("password") || "";
        const confirm = fields.get("confirm") || "";
        const allowedFields = ["token", "username", "password", "confirm"];
        const exactFields = [...fields.keys()].length === allowedFields.length &&
          allowedFields.every((key) => fields.getAll(key).length === 1);
        if (!exactFields || !tokenMatches(submittedToken, token) || password !== confirm) {
          response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          response.end(page(token, "The entries were invalid or the passwords did not match."));
          return;
        }
        try {
          writeCredentials({ username, password, replace, storeDir });
          used = true;
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end("<!doctype html><html><body><h1>Credential saved</h1><p>You may close this tab.</p></body></html>");
          finish(null, { stored: true });
        } catch (error) {
          response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Credential could not be saved. Close this tab and check the setup command.");
          finish(error);
        }
      });
    });
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n"));
    server.on("error", (error) => reject(new CredentialSetupError("server_failed", `Credential setup server failed: ${error.code || "unknown"}`)));
    server.listen(0, "127.0.0.1", async () => {
      const port = server.address().port;
      expiresAt = Date.now() + ttlMs;
      timer = setTimeout(() => finish(new CredentialSetupError("expired", "Credential setup page expired before it was submitted")), ttlMs);
      const url = `http://127.0.0.1:${port}/${token}`;
      try {
        await opener(url);
        if (options.onReady) options.onReady({ port, expiresAt });
      } catch (error) {
        finish(error instanceof CredentialSetupError ? error : new CredentialSetupError("browser_open_failed", "Could not open the credential form in the shared browser"));
      }
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  try {
    if (command === "capture") {
      const unknown = argv.slice(1).filter((arg) => arg !== "--replace");
      if (unknown.length) throw new CredentialSetupError("invalid_argument", "Only --replace is accepted by the capture command");
      process.stdout.write("Opening a private, one-use credential form in the shared browser.\n");
      await startCapture({ replace: argv.includes("--replace") });
      process.stdout.write("Expedia credentials saved.\n");
    } else if (command === "check") {
      process.stdout.write(`${JSON.stringify(checkCredentials(), null, 2)}\n`);
    } else if (command === "remove") {
      if (!argv.includes("--confirm") || argv.length !== 2) throw new CredentialSetupError("confirmation_required", "Removal requires the explicit --confirm option");
      const result = removeCredentials();
      process.stdout.write(result.removed ? "Expedia credentials removed.\n" : "No Expedia credentials were configured.\n");
    } else {
      process.stderr.write("Usage: node scripts/credential_webform.js <capture [--replace] | check | remove --confirm>\n");
      process.exitCode = 2;
    }
  } catch (error) {
    const code = error instanceof CredentialSetupError ? error.code : "unexpected_error";
    process.stderr.write(`Credential setup failed (${code}).\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CredentialSetupError,
  checkCredentials,
  defaultStoreDir,
  openSharedBrowser,
  pathsFor,
  readCredentials,
  removeCredentials,
  startCapture,
  writeCredentials
};

if (require.main === module) main();
