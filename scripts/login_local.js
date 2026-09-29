#!/usr/bin/env node
"use strict";

const http = require("node:http");
const WebSocket = require("ws");
const { checkCredentials, readCredentials } = require("./credential_webform");

const LOGIN_URL = "https://www.expediapartnercentral.com/";
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const ALLOWED_HOST = /(^|\.)(expediapartnercentral\.com|expediagroup\.com)$/i;

class LoginError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireLoopback(url, protocol) {
  const parsed = new URL(url);
  if (parsed.protocol !== protocol || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) {
    throw new LoginError("local_browser_required");
  }
  return parsed;
}

function createTarget(cdpBase = process.env.KOLO_BROWSER_CDP_URL || DEFAULT_CDP_URL) {
  const base = requireLoopback(cdpBase, "http:");
  const endpoint = new URL(`/json/new?${LOGIN_URL}`, base);
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, { method: "PUT", timeout: 10000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 100000) request.destroy();
      });
      response.on("end", () => {
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error();
          const target = JSON.parse(body);
          requireLoopback(target.webSocketDebuggerUrl, "ws:");
          if (target.type !== "page" || !target.id) throw new Error();
          resolve({ id: target.id, webSocketDebuggerUrl: target.webSocketDebuggerUrl });
        } catch {
          reject(new LoginError("browser_target_unavailable"));
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => reject(new LoginError("browser_target_unavailable")));
    request.end();
  });
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new LoginError("browser_command_failed"));
      else pending.resolve(message.result);
    });
    socket.on("close", () => this.failPending());
    socket.on("error", () => this.failPending());
  }

  failPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new LoginError("browser_disconnected"));
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new LoginError("browser_disconnected"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LoginError("browser_timeout"));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new LoginError("browser_disconnected"));
        }
      });
    });
  }

  async evaluate(fn, value) {
    const expression = `(${fn.toString()})(${JSON.stringify(value)})`;
    const response = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, silent: true
    });
    if (response.exceptionDetails) throw new LoginError("browser_script_failed");
    return response.result?.value;
  }

  close() { this.socket.close(); }
}

function connectTarget(target) {
  requireLoopback(target.webSocketDebuggerUrl, "ws:");
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 10000, perMessageDeflate: false });
    socket.once("open", () => resolve(new CdpSession(socket)));
    socket.once("error", () => reject(new LoginError("browser_disconnected")));
  });
}

function inspectPage() {
  if (document.location.href === "about:blank") return { stage: "loading" };
  const host = document.location.hostname;
  if (!/(^|\.)(expediapartnercentral\.com|expediagroup\.com)$/i.test(host)) return { stage: "unexpected_origin" };
  const visible = (element) => Boolean(element.getClientRects().length) &&
    getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none";
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const password = inputs.filter((input) => input.type === "password");
  const username = inputs.filter((input) => {
    const label = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") || ""} ${input.autocomplete}`;
    return input.type === "email" || (/user|email|login/i.test(label) && ["text", "email"].includes(input.type));
  });
  if (password.length > 1 || username.length > 1) return { stage: "ambiguous_form" };
  if (password.length === 1) return { stage: "password", hasUsername: username.length === 1 };
  if (username.length === 1) return { stage: "username" };
  if (inputs.some((input) => input.autocomplete === "one-time-code") ||
      /verification code|two.factor|authenticator code/i.test(document.body?.innerText || "")) return { stage: "mfa" };
  return { stage: "no_login_form" };
}

async function fillAndSubmit({ kind, value, submit, enableTimeoutMs = 4000, pollMs = 100 }) {
  if (!/(^|\.)(expediapartnercentral\.com|expediagroup\.com)$/i.test(document.location.hostname)) return false;
  const visible = (element) => Boolean(element.getClientRects().length) &&
    getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none";
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const matches = inputs.filter((input) => {
    if (kind === "password") return input.type === "password";
    const label = `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") || ""} ${input.autocomplete}`;
    return input.type === "email" || (/user|email|login/i.test(label) && ["text", "email"].includes(input.type));
  });
  if (matches.length !== 1) return false;
  const input = matches[0];
  let submitButton;
  if (submit) {
    const form = input.closest("form");
    let buttons = form ? [...form.querySelectorAll("button, input[type='submit']")] :
      [...document.querySelectorAll("button, input[type='submit']")];
    buttons = buttons.filter(visible);
    const named = buttons.filter((button) => /next|continue|sign in|log in|submit/i.test(
      `${button.innerText || button.value || ""} ${button.getAttribute("aria-label") || ""}`));
    const candidates = named.length ? named : buttons.filter((button) => button.type === "submit");
    if (candidates.length !== 1) return false;
    submitButton = candidates[0];
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  if (submitButton) {
    const deadline = Date.now() + enableTimeoutMs;
    while (submitButton.disabled) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    submitButton.click();
  }
  return true;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStage(session, accepted, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await session.evaluate(inspectPage);
    if (accepted.includes(state?.stage)) return state;
    if (["unexpected_origin", "ambiguous_form"].includes(state?.stage)) throw new LoginError(state.stage);
    await delay(400);
  }
  throw new LoginError("login_form_timeout");
}

async function runLoginFlow(session, credentials) {
  let state = await waitForStage(session, ["username", "password", "mfa"], 20000).catch((error) => {
    if (error.code === "login_form_timeout") return { stage: "no_login_form" };
    throw error;
  });
  if (state.stage === "mfa") return "mfa_required";
  if (state.stage === "no_login_form") return "session_check_required";
  if (state.stage === "username") {
    const filled = await session.evaluate(fillAndSubmit, { kind: "username", value: credentials.username, submit: true });
    if (!filled) throw new LoginError("username_form_ambiguous");
    state = await waitForStage(session, ["password", "mfa"], 20000);
    if (state.stage === "mfa") return "mfa_required";
  } else if (state.hasUsername) {
    const filled = await session.evaluate(fillAndSubmit, { kind: "username", value: credentials.username, submit: false });
    if (!filled) throw new LoginError("username_form_ambiguous");
  }
  const filled = await session.evaluate(fillAndSubmit, { kind: "password", value: credentials.password, submit: true });
  if (!filled) throw new LoginError("password_form_ambiguous");
  state = await waitForStage(session, ["mfa", "no_login_form"], 30000);
  return state.stage === "mfa" ? "mfa_required" : "session_check_required";
}

async function login({ storeDir, cdpBase } = {}) {
  const status = checkCredentials({ storeDir });
  if (!status.usernameConfigured || !status.passwordConfigured || !status.permissionsOk) {
    throw new LoginError("local_credentials_not_ready");
  }
  const credentials = readCredentials({ storeDir });
  let session;
  try {
    const target = await createTarget(cdpBase);
    session = await connectTarget(target);
    const result = await runLoginFlow(session, credentials);
    return { status: result, targetId: target.id };
  } finally {
    if (session) session.close();
    credentials.username = "";
    credentials.password = "";
  }
}

module.exports = { CdpSession, LoginError, createTarget, inspectPage, fillAndSubmit, login, runLoginFlow };

if (require.main === module) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node scripts/login_local.js\n");
    process.exit(2);
  }
  login().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    const code = error instanceof LoginError ? error.code : "login_failed";
    process.stderr.write(`Expedia local login stopped (${code}).\n`);
    process.exitCode = 1;
  });
}
