// The board's single page. Everything inline, nonce'd by the server's CSP; no external
// assets. Task text only ever reaches the DOM through textContent, and the initial state
// is embedded as JSON with every "<" escaped, so a title can't close the script.
//
// The token (D0021) arrives in the URL fragment, which the browser never sends: the page
// moves it to sessionStorage, clears it from the address bar and sends it as a header.
//
// The look comes from two files next to this one: tokens.css (every raw value) and board.css
// (components, tokens only; `design-kit lint` checks it). Design notes: docs/board-design.md.
import { readFileSync } from "node:fs";

/** JSON safe to put inside a <script> element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

// These three run in the page too (inlined with toString), so tests can check them here.

/** "#344" for a GitHub PR URL, "" for anything else. */
export function prNumber(pr: string | null): string {
  const m = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?$/.exec(pr || "");
  return m ? "#" + m[1] : "";
}

export interface CardAction {
  kind: "approve" | "merge" | "wait" | "none";
  /** The button's label, or the waiting text. */
  label: string;
  /** Set when the button shows but can't be used, with why. */
  disabled?: string;
}

/** What a card offers the person: the one next action, or what it is waiting for. */
export function nextAction(
  t: { id: string; status: string; pr: string | null; assignee: string | null },
  canAct: boolean,
  readOnly: boolean,
): CardAction {
  const off = readOnly ? "read-only board" : "open the link fm serve printed";
  switch (t.status) {
    case "needs_approval":
      return canAct ? { kind: "approve", label: "Approve" } : { kind: "approve", label: "Approve", disabled: off };
    case "approved": {
      const n = prNumber(t.pr);
      if (!n) return { kind: "wait", label: "no GitHub PR: merge it by hand, then fm merged " + t.id };
      return canAct ? { kind: "merge", label: "Merge " + n } : { kind: "merge", label: "Merge " + n, disabled: off };
    }
    case "draft":
      return { kind: "wait", label: "draft: fm ready " + t.id + " to start it" };
    case "ready":
      return { kind: "wait", label: "waiting for a worker" };
    case "claimed":
    case "in_progress":
      return { kind: "wait", label: t.assignee ? "with " + t.assignee : "in progress" };
    case "in_review":
      return { kind: "wait", label: "waiting for verifier" };
    case "verifying":
      return { kind: "wait", label: t.assignee ? "being verified by " + t.assignee : "being verified" };
    default:
      return { kind: "none", label: "" };
  }
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 36) return h + " h ago";
  return Math.round(h / 24) + " d ago";
}

/** Seconds between the click and the request, while Undo still stops it. */
export const UNDO_SECONDS = 5;

/**
 * Every key the page answers, as [keys, what it does, group]. "Mod" is ⌘ on a Mac and Ctrl
 * elsewhere; " / " separates alternatives and a space separates keys pressed in turn.
 * The ? dialog is drawn from this list, so it can't drift from the handler (a test checks both).
 */
export const SHORTCUTS: [string, string, string][] = [
  ["Mod K", "command palette: every action, view and task", "General"],
  ["/", "filter the tasks", "General"],
  ["?", "show these shortcuts", "General"],
  ["Esc", "close, clear the filter, or clear the selection", "General"],
  ["j / ↓", "next task", "Move"],
  ["k / ↑", "previous task", "Move"],
  ["h / ←", "previous column (board)", "Move"],
  ["l / →", "next column (board)", "Move"],
  ["Enter / o", "open the task", "Move"],
  ["g n", "go to Needs you", "Go to"],
  ["g a", "go to All tasks", "Go to"],
  ["g 1", "go to the first project (2, 3 … for the others)", "Go to"],
  ["v", "switch between list and board", "Go to"],
  ["a", "approve the task", "Act"],
  ["m", "merge the task", "Act"],
  ["u", "undo the last approve or merge", "Act"],
  ["p", "open the task's pull request", "Act"],
];

const CSS = [
  readFileSync(new URL("./tokens.css", import.meta.url), "utf8"),
  readFileSync(new URL("./board.css", import.meta.url), "utf8"),
].join("\n");

const JS = `
"use strict";
${prNumber.toString()}
${nextAction.toString()}
${ago.toString()}
const UNDO_MS = ${UNDO_SECONDS * 1000};
const SHORTCUTS = ${JSON.stringify(SHORTCUTS)};
const S = JSON.parse(document.getElementById("initial").textContent);
const KEY = "foreman-board-token";
const PREFS = "foreman-board-prefs";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const MOD = MAC ? "⌘" : "Ctrl";
const NAMES = { draft: "Draft", ready: "Ready", claimed: "Claimed", in_progress: "In progress", in_review: "In review",
  verifying: "Verifying", needs_approval: "Needs approval", approved: "Approved", done: "Done", cancelled: "Cancelled" };
// The list puts what waits for the person first, then the work in flight, then what's finished.
const LIST_ORDER = ["needs_approval", "approved", "verifying", "in_review", "in_progress", "claimed", "ready", "draft", "done", "cancelled"];
const EMPTY = { needs_approval: "Nothing to sign off.", approved: "Nothing to merge." };
const YOURS = (t) => t.status === "needs_approval" || t.status === "approved";
// Tasks of every project, merged. t.k (project/id) is the key: ids repeat across projects.
const PROJECTS = (S.projects || [{ name: "", tasks: S.tasks || [], lastEvent: S.lastEvent || 0 }]).map((p) => p.name);
const multi = PROJECTS.length > 1;
const lastEvents = new Map((S.projects || [{ name: "", lastEvent: S.lastEvent || 0 }]).map((p) => [p.name, p.lastEvent]));
const tag = (name, ts) => ts.map((t) => ({ ...t, project: name, k: name + "/" + t.id }));
let tasks = (S.projects || [{ name: "", tasks: S.tasks || [] }]).flatMap((p) => tag(p.name, p.tasks));
// view: "all" or one project's name. inbox: only what needs the person. mode: "list" or "board".
let openId = null, sel = null, filter = "", live = true, token = "", view = "all", inbox = false, mode = "list";
let collapsed = new Set(["done", "cancelled"]);
try {
  const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
  if (p.mode === "board") mode = "board";
  if (Array.isArray(p.collapsed)) collapsed = new Set(p.collapsed.filter((s) => typeof s === "string"));
} catch {}
function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify({ mode, collapsed: [...collapsed] })); } catch {} }
const byKey = (k) => tasks.find((t) => t.k === k);
const inView = () => tasks.filter((t) => (view === "all" || t.project === view) && (!inbox || YOURS(t)));
const pending = new Map(); // key -> { kind, ids, until, timer }: waiting out the undo window
const busy = new Map();    // key -> { kind, text }: request sent, waiting for the answer
const results = new Map(); // key -> { cls, text, at }
const prs = new Map();     // task key -> { at, body } | { at, loading: true }
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

// Icons: inline SVG built here, outline, one stroke weight.
const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const PATHS = {
  search: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM14.5 14.5l-3.6-3.6",
  list: "M2 4h12M2 8h12M2 12h12",
  board: "M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v9h-3z",
  chev: "M4 6l4 4 4-4",
  close: "M4 4l8 8M12 4l-8 8",
  up: "M4 10l4-4 4 4",
  down: "M4 6l4 4 4-4",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  inbox: "M2 9.5l1.6-6h8.8l1.6 6v3.5H2zM2 9.5h3.5l1 1.5h3l1-1.5H14",
  tasks: "M3 4.5h1M6.5 4.5H13M3 8h1M6.5 8H13M3 11.5h1M6.5 11.5H13",
  folder: "M2 4.5v8h12v-6.5H7.5L6 4.5z",
  layers: "M8 2.5l5.5 3L8 8.5l-5.5-3zM2.5 8.5L8 11.5l5.5-3",
  external: "M9.5 2.5h4v4M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4H6.5",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  check: "M3.5 8.5l3 3 6-7",
  undo: "M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7",
  key: "M2 5.5h12v6H2zM4.5 8.5h7",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
};
function icon(name, cls) {
  const s = svgEl("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" });
  if (cls) s.setAttribute("class", cls);
  s.append(svgEl("path", { d: PATHS[name] }));
  return s;
}
// One glyph per status: a dashed ring (draft), a ring filling up as the work moves (ready to
// verifying), the same in amber when it waits for the person, a check when approved or done.
const FILL = { claimed: 0.25, in_progress: 0.5, in_review: 0.75, verifying: 0.75, needs_approval: 0.75 };
function statusIcon(s) {
  const g = svgEl("svg", { viewBox: "0 0 14 14", class: "si si-" + s, "aria-hidden": "true" });
  if (s === "approved" || s === "done" || s === "cancelled") {
    g.append(svgEl("circle", { cx: "7", cy: "7", r: "7", class: "disc" }));
    g.append(svgEl("path", { class: "glyph", d: s === "cancelled" ? "M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" : "M4.2 7.3l1.9 1.9 3.8-4" }));
    return g;
  }
  const ring = svgEl("circle", { cx: "7", cy: "7", r: "6", class: "ring" });
  if (s === "draft") ring.setAttribute("stroke-dasharray", "1.6 1.9");
  g.append(ring);
  const f = FILL[s];
  if (f) {
    const c = 2 * Math.PI * 2.5;
    g.append(svgEl("circle", { cx: "7", cy: "7", r: "2.5", class: "pie", "stroke-width": "5",
      "stroke-dasharray": (f * c).toFixed(2) + " " + c.toFixed(2), transform: "rotate(-90 7 7)" }));
  }
  return g;
}
function avatar(name) {
  const a = el("span", "avatar" + (name ? "" : " none"), name ? name.replace(/^[^a-z0-9]+/i, "").charAt(0) || "?" : "");
  a.title = name ? name : "Unassigned";
  return a;
}
function kbds(keys) {
  const f = document.createDocumentFragment();
  for (const k of keys.split(" ")) f.append(el("kbd", "", k === "Mod" ? MOD : k));
  return f;
}

// The token: from the fragment (#t=...) into this tab's sessionStorage, then off the address bar.
(function takeToken() {
  const m = /^#t=([^&]*)(?:&(.*))?$/.exec(location.hash);
  if (m) {
    token = /^[0-9a-f]{64}$/.test(m[1]) ? m[1] : "";
    try { if (token) sessionStorage.setItem(KEY, token); } catch {}
    history.replaceState(null, "", location.pathname + location.search + (m[2] ? "#" + m[2] : ""));
  } else {
    try { token = sessionStorage.getItem(KEY) || ""; } catch {}
  }
})();
function forgetToken() { token = ""; try { sessionStorage.removeItem(KEY); } catch {} }
const canAct = () => S.canApprove && token !== "";
function notice() {
  const n = $("#notice");
  if (!S.canApprove) n.textContent = "Read-only: fm serve wasn't started by a person at a terminal, so approving and merging here are off.";
  else if (!token) n.textContent = "To approve and merge here, open the link fm serve printed in its terminal.";
  n.hidden = canAct();
}

async function get(path) {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || r.statusText);
  return r.json();
}
// A merge is running (the server answers 409 busy): show "merge in progress…" and retry
// the click every few seconds rather than failing it.
async function post(path, key) {
  let r, body;
  for (let tries = 0; ; tries++) {
    try { r = await fetch(path, { method: "POST", headers: { "x-foreman-token": token } }); }
    catch (e) { return { ok: false, body: { message: "couldn't reach the board: " + (e && e.message ? e.message : e) } }; }
    body = await r.json().catch(() => ({}));
    if (r.status === 409 && body.error === "busy" && tries < 90) {
      if (key && busy.has(key)) { busy.set(key, { ...busy.get(key), text: "Merge in progress… waiting for it to finish, then this one goes" }); render(); }
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    break;
  }
  if (r.status === 403 && /token/.test(body.message || "")) { forgetToken(); notice(); }
  return { ok: r.ok, body };
}
const proj = (name) => "/api/p/" + encodeURIComponent(name);
const taskPath = (t, what) => proj(t.project) + "/tasks/" + encodeURIComponent(t.id) + "/" + what;
// #p=<project>&<task id>: either part may be missing. (The token's #t=... is taken off first.)
function hashFor(t) { return "#" + (multi ? "p=" + encodeURIComponent(t.project) + "&" : "") + t.id; }
function parseHash(h) {
  let project = null, id = null;
  for (const part of h.replace(/^#/, "").split("&")) {
    if (part.startsWith("p=")) { try { project = decodeURIComponent(part.slice(2)); } catch {} }
    else if (/^[A-Za-z0-9_-]+$/.test(part)) id = part;
  }
  return { project, id };
}
function setHash(h) { if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h); }
const scopeHash = () => (view === "all" || !multi ? "" : "#p=" + encodeURIComponent(view));

// Approve, merge and run queue all wait out the same undo window before anything is sent.
function schedule(key, kind, ids) {
  if (!canAct() || pending.has(key) || busy.has(key)) return;
  results.delete(key);
  const until = Date.now() + UNDO_MS;
  pending.set(key, { kind, ids, until, timer: setTimeout(() => fire(key), UNDO_MS) });
  render();
}
function undo(key) {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  render();
}
function undoLast() {
  const last = [...pending.entries()].sort((a, b) => b[1].until - a[1].until)[0];
  if (last) undo(last[0]);
}
const label = (t) => (multi ? t.project + " " : "") + t.id;
async function fire(key) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  busy.set(key, { kind: p.kind, text: p.kind === "approve" ? "Approving…" : p.kind === "merge" ? "Merging: waiting for checks to settle, then merging…" : "Running the queue: one pass, at most one merge…" });
  render();
  let out;
  if (p.kind === "approve") {
    const bad = [];
    for (const k of p.ids) {
      const t = byKey(k);
      if (!t) continue;
      const r = await post(taskPath(t, "approve"), key);
      if (!r.ok) bad.push(label(t) + ": " + (r.body.message || "refused"));
    }
    out = bad.length ? { cls: "bad", text: bad.join("; ") } : { cls: "ok", text: p.ids.length > 1 ? "Approved " + p.ids.length + " tasks." : "Approved." };
  } else if (p.kind === "merge") {
    const t = byKey(p.ids[0]);
    const r = t ? await post(taskPath(t, "merge"), key) : { ok: true, body: { entry: null } };
    out = r.ok ? entryOut(r.body.entry) : { cls: "bad", text: r.body.message || "refused" };
  } else {
    // Each project's queue in turn, so merges in one repo never overlap and never touch another.
    const names = [...new Set(p.ids.map((k) => (byKey(k) || {}).project).filter((n) => n !== undefined))];
    const lines = [];
    let bad = false;
    for (const n of names) {
      const r = await post(proj(n) + "/queue/run", key);
      if (!r.ok) { bad = true; lines.push((multi ? n + ": " : "") + (r.body.message || "refused")); continue; }
      for (const e of r.body.entries) lines.push((multi ? n + " " : "") + e.id + " " + e.action.replace(/_/g, " ") + ": " + e.reason);
    }
    out = { cls: bad ? "bad" : "ok", text: lines.length ? lines.join("\\n") : "Nothing approved." };
  }
  busy.delete(key);
  results.set(key, { ...out, at: Date.now() });
  const one = p.kind !== "queue" && p.ids.length === 1 ? byKey(p.ids[0]) : null;
  toast({ cls: out.cls, text: (one ? label(one) + ": " : "") + out.text });
  prs.clear();
  await refresh().catch(() => render());
}
function entryOut(e) {
  if (!e) return { cls: "skip", text: "Skipped: no longer approved." };
  if (e.action === "merged") return { cls: "ok", text: "Merged. " + e.reason };
  if (e.action === "sent_back") return { cls: "skip", text: "Sent back: " + e.reason };
  if (e.action === "skipped") return { cls: "skip", text: "Skipped: " + e.reason };
  return { cls: "bad", text: "Error: " + e.reason };
}

// Toasts: what an approve, merge or queue pass came back with, and short confirmations.
function toast(out) {
  const box = $("#toasts");
  const t = el("div", "toast");
  const close = el("button", "icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.append(icon("close"));
  close.addEventListener("click", () => t.remove());
  t.append(el("div", "out " + out.cls, out.text), close);
  box.append(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.remove(), out.cls === "ok" ? 6000 : 14000);
}

// The PR state shown for approved tasks, read through the board (which caches it).
function prLine(t) {
  const p = prs.get(t.k);
  if (!p || (!p.loading && Date.now() - p.at > 15000)) {
    prs.set(t.k, { at: Date.now(), loading: true });
    get(taskPath(t, "pr")).then((body) => { prs.set(t.k, { at: Date.now(), body }); render(); },
      () => { prs.set(t.k, { at: Date.now(), body: { readable: false, reason: "couldn't read the PR" } }); render(); });
  }
  const b = p && p.body;
  if (!b) return el("span", "prs", "Reading the PR…");
  if (!b.readable) { const s = el("span", "prs red", b.reason); s.title = b.reason; return s; }
  let cls = b.checks.kind, text;
  if (b.mergeable === "CONFLICTING") { cls = "red"; text = "Conflicts with main"; }
  else if (!b.atVerified) { cls = "red"; text = "Moved since verified"; }
  else if (b.checks.kind === "green") text = b.mergeable === "MERGEABLE" ? "Checks green" : "Checks green, " + b.mergeable.toLowerCase();
  else if (b.checks.kind === "pending") text = "Checks pending";
  else text = "Checks red";
  const s = el("span", "prs " + cls, text);
  if (b.checks.reason) s.title = b.checks.reason;
  return s;
}

// The one next action for a task: its button, the undo window, or the request in flight.
// compact (rows and cards) leaves out the waiting text and the result, which go to the panel and a toast.
function actionArea(t, compact) {
  const box = el("div", "act");
  const key = t.k, laneKey = t.status === "needs_approval" ? "lane:approve" : null;
  const p = pending.get(key) || (laneKey && pending.get(laneKey) && pending.get(laneKey).ids.includes(t.k) ? pending.get(laneKey) : null);
  const a = nextAction(t, canAct(), !S.canApprove);
  if (compact && t.status === "approved" && prNumber(t.pr)) box.append(prLine(t));
  if (p) box.append(undoBar(pending.get(key) ? key : laneKey, p));
  else if (busy.has(key)) { const b = busy.get(key); box.append(el("span", "busy", compact ? (b.kind === "approve" ? "Approving…" : "Merging…") : b.text)); }
  else if (a.kind === "approve" || a.kind === "merge") {
    // Merge is the strong button only when the PR looks mergeable; otherwise it reads as a try.
    const pb = prs.get(t.k) && prs.get(t.k).body;
    const strong = a.kind === "approve" || (pb && pb.readable && pb.atVerified && pb.checks.kind === "green" && pb.mergeable === "MERGEABLE");
    const b = el("button", "btn " + (strong ? a.kind : "quiet"), a.label);
    b.type = "button";
    b.dataset.kbd = a.kind === "approve" ? "a" : "m";
    if (!compact) b.append(el("kbd", "", b.dataset.kbd));
    if (a.disabled) { b.disabled = true; b.title = "Off: " + a.disabled; }
    b.addEventListener("click", (e) => { e.stopPropagation(); schedule(key, a.kind, [t.k]); });
    box.append(b);
    if (a.disabled && !compact) box.append(el("span", "why", a.disabled));
  } else if (a.kind === "wait" && !compact) box.append(el("span", "wait", a.label));
  const r = results.get(key);
  if (r && !compact) box.append(el("div", "out " + r.cls, r.text));
  return box.childNodes.length ? box : null;
}
function undoBar(key, p) {
  const bar = el("div", "undo");
  const fill = el("div", "fill");
  // Negative delay: a re-render picks the drain up where it was.
  fill.style.animationDuration = UNDO_MS + "ms";
  fill.style.animationDelay = -(UNDO_MS - Math.max(0, p.until - Date.now())) + "ms";
  const what = p.kind === "approve" ? (p.ids.length > 1 ? "Approving " + p.ids.length : "Approving")
    : p.kind === "merge" ? "Merging " + (prNumber((byKey(p.ids[0]) || {}).pr) || (byKey(p.ids[0]) || { id: p.ids[0] }).id) : "Running the queue";
  const b = el("button", "", "Undo");
  b.type = "button";
  b.title = "Undo (u)";
  b.addEventListener("click", (e) => { e.stopPropagation(); undo(key); });
  const left = el("span", "", "");
  left.dataset.what = what;
  left.dataset.until = String(p.until);
  tick(left);
  bar.append(fill, left, b);
  return bar;
}
function tick(s) { s.textContent = s.dataset.what + " in " + Math.max(1, Math.ceil((Number(s.dataset.until) - Date.now()) / 1000)) + " s"; }
setInterval(() => { for (const s of document.querySelectorAll(".undo span[data-until]")) tick(s); }, 250);

function matches(t) {
  if (!filter) return true;
  const hay = (t.project + " " + t.id + " " + t.title + " " + (t.assignee || "") + " " + NAMES[t.status] + " " + t.risk + " " + prNumber(t.pr)).toLowerCase();
  return filter.toLowerCase().split(/\\s+/).every((w) => hay.includes(w));
}
function visible() { return inView().filter(matches); }
// The order j and k walk: the list's groups (open ones only), or the board's columns.
function order() {
  const v = visible();
  if (mode === "board") return S.lanes.flatMap((l) => v.filter((t) => t.status === l));
  return LIST_ORDER.filter((l) => !collapsed.has(l)).flatMap((l) => v.filter((t) => t.status === l));
}
const node = (k) => document.querySelector('#content [data-id="' + CSS.escape(k) + '"]');

function when(t, now) {
  const w = el("span", "ago", ago(t.updatedAt, now));
  w.title = new Date(t.updatedAt).toLocaleString();
  return w;
}
function prLink(t) {
  const n = prNumber(t.pr);
  if (!n) return null;
  const a = el("a", "pr", n);
  a.href = t.pr; a.rel = "noopener noreferrer"; a.target = "_blank";
  a.title = "Open " + n + " on GitHub (p)";
  a.addEventListener("click", (e) => e.stopPropagation());
  return a;
}
function liveDot() { const d = el("span", "live-dot"); d.title = "A session is running"; return d; }
function bindItem(n, t) {
  n.dataset.id = t.k;
  n.tabIndex = sel === t.k ? 0 : -1;
  n.setAttribute("aria-label", t.id + " " + t.title + ", " + NAMES[t.status]);
  n.addEventListener("click", (e) => { if (e.target.closest("button, a")) return; select(t.k, false); openTask(t.k); });
  n.addEventListener("focus", () => { if (sel !== t.k) { sel = t.k; markSel(); } });
}
function row(t, now) {
  const r = el("div", "row" + (sel === t.k ? " sel" : ""));
  bindItem(r, t);
  const main = el("div", "main-line");
  const title = el("span", "title", t.title);
  title.title = t.title;
  const sub = el("div", "sub");
  sub.append(el("span", "", t.id));
  if (multi && view === "all") sub.append(el("span", "", t.project));
  if (t.risk !== "auto") sub.append(el("span", "tag " + t.risk, t.risk));
  if (t.assignee) sub.append(el("span", "", t.assignee));
  sub.append(when(t, now));
  main.append(title, sub);
  const side = el("div", "side");
  if (t.live) side.append(liveDot());
  if (multi && view === "all") side.append(el("span", "proj", t.project));
  if (t.risk !== "auto") side.append(el("span", "tag " + t.risk, t.risk));
  const act = actionArea(t, true);
  if (act) side.append(act);
  // An approved task's Merge button already names its PR.
  const pr = t.status === "approved" && act ? null : prLink(t);
  if (pr) side.append(pr);
  side.append(avatar(t.assignee), when(t, now));
  r.append(statusIcon(t.status), el("span", "id", t.id), main, side);
  return r;
}
function card(t, now) {
  const c = el("article", "card" + (sel === t.k ? " sel" : ""));
  bindItem(c, t);
  const top = el("div", "card-top");
  top.append(el("span", "id", t.id));
  if (multi && view === "all") top.append(el("span", "proj", t.project));
  top.append(when(t, now));
  const meta = el("div", "card-meta");
  if (t.risk !== "auto") meta.append(el("span", "tag " + t.risk, t.risk));
  const pr = prLink(t);
  if (pr) meta.append(pr);
  if (t.live) meta.append(liveDot());
  if (t.assignee) meta.append(avatar(t.assignee));
  c.append(top, el("div", "card-title", t.title));
  if (meta.childNodes.length) c.append(meta);
  const act = actionArea(t, true);
  if (act) c.append(act);
  return c;
}
function markSel() {
  for (const c of document.querySelectorAll("#content .row, #content .card")) {
    const on = c.dataset.id === sel;
    c.classList.toggle("sel", on);
    c.tabIndex = on ? 0 : -1;
  }
}
function select(k, focus) {
  sel = k;
  markSel();
  const n = k && node(k);
  if (n && focus) { n.focus({ preventScroll: true }); n.scrollIntoView({ block: "nearest", inline: "nearest" }); }
}

// The group buttons: Approve all and Run queue (both wait out the undo window too).
function laneButton(key, kind, label, ids) {
  const b = el("button", "btn quiet", label);
  b.type = "button";
  b.disabled = !canAct() || pending.has(key) || busy.has(key);
  if (!canAct()) b.title = S.canApprove ? "open the link fm serve printed" : "read-only board";
  b.addEventListener("click", (e) => { e.stopPropagation(); schedule(key, kind, ids); });
  return b;
}
function groupActions(lane, ts) {
  const out = [];
  if (lane === "needs_approval" && ts.length > 1) out.push(laneButton("lane:approve", "approve", "Approve all " + ts.length, ts.map((t) => t.k)));
  if (lane === "approved" && ts.length) out.push(laneButton("queue", "queue", "Run queue", ts.map((t) => t.k)));
  return out;
}
function queueOut(cls) {
  const p = pending.get("queue"), r = results.get("queue");
  if (!p && !busy.has("queue") && !r) return null;
  const o = el("div", cls);
  if (p) o.append(undoBar("queue", p));
  else if (busy.has("queue")) o.append(el("div", "busy", busy.get("queue").text));
  if (r) o.append(el("div", "out " + r.cls, r.text));
  return o;
}

function renderList(box, shown, now) {
  const wrap = el("div", "list");
  for (const lane of LIST_ORDER) {
    const ts = shown.filter((t) => t.status === lane);
    // Empty groups are left out, except the two that wait for the person in Needs you.
    if (!ts.length && !(inbox && EMPTY[lane] && !filter)) continue;
    const closed = collapsed.has(lane);
    const g = el("section", "group" + (closed ? " closed" : ""));
    g.dataset.lane = lane;
    g.setAttribute("aria-label", NAMES[lane]);
    const head = el("div", "group-head");
    const tog = el("button", "group-toggle");
    tog.type = "button";
    tog.setAttribute("aria-expanded", String(!closed));
    tog.title = (closed ? "Show " : "Hide ") + NAMES[lane];
    tog.append(icon("chev", "chev"), statusIcon(lane), el("h2", "group-name", NAMES[lane]), el("span", "group-count", ts.length));
    tog.addEventListener("click", () => toggleGroup(lane));
    const acts = el("div", "group-act");
    acts.append(...groupActions(lane, ts));
    head.append(tog, acts);
    g.append(head);
    if (lane === "approved") { const o = queueOut("group-out"); if (o) g.append(o); }
    if (!closed) {
      if (!ts.length) g.append(el("div", "group-note", EMPTY[lane]));
      for (const t of ts) g.append(row(t, now));
    }
    wrap.append(g);
  }
  box.append(wrap);
}
function toggleGroup(lane) {
  if (collapsed.has(lane)) collapsed.delete(lane); else collapsed.add(lane);
  savePrefs();
  render();
}
function renderBoard(box, shown, now, scroll) {
  const wrap = el("div", "board");
  for (const lane of S.lanes) {
    const ts = shown.filter((t) => t.status === lane);
    const sec = el("section", "lane" + (ts.length ? "" : " empty"));
    sec.dataset.lane = lane;
    sec.setAttribute("aria-label", NAMES[lane]);
    const head = el("div", "lane-head");
    head.append(statusIcon(lane), el("h2", "", NAMES[lane]), el("span", "n", ts.length), ...groupActions(lane, ts));
    sec.append(head);
    if (lane === "approved") { const o = queueOut("lane-out"); if (o) sec.append(o); }
    if (!ts.length) sec.append(el("div", "lane-note", EMPTY[lane] || "Empty"));
    const list = el("div", "cards");
    for (const t of ts) list.append(card(t, now));
    sec.append(list);
    wrap.append(sec);
  }
  box.append(wrap);
  for (const l of wrap.querySelectorAll(".lane")) l.querySelector(".cards").scrollTop = scroll.lanes.get(l.dataset.lane) || 0;
  wrap.scrollLeft = scroll.x;
  // First paint of the board: bring the columns that wait for the person into view.
  if (!renderBoard.done) {
    renderBoard.done = true;
    const lane = wrap.querySelector('.lane[data-lane="needs_approval"]:not(.empty)') || wrap.querySelector('.lane[data-lane="approved"]:not(.empty)');
    if (lane && innerWidth > 768 && lane.getBoundingClientRect().right > innerWidth) wrap.scrollLeft = lane.offsetLeft - 12;
  }
}

function render() {
  const box = $("#content"), now = Date.now();
  const a = document.activeElement;
  const focused = a && box.contains(a) && a.dataset && a.dataset.id ? a.dataset.id : null;
  const b = box.querySelector(".board");
  const scroll = { top: box.scrollTop, x: b ? b.scrollLeft : 0, lanes: new Map([...box.querySelectorAll(".lane")].map((l) => [l.dataset.lane, l.querySelector(".cards").scrollTop])) };
  box.replaceChildren();
  const mine = inView(), shown = visible();
  nav();
  if (!shown.length && !(inbox && !filter)) {
    const e = el("div", "blank");
    if (filter) e.append(el("h2", "", "Nothing matches “" + filter + "”"), el("p", "", "Press Esc to clear the filter."));
    else if (!tasks.length) {
      e.append(el("h2", "", "No tasks yet"), el("p", "", "Add one from the terminal, and it shows up here."));
      const p = el("p"); p.append(el("code", "", 'fm add "What to build" --check "cmd: bun test" --ready')); e.append(p);
    } else e.append(el("h2", "", "No tasks in " + view), el("p", "", "Press g a for every project."));
    box.append(e);
  } else if (mode === "board") renderBoard(box, shown, now, scroll);
  else renderList(box, shown, now);
  box.scrollTop = scroll.top;
  $("#total").textContent = filter ? shown.length + " of " + mine.length : String(mine.length);
  if (focused) { const c = node(focused); if (c) c.focus({ preventScroll: true }); }
  if (openId) { const t = byKey(openId); const slot = $("#detail-act"); if (t && slot) slot.replaceChildren(...[actionArea(t, false)].filter(Boolean)); }
}

// The sidebar: the two views, then each project, each with what waits for the person there.
function nav() {
  const scoped = tasks.filter((t) => view === "all" || t.project === view);
  const yours = scoped.filter(YOURS).length;
  const mkView = (isInbox, name, ic, n, attn) => {
    const b = el("button", "nav-item" + (inbox === isInbox ? " on" : ""));
    b.type = "button";
    b.setAttribute("aria-current", inbox === isInbox ? "page" : "false");
    b.append(icon(ic), el("span", "name", name));
    if (n) b.append(el("span", "count" + (attn ? " attn" : ""), n));
    b.title = name + " (g " + (isInbox ? "n" : "a") + ")";
    b.addEventListener("click", () => setInbox(isInbox));
    return b;
  };
  $("#views").replaceChildren(mkView(true, "Needs you", "inbox", yours, true), mkView(false, "All tasks", "tasks", scoped.length, false));
  $("#scope").textContent = multi ? (view === "all" ? "" : view + " / ") : (PROJECTS[0] ? PROJECTS[0] + " / " : "");
  $("#title-text").textContent = inbox ? "Needs you" : "All tasks";
  document.title = (yours ? "(" + yours + ") " : "") + (inbox ? "Needs you" : "All tasks") + " · foreman";
  for (const s of document.querySelectorAll(".seg button")) {
    const on = s.dataset.mode === mode;
    s.classList.toggle("on", on);
    s.setAttribute("aria-pressed", String(on));
  }
  const box = $("#projects");
  box.hidden = !multi;
  if (!multi) return;
  const mk = (value, name) => {
    const ts = value === "all" ? tasks : tasks.filter((t) => t.project === value);
    const n = ts.filter(YOURS).length;
    const b = el("button", "nav-item" + (view === value ? " on" : ""));
    b.type = "button";
    b.dataset.project = value;
    b.setAttribute("aria-pressed", String(view === value));
    b.append(icon(value === "all" ? "layers" : "folder"), el("span", "name", name));
    const i = PROJECTS.indexOf(value);
    b.title = value === "all" ? "Every project" : name + (i < 9 ? " (g " + (i + 1) + ")" : "");
    if (n) { const c = el("span", "count attn", n); c.title = n + " waiting for you"; b.append(c); }
    b.addEventListener("click", () => setView(value));
    return b;
  };
  box.replaceChildren(el("h2", "nav-label", "Projects"), mk("all", "All projects"), ...PROJECTS.map((n) => mk(n, n)));
}
function setView(value) {
  view = value;
  setHash(openId ? location.hash : scopeHash());
  sideNav(false);
  render();
}
function setInbox(on) {
  inbox = on;
  sideNav(false);
  render();
}
function setMode(m) {
  mode = m;
  savePrefs();
  render();
  if (sel) select(sel, true);
}
function sideNav(open) {
  $(".app").classList.toggle("nav-open", open);
  $("#menu").setAttribute("aria-expanded", String(open));
  syncScrim();
}
function syncScrim() {
  $("#scrim").hidden = !(palOpen || !$("#help").hidden || $(".app").classList.contains("nav-open"));
}

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}
function summary(e) {
  const d = e.data || {};
  const parts = [];
  for (const k of ["note", "reason", "pr", "summary", "branch"]) if (d[k]) parts.push(k + ": " + d[k]);
  if (d.attach) parts.push("session " + (d.name || d.session) + ": " + d.attach);
  if (Array.isArray(d.results)) parts.push(d.results.map((r) => r.check + (r.pass ? " pass" : " fail")).join(", "));
  return parts.join("\\n");
}
function prop(dl, name, ...value) {
  const dd = el("dd");
  dd.append(...value.filter(Boolean));
  dl.append(el("dt", "", name), dd);
}
function panelBar(k, status) {
  const bar = el("div", "panel-bar");
  const crumb = el("div", "crumb");
  if (multi) crumb.append(el("span", "", k.project), el("span", "sep", "/"));
  crumb.append(statusIcon(status), el("span", "id", k.id));
  const btn = (ic, lbl, fn) => { const b = el("button", "icon-btn"); b.type = "button"; b.setAttribute("aria-label", lbl); b.title = lbl; b.append(icon(ic)); b.addEventListener("click", fn); return b; };
  bar.append(crumb, btn("up", "Previous task (k)", () => move(-1)), btn("down", "Next task (j)", () => move(1)), btn("close", "Close (Esc)", closeTask));
  return bar;
}
let liveTimer = 0;
async function openTask(id) {
  openId = id;
  const k = byKey(id);
  if (!k) return;
  setHash(hashFor(k));
  const p = $("#detail");
  // Show what the list already knows at once; the rest fills in when the request answers.
  if (p.hidden || p.dataset.id !== id) {
    p.dataset.id = id;
    const body = el("div", "panel-body");
    body.append(el("h2", "panel-title", k.title), el("p", "wait", "Loading…"));
    p.replaceChildren(panelBar(k, k.status), body);
    p.hidden = false;
  }
  let d;
  try { d = await get(proj(k.project) + "/tasks/" + encodeURIComponent(k.id)); }
  catch (e) {
    if (openId !== id) return;
    const body = el("div", "panel-body");
    const retry = el("button", "btn quiet", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => openTask(id));
    body.append(el("h2", "panel-title", k.title), el("p", "out bad", "Couldn't load " + k.id + ": " + (e && e.message ? e.message : e)), retry);
    p.replaceChildren(panelBar(k, k.status), body);
    return;
  }
  if (openId !== id) return;
  const t = d.task;
  const old = p.querySelector(".panel-body");
  const keepScroll = old ? old.scrollTop : 0;
  const body = el("div", "panel-body");
  body.append(el("h2", "panel-title", t.title));
  const dl = el("dl", "props");
  prop(dl, "Status", statusIcon(t.status), el("span", "", NAMES[t.status]));
  prop(dl, "Risk", el("span", "tag " + t.risk, t.risk));
  prop(dl, "Assignee", avatar(t.assignee), el("span", "", t.assignee || "Unassigned"));
  if (t.branch) prop(dl, "Branch", el("span", "mono", t.branch));
  const u = t.pr && safeUrl(t.pr);
  if (u) {
    const a = el("a", "", prNumber(t.pr) || t.pr); a.href = u; a.rel = "noopener noreferrer"; a.target = "_blank";
    prop(dl, "Pull request", a, t.status === "approved" && prNumber(t.pr) ? prLine(k) : null);
  } else if (t.pr) prop(dl, "Pull request", el("span", "", t.pr));
  const upd = el("span", "", ago(t.updatedAt, Date.now()));
  upd.title = new Date(t.updatedAt).toLocaleString();
  prop(dl, "Updated", upd);
  if (multi) prop(dl, "Project", el("span", "", k.project));
  body.append(dl);
  const slot = el("div", "detail-act");
  slot.id = "detail-act";
  const act = actionArea({ ...k, status: t.status, pr: t.pr, assignee: t.assignee }, false);
  if (act) slot.append(act);
  body.append(slot);
  if (t.spec) {
    const s = el("section", "section");
    s.append(el("h3", "", "Spec"), el("div", "spec", t.spec));
    body.append(s);
  }
  const cs = el("section", "section");
  const passed = d.checks.filter((c) => c.verdict && c.verdict.pass).length;
  const h = el("h3", "", "Acceptance checks");
  h.append(el("span", "n", passed + " of " + d.checks.length + " pass"));
  cs.append(h);
  const ul = el("ul", "checks");
  for (const c of d.checks) {
    const v = c.verdict;
    const li = el("li", "check");
    const mark = svgEl("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round",
      class: "v " + (v ? (v.pass ? "pass" : "fail") : "pending"), "aria-label": v ? (v.pass ? "pass" : "fail") : "no verdict yet", role: "img" });
    mark.append(svgEl(v ? "path" : "circle", v ? { d: v.pass ? PATHS.check : PATHS.close } : { cx: "8", cy: "8", r: "5.5", "stroke-dasharray": "2 2" }));
    const cb = el("div", "check-body");
    const text = el("div", "check-text");
    if (c.kind === "cmd") text.append(el("code", "", c.text)); else text.textContent = c.text;
    cb.append(text);
    if (v) cb.append(el("div", "ev", v.evidence + "\\n" + v.by + ", " + new Date(v.at).toLocaleString()));
    li.append(mark, cb);
    ul.append(li);
  }
  cs.append(ul);
  body.append(cs);
  let anyLive = false;
  for (const s of d.sessions || []) {
    if (s.live) anyLive = true;
    const sec = el("section", "section");
    const sh = el("h3", "", s.role.charAt(0).toUpperCase() + s.role.slice(1) + " session");
    if (s.live) sh.append(liveDot());
    sh.append(el("span", "n", s.turns + " turns · $" + s.costUsd.toFixed(2)));
    sec.append(sh, el("pre", "log", s.lines.length ? s.lines.map((l) => (l.kind === "result" ? "  → " : l.kind === "tool" ? "› " : "# ") + l.text).join("\\n") : "No activity yet."));
    body.append(sec);
  }
  clearTimeout(liveTimer);
  if (anyLive) liveTimer = setTimeout(() => { if (openId === id) openTask(id); }, 3000);
  const hs = el("section", "section");
  hs.append(el("h3", "", "Activity"));
  const hl = el("ul", "timeline");
  for (const e of d.events.slice().reverse()) {
    const li = el("li", e.type === "verify_failed" ? "fail" : e.type === "verified" || e.type === "approved" || e.type === "merged" ? "pass" : "");
    const tm = el("time", "", ago(e.at, Date.now()));
    tm.title = new Date(e.at).toLocaleString();
    li.append(el("b", "", e.type.replace(/_/g, " ")), document.createTextNode(" by " + e.actor + (e.actorKind === "agent" ? " (agent)" : "")), tm);
    const s = summary(e);
    if (s) li.append(el("div", "ev", s));
    hl.append(li);
  }
  hs.append(hl);
  body.append(hs);
  p.replaceChildren(panelBar(k, t.status), body);
  body.scrollTop = keepScroll;
}
function closeTask() {
  clearTimeout(liveTimer);
  openId = null;
  const p = $("#detail");
  p.hidden = true;
  p.dataset.id = "";
  setHash(scopeHash());
  if (sel) select(sel, true);
}

// The ? dialog, drawn from SHORTCUTS.
function help(show) {
  $("#help").hidden = !show;
  syncScrim();
  if (show) { const b = $("#help .help-body"); b.scrollTop = 0; b.focus({ preventScroll: true }); }
  else if (sel) select(sel, true);
}
(function drawHelp() {
  const box = $("#help-keys");
  let group = null, dl = null;
  for (const [keys, what, g] of SHORTCUTS) {
    if (g !== group) { group = g; box.append(el("h3", "", g)); dl = el("dl", "keys"); box.append(dl); }
    const item = el("div");
    const dt = el("dt");
    keys.split(" / ").forEach((alt, i) => { if (i) dt.append(el("span", "why", "or")); dt.append(kbds(alt)); });
    item.append(dt, el("dd", "", what.charAt(0).toUpperCase() + what.slice(1)));
    dl.append(item);
  }
})();

// The command palette: every action, view and task, found by typing.
let palOpen = false, palIdx = 0, palItems = [];
function current() { return byKey(openId || sel); }
function commands(q) {
  const t = current(), out = [];
  const off = canAct() ? null : S.canApprove ? "open the link fm serve printed" : "read-only board";
  if (t) {
    const a = nextAction(t, canAct(), !S.canApprove);
    if (a.kind === "approve") out.push({ group: "This task", label: "Approve " + label(t), keys: "a", icon: "check", off: a.disabled, run: () => schedule(t.k, "approve", [t.k]) });
    if (a.kind === "merge") out.push({ group: "This task", label: a.label + " (" + label(t) + ")", keys: "m", icon: "check", off: a.disabled, run: () => schedule(t.k, "merge", [t.k]) });
    if (safeUrl(t.pr)) out.push({ group: "This task", label: "Open " + (prNumber(t.pr) || "the pull request") + " on GitHub", keys: "p", icon: "external", run: () => openPr(t) });
    out.push({ group: "This task", label: (openId ? "Close " : "Open ") + t.id, keys: openId ? "Esc" : "Enter", icon: "eye", run: () => (openId ? closeTask() : openTask(t.k)) });
    out.push({ group: "This task", label: "Copy " + t.id, icon: "copy", run: () => copy(t.id) });
  }
  if (pending.size) out.push({ group: "Sign off", label: "Undo the last approve or merge", keys: "u", icon: "undo", run: undoLast });
  const v = inView();
  const need = v.filter((x) => x.status === "needs_approval"), ok = v.filter((x) => x.status === "approved");
  if (need.length > 1) out.push({ group: "Sign off", label: "Approve all " + need.length + " waiting" + (view === "all" ? "" : " in " + view), icon: "check", off, run: () => schedule("lane:approve", "approve", need.map((x) => x.k)) });
  if (ok.length) out.push({ group: "Sign off", label: "Run the merge queue (" + ok.length + " approved)", icon: "check", off, run: () => schedule("queue", "queue", ok.map((x) => x.k)) });
  out.push({ group: "Go to", label: "Needs you", keys: "g n", icon: "inbox", run: () => setInbox(true) });
  out.push({ group: "Go to", label: "All tasks", keys: "g a", icon: "tasks", run: () => setInbox(false) });
  if (multi) {
    out.push({ group: "Go to", label: "All projects", icon: "layers", run: () => setView("all") });
    PROJECTS.forEach((n, i) => out.push({ group: "Go to", label: "Project " + n, keys: i < 9 ? "g " + (i + 1) : "", icon: "folder", run: () => setView(n) }));
  }
  out.push({ group: "View", label: mode === "list" ? "Show as board" : "Show as list", keys: "v", icon: mode === "list" ? "board" : "list", run: () => setMode(mode === "list" ? "board" : "list") });
  const fin = collapsed.has("done") && collapsed.has("cancelled");
  out.push({ group: "View", label: fin ? "Show finished tasks" : "Hide finished tasks", icon: "eye", run: () => { for (const s of ["done", "cancelled"]) { if (fin) collapsed.delete(s); else collapsed.add(s); } savePrefs(); render(); } });
  out.push({ group: "View", label: "Filter tasks", keys: "/", icon: "search", run: () => $("#filter").focus() });
  out.push({ group: "View", label: "Keyboard shortcuts", keys: "?", icon: "key", run: () => help(true) });
  const words = q.toLowerCase().split(/\\s+/).filter(Boolean);
  const hit = (s) => words.every((w) => s.toLowerCase().includes(w));
  const cmds = out.filter((c) => hit(c.group + " " + c.label));
  const found = tasks.filter((x) => hit(x.project + " " + x.id + " " + x.title + " " + NAMES[x.status]));
  const taskItems = found.slice(0, words.length ? 40 : 8).map((x) => ({
    group: "Tasks", label: x.id + "  " + x.title, status: x.status, sub: multi ? x.project : "",
    run: () => goToTask(x),
  }));
  return [...cmds, ...taskItems];
}
// Bring a task into view (leaving Needs you or a project if it isn't there), select it and open it.
function goToTask(x) {
  if (!inView().includes(x)) { inbox = false; if (view !== "all" && view !== x.project) view = "all"; }
  if (filter && !matches(x)) { filter = ""; $("#filter").value = ""; }
  if (mode === "list" && collapsed.has(x.status)) { collapsed.delete(x.status); savePrefs(); }
  render();
  select(x.k, true);
  openTask(x.k);
}
function openPr(t) { const u = safeUrl(t.pr); if (u) window.open(u, "_blank", "noopener,noreferrer"); }
function copy(text) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard")))
    .then(() => toast({ cls: "ok", text: "Copied " + text + "." }), () => toast({ cls: "bad", text: "Couldn't copy " + text + "." }));
}
function openPalette() {
  if (palOpen) return;
  palOpen = true;
  $("#help").hidden = true;
  sideNav(false);
  const t = current();
  const ctx = $("#palette-ctx");
  ctx.replaceChildren();
  if (t) { const c = el("span", "chip"); c.append(statusIcon(t.status), document.createTextNode(t.id + "  " + t.title)); ctx.append(c); }
  ctx.hidden = !t;
  $("#palette").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  palIdx = 0;
  drawPalette();
  syncScrim();
  input.focus();
}
function closePalette(refocus) {
  palOpen = false;
  $("#palette").hidden = true;
  syncScrim();
  if (document.activeElement === $("#palette-input")) $("#palette-input").blur();
  if (refocus !== false && sel) select(sel, true);
}
function drawPalette() {
  palItems = commands($("#palette-input").value.trim());
  palIdx = Math.max(0, Math.min(palIdx, palItems.length - 1));
  const list = $("#palette-list");
  list.replaceChildren();
  if (!palItems.length) { list.append(el("div", "pal-empty", "No commands or tasks match.")); return; }
  let group = null;
  palItems.forEach((c, i) => {
    if (c.group !== group) { group = c.group; list.append(el("div", "pal-group", group)); }
    const it = el("div", "pal-item" + (i === palIdx ? " on" : ""));
    it.id = "pal-" + i;
    it.setAttribute("role", "option");
    it.setAttribute("aria-selected", String(i === palIdx));
    if (c.off) { it.setAttribute("aria-disabled", "true"); it.title = "Off: " + c.off; }
    const lead = el("span", "lead");
    lead.append(c.status ? statusIcon(c.status) : icon(c.icon || "tasks"));
    const hint = el("span", "hint");
    if (c.sub) hint.append(el("span", "", c.sub));
    if (c.keys) hint.append(kbds(c.keys));
    it.append(lead, el("span", "label", c.label), hint);
    it.addEventListener("mousemove", () => { if (palIdx !== i) { palIdx = i; markPal(); } });
    it.addEventListener("click", () => runPal(i));
    list.append(it);
  });
  $("#palette-input").setAttribute("aria-activedescendant", "pal-" + palIdx);
}
function markPal() {
  for (const it of document.querySelectorAll(".pal-item")) {
    const on = it.id === "pal-" + palIdx;
    it.classList.toggle("on", on);
    it.setAttribute("aria-selected", String(on));
    if (on) it.scrollIntoView({ block: "nearest" });
  }
  $("#palette-input").setAttribute("aria-activedescendant", "pal-" + palIdx);
}
function runPal(i) {
  const c = palItems[i];
  if (!c) return;
  if (c.off) { toast({ cls: "skip", text: "Off: " + c.off + "." }); return; }
  closePalette(false);
  c.run();
  if (document.activeElement === document.body && sel && !palOpen && $("#help").hidden) select(sel, true);
}
function palKey(e) {
  if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); markPal(); }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); markPal(); }
  else if (e.key === "Enter") { e.preventDefault(); runPal(palIdx); }
}

async function refresh() {
  const all = await Promise.all(PROJECTS.map((n) => get(proj(n) + "/tasks").then((s) => [n, s])));
  tasks = [];
  for (const [n, s] of all) {
    lastEvents.set(n, Math.max(lastEvents.get(n) || 0, s.lastEvent));
    tasks.push(...tag(n, s.tasks));
    S.canApprove = s.canApprove;
  }
  render();
  if (openId) await openTask(openId);
}
async function poll() {
  try {
    const rs = await Promise.all(PROJECTS.map((n) => get(proj(n) + "/events?since=" + (lastEvents.get(n) || 0)).then((r) => [n, r])));
    setLive(true);
    let changed = false;
    for (const [n, r] of rs) if (r.events.length) { lastEvents.set(n, r.lastEvent); changed = true; }
    if (changed) await refresh();
  } catch { setLive(false); }
  setTimeout(poll, 2000);
}
function setLive(on) {
  if (on === live) return;
  live = on;
  $("#live").className = "dot" + (on ? "" : " off");
  $("#livetext").textContent = on ? "Live" : "Offline, retrying";
}

function move(step) {
  const v = order();
  if (!v.length) return;
  const i = v.findIndex((t) => t.k === sel);
  const next = v[i < 0 ? (step < 0 ? v.length - 1 : 0) : Math.min(v.length - 1, Math.max(0, i + step))];
  select(next.k, true);
  if (openId && openId !== next.k) openTask(next.k);
}
// h and l on the board: the same row in the previous or next column that has tasks.
function across(step) {
  const v = visible();
  const lanes = S.lanes.map((l) => v.filter((t) => t.status === l)).filter((ts) => ts.length);
  if (!lanes.length) return;
  let li = lanes.findIndex((ts) => ts.some((t) => t.k === sel));
  const pos = li < 0 ? 0 : lanes[li].findIndex((t) => t.k === sel);
  li = li < 0 ? 0 : Math.max(0, Math.min(lanes.length - 1, li + step));
  const t = lanes[li][Math.min(pos, lanes[li].length - 1)];
  select(t.k, true);
  if (openId && openId !== t.k) openTask(t.k);
}
function escape(typing) {
  if (!$("#help").hidden) help(false);
  else if ($(".app").classList.contains("nav-open")) sideNav(false);
  else if (openId) closeTask();
  else if (filter || typing) { $("#filter").value = ""; filter = ""; $("#filter").blur(); render(); if (sel) select(sel, true); }
  else if (sel) { sel = null; markSel(); if (document.activeElement) document.activeElement.blur(); }
}
let gAt = 0;
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (palOpen) closePalette(); else openPalette(); return; }
  if (palOpen) { palKey(e); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === "Escape") { escape(typing); return; }
  if (typing) {
    // From the filter, Enter or ↓ goes to the first match.
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); e.target.blur(); const v = order(); if (v.length) select(v[0].k, true); }
    return;
  }
  if (!$("#help").hidden && e.key !== "?") return;
  const now = Date.now();
  if (gAt && now - gAt < 1500) {
    gAt = 0;
    if (e.key === "n") setInbox(true);
    else if (e.key === "a") setInbox(false);
    else if (/^[1-9]$/.test(e.key) && multi && PROJECTS[Number(e.key) - 1] !== undefined) setView(PROJECTS[Number(e.key) - 1]);
    e.preventDefault();
    return;
  }
  gAt = 0;
  const onControl = e.target.closest && e.target.closest("button, a");
  const t = current();
  if (e.key === "/") { e.preventDefault(); $("#filter").focus(); $("#filter").select(); }
  else if (e.key === "?") help($("#help").hidden);
  else if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if ((e.key === "h" || e.key === "ArrowLeft") && mode === "board") { e.preventDefault(); across(-1); }
  else if ((e.key === "l" || e.key === "ArrowRight") && mode === "board") { e.preventDefault(); across(1); }
  else if ((e.key === "Enter" || e.key === "o") && t && !onControl && openId !== t.k) { e.preventDefault(); openTask(t.k); }
  else if (e.key === "g") gAt = now;
  else if (e.key === "v") setMode(mode === "list" ? "board" : "list");
  else if (e.key === "u") undoLast();
  else if (e.key === "p" && t) openPr(t);
  else if (e.key === "a" && t && nextAction(t, canAct(), !S.canApprove).kind === "approve") act(t, "approve");
  else if (e.key === "m" && t && nextAction(t, canAct(), !S.canApprove).kind === "merge") act(t, "merge");
});
// A key on a task that can't be acted on here says why, instead of doing nothing.
function act(t, kind) {
  const a = nextAction(t, canAct(), !S.canApprove);
  if (a.disabled) toast({ cls: "skip", text: "Can't " + kind + " here: " + a.disabled + "." });
  else schedule(t.k, kind, [t.k]);
}
$("#filter").addEventListener("input", (e) => { filter = e.target.value.trim(); render(); });
$("#help-open").addEventListener("click", () => help(true));
$("#help-close").addEventListener("click", () => help(false));
$("#cmdk").addEventListener("click", openPalette);
$("#menu").addEventListener("click", () => sideNav(!$(".app").classList.contains("nav-open")));
$("#scrim").addEventListener("click", () => { if (palOpen) closePalette(); else if (!$("#help").hidden) help(false); else sideNav(false); });
$("#palette-input").addEventListener("input", () => { palIdx = 0; drawPalette(); });
for (const b of document.querySelectorAll(".seg button")) { b.prepend(icon(b.dataset.mode)); b.addEventListener("click", () => setMode(b.dataset.mode)); }
$("#cmdk-key").replaceChildren(kbds("Mod K"));
$("#cmdk").prepend(icon("search"));
$("#menu").append(icon("menu"));
$("#filter-icon").replaceWith(icon("search"));
notice();
setTimeout(poll, 2000);
setInterval(render, 30000);
{
  const h = parseHash(location.hash);
  if (h.project && PROJECTS.includes(h.project)) view = h.project;
  render();
  if (h.id) {
    const t = tasks.find((x) => x.id === h.id && (!h.project || x.project === h.project)) || tasks.find((x) => x.id === h.id);
    if (t) goToTask(t);
  }
}
`;

/** The product mark: three bars, the work queue foreman keeps, on an ink square. */
const MARK = `<svg class="mark" viewBox="0 0 20 20" aria-hidden="true"><rect width="20" height="20" rx="5" fill="currentColor"/><path d="M5.5 7h9M5.5 10h6M5.5 13h3.5" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export function pageHtml(nonce: string, initial: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>foreman board</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div class="app">
<aside class="sidebar" aria-label="Navigation">
<div class="brand">${MARK}<span class="brand-name">foreman</span><span class="host">127.0.0.1</span></div>
<button type="button" class="cmdk" id="cmdk" aria-label="Search tasks or run a command"><span>Search…</span><span id="cmdk-key"></span></button>
<nav class="nav" id="views" aria-label="Views"></nav>
<nav class="nav" id="projects" aria-label="Projects" hidden></nav>
<div class="side-foot"><span class="live"><i id="live" class="dot"></i><span id="livetext">Live</span></span>
<button type="button" class="link" id="help-open" title="Keyboard shortcuts (?)">Shortcuts <kbd>?</kbd></button></div>
</aside>
<div class="sheet">
<header class="topbar">
<button type="button" class="icon-btn menu-btn" id="menu" aria-label="Menu" aria-expanded="false"></button>
<h1><span class="scope" id="scope"></span><span id="title-text">All tasks</span></h1>
<span class="total" id="total"></span>
<label class="filter"><span id="filter-icon"></span><input id="filter" type="search" placeholder="Filter" aria-label="Filter by project, id, title, person or status" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
<div class="seg" role="group" aria-label="Layout"><button type="button" data-mode="list" title="List (v)"><span class="label">List</span></button><button type="button" data-mode="board" title="Board (v)"><span class="label">Board</span></button></div>
</header>
<p class="notice" id="notice" hidden></p>
<main class="content" id="content"></main>
</div>
</div>
<div class="scrim" id="scrim" hidden></div>
<aside id="detail" class="panel" hidden aria-label="Task detail"></aside>
<div id="palette" class="dialog" role="dialog" aria-modal="true" aria-label="Command palette" hidden>
<input id="palette-input" class="palette-input" type="text" placeholder="Type a command or search tasks…" aria-label="Command or task" role="combobox" aria-expanded="true" aria-controls="palette-list" autocomplete="off" spellcheck="false">
<div class="palette-ctx" id="palette-ctx" hidden></div>
<div class="pal-list" id="palette-list" role="listbox"></div>
<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
</div>
<div id="help" class="dialog small" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" hidden><div class="help-body" tabindex="-1">
<h2>Keyboard shortcuts</h2><div id="help-keys"></div>
<p class="why">Approve and merge wait ${UNDO_SECONDS} seconds before they're sent, with Undo.</p>
<button type="button" class="btn quiet" id="help-close">Close</button></div></div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script type="application/json" id="initial">${scriptJson(initial)}</script>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}
