// The board's single page. Everything inline, nonce'd by the server's CSP; no external
// assets. Task text only ever reaches the DOM through textContent, and the initial state
// is embedded as JSON with every "<" escaped, so a title can't close the script.
//
// The token (D0021) arrives in the URL fragment, which the browser never sends: the page
// moves it to sessionStorage, clears it from the address bar and sends it as a header.

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

export const SHORTCUTS: [string, string][] = [
  ["j / k", "next / previous card"],
  ["Enter", "open the card"],
  ["a", "approve the card"],
  ["m", "merge the card"],
  ["u", "undo the last approve or merge"],
  ["/", "filter"],
  ["Esc", "close, or clear the filter"],
  ["?", "show these shortcuts"],
];

// Palette: cool paper and ink; viridian means "yours to sign off", ink-on-paper means merge
// (it ships), ochre marks what waits for you, red only for failure.
const CSS = `
:root{--paper:#f3f5f2;--surface:#fff;--sunk:#e9ece8;--ink:#18201d;--muted:#5c6763;--faint:#8a9590;--line:#d9dfdb;
--go:#17654f;--go-soft:#e1efe9;--on-go:#fff;--attn:#93570a;--attn-soft:#f6ecdc;--bad:#a8261d;--bad-soft:#f8e4e1;
--thumb:#c3cbc6;--thumb-hover:#9aa59f;--focus:#17654f;--scrim:rgba(24,32,29,.28);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#101412;--surface:#171c1a;--sunk:#141917;--ink:#e2e8e4;--muted:#97a39d;
--faint:#6c7873;--line:#28302d;--go:#58bf9d;--go-soft:#14271f;--on-go:#08140f;--attn:#e2a54c;--attn-soft:#251f15;
--bad:#f2867a;--bad-soft:#3a1c19;--thumb:#333d39;--thumb-hover:#4a5651;--focus:#58bf9d;--scrim:rgba(0,0,0,.5);color-scheme:dark}}
*{box-sizing:border-box}
*{scrollbar-width:thin;scrollbar-color:var(--thumb) transparent}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background-color:var(--thumb);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background-color:var(--thumb-hover)}
::-webkit-scrollbar-corner{background:transparent}
html{height:100%}
body{margin:0;height:100vh;height:100dvh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);
font:13.5px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
a{color:var(--go);text-underline-offset:2px}
header{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--surface)}
.brand{font-size:15px;font-weight:650;letter-spacing:-.01em;margin:0;display:flex;align-items:baseline;gap:8px}
.brand small{font-size:12px;font-weight:450;color:var(--faint)}
.filter{flex:1 1 220px;max-width:360px;position:relative}
.filter input{width:100%;height:30px;padding:0 30px 0 10px;border:1px solid var(--line);border-radius:7px;background:var(--paper)}
.filter input::placeholder{color:var(--faint)}
.filter kbd{position:absolute;right:7px;top:6px}
.yours{display:flex;gap:12px;align-items:center;margin-left:auto;font-size:12.5px;color:var(--muted)}
.yours b{font-weight:650;color:var(--ink)}
.yours .n-attn b{color:var(--attn)}.yours .n-go b{color:var(--go)}
.live{display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--go)}
.dot.off{background:var(--bad)}
.icon{width:28px;height:28px;border-radius:7px;border:1px solid var(--line);background:none;cursor:pointer;color:var(--muted)}
.icon:hover{color:var(--ink);border-color:var(--thumb-hover)}
.notice{margin:0;padding:8px 16px;font-size:12.5px;color:var(--attn);background:var(--attn-soft);border-bottom:1px solid var(--line)}
.notice[hidden]{display:none}
main{flex:1;min-height:0;display:flex;gap:10px;align-items:stretch;padding:12px 16px 14px;overflow-x:auto;overflow-y:hidden;
scroll-snap-type:x proximity;scroll-padding-inline:16px;scrollbar-color:transparent transparent}
main:hover,main:focus-within{scrollbar-color:var(--thumb) transparent}
main::-webkit-scrollbar-thumb{background-color:transparent}
main:hover::-webkit-scrollbar-thumb,main:focus-within::-webkit-scrollbar-thumb{background-color:var(--thumb)}
.lane{flex:0 0 276px;display:flex;flex-direction:column;min-height:0;max-height:100%;background:var(--sunk);border-radius:12px;scroll-snap-align:start}
.lane.empty{flex-basis:148px}
.lane.attn{background:var(--attn-soft)}.lane.go{background:var(--go-soft)}
.lane-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;min-height:44px}
.lane-head h2{margin:0;font-size:13px;font-weight:620;letter-spacing:-.005em;white-space:nowrap}
.lane-head .n{color:var(--faint);font-size:12.5px}
.lane-head .btn{margin-left:auto}
.lane-note{padding:0 12px 10px;font-size:12px;color:var(--faint)}
.lane-out{margin:0 8px 8px;padding:8px 10px;border-radius:8px;background:var(--surface);font-size:12.5px}
.lane-out div{overflow-wrap:anywhere}
.cards{flex:1;min-height:0;overflow-y:auto;padding:0 8px 8px;display:flex;flex-direction:column;gap:6px}
.card{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:9px 11px 10px;cursor:pointer}
.card:hover{border-color:var(--thumb-hover)}
.card.sel{border-color:var(--focus);box-shadow:0 0 0 1px var(--focus)}
.card.attn{box-shadow:inset 3px 0 0 var(--attn)}.card.go{box-shadow:inset 3px 0 0 var(--go)}
.card.sel.attn,.card.sel.go{box-shadow:0 0 0 1px var(--focus)}
.top{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--faint)}
.top .id{color:var(--muted);font-weight:550}
.top .proj{margin-right:auto;margin-left:8px;padding:0 6px;border-radius:4px;background:var(--sunk);color:var(--muted);font-weight:550;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.projects{display:flex;gap:6px;padding:8px 16px;overflow-x:auto;border-bottom:1px solid var(--line)}
.projects[hidden]{display:none}
.tab{font:inherit;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--muted);cursor:pointer;white-space:nowrap}
.tab.on{background:var(--ink);border-color:var(--ink);color:var(--paper)}
.tab:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.tab .n{margin-left:6px;padding:0 6px;border-radius:8px;background:var(--attn-soft);color:var(--attn);font-weight:600}
.tab.on .n{background:var(--paper)}
.title{margin:3px 0 7px;font-size:13.5px;font-weight:500;line-height:1.35;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:12px;color:var(--muted)}
.risk{padding:0 6px;border-radius:5px;background:var(--sunk);font-size:11.5px}
.risk.review{color:var(--attn)}.risk.human{color:var(--bad)}
.act{margin-top:9px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.wait{font-size:12px;color:var(--faint)}
.prs{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px}
.prs::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}
.prs.green::before{background:var(--go)}.prs.pending::before{background:var(--attn)}.prs.red::before{background:var(--bad)}
.btn{height:28px;padding:0 12px;border-radius:7px;border:1px solid transparent;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap}
.btn.approve{background:var(--go);color:var(--on-go)}
.btn.merge{background:var(--ink);color:var(--surface)}
.btn.quiet{background:var(--surface);border-color:var(--line);color:var(--ink)}
.btn:hover:not(:disabled){filter:brightness(1.08)}
.btn:disabled{background:var(--sunk);color:var(--faint);border-color:var(--line);cursor:not-allowed}
.why{font-size:11.5px;color:var(--faint)}
.undo{position:relative;display:flex;align-items:center;gap:10px;height:28px;padding:0 4px 0 10px;border-radius:7px;overflow:hidden;
border:1px solid var(--go);font-size:12.5px;color:var(--ink);flex:1 1 auto;max-width:100%}
.undo .fill{position:absolute;inset:0;background:var(--go-soft);transform-origin:left;animation:drain linear forwards}
.undo span,.undo button{position:relative}
.undo button{margin-left:auto;height:22px;padding:0 10px;border-radius:5px;border:0;background:var(--go);color:var(--on-go);font-weight:600;font-size:12px;cursor:pointer}
@keyframes drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.busy{font-size:12.5px;color:var(--muted)}
.out{font-size:12.5px;overflow-wrap:anywhere}.out.ok{color:var(--go)}.out.bad{color:var(--bad)}.out.skip{color:var(--attn)}
.blank{margin:auto;max-width:440px;text-align:center;color:var(--muted)}
.blank h2{font-size:18px;color:var(--ink);margin:0 0 6px;font-weight:620}
.blank code{background:var(--sunk);padding:2px 6px;border-radius:5px;font-size:12.5px}
kbd{display:inline-block;min-width:18px;padding:0 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;
font:11.5px/16px system-ui,sans-serif;color:var(--muted);text-align:center;background:var(--surface)}
.scrim{position:fixed;inset:0;background:var(--scrim);z-index:3}
.scrim[hidden],#detail[hidden],#help[hidden]{display:none}
#detail{position:fixed;top:0;right:0;bottom:0;width:min(560px,100%);background:var(--surface);border-left:1px solid var(--line);
overflow-y:auto;padding:16px 22px 32px;z-index:4}
#detail .bar{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:12.5px}
#detail h2{font-size:19px;line-height:1.3;margin:6px 0 10px;font-weight:640;letter-spacing:-.01em;overflow-wrap:anywhere}
#detail h3{font-size:13px;font-weight:620;margin:22px 0 8px}
#detail .act{margin-top:14px}
.spec{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0;
font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:50vh;overflow:auto}
ul.checks,ul.hist{list-style:none;padding:0;margin:0}
ul.checks li{border:1px solid var(--line);border-radius:8px;padding:8px 11px;margin-bottom:6px}
ul.checks .head{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:2px}
.v{font-weight:620;font-size:12px}.v.pass{color:var(--go)}.v.fail{color:var(--bad)}.v.pending{color:var(--faint)}
.ev{color:var(--muted);font-size:12px;margin-top:4px;overflow-wrap:anywhere;white-space:pre-wrap}
ul.hist li{padding:7px 0;border-bottom:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
ul.hist time{color:var(--faint);font-size:12px;margin-right:8px}
#help{position:fixed;z-index:5;top:12vh;left:50%;transform:translateX(-50%);width:min(380px,calc(100% - 32px));background:var(--surface);
border:1px solid var(--line);border-radius:12px;padding:16px 18px}
#help h2{margin:0 0 10px;font-size:15px;font-weight:640}
#help dl{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;margin:0;font-size:13px}
#help dt{text-align:right}#help dd{margin:0;color:var(--muted)}
@media (max-width:640px){
header{padding:10px 16px}.filter{order:3;flex-basis:100%;max-width:none}.filter kbd{display:none}
.yours{gap:10px}.yours .live span{display:none}
main{scroll-snap-type:x mandatory;gap:8px}
.lane{flex:0 0 calc(100vw - 48px)}.lane.empty{flex-basis:148px}
.lane[data-lane=needs_approval]{order:-2}.lane[data-lane=approved]{order:-1}
#detail{padding:14px 16px 28px}}
@media (prefers-reduced-motion:reduce){.undo .fill{animation:none;opacity:.6}}
`;

const JS = `
"use strict";
${prNumber.toString()}
${nextAction.toString()}
${ago.toString()}
const UNDO_MS = ${UNDO_SECONDS * 1000};
const SHORTCUTS = ${JSON.stringify(SHORTCUTS)};
const S = JSON.parse(document.getElementById("initial").textContent);
const KEY = "foreman-board-token";
const NAMES = { draft: "Draft", ready: "Ready", claimed: "Claimed", in_progress: "In progress", in_review: "In review",
  verifying: "Verifying", needs_approval: "Needs approval", approved: "Approved", done: "Done", cancelled: "Cancelled" };
const EMPTY = { needs_approval: "Nothing to sign off.", approved: "Nothing to merge." };
// Tasks of every project, merged. t.k (project/id) is the key: ids repeat across projects.
const PROJECTS = (S.projects || [{ name: "", tasks: S.tasks || [], lastEvent: S.lastEvent || 0 }]).map((p) => p.name);
const multi = PROJECTS.length > 1;
const lastEvents = new Map((S.projects || [{ name: "", lastEvent: S.lastEvent || 0 }]).map((p) => [p.name, p.lastEvent]));
const tag = (name, ts) => ts.map((t) => ({ ...t, project: name, k: name + "/" + t.id }));
let tasks = (S.projects || [{ name: "", tasks: S.tasks || [] }]).flatMap((p) => tag(p.name, p.tasks));
let openId = null, sel = null, filter = "", live = true, token = "", view = "all";
const byKey = (k) => tasks.find((t) => t.k === k);
const inView = () => (view === "all" ? tasks : tasks.filter((t) => t.project === view));
const pending = new Map(); // key -> { kind, ids, until, timer }: waiting out the undo window
const busy = new Map();    // key -> text: request sent, waiting for the answer
const results = new Map(); // key -> { cls, text, at }
const prs = new Map();     // task id -> { at, body } | { at, loading: true }
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
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
      if (key && busy.has(key)) { busy.set(key, "Merge in progress… waiting for it to finish, then this one goes"); render(); }
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
const VERB = { approve: "Approving", merge: "Merging", queue: "Running the queue" };
async function fire(key) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  busy.set(key, p.kind === "approve" ? "Approving…" : "Merging: waiting for checks to settle, then merging…");
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

// The PR state shown on approved cards, read through the board (which caches it).
function prLine(t) {
  const p = prs.get(t.k);
  if (!p || (!p.loading && Date.now() - p.at > 15000)) {
    prs.set(t.k, { at: Date.now(), loading: true });
    get(taskPath(t, "pr")).then((body) => { prs.set(t.k, { at: Date.now(), body }); render(); },
      () => { prs.set(t.k, { at: Date.now(), body: { readable: false, reason: "couldn't read the PR" } }); render(); });
  }
  const b = p && p.body;
  if (!b) return el("span", "prs", "reading the PR…");
  if (!b.readable) return el("span", "prs red", b.reason);
  let cls = b.checks.kind, text;
  if (b.mergeable === "CONFLICTING") { cls = "red"; text = "conflicts with main"; }
  else if (!b.atVerified) { cls = "red"; text = "moved since it was verified"; }
  else if (b.checks.kind === "green") text = "checks green, " + (b.mergeable === "MERGEABLE" ? "mergeable" : "mergeable: " + b.mergeable.toLowerCase());
  else if (b.checks.kind === "pending") text = "checks pending";
  else text = "checks red";
  const s = el("span", "prs " + cls, text);
  if (b.checks.reason) s.title = b.checks.reason;
  return s;
}

function actionArea(t) {
  const box = el("div", "act");
  const key = t.k, laneKey = t.status === "needs_approval" ? "lane:approve" : null;
  const p = pending.get(key) || (laneKey && pending.get(laneKey) && pending.get(laneKey).ids.includes(t.k) ? pending.get(laneKey) : null);
  const a = nextAction(t, canAct(), !S.canApprove);
  if (t.status === "approved" && prNumber(t.pr)) box.append(prLine(t));
  if (p) box.append(undoBar(pending.get(key) ? key : laneKey, p));
  else if (busy.has(key)) box.append(el("span", "busy", busy.get(key)));
  else if (a.kind === "approve" || a.kind === "merge") {
    // Merge is the strong button only when the PR looks mergeable; otherwise it reads as a try.
    const pb = prs.get(t.k) && prs.get(t.k).body;
    const strong = a.kind === "approve" || (pb && pb.readable && pb.atVerified && pb.checks.kind === "green" && pb.mergeable === "MERGEABLE");
    const b = el("button", "btn " + (strong ? a.kind : "quiet"), a.label);
    b.type = "button";
    b.dataset.kbd = a.kind === "approve" ? "a" : "m";
    if (a.disabled) { b.disabled = true; b.title = a.disabled; }
    b.addEventListener("click", (e) => { e.stopPropagation(); schedule(key, a.kind, [t.k]); });
    box.append(b);
    if (a.disabled) box.append(el("span", "why", a.disabled));
  } else if (a.kind === "wait") box.append(el("span", "wait", a.label));
  const r = results.get(key);
  if (r) box.append(el("div", "out " + r.cls, r.text));
  return box.childNodes.length ? box : null;
}
function undoBar(key, p) {
  const bar = el("div", "undo");
  const fill = el("div", "fill");
  // Negative delay: a re-render picks the drain up where it was.
  fill.style.animationDuration = UNDO_MS + "ms";
  fill.style.animationDelay = -(UNDO_MS - Math.max(0, p.until - Date.now())) + "ms";
  const what = p.kind === "approve" ? (p.ids.length > 1 ? "Approving " + p.ids.length + " tasks" : "Approving")
    : p.kind === "merge" ? "Merging " + (prNumber((byKey(p.ids[0]) || {}).pr) || (byKey(p.ids[0]) || { id: p.ids[0] }).id) : "Running the queue";
  const b = el("button", "", "Undo");
  b.type = "button";
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
function visible() { return S.lanes.flatMap((l) => inView().filter((t) => t.status === l && matches(t))); }

function card(t, now) {
  const c = el("article", "card" + (t.status === "needs_approval" ? " attn" : t.status === "approved" ? " go" : "") + (sel === t.k ? " sel" : ""));
  c.tabIndex = 0;
  c.dataset.id = t.k;
  const top = el("div", "top");
  const when = el("time", "", ago(t.updatedAt, now));
  when.title = new Date(t.updatedAt).toLocaleString();
  top.append(el("span", "id", t.id));
  if (multi && view === "all") top.append(el("span", "proj", t.project));
  top.append(when);
  c.append(top, el("div", "title", t.title));
  const meta = el("div", "meta");
  meta.append(el("span", "risk " + t.risk, t.risk));
  if (t.assignee) meta.append(el("span", "", "@" + t.assignee));
  const n = prNumber(t.pr);
  if (n) {
    const a = el("a", "", n);
    a.href = t.pr; a.rel = "noopener noreferrer"; a.target = "_blank";
    a.addEventListener("click", (e) => e.stopPropagation());
    meta.append(a);
  }
  c.append(meta);
  const act = actionArea(t);
  if (act) c.append(act);
  c.addEventListener("click", () => { sel = t.k; openTask(t.k); });
  c.addEventListener("focus", () => { if (sel !== t.k) { sel = t.k; markSel(); } });
  return c;
}
function markSel() { for (const c of document.querySelectorAll(".card")) c.classList.toggle("sel", c.dataset.id === sel); }

function render() {
  const main = $("main"), now = Date.now();
  const focused = document.activeElement && document.activeElement.classList.contains("card") ? document.activeElement.dataset.id : null;
  const scroll = new Map([...main.querySelectorAll(".lane")].map((l) => [l.dataset.lane, l.querySelector(".cards").scrollTop]));
  const sx = main.scrollLeft;
  main.replaceChildren();
  const shown = visible();
  const mine = inView();
  switcher();
  if (!mine.length || !shown.length) {
    const b = el("div", "blank");
    if (!mine.length) {
      b.append(el("h2", "", "No tasks yet"), el("p", "", "Add one from the terminal, and it shows up here:"));
      const p = el("p"); p.append(el("code", "", 'fm add "What to build" --check "cmd: bun test" --ready')); b.append(p);
    } else b.append(el("h2", "", "Nothing matches “" + filter + "”"), el("p", "", "Press Esc to clear the filter."));
    main.append(b);
  } else for (const lane of S.lanes) {
    const ts = shown.filter((t) => t.status === lane);
    const mark = ts.length && lane === "needs_approval" ? " attn" : ts.length && lane === "approved" ? " go" : "";
    const sec = el("section", "lane" + (ts.length ? "" : " empty") + mark);
    sec.dataset.lane = lane;
    sec.setAttribute("aria-label", NAMES[lane]);
    const head = el("div", "lane-head");
    head.append(el("h2", "", NAMES[lane]), el("span", "n", ts.length));
    if (lane === "needs_approval" && ts.length > 1) head.append(laneButton("lane:approve", "approve", "Approve all " + ts.length, ts.map((t) => t.k)));
    if (lane === "approved" && ts.length) head.append(laneButton("queue", "queue", "Run queue", ts.map((t) => t.k)));
    sec.append(head);
    if (lane === "approved") {
      const p = pending.get("queue"), r = results.get("queue");
      if (p || busy.has("queue") || r) {
        const o = el("div", "lane-out");
        if (p) o.append(undoBar("queue", p));
        else if (busy.has("queue")) o.append(el("div", "busy", "Running the queue: one pass, at most one merge…"));
        if (r) o.append(el("div", "out " + r.cls, r.text));
        sec.append(o);
      }
    }
    if (!ts.length) sec.append(el("div", "lane-note", EMPTY[lane] || "Empty"));
    const list = el("div", "cards");
    for (const t of ts) list.append(card(t, now));
    sec.append(list);
    main.append(sec);
    list.scrollTop = scroll.get(lane) || 0;
  }
  main.scrollLeft = sx;
  // First paint: bring the lanes that wait for the person into view.
  if (!render.done) {
    render.done = true;
    const lane = main.querySelector(".lane.attn") || main.querySelector(".lane.go");
    if (lane && innerWidth > 640 && lane.getBoundingClientRect().right > innerWidth) main.scrollLeft = lane.offsetLeft - 16;
  }
  const waiting = mine.filter((t) => t.status === "needs_approval").length, toMerge = mine.filter((t) => t.status === "approved").length;
  $("#n-attn").replaceChildren(el("b", "", waiting), document.createTextNode(" to sign off"));
  $("#n-go").replaceChildren(el("b", "", toMerge), document.createTextNode(" to merge"));
  if (focused) { const c = main.querySelector('.card[data-id="' + CSS.escape(focused) + '"]'); if (c) c.focus({ preventScroll: true }); }
  if (openId) { const t = byKey(openId); const slot = $("#detail-act"); if (t && slot) slot.replaceChildren(...[actionArea(t)].filter(Boolean)); }
}
// The project switcher: All, then each project, each with what waits for the person there.
function switcher() {
  const nav = $("#projects");
  nav.hidden = !multi;
  if (!multi) return;
  const mk = (value, name) => {
    const ts = value === "all" ? tasks : tasks.filter((t) => t.project === value);
    const n = ts.filter((t) => t.status === "needs_approval" || t.status === "approved").length;
    const b = el("button", "tab" + (view === value ? " on" : ""), name);
    b.type = "button";
    b.dataset.project = value;
    b.setAttribute("aria-pressed", String(view === value));
    if (n) { const c = el("span", "n", n); c.title = n + " waiting for you"; b.append(c); }
    b.addEventListener("click", () => { view = value; setHash(value === "all" ? "" : "#p=" + encodeURIComponent(value)); render(); });
    return b;
  };
  nav.replaceChildren(mk("all", "All"), ...PROJECTS.map((n) => mk(n, n)));
}
function laneButton(key, kind, label, ids) {
  const b = el("button", "btn quiet", label);
  b.type = "button";
  b.disabled = !canAct() || pending.has(key) || busy.has(key);
  if (!canAct()) b.title = S.canApprove ? "open the link fm serve printed" : "read-only board";
  b.addEventListener("click", () => schedule(key, kind, ids));
  return b;
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
let liveTimer = 0;
async function openTask(id) {
  openId = id;
  const k = byKey(id);
  if (!k) return;
  setHash(hashFor(k));
  let d;
  try { d = await get(proj(k.project) + "/tasks/" + encodeURIComponent(k.id)); } catch (e) { return; }
  if (openId !== id) return;
  const t = d.task, p = $("#detail");
  const keepScroll = p.hidden ? 0 : p.scrollTop;
  p.replaceChildren();
  const bar = el("div", "bar");
  const close = el("button", "btn quiet", "Close");
  close.type = "button";
  close.addEventListener("click", closeTask);
  bar.append(el("span", "", (multi ? k.project + " / " : "") + t.id + "  " + NAMES[t.status]), close);
  p.append(bar, el("h2", "", t.title));
  const meta = el("div", "meta");
  meta.append(el("span", "risk " + t.risk, t.risk));
  if (t.assignee) meta.append(el("span", "", "@" + t.assignee));
  if (t.branch) meta.append(el("span", "", t.branch));
  const u = t.pr && safeUrl(t.pr);
  if (u) { const a = el("a", "", prNumber(t.pr) || t.pr); a.href = u; a.rel = "noopener noreferrer"; a.target = "_blank"; meta.append(a); }
  else if (t.pr) meta.append(el("span", "", t.pr));
  p.append(meta);
  const slot = el("div");
  slot.id = "detail-act";
  const act = actionArea({ ...k, status: t.status, pr: t.pr, assignee: t.assignee });
  if (act) slot.append(act);
  p.append(slot, el("h3", "", "Spec"), el("pre", "spec", t.spec || "(none)"));
  p.append(el("h3", "", "Acceptance checks"));
  const ul = el("ul", "checks");
  for (const c of d.checks) {
    const li = el("li");
    const head = el("div", "head");
    const v = c.verdict;
    head.append(el("span", "", c.id + " " + c.kind), el("span", "v " + (v ? (v.pass ? "pass" : "fail") : "pending"), v ? (v.pass ? "pass" : "fail") : "no verdict yet"));
    li.append(head, el("div", "", c.text));
    if (v) li.append(el("div", "ev", v.evidence + "\\n" + v.by + ", " + new Date(v.at).toLocaleString()));
    ul.append(li);
  }
  p.append(ul);
  let anyLive = false;
  for (const s of d.sessions || []) {
    if (s.live) anyLive = true;
    p.append(el("h3", "", s.role + (s.live ? " (running)" : "") + "  " + s.turns + " turns, $" + s.costUsd.toFixed(2)));
    p.append(el("pre", "ev", s.lines.length ? s.lines.map((l) => (l.kind === "result" ? "  -> " : l.kind === "tool" ? "> " : "# ") + l.text).join("\n") : "(no activity yet)"));
  }
  clearTimeout(liveTimer);
  if (anyLive) liveTimer = setTimeout(() => { if (openId === id) openTask(id); }, 3000);
  p.append(el("h3", "", "History"));
  const hl = el("ul", "hist");
  for (const e of d.events.slice().reverse()) {
    const li = el("li");
    const tm = el("time", "", ago(e.at, Date.now()));
    tm.title = new Date(e.at).toLocaleString();
    li.append(tm, el("strong", "", e.type.replace(/_/g, " ")), document.createTextNode(" by " + e.actor + " (" + e.actorKind + ")"));
    const s = summary(e);
    if (s) li.append(el("div", "ev", s));
    hl.append(li);
  }
  p.append(hl);
  p.hidden = false;
  $("#scrim").hidden = false;
  p.scrollTop = keepScroll;
}
function closeTask() {
  clearTimeout(liveTimer);
  openId = null; $("#detail").hidden = true; $("#scrim").hidden = true;
  setHash(view === "all" || !multi ? "" : "#p=" + encodeURIComponent(view));
  const c = sel && document.querySelector('.card[data-id="' + CSS.escape(sel) + '"]');
  if (c) c.focus();
}
function help(show) { $("#help").hidden = !show; $("#scrim").hidden = !show && !openId; }

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
  $("#livetext").textContent = on ? "live" : "offline";
}

function move(step) {
  const v = visible();
  if (!v.length) return;
  const i = v.findIndex((t) => t.id === sel);
  const next = v[Math.min(v.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
  sel = next.id;
  markSel();
  const c = document.querySelector('.card[data-id="' + CSS.escape(sel) + '"]');
  if (c) { c.focus({ preventScroll: true }); c.scrollIntoView({ block: "nearest", inline: "nearest" }); }
}
function current() { return byKey(openId || sel); }
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === "Escape") {
    if (!$("#help").hidden) help(false);
    else if (openId) closeTask();
    else if (filter || typing) { $("#filter").value = ""; filter = ""; $("#filter").blur(); render(); }
    return;
  }
  if (typing) return;
  const t = current();
  if (e.key === "/") { e.preventDefault(); $("#filter").focus(); }
  else if (e.key === "?") help($("#help").hidden);
  else if (e.key === "j") move(1);
  else if (e.key === "k") move(-1);
  else if (e.key === "u") undoLast();
  else if (e.key === "Enter" && e.target.classList && e.target.classList.contains("card")) openTask(e.target.dataset.id);
  else if (e.key === "a" && t && nextAction(t, canAct(), !S.canApprove).kind === "approve") schedule(t.k, "approve", [t.k]);
  else if (e.key === "m" && t && nextAction(t, canAct(), !S.canApprove).kind === "merge") schedule(t.k, "merge", [t.k]);
});
$("#filter").addEventListener("input", (e) => { filter = e.target.value.trim(); render(); });
$("#help-open").addEventListener("click", () => help(true));
$("#help-close").addEventListener("click", () => help(false));
$("#scrim").addEventListener("click", () => { if (!$("#help").hidden) help(false); else closeTask(); });
const dl = $("#help dl");
for (const [k, v] of SHORTCUTS) { const dt = el("dt"); dt.append(el("kbd", "", k)); dl.append(dt, el("dd", "", v)); }
notice();
render();
setInterval(render, 30000);
setTimeout(poll, 2000);
{
  const h = parseHash(location.hash);
  if (h.project && PROJECTS.includes(h.project)) view = h.project;
  if (h.id) {
    const t = tasks.find((x) => x.id === h.id && (!h.project || x.project === h.project)) || tasks.find((x) => x.id === h.id);
    if (t) { sel = t.k; openTask(t.k); }
  }
  render();
}
`;

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
<header>
<h1 class="brand">foreman <small>127.0.0.1</small></h1>
<label class="filter"><input id="filter" type="search" placeholder="Filter by project, id, title, person, status" aria-label="Filter tasks" autocomplete="off"><kbd>/</kbd></label>
<div class="yours"><span class="n-attn" id="n-attn"></span><span class="n-go" id="n-go"></span>
<span class="live"><i id="live" class="dot"></i><span id="livetext">live</span></span>
<button type="button" class="icon" id="help-open" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button></div>
</header>
<nav id="projects" class="projects" aria-label="Projects" hidden></nav>
<p class="notice" id="notice" hidden></p>
<main></main>
<div class="scrim" id="scrim" hidden></div>
<aside id="detail" hidden aria-label="Task detail"></aside>
<div id="help" role="dialog" aria-label="Keyboard shortcuts" hidden><h2>Keyboard shortcuts</h2><dl></dl>
<p class="why">Approve and merge wait ${UNDO_SECONDS} seconds before they're sent, with Undo.</p>
<button type="button" class="btn quiet" id="help-close">Close</button></div>
<script type="application/json" id="initial">${scriptJson(initial)}</script>
<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}
