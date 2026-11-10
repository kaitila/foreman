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
import { LABEL_COLORS } from "../projects";

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
  ["Enter / o", "open the task or plan", "Move"],
  ["g n", "go to Needs you", "Go to"],
  ["g a", "go to All tasks", "Go to"],
  ["g p", "go to Plans", "Go to"],
  ["g 1", "go to the first project (2, 3 … for the others)", "Go to"],
  ["v", "switch between list and board", "Go to"],
  ["a", "approve the task", "Act"],
  ["m", "merge the task", "Act"],
  ["Shift A", "approve every waiting task in view", "Act"],
  ["Shift M", "run the merge queue for the approved tasks in view", "Act"],
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
const LABELS = ${JSON.stringify(LABEL_COLORS)};
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
// Each project's colour label (T-0089), or null.
const COLORS = new Map((S.projects || []).map((p) => [p.name, p.color || null]));
const lastEvents = new Map((S.projects || [{ name: "", lastEvent: S.lastEvent || 0 }]).map((p) => [p.name, p.lastEvent]));
const tag = (name, ts) => ts.map((t) => ({ ...t, project: name, k: name + "/" + t.id }));
let tasks = (S.projects || [{ name: "", tasks: S.tasks || [] }]).flatMap((p) => tag(p.name, p.tasks));
// Plans (D0033), read-only here. p.k is "plan:" + project/id, so it never collides with a task's key.
const PLAN_NAMES = { active: "Active", done: "Done", cancelled: "Cancelled" };
const PLAN_ORDER = ["active", "done", "cancelled"];
const STEP_NAMES = { empty: "Empty", waiting: "Waiting", in_progress: "In progress", done: "Done" };
// A step's state drawn with the task glyph it reads like: no tasks is a dashed ring, done a check.
const STEP_GLYPH = { empty: "draft", waiting: "ready", in_progress: "in_progress", done: "done" };
const tagPlans = (name, ps) => ps.map((p) => ({ ...p, project: name, k: "plan:" + name + "/" + p.id }));
let plans = (S.projects || []).flatMap((p) => tagPlans(p.name, p.plans || []));
// view: "all" or one project's name. inbox: only what needs the person. mode: "list" or "board".
// plansView: the Plans view is showing; openPlan: the plan whose steps show (its key), or null for the list.
let openId = null, sel = null, filter = "", live = true, token = "", view = "all", inbox = false, mode = "list";
let plansView = false, openPlan = null;
let collapsed = new Set(["done", "cancelled"]);
let planFolded = new Set(["done", "cancelled"]);
try {
  const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
  if (p.mode === "board") mode = "board";
  if (Array.isArray(p.collapsed)) collapsed = new Set(p.collapsed.filter((s) => typeof s === "string"));
  if (Array.isArray(p.planFolded)) planFolded = new Set(p.planFolded.filter((s) => typeof s === "string"));
} catch {}
function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify({ mode, collapsed: [...collapsed], planFolded: [...planFolded] })); } catch {} }
const byKey = (k) => tasks.find((t) => t.k === k);
const byPlan = (k) => plans.find((p) => p.k === k);
const curPlan = () => (plansView && openPlan ? byPlan(openPlan) || null : null);
// A plan's tasks in step order, as the task list knows them (a task the list hasn't seen yet gets the plan's own fields).
function planTasks(p) {
  return p.steps.flatMap((s) => s.tasks.map((x) => byKey(p.project + "/" + x.id) || { risk: "auto", updatedAt: p.updatedAt, live: false, undone: null, ...x, project: p.project, k: p.project + "/" + x.id }));
}
const plansInView = () => plans.filter((p) => view === "all" || p.project === view);
const planMatches = (p) => !filter || filter.toLowerCase().split(/\\s+/).every((w) => (p.project + " " + p.id + " " + p.title + " " + p.goal + " " + PLAN_NAMES[p.state]).toLowerCase().includes(w));
// The tasks the keys and Approve all act on: in a plan, its tasks; in the plan list, none.
const inView = () => (plansView ? (curPlan() ? planTasks(curPlan()) : [])
  : tasks.filter((t) => (view === "all" || t.project === view) && (!inbox || YOURS(t))));
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
  plans: "M2.5 4h5M5 8h5M7.5 12h6",
  back: "M10 4L6 8l4 4",
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
const RISK = { auto: "Auto", review: "Review risk", human: "Human only" };
const riskTag = (r) => { const e = el("span", "tag " + r, RISK[r] || r); e.title = "Risk: " + r; return e; };
// A project's colour label as a dot; an unlabelled project gets a hollow one where it stands alone.
function labelDot(project, hollow) {
  const c = COLORS.get(project);
  if (!c && !hollow) return null;
  const d = el("span", "label-dot " + (c ? "label-" + c : "none"));
  d.title = c ? project + ": " + c : project + ": no colour label";
  return d;
}
function projChip(project) {
  const c = el("span", "proj");
  const d = labelDot(project, false);
  if (d) c.append(d);
  c.append(document.createTextNode(project));
  return c;
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
// #plan=<id> opens that plan (#plans the list), alongside the project and task parts.
function parseHash(h) {
  let project = null, id = null, plan = null, plansList = false;
  for (const part of h.replace(/^#/, "").split("&")) {
    if (part.startsWith("p=")) { try { project = decodeURIComponent(part.slice(2)); } catch {} }
    else if (/^plan=[A-Za-z0-9_-]+$/.test(part)) plan = part.slice(5);
    else if (part === "plans") plansList = true;
    else if (/^[A-Za-z0-9_-]+$/.test(part)) id = part;
  }
  return { project, id, plan, plansList };
}
function setHash(h) { if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h); }
function scopeHash() {
  const parts = [];
  const p = curPlan();
  if (multi && (p || view !== "all")) parts.push("p=" + encodeURIComponent(p ? p.project : view));
  if (p) parts.push("plan=" + p.id);
  else if (plansView) parts.push("plans");
  return parts.length ? "#" + parts.join("&") : "";
}

// Approve, merge and run queue all wait out the same undo window before anything is sent.
// A task already waiting out an undo window or in a request (on its own or in Approve all) isn't scheduled twice.
const inFlight = (k) => [...pending.values(), ...busy.values()].some((p) => p.ids && p.ids.includes(k));
function schedule(key, kind, ids) {
  if (!canAct() || pending.has(key) || busy.has(key)) return;
  if (kind !== "queue" && ids.some(inFlight)) return;
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
  busy.set(key, { kind: p.kind, ids: p.ids, text: p.kind === "approve" ? "Approving…" : p.kind === "merge" ? (conflicting(p.ids[0]) ? "Sending back: checking the PR with GitHub…" : "Merging: waiting for checks to settle, then merging…") : "Running the queue: one pass, at most one merge…" });
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
    const entries = [], failures = [];
    for (const n of names) {
      const r = await post(proj(n) + "/queue/run", key);
      if (!r.ok) { failures.push((multi ? n + ": " : "") + (r.body.message || "refused")); continue; }
      for (const e of r.body.entries) entries.push({ k: n + "/" + e.id, project: n, id: e.id, action: e.action, reason: e.reason });
    }
    out = queueSummary(entries, failures);
  }
  busy.delete(key);
  results.set(key, { ...out, at: Date.now() });
  const one = p.kind !== "queue" && p.ids.length === 1 ? byKey(p.ids[0]) : null;
  toast({ cls: out.cls, text: (one ? label(one) + ": " : "") + out.text });
  prs.clear();
  await refresh().catch(() => render());
  // The queue's notice stays until a task it names changes (merged, sent back, approved again):
  // remember each one's status as it is now, after the pass.
  const r = results.get(key);
  if (r && r.entries) { r.snap = Object.fromEntries(r.entries.map((e) => [e.k, (byKey(e.k) || {}).status])); render(); }
}
// What a queue pass did, for its notice and its toast. A pass that merged nothing is never "ok".
const ACTION = { merged: "Merged", sent_back: "Sent back", skipped: "Skipped", error: "Error", would_merge: "Would merge", would_send_back: "Would send back" };
function queueSummary(entries, failures) {
  const of = (a) => entries.filter((e) => e.action === a);
  const merged = of("merged"), back = of("sent_back"), skipped = of("skipped"), errors = of("error");
  const parts = [merged.length ? "Merged " + merged.map((e) => label(e)).join(", ") : entries.length ? "Nothing merged" : failures.length ? "The queue didn't run" : "Nothing was approved"];
  if (back.length) parts.push(back.length + " sent back");
  if (skipped.length) parts.push(skipped.length + " skipped");
  if (errors.length + failures.length) parts.push(errors.length + failures.length + " failed");
  const cls = errors.length || failures.length ? "bad" : merged.length ? "ok" : "skip";
  return { cls, text: parts.join(" · "), entries, failures, snap: null };
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
  if (out.sticky) t.dataset.sticky = "1";
  // Keep at most four, dropping the oldest that isn't meant to stay.
  while (box.children.length > 4) (box.querySelector(".toast:not([data-sticky])") || box.firstChild).remove();
  // A sticky toast (an undone approval) stays until it is dismissed.
  if (!out.sticky) setTimeout(() => t.remove(), out.cls === "ok" ? 6000 : 14000);
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
  else if (b.mergeable === "UNKNOWN") { cls = "pending"; text = "GitHub is checking if it merges"; }
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
  else if (busy.has(key)) { const b = busy.get(key); box.append(el("span", "busy", compact ? (b.kind === "approve" ? "Approving…" : conflicting(key) ? "Sending back…" : "Merging…") : b.text)); }
  else if (a.kind === "approve" || a.kind === "merge") {
    // Merge is the strong button only when the PR looks mergeable; otherwise it reads as a try.
    const pb = prs.get(t.k) && prs.get(t.k).body;
    const strong = a.kind === "approve" || (pb && pb.readable && pb.atVerified && pb.checks.kind === "green" && pb.mergeable === "MERGEABLE");
    // A PR that conflicts isn't merged: the queue sends it back to its worker, so the button says so.
    const conflict = a.kind === "merge" && pb && pb.mergeable === "CONFLICTING";
    const b = el("button", "btn " + (strong ? a.kind : "quiet"), conflict ? "Send back " + prNumber(t.pr) : a.label);
    b.type = "button";
    if (conflict) b.title = "Conflicts with main: this sends it back to its worker to merge main, then it is verified and approved again. If GitHub says it merges cleanly by then, it merges instead.";
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
    : p.kind === "merge" ? (conflicting(p.ids[0]) ? "Sending back " : "Merging ") + (prNumber((byKey(p.ids[0]) || {}).pr) || (byKey(p.ids[0]) || { id: p.ids[0] }).id) : "Running the queue";
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
function conflicting(k) { const p = prs.get(k); return !!(p && p.body && p.body.mergeable === "CONFLICTING"); }
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
  if (plansView && !openPlan) return PLAN_ORDER.filter((s) => !planFolded.has(s)).flatMap((s) => plansInView().filter((p) => p.state === s && planMatches(p)));
  const v = visible();
  if (plansView) return v; // a plan's tasks, step by step
  if (mode === "board") return S.lanes.flatMap((l) => v.filter((t) => t.status === l)); // Needs you holds only two statuses anyway
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
// A person's approval that was undone (T-0094): sent back after they approved it.
function undoneText(u) {
  const who = u.conflict ? "the merge queue (it conflicts with main)" : u.by + (u.byKind === "agent" ? " (an agent)" : "");
  return "Approved, then sent back by " + who + " " + ago(u.at, Date.now()) + (u.reason && !u.conflict ? ": " + u.reason : "");
}
function undoneTag(t) {
  if (!t.undone) return null;
  const f = el("span", "flag", "Approval undone");
  f.title = undoneText(t.undone);
  return f;
}
function liveDot() { const d = el("span", "live-dot"); d.title = "A session is running"; return d; }
function bindItem(n, t) {
  n.dataset.id = t.k;
  n.tabIndex = sel === t.k ? 0 : -1;
  // A group, not a button: rows and cards hold their own buttons and links.
  n.setAttribute("role", "group");
  n.setAttribute("aria-label", t.id + " " + t.title + ", " + NAMES[t.status]);
  n.addEventListener("click", (e) => { if (e.target.closest("button, a")) return; select(t.k, false); openTask(t.k); });
  n.addEventListener("focus", () => { if (sel !== t.k) { sel = t.k; markSel(); } });
}
function row(t, now) {
  const r = el("div", "row" + (sel === t.k ? " sel" : "") + (openId === t.k ? " open" : ""));
  bindItem(r, t);
  const main = el("div", "main-line");
  const title = el("span", "title", t.title);
  title.title = t.title;
  const sub = el("div", "sub");
  sub.append(el("span", "", t.id));
  if (multi && view === "all") sub.append(projChip(t.project));
  if (t.risk !== "auto") sub.append(riskTag(t.risk));
  if (t.assignee) sub.append(el("span", "", t.assignee));
  sub.append(when(t, now));
  const flag = undoneTag(t);
  if (flag) { const line = el("span", "title-line"); line.append(title, flag); main.append(line, sub); }
  else main.append(title, sub);
  // Fixed slots, so each column lines up from row to row; an empty slot keeps its width.
  const side = el("div", "side");
  const slot = (cls, ...kids) => { const s = el("span", "slot " + cls); s.append(...kids.filter(Boolean)); side.append(s); };
  slot("s-live", t.live ? liveDot() : null);
  if (multi && view === "all") slot("s-proj", projChip(t.project));
  slot("s-tag", t.risk !== "auto" ? riskTag(t.risk) : null);
  const act = actionArea(t, true);
  slot("s-act", act);
  // An approved task's Merge button already names its PR.
  slot("s-pr", t.status === "approved" && act ? null : prLink(t));
  side.append(avatar(t.assignee), when(t, now));
  r.append(statusIcon(t.status), el("span", "id", t.id), main, side);
  return r;
}
function card(t, now) {
  const c = el("article", "card" + (sel === t.k ? " sel" : "") + (openId === t.k ? " open" : ""));
  bindItem(c, t);
  const top = el("div", "card-top");
  top.append(el("span", "id", t.id));
  if (multi && view === "all") top.append(projChip(t.project));
  top.append(when(t, now));
  const meta = el("div", "card-meta");
  const flag = undoneTag(t);
  if (flag) meta.append(flag);
  if (t.risk !== "auto") meta.append(riskTag(t.risk));
  const pr = t.status === "approved" && prNumber(t.pr) ? null : prLink(t);
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
    c.classList.toggle("open", c.dataset.id === openId);
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
  else if (r) o.append(queueNotice(r));
  return o;
}
// The queue's result as a notice: a summary in the outcome's colour, then each PR in its own words.
function queueNotice(r) {
  const n = el("section", "qnote " + r.cls);
  n.setAttribute("aria-label", "Merge queue result");
  const head = el("div", "qnote-head");
  const t = el("time", "ago", ago(r.at, Date.now()));
  t.title = new Date(r.at).toLocaleString();
  const again = laneButton("queue", "queue", "Run again", inView().filter((x) => x.status === "approved").map((x) => x.k));
  again.title = "Run the merge queue again (Shift M)";
  const close = el("button", "icon-btn");
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  close.append(icon("close"));
  close.addEventListener("click", (e) => { e.stopPropagation(); results.delete("queue"); render(); });
  head.append(el("strong", "", "Merge queue: " + r.text), t, again, close);
  n.append(head);
  const ul = el("ul", "qnote-list");
  for (const e of r.entries || []) {
    const li = el("li");
    li.append(el("span", "qa " + e.action, ACTION[e.action] || e.action), el("span", "id", (multi ? e.project + " " : "") + e.id), el("span", "qr", e.reason));
    ul.append(li);
  }
  for (const f of r.failures || []) { const li = el("li"); li.append(el("span", "qa error", "Failed"), el("span", "qr", f)); ul.append(li); }
  if (ul.childNodes.length) n.append(ul);
  const left = inView().filter((x) => x.status === "approved").length;
  if ((r.entries || []).some((e) => e.action === "merged") && left) n.append(el("p", "why", "A pass merges at most one PR, so main is re-read before the next. " + left + " still approved: run it again for the next."));
  return n;
}

function renderList(box, shown, now) {
  const wrap = el("div", "list" + (shown.some(YOURS) ? " with-act" : ""));
  // In the list the queue's notice sits on top, so it stays in sight even when Approved empties.
  const q = queueOut("list-out");
  if (q) wrap.append(q);
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
    const name = el("span", "group-name", NAMES[lane]);
    name.setAttribute("role", "heading");
    name.setAttribute("aria-level", "2");
    tog.append(icon("chev", "chev"), statusIcon(lane), name, el("span", "group-count", ts.length));
    tog.addEventListener("click", () => toggleGroup(lane));
    const acts = el("div", "group-act");
    acts.append(...groupActions(lane, ts));
    head.append(tog, acts);
    g.append(head);

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

// The Plans view: every plan with its progress, grouped Active, Done, Cancelled (the last two folded).
const progressText = (p) => p.progress.stepsDone + " of " + p.progress.steps + " steps · " + p.progress.tasksDone + " of " + p.progress.tasks + " tasks";
const planGlyph = (p) => statusIcon(p.state === "active" ? (p.steps.some((s) => s.state !== "empty" && s.state !== "waiting") ? "in_progress" : "ready") : p.state);
// One glyph per step, in order: the plan's progress at a glance.
function pips(p) {
  const box = el("span", "pips");
  box.setAttribute("aria-label", progressText(p));
  for (const s of p.steps) {
    const g = statusIcon(STEP_GLYPH[s.state]);
    const w = el("span", "pip");
    w.title = "Step " + s.n + ": " + s.title + " (" + STEP_NAMES[s.state].toLowerCase() + ")";
    w.append(g);
    box.append(w);
  }
  return box;
}
function planRow(p) {
  const r = el("div", "row plan-row" + (sel === p.k ? " sel" : ""));
  r.dataset.id = p.k;
  r.tabIndex = sel === p.k ? 0 : -1;
  r.setAttribute("role", "group");
  r.setAttribute("aria-label", p.id + " " + p.title + ", " + PLAN_NAMES[p.state] + ", " + progressText(p));
  r.addEventListener("click", () => { select(p.k, false); openPlanView(p.k); });
  r.addEventListener("focus", () => { if (sel !== p.k) { sel = p.k; markSel(); } });
  const main = el("div", "main-line");
  const title = el("span", "title", p.title);
  title.title = p.title;
  const sub = el("div", "sub");
  sub.append(el("span", "", p.id));
  if (multi && view === "all") sub.append(projChip(p.project));
  sub.append(el("span", "", progressText(p)));
  main.append(title, sub);
  const side = el("div", "side");
  if (multi && view === "all") { const s = el("span", "slot s-proj"); s.append(projChip(p.project)); side.append(s); }
  side.append(pips(p), el("span", "progress", progressText(p)));
  r.append(planGlyph(p), el("span", "id", p.id), main, side);
  return r;
}
function renderPlans(box, now) {
  const p = curPlan();
  if (p) return renderPlan(box, p, now);
  const all = plansInView(), shown = all.filter(planMatches);
  if (!shown.length) {
    const e = el("div", "blank");
    if (filter && all.length) e.append(el("h2", "", "No plan matches “" + filter + "”"), el("p", "", "Press Esc to clear the filter."));
    else {
      e.append(el("h2", "", "No plans yet"), el("p", "", "A plan is ordered steps, each with a check, and the tasks that make each step. File one from the terminal."));
      const c = el("p"); c.append(el("code", "", 'fm plan new "What to ship" --step "First step :: what shows it is done"')); e.append(c);
    }
    box.append(e);
    return;
  }
  const wrap = el("div", "list plans");
  for (const state of PLAN_ORDER) {
    const ps = shown.filter((x) => x.state === state);
    if (!ps.length) continue;
    const closed = planFolded.has(state);
    const g = el("section", "group" + (closed ? " closed" : ""));
    g.dataset.lane = "plans-" + state;
    g.setAttribute("aria-label", PLAN_NAMES[state] + " plans");
    const head = el("div", "group-head");
    const tog = el("button", "group-toggle");
    tog.type = "button";
    tog.setAttribute("aria-expanded", String(!closed));
    tog.title = (closed ? "Show " : "Hide ") + PLAN_NAMES[state].toLowerCase() + " plans";
    const name = el("span", "group-name", PLAN_NAMES[state]);
    name.setAttribute("role", "heading");
    name.setAttribute("aria-level", "2");
    tog.append(icon("chev", "chev"), name, el("span", "group-count", ps.length));
    tog.addEventListener("click", () => { if (planFolded.has(state)) planFolded.delete(state); else planFolded.add(state); savePrefs(); render(); });
    head.append(tog);
    g.append(head);
    if (!closed) for (const x of ps) g.append(planRow(x));
    wrap.append(g);
  }
  box.append(wrap);
}
// One plan: its goal, then each step in order with its check, its state and its tasks as normal rows.
function renderPlan(box, p, now) {
  const ts = planTasks(p), shown = ts.filter(matches);
  const wrap = el("div", "list plan-detail" + (shown.some(YOURS) ? " with-act" : ""));
  const head = el("div", "plan-head");
  const back = el("button", "btn quiet back");
  back.type = "button";
  back.title = "Back to Plans (Esc)";
  back.append(icon("back"), el("span", "", "Plans"));
  back.addEventListener("click", closePlanView);
  const meta = el("div", "plan-meta");
  if (multi) meta.append(projChip(p.project));
  meta.append(planGlyph(p), el("span", "id", p.id), el("span", "", PLAN_NAMES[p.state]), el("span", "progress", progressText(p)));
  const title = el("h2", "plan-title", p.title);
  head.append(back, meta, title);
  if (p.state === "cancelled" && p.cancelReason) head.append(el("p", "why", "Cancelled: " + p.cancelReason));
  if (p.goal) head.append(spec(p.goal));
  wrap.append(head);
  for (const s of p.steps) {
    const sec = el("section", "group step");
    sec.dataset.lane = "step-" + s.n;
    sec.setAttribute("aria-label", "Step " + s.n + ": " + s.title);
    const h = el("div", "group-head");
    const name = el("span", "group-name", s.n + ". " + s.title);
    name.setAttribute("role", "heading");
    name.setAttribute("aria-level", "2");
    const st = el("span", "step-state " + s.state, STEP_NAMES[s.state]);
    h.append(statusIcon(STEP_GLYPH[s.state]), name, st, el("span", "group-count", s.tasks.length));
    sec.append(h);
    const check = el("p", "step-check");
    check.append(el("span", "step-label", "Check"), document.createTextNode(s.check));
    sec.append(check);
    const mine = shown.filter((t) => s.tasks.some((x) => p.project + "/" + x.id === t.k));
    if (!s.tasks.length) sec.append(el("div", "group-note", "No tasks yet. File one with fm add … --plan " + p.id + " --step " + s.n + "."));
    else if (!mine.length && filter) sec.append(el("div", "group-note", "No task here matches the filter."));
    for (const t of mine) sec.append(row(t, now));
    wrap.append(sec);
  }
  box.append(wrap);
}
// Open a plan from its row, a task's panel or the palette. The list's copy shows at once; then it is read fresh.
async function openPlanView(k) {
  const p = byPlan(k);
  if (!p) return;
  plansView = true;
  openPlan = k;
  sel = null;
  if (view !== "all" && view !== p.project) view = p.project;
  sideNav(false);
  if (!openId) setHash(scopeHash());
  render();
  $("#content").scrollTop = 0;
  try {
    const d = await get(proj(p.project) + "/plans/" + encodeURIComponent(p.id));
    const fresh = tagPlans(p.project, [d.plan])[0];
    plans = plans.map((x) => (x.k === k ? fresh : x));
    if (openPlan === k) render();
  } catch {}
}
function closePlanView() {
  const k = openPlan;
  openPlan = null;
  sel = k;
  if (!openId) setHash(scopeHash());
  render();
  if (k) select(k, true);
}
function setPlans() {
  plansView = true;
  openPlan = null;
  sel = null;
  sideNav(false);
  if (!openId) setHash(scopeHash());
  render();
}
function goToPlan(project, id) {
  const p = plans.find((x) => x.project === project && x.id === id);
  if (p) openPlanView(p.k); else toast({ cls: "skip", text: "No plan " + id + " on this board." });
}
function renderBoard(box, shown, now, scroll) {
  const wrap = el("div", "board");
  for (const lane of S.lanes.filter((l) => !inbox || l === "needs_approval" || l === "approved")) {
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
}

// Re-renders rebuild the DOM, so remember the focused control by where it sits and focus its replacement.
function focusKey() {
  const a = document.activeElement;
  const host = a && a !== document.body && a.closest && a.closest("#content, #detail");
  if (!host) return null;
  const item = a.closest("[data-id], [data-lane]");
  return { host: host.id, item: item ? (item.dataset.id ? '[data-id="' + CSS.escape(item.dataset.id) + '"]' : '[data-lane="' + CSS.escape(item.dataset.lane) + '"]') : "",
    self: item === a, sel: a.tagName.toLowerCase() + (a.classList[0] ? "." + CSS.escape(a.classList[0]) : "") };
}
function restoreFocus(f) {
  if (!f || (document.activeElement && document.activeElement !== document.body)) return;
  const host = document.getElementById(f.host);
  const scope = host && (f.item ? host.querySelector(f.item) : host);
  const target = scope && (f.self ? scope : scope.querySelector(f.sel));
  if (target) target.focus({ preventScroll: true });
}
function render() {
  const box = $("#content"), now = Date.now();
  const qr = results.get("queue");
  if (qr && qr.snap && qr.entries.some((e) => (byKey(e.k) || {}).status !== qr.snap[e.k])) results.delete("queue");
  const fk = focusKey();
  const b = box.querySelector(".board");
  const scroll = { top: box.scrollTop, x: b ? b.scrollLeft : 0, lanes: new Map([...box.querySelectorAll(".lane")].map((l) => [l.dataset.lane, l.querySelector(".cards").scrollTop])) };
  box.replaceChildren();
  const mine = inView(), shown = visible();
  nav();
  if (plansView) renderPlans(box, now);
  else if (!shown.length && !(inbox && !filter)) {
    const e = el("div", "blank");
    if (filter) e.append(el("h2", "", "Nothing matches “" + filter + "”"), el("p", "", "Press Esc to clear the filter."));
    else if (!tasks.length) {
      e.append(el("h2", "", "No tasks yet"), el("p", "", "Add one from the terminal, and it shows up here."));
      const p = el("p"); p.append(el("code", "", 'fm add "What to build" --check "cmd: bun test" --ready')); e.append(p);
    } else e.append(el("h2", "", "No tasks in " + view), el("p", "", "Pick All projects in the sidebar."));
    box.append(e);
  } else if (mode === "board") renderBoard(box, shown, now, scroll);
  else renderList(box, shown, now);
  box.scrollTop = scroll.top;
  if (plansView && !openPlan) { const all = plansInView(), n = all.filter(planMatches).length; $("#total").textContent = filter ? n + " of " + all.length : String(all.length); }
  else $("#total").textContent = filter ? shown.length + " of " + mine.length : String(mine.length);
  if (openId) { const t = byKey(openId); const slot = $("#detail-act"); if (t && slot) slot.replaceChildren(...[actionArea(t, false)].filter(Boolean)); }
  restoreFocus(fk);
}

// The sidebar: the two views, then each project, each with what waits for the person there.
function nav() {
  const scoped = tasks.filter((t) => view === "all" || t.project === view);
  const yours = scoped.filter(YOURS).length;
  const mkView = (on, name, ic, n, attn, key, run) => {
    const b = el("button", "nav-item" + (on ? " on" : ""));
    b.type = "button";
    b.setAttribute("aria-current", on ? "page" : "false");
    b.append(icon(ic), el("span", "name", name));
    if (n) b.append(el("span", "count" + (attn ? " attn" : ""), n));
    b.title = name + " (g " + key + ")";
    b.addEventListener("click", run);
    return b;
  };
  const activePlans = plansInView().filter((p) => p.state === "active").length;
  $("#views").replaceChildren(mkView(!plansView && inbox, "Needs you", "inbox", yours, true, "n", () => setInbox(true)),
    mkView(!plansView && !inbox, "All tasks", "tasks", scoped.length, false, "a", () => setInbox(false)),
    mkView(plansView, "Plans", "plans", activePlans, false, "p", setPlans));
  const scopeName = multi ? (view === "all" ? null : view) : PROJECTS[0] || null;
  $("#scope").replaceChildren(...(scopeName ? [labelDot(scopeName, false), document.createTextNode(scopeName + " / ")].filter(Boolean) : []));
  const heading = plansView ? "Plans" : inbox ? "Needs you" : "All tasks";
  $("#title-text").textContent = heading;
  document.title = (yours ? "(" + yours + ") " : "") + (curPlan() ? curPlan().title + " · Plans" : heading) + " · foreman";
  // List or Board is for tasks; a plan always lists its steps.
  $(".seg").hidden = plansView;
  for (const s of document.querySelectorAll(".seg button")) {
    const on = s.dataset.mode === mode;
    s.classList.toggle("on", on);
    s.setAttribute("aria-pressed", String(on));
  }
  const box = $("#projects");
  box.hidden = !PROJECTS[0];
  if (box.hidden) return;
  const mk = (value, name) => {
    const ts = value === "all" ? tasks : tasks.filter((t) => t.project === value);
    const n = ts.filter(YOURS).length;
    const b = el("button", "nav-item" + (view === value || !multi ? " on" : ""));
    b.type = "button";
    b.dataset.project = value;
    b.setAttribute("aria-pressed", String(view === value || !multi));
    b.append(value === "all" ? icon("layers") : el("span", "label-slot"), el("span", "name", name));
    const i = PROJECTS.indexOf(value);
    b.title = value === "all" ? "Every project" : name + (i < 9 ? " (g " + (i + 1) + ")" : "");
    if (n) { const d = el("span", "attn-dot"); d.title = n + " waiting for you"; b.append(d); }
    b.append(el("span", "count", ts.length));
    b.addEventListener("click", () => { if (multi) setView(value); });
    if (value === "all") return b;
    // The dot is its own button, beside the row's: it opens the colour picker for this project.
    const row = el("div", "nav-row");
    const pick = el("button", "label-btn");
    pick.type = "button";
    pick.setAttribute("aria-label", "Colour label for " + name);
    pick.title = "Colour label for " + name;
    pick.append(labelDot(name, true));
    pick.addEventListener("click", (e) => { e.stopPropagation(); openPalette({ color: name }); });
    row.append(b, pick);
    return row;
  };
  box.replaceChildren(el("div", "nav-label", multi ? "Projects" : "Project"), ...(multi ? [mk("all", "All projects")] : []), ...PROJECTS.map((n) => mk(n, n)));
}
function setView(value) {
  view = value;
  if (openPlan && (byPlan(openPlan) || {}).project !== value && value !== "all") openPlan = null;
  setHash(openId ? location.hash : scopeHash());
  sideNav(false);
  render();
}
function setInbox(on) {
  inbox = on;
  plansView = false;
  openPlan = null;
  if (!openId) setHash(scopeHash());
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
  const modal = palOpen || !$("#help").hidden;
  $("#scrim").hidden = !(modal || $(".app").classList.contains("nav-open"));
  // While a dialog is open, the page behind it can't take focus.
  $(".app").inert = modal;
  $("#detail").inert = modal;
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
// The spec's markdown, kept to what specs use: headings, lists, code fences, inline code.
// Built with textContent like everything else, so no markup in a spec ever runs.
function inline(text) {
  const f = document.createDocumentFragment();
  text.split("\\u0060").forEach((part, i) => { if (part) f.append(i % 2 ? el("code", "", part) : document.createTextNode(part)); });
  return f;
}
function spec(md) {
  const box = el("div", "spec");
  let para = null, list = null, code = null;
  const end = () => { para = null; list = null; };
  for (const line of md.replace(/\\r/g, "").split("\\n")) {
    if (code) { if (/^\\s*\\u0060\\u0060\\u0060/.test(line)) code = null; else code.textContent += (code.textContent ? "\\n" : "") + line; continue; }
    if (/^\\s*\\u0060\\u0060\\u0060/.test(line)) { end(); code = el("pre", "log"); box.append(code); continue; }
    const h = /^#{1,6}\\s+(.*)$/.exec(line);
    const li = /^\\s*(?:[-*+]|\\d+[.)])\\s+(.*)$/.exec(line);
    if (!line.trim()) end();
    else if (h) { end(); const e = el("h4"); e.append(inline(h[1])); box.append(e); }
    else if (li) { para = null; if (!list) { list = el("ul"); box.append(list); } const e = el("li"); e.append(inline(li[1])); list.append(e); }
    else if (list && /^\\s+\\S/.test(line)) { list.lastChild.append(" ", inline(line.trim())); }
    else { list = null; if (para) para.append(" "); else { para = el("p"); box.append(para); } para.append(inline(line.trim())); }
  }
  return box;
}
function prop(dl, name, ...value) {
  const dd = el("dd");
  dd.append(...value.filter(Boolean));
  dl.append(el("dt", "", name), dd);
}
function panelBar(k, status) {
  const bar = el("div", "panel-bar");
  const crumb = el("div", "crumb");
  if (multi) { const pn = el("span", "crumb-proj"); const d = labelDot(k.project, false); if (d) pn.append(d); pn.append(document.createTextNode(k.project)); crumb.append(pn, el("span", "sep", "/")); }
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
  markSel();
  const p = $("#detail");
  // Show what the list already knows at once; the rest fills in when the request answers.
  if (p.hidden || p.dataset.id !== id) {
    p.dataset.id = id;
    const body = el("div", "panel-body");
    body.append(el("h2", "panel-title", k.title), el("p", "wait", "Loading…"));
    p.replaceChildren(panelBar(k, k.status), body);
    p.hidden = false;
    $(".app").classList.add("panel-open");
    clearOfPanel(id);
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
  if (k.undone) {
    const u = k.undone, n = el("div", "flag-note");
    n.setAttribute("role", "note");
    n.append(el("strong", "", "Your approval was undone"), el("p", "", undoneText(u) + "."),
      el("p", "", u.conflict ? "Its worker merges main; then it is verified and comes back to you for approval." : "Whatever changed is verified again, then it comes back to you for approval."));
    body.append(n);
  }
  const dl = el("dl", "props");
  prop(dl, "Status", statusIcon(t.status), el("span", "", NAMES[t.status]));
  prop(dl, "Risk", riskTag(t.risk));
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
  if (multi) prop(dl, "Project", labelDot(k.project, false), el("span", "", k.project));
  // The plan and step it is in (D0033), linked to the plan.
  const pl = d.placement;
  if (pl) {
    const a = el("a", "", pl.plan + " " + pl.planTitle);
    a.href = "#" + (multi ? "p=" + encodeURIComponent(k.project) + "&" : "") + "plan=" + pl.plan;
    a.title = "Open " + pl.plan + " in Plans";
    a.addEventListener("click", (e) => { e.preventDefault(); goToPlan(k.project, pl.plan); });
    prop(dl, "Plan", a);
    prop(dl, "Step", statusIcon(STEP_GLYPH[pl.stepState] || "draft"), el("span", "", pl.step + ". " + pl.stepTitle));
  }
  body.append(dl);
  const slot = el("div", "detail-act");
  slot.id = "detail-act";
  const act = actionArea({ ...k, status: t.status, pr: t.pr, assignee: t.assignee }, false);
  if (act) slot.append(act);
  body.append(slot);
  if (t.spec) {
    const s = el("section", "section");
    s.append(el("h3", "", "Spec"), spec(t.spec));
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
    mark.append(svgEl(v ? "path" : "circle", v ? { d: v.pass ? PATHS.check : PATHS.close } : { cx: "8", cy: "8", r: "5.5", "stroke-width": "1.5" }));
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
  const fk = focusKey();
  p.replaceChildren(panelBar(k, t.status), body);
  body.scrollTop = keepScroll;
  restoreFocus(fk);
}
// On the board the panel floats over the right of the columns: keep the open card left of it.
function clearOfPanel(k) {
  const n = mode === "board" && node(k), p = $("#detail"), b = $("#content .board");
  if (!n || !b || p.hidden || innerWidth <= 768) return;
  const over = n.getBoundingClientRect().right - p.getBoundingClientRect().left;
  if (over > 0) b.scrollBy({ left: over + n.offsetWidth / 4, behavior: "smooth" });
}
function closeTask() {
  clearTimeout(liveTimer);
  openId = null;
  const p = $("#detail");
  p.hidden = true;
  p.dataset.id = "";
  $(".app").classList.remove("panel-open");
  markSel();
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
let palOpen = false, palIdx = 0, palItems = [], palMode = null; // palMode: { color: project } picks a label
// The task the keys act on: the open one, else the selection while it's still on screen.
function current() {
  if (openId) return byKey(openId);
  return sel && order().some((t) => t.k === sel) ? byKey(sel) : null;
}
function colorCommands(project, q) {
  const now = COLORS.get(project);
  const items = LABELS.map((c) => ({ group: "Colour label for " + project, label: c.charAt(0).toUpperCase() + c.slice(1) + (c === now ? " (current)" : ""), swatch: c, run: () => setLabel(project, c) }));
  items.push({ group: "Colour label for " + project, label: "No colour" + (now ? "" : " (current)"), swatch: "none", run: () => setLabel(project, "none") });
  const words = q.toLowerCase().split(/\\s+/).filter(Boolean);
  return items.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
}
function commands(q) {
  if (palMode && palMode.color) return colorCommands(palMode.color, q);
  const t = current(), out = [];
  const off = canAct() ? null : S.canApprove ? "open the link fm serve printed" : "read-only board";
  if (t) {
    // Open comes first, so Enter right after Mod K never starts an approve or a merge.
    out.push({ group: "This task", label: (openId ? "Close " : "Open ") + t.id, keys: openId ? "Esc" : "Enter", icon: "eye", run: () => (openId ? closeTask() : openTask(t.k)) });
    const a = nextAction(t, canAct(), !S.canApprove);
    if (a.kind === "approve") out.push({ group: "This task", label: "Approve " + label(t), keys: "a", icon: "check", off: a.disabled, run: () => schedule(t.k, "approve", [t.k]) });
    if (a.kind === "merge") out.push({ group: "This task", label: a.label + " (" + label(t) + ")", keys: "m", icon: "check", off: a.disabled, run: () => schedule(t.k, "merge", [t.k]) });
    if (safeUrl(t.pr)) out.push({ group: "This task", label: "Open " + (prNumber(t.pr) || "the pull request") + " on GitHub", keys: "p", icon: "external", run: () => openPr(t) });
    out.push({ group: "This task", label: "Copy " + t.id, icon: "copy", run: () => copy(t.id) });
  }
  out.push({ group: "Go to", label: "Needs you", keys: "g n", icon: "inbox", run: () => setInbox(true) });
  out.push({ group: "Go to", label: "All tasks", keys: "g a", icon: "tasks", run: () => setInbox(false) });
  out.push({ group: "Go to", label: "Plans", keys: "g p", icon: "plans", run: setPlans });
  if (curPlan()) out.push({ group: "Go to", label: "Back to Plans", keys: "Esc", icon: "back", run: closePlanView });
  if (multi) {
    out.push({ group: "Go to", label: "All projects", icon: "layers", run: () => setView("all") });
    PROJECTS.forEach((n, i) => out.push({ group: "Go to", label: "Project " + n, keys: i < 9 ? "g " + (i + 1) : "", swatch: COLORS.get(n) || "none", run: () => setView(n) }));
  }
  const labelFirst = t ? t.project : view !== "all" ? view : null;
  for (const n of [labelFirst, ...PROJECTS.filter((x) => x !== labelFirst)].filter((x) => x !== null && x !== undefined)) {
    out.push({ group: "Projects", label: "Colour label for " + n + "…", swatch: COLORS.get(n) || "none", keep: true, run: () => openPalette({ color: n }) });
  }
  out.push({ group: "View", label: mode === "list" ? "Show as board" : "Show as list", keys: "v", icon: mode === "list" ? "board" : "list", run: () => setMode(mode === "list" ? "board" : "list") });
  const fin = collapsed.has("done") && collapsed.has("cancelled");
  out.push({ group: "View", label: fin ? "Show finished tasks" : "Hide finished tasks", icon: "eye", run: () => { for (const s of ["done", "cancelled"]) { if (fin) collapsed.delete(s); else collapsed.add(s); } savePrefs(); render(); } });
  out.push({ group: "View", label: "Filter tasks", keys: "/", icon: "search", run: () => $("#filter").focus() });
  out.push({ group: "View", label: "Keyboard shortcuts", keys: "?", icon: "key", run: () => help(true) });
  if (pending.size) out.push({ group: "Sign off", label: "Undo the last approve or merge", keys: "u", icon: "undo", run: undoLast });
  const v = visible();
  const need = v.filter((x) => x.status === "needs_approval"), ok = v.filter((x) => x.status === "approved");
  if (need.length) out.push({ group: "Sign off", label: "Approve all " + need.length + " waiting" + (filter ? " that match the filter" : view === "all" ? "" : " in " + view), keys: "Shift A", icon: "check", off, run: approveAll });
  if (ok.length) out.push({ group: "Sign off", label: "Run the merge queue (" + ok.length + " approved)", keys: "Shift M", icon: "check", off, run: runQueue });
  const words = q.toLowerCase().split(/\\s+/).filter(Boolean);
  const hit = (s) => words.every((w) => s.toLowerCase().includes(w));
  const cmds = out.filter((c) => hit(c.group + " " + c.label));
  const planItems = plans.filter((x) => hit(x.project + " " + x.id + " " + x.title + " " + PLAN_NAMES[x.state]))
    .slice(0, words.length ? 20 : 4).map((x) => ({
      group: "Plans", label: x.id + "  " + x.title, icon: "plans", sub: (multi ? x.project + " · " : "") + progressText(x),
      run: () => openPlanView(x.k),
    }));
  const found = tasks.filter((x) => hit(x.project + " " + x.id + " " + x.title + " " + NAMES[x.status]));
  const taskItems = found.slice(0, words.length ? 40 : 8).map((x) => ({
    group: "Tasks", label: x.id + "  " + x.title, status: x.status, sub: multi ? x.project : "",
    run: () => goToTask(x),
  }));
  return [...cmds, ...planItems, ...taskItems];
}
// Bring a task into view (leaving Needs you or a project if it isn't there), select it and open it.
function goToTask(x) {
  x = byKey(x.k) || x;
  if (!inView().includes(x)) { plansView = false; openPlan = null; inbox = false; if (view !== "all" && view !== x.project) view = "all"; }
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
// Sets a project's colour label. Like the other writes it needs the token; it changes nothing
// about the work, so it goes at once, without the undo window.
async function setLabel(project, color) {
  if (!canAct()) { toast({ cls: "skip", text: "Off: " + (S.canApprove ? "open the link fm serve printed" : "read-only board") + "." }); return; }
  const r = await post(proj(project) + "/color/" + encodeURIComponent(color));
  if (!r.ok) { toast({ cls: "bad", text: "Couldn't label " + project + ": " + (r.body.message || "refused") }); return; }
  COLORS.set(project, r.body.color || null);
  render();
  if (openId) openTask(openId);
}
function openPalette(mode) {
  palMode = mode || null;
  // The colour step opens on the project's current colour.
  const startIdx = () => (palMode && palMode.color ? Math.max(0, LABELS.indexOf(COLORS.get(palMode.color) || "none") < 0 ? LABELS.length : LABELS.indexOf(COLORS.get(palMode.color))) : 0);
  if (palOpen) { $("#palette-input").value = ""; palIdx = startIdx(); paletteCtx(); drawPalette(); markPal(); $("#palette-input").focus(); return; }
  palOpen = true;
  $("#help").hidden = true;
  sideNav(false);
  paletteCtx();
  $("#palette").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  palIdx = startIdx();
  drawPalette();
  syncScrim();
  input.focus();
}
function paletteCtx() {
  const t = current();
  const ctx = $("#palette-ctx");
  ctx.replaceChildren();
  const input = $("#palette-input");
  if (palMode && palMode.color) {
    input.placeholder = "Pick a colour for " + palMode.color + "…";
  } else {
    if (t) { const c = el("span", "chip"); c.append(statusIcon(t.status), document.createTextNode(t.id + "  " + t.title)); ctx.append(c); }
    input.placeholder = "Type a command or search tasks…";
  }
  ctx.hidden = !ctx.childNodes.length;
}
function closePalette(refocus) {
  palOpen = false;
  palMode = null;
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
  if (!palItems.length) { list.append(el("div", "pal-empty", "No commands or tasks match.")); $("#palette-input").removeAttribute("aria-activedescendant"); return; }
  let group = null;
  palItems.forEach((c, i) => {
    if (c.group !== group) { group = c.group; list.append(el("div", "pal-group", group)); }
    const it = el("div", "pal-item" + (i === palIdx ? " on" : ""));
    it.id = "pal-" + i;
    it.setAttribute("role", "option");
    it.setAttribute("aria-selected", String(i === palIdx));
    if (c.off) { it.setAttribute("aria-disabled", "true"); it.title = "Off: " + c.off; }
    const lead = el("span", "lead");
    if (c.swatch) { const d = el("span", "label-dot " + (c.swatch === "none" ? "none" : "label-" + c.swatch)); lead.append(d); }
    else lead.append(c.status ? statusIcon(c.status) : icon(c.icon || "tasks"));
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
  if (c.keep) { c.run(); return; } // opens a second step of the palette
  closePalette(false);
  c.run();
  if (document.activeElement === document.body && sel && !palOpen && $("#help").hidden) select(sel, true);
}
function palKey(e) {
  if (e.key === "Escape") { e.preventDefault(); if (palMode && palMode.color) openPalette(); else closePalette(); }
  else if (e.key === "Backspace" && palMode && palMode.color && !$("#palette-input").value) { e.preventDefault(); openPalette(); }
  else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); markPal(); }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); markPal(); }
  else if (e.key === "Enter") { e.preventDefault(); runPal(palIdx); }
}

// Each undone approval seen so far, so a new one raises a toast once (not again on every refresh).
const undoneSeen = new Set(tasks.filter((t) => t.undone).map((t) => t.k + "@" + t.undone.at));
function flagNewUndone() {
  for (const t of tasks) {
    if (!t.undone || undoneSeen.has(t.k + "@" + t.undone.at)) continue;
    undoneSeen.add(t.k + "@" + t.undone.at);
    if (t.undone.byKind === "human" && S.me && t.undone.by === S.me) continue; // they did it themselves
    toast({ cls: "bad", sticky: !t.undone.conflict && t.undone.byKind !== "human", text: label(t) + ": your approval was undone. " + undoneText(t.undone) + "." });
  }
}
async function refresh() {
  const all = await Promise.all(PROJECTS.map((n) => Promise.all([get(proj(n) + "/tasks"), get(proj(n) + "/plans")]).then(([s, ps]) => [n, s, ps])));
  tasks = [];
  plans = all.flatMap(([n, , ps]) => tagPlans(n, ps.plans));
  setTimeout(flagNewUndone, 0);
  for (const [n, s] of all) {
    lastEvents.set(n, Math.max(lastEvents.get(n) || 0, s.lastEvent));
    tasks.push(...tag(n, s.tasks));
    COLORS.set(n, s.color || null);
    S.canApprove = s.canApprove;
  }
  render();
  if (openId) await openTask(openId);
}
let pollCount = 0;
async function poll() {
  try {
    if (++pollCount % 5 === 0) {
      const ps = await get("/api/projects");
      let changed = false;
      for (const p of ps.projects) if (COLORS.has(p.name) && COLORS.get(p.name) !== (p.color || null)) { COLORS.set(p.name, p.color || null); changed = true; }
      if (changed) render();
    }
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
  if (openId && openId !== next.k && byKey(next.k)) openTask(next.k);
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
  else if (openPlan && !typing) closePlanView();
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
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); e.target.blur(); const v = order(); if (v.length) { select(v[0].k, true); if (openId && openId !== v[0].k) openTask(v[0].k); } }
    return;
  }
  if (!$("#help").hidden && e.key !== "?") return;
  const now = Date.now();
  if (gAt && now - gAt < 1500) {
    gAt = 0;
    if (e.key === "n") setInbox(true);
    else if (e.key === "a") setInbox(false);
    else if (e.key === "p") setPlans();
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
  else if ((e.key === "h" || e.key === "ArrowLeft") && mode === "board" && !plansView) { e.preventDefault(); across(-1); }
  else if ((e.key === "l" || e.key === "ArrowRight") && mode === "board" && !plansView) { e.preventDefault(); across(1); }
  else if ((e.key === "Enter" || e.key === "o") && plansView && !openPlan && sel && byPlan(sel) && !onControl) { e.preventDefault(); openPlanView(sel); }
  else if ((e.key === "Enter" || e.key === "o") && t && !onControl && openId !== t.k) { e.preventDefault(); openTask(t.k); }
  else if (e.key === "g") gAt = now;
  else if (e.key === "v") setMode(mode === "list" ? "board" : "list");
  else if (e.key === "u") undoLast();
  else if (e.key === "A") approveAll();
  else if (e.key === "M") runQueue();
  else if (e.key === "p" && t) openPr(t);
  else if (e.key === "a" && t && nextAction(t, canAct(), !S.canApprove).kind === "approve") act(t, "approve");
  else if (e.key === "m" && t && nextAction(t, canAct(), !S.canApprove).kind === "merge") act(t, "merge");
});
// Shift A and Shift M: the group buttons' Approve all and Run queue, for whatever is in view,
// through the same undo window. With nothing to do, or no token, they say so.
function approveAll() {
  const ids = visible().filter((t) => t.status === "needs_approval").map((t) => t.k).filter((k) => !inFlight(k));
  if (!canAct()) toast({ cls: "skip", text: "Can't approve here: " + (S.canApprove ? "open the link fm serve printed" : "read-only board") + "." });
  else if (pending.has("lane:approve") || busy.has("lane:approve")) toast({ cls: "skip", text: "Approve all is already on its way (u undoes it)." });
  else if (!ids.length) toast({ cls: "skip", text: "Nothing here waits for approval." });
  else schedule("lane:approve", "approve", ids);
}
function runQueue() {
  const ids = visible().filter((t) => t.status === "approved").map((t) => t.k);
  if (!canAct()) toast({ cls: "skip", text: "Can't merge here: " + (S.canApprove ? "open the link fm serve printed" : "read-only board") + "." });
  else if (pending.has("queue") || busy.has("queue")) toast({ cls: "skip", text: "The merge queue is already on its way (u undoes it while it waits)." });
  else if (!ids.length) toast({ cls: "skip", text: "Nothing here is approved to merge." });
  else schedule("queue", "queue", ids);
}
// A key on a task that can't be acted on here says why, instead of doing nothing.
function act(t, kind) {
  const a = nextAction(t, canAct(), !S.canApprove);
  if (a.disabled) toast({ cls: "skip", text: "Can't " + kind + " here: " + a.disabled + "." });
  else schedule(t.k, kind, [t.k]);
}
$("#filter").addEventListener("input", (e) => { filter = e.target.value.trim(); render(); });
$("#help-open").addEventListener("click", () => help(true));
$("#help-close").addEventListener("click", () => help(false));
$("#cmdk").addEventListener("click", () => openPalette());
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
  if (h.plansList) plansView = true;
  render();
  if (h.plan) {
    const p = plans.find((x) => x.id === h.plan && (!h.project || x.project === h.project)) || plans.find((x) => x.id === h.plan);
    if (p) openPlanView(p.k);
  }
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
</div><div class="dialog-foot"><p class="why">Approve and merge wait ${UNDO_SECONDS} seconds before they're sent, with Undo.</p>
<button type="button" class="btn quiet" id="help-close">Close</button></div></div>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script type="application/json" id="initial">${scriptJson(initial)}</script>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}
