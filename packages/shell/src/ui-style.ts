/**
 * Hand-written stylesheet for the server-rendered UI ("landing control tower").
 * One signal colour (approach-light amber) is reserved for LANDED lanes and ancestor proofs;
 * every other state is told apart by label + glyph shape, not by colour.
 */
export const STYLES = `
:root {
  color-scheme: dark light;
  --bg: #12161f; --surface: #191e29; --raise: #202634; --line: #2a3140; --line-2: #3a4356;
  --ink: #e9ecf2; --ink-2: #b4bccb; --ink-3: #8e97aa;
  --signal: #f4b740; --signal-fill: #f4b740; --signal-ink: #1c1404;
  --signal-wash: rgba(244, 183, 64, 0.09); --signal-line: rgba(244, 183, 64, 0.42);
  --alert: #ff8f80; --alert-wash: rgba(255, 143, 128, 0.1); --alert-line: rgba(255, 143, 128, 0.38);
  --focus: #9dbcff;
  --sans: Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px;
  --r1: 3px; --r2: 6px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #eceef2; --surface: #ffffff; --raise: #f5f6f9; --line: #d7dbe3; --line-2: #c0c6d1;
    --ink: #141820; --ink-2: #3d4554; --ink-3: #566073;
    --signal: #845300; --signal-fill: #f0ae2e; --signal-ink: #1c1404;
    --signal-wash: rgba(240, 174, 46, 0.14); --signal-line: rgba(176, 116, 0, 0.5);
    --alert: #b3261e; --alert-wash: rgba(179, 38, 30, 0.07); --alert-line: rgba(179, 38, 30, 0.35);
    --focus: #2456d6;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink);
  font: 15px/1.45 var(--sans); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
code, .mono { font-family: var(--mono); font-size: 0.86em; letter-spacing: -0.01em; }
h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -0.01em; }
p { margin: 0; }
ul, ol { margin: 0; padding: 0; list-style: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--r1); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.muted { color: var(--ink-3); }
.skip { position: absolute; left: var(--s4); top: -40px; background: var(--ink); color: var(--bg); padding: var(--s2) var(--s3); z-index: 10; }
.skip:focus { top: var(--s2); }

/* top bar */
.top {
  display: flex; align-items: center; gap: var(--s5); height: 52px; padding: 0 var(--s5);
  border-bottom: 1px solid var(--line); background: var(--bg); position: sticky; top: 0; z-index: 5;
}
.mark { display: inline-flex; align-items: baseline; gap: 6px; font-weight: 700; font-size: 18px; text-decoration: none; letter-spacing: -0.02em; }
.mark b { color: var(--signal); font-weight: 600; font-size: 20px; line-height: 1; }
.crumbs ol { display: flex; gap: var(--s2); color: var(--ink-3); }
.crumbs li + li::before { content: "/"; margin-right: var(--s2); color: var(--line-2); }
.crumbs [aria-current] { color: var(--ink); }
.top-r { margin-left: auto; display: flex; align-items: center; gap: var(--s4); }
.live { display: inline-flex; align-items: center; gap: var(--s2); color: var(--ink-3); font-size: 13px; }
.live i { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
.live[data-live="on"] i { background: var(--ink); }
.live[data-live="off"] { color: var(--alert); }
.live[data-live="off"] i { background: var(--alert); }
.live.beat i { animation: beat 0.9s ease-out; }
@keyframes beat { 0% { box-shadow: 0 0 0 0 var(--ink-3); } 100% { box-shadow: 0 0 0 6px transparent; } }

/* buttons */
.btn {
  font: inherit; font-size: 13px; font-weight: 600; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 var(--s3);
  border-radius: var(--r1); border: 1px solid var(--line-2); background: transparent; color: var(--ink);
}
.btn:hover { background: var(--raise); }
.btn.primary { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.btn.primary:hover { opacity: 0.88; }
.btn.quiet { border-color: transparent; color: var(--ink-3); padding: 0 var(--s2); }
.btn.quiet:hover { color: var(--ink); background: transparent; text-decoration: underline; text-underline-offset: 3px; }
.btn[disabled] { opacity: 0.5; cursor: progress; }
.keybtn[data-set="1"] i { background: var(--ink); }
.keybtn i { width: 6px; height: 6px; border-radius: 50%; background: transparent; border: 1px solid var(--ink-3); }

/* state glyphs: shape carries the state, colour stays restrained */
.g { display: inline-block; flex: none; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--ink-2); }
.g[data-g="PUSHED"] { box-shadow: inset 3.5px 0 0 var(--ink-2); }
.g[data-g="READY"] { background: var(--ink); border-color: var(--ink); }
.g[data-g="LANDING"] { background: var(--signal-fill); border-color: var(--signal-fill); animation: landing 1.2s ease-in-out infinite alternate; }
.g[data-g="LANDED"] { border-radius: 1px; background: var(--signal-fill); border-color: var(--signal-fill); }
.g[data-g="BEHIND"] { width: 0; height: 0; border-radius: 0; border: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 9px solid var(--alert); }
.g[data-g="FAILED"] { width: 8px; height: 8px; border-radius: 0; border: 0; background: var(--alert); transform: rotate(45deg); }
.g[data-g="ARCHIVED"] { width: 10px; height: 0; border-radius: 0; border-width: 1.5px 0 0; border-color: var(--ink-3); }
@keyframes landing { to { opacity: 0.35; } }

/* board header strip */
.strip { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3) var(--s6); padding: var(--s5) var(--s5) var(--s4); }
.strip h1 { font-size: 26px; line-height: 1.1; }
.head { display: inline-flex; align-items: baseline; gap: var(--s2); color: var(--ink-2); }
.head code { color: var(--ink); font-size: 14px; }
.tally { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s4); color: var(--ink-2); font-size: 14px; }
.tally li { display: inline-flex; align-items: center; gap: 7px; }
.tally b { color: var(--ink); font-weight: 650; }
.tally li[data-zero] { color: var(--ink-3); }
.tally li[data-zero] b { color: var(--ink-3); font-weight: 400; }
.queue { color: var(--ink-2); font-size: 14px; display: inline-flex; gap: var(--s2); align-items: baseline; }
.queue ol { display: inline-flex; gap: var(--s2); }
.queue li + li::before { content: "then "; color: var(--ink-3); }

/* board grid */
.deck { display: grid; grid-template-columns: minmax(0, 1fr) 19rem; gap: var(--s5); padding: 0 var(--s5) var(--s7); align-items: start; }
.cols { display: grid; gap: var(--s3); align-items: start; min-width: 0; }
.col { min-width: 0; }
.col-h {
  display: flex; align-items: center; gap: var(--s2); height: 36px; padding: 0 var(--s1);
  border-bottom: 1px solid var(--line); margin-bottom: var(--s3); font-size: 14px;
}
.col-h .n { margin-left: auto; color: var(--ink-3); font-weight: 400; }
.col[data-col="LANDED"] .col-h { border-bottom-color: var(--signal-line); }
.stack { display: grid; gap: var(--s2); }
.rail { align-self: stretch; border: 1px dashed var(--line); border-radius: var(--r2); min-height: 220px; }
.rail .col-h { writing-mode: vertical-rl; height: auto; border: 0; margin: 0; padding: var(--s3) 0; width: 100%; justify-content: flex-start; align-items: center; color: var(--ink-3); font-weight: 500; }
.rail .col-h .n { margin: var(--s2) 0 0; }
.rail .g { transform: rotate(90deg); }
.rail .g[data-g="FAILED"] { transform: rotate(135deg); }

/* lane card */
.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r2);
  padding: var(--s3); display: grid; gap: var(--s2);
}
.card[data-state="LANDED"] { border-color: var(--signal-line); }
.card[data-state="FAILED"], .card[data-state="BEHIND"] { border-color: var(--alert-line); }
.card-top { display: flex; align-items: baseline; gap: var(--s2); font-size: 13px; color: var(--ink-3); }
.card-top .id { color: var(--ink); font-weight: 700; font-size: 14px; text-decoration: none; }
.card-top .id:hover { text-decoration: underline; }
.card-top .task { margin-left: auto; }
.intent { font-size: 15px; line-height: 1.35; color: var(--ink); overflow-wrap: anywhere; }
.fork { font-size: 12.5px; color: var(--ink-3); overflow-wrap: anywhere; }
.fork code { font-size: 12px; color: var(--ink-2); }
.facts { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); font-size: 12.5px; color: var(--ink-3); }
.facts code { color: var(--ink-2); }
.chips { display: flex; flex-wrap: wrap; gap: var(--s1); }
.chip {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 2px 7px;
  border-radius: var(--r1); border: 1px solid var(--line-2); font-size: 12px; line-height: 1.35; color: var(--ink-2);
  overflow-wrap: anywhere;
}
.chip[data-tone="alert"] { color: var(--alert); border-color: var(--alert-line); background: var(--alert-wash); }
.chip[data-tone="ok"] { color: var(--ink-2); border-style: solid; }
.chip code { font-size: 11.5px; }
.note { font-size: 12.5px; color: var(--alert); overflow-wrap: anywhere; }
.acts { display: flex; gap: var(--s1); justify-content: flex-end; align-items: center; padding-top: var(--s1); }
.acts .btn.quiet { margin-right: auto; padding-left: 0; font-weight: 500; }
.empty { color: var(--ink-3); font-size: 13px; padding: var(--s2) var(--s1); }

/* the ancestor proof: the product's core claim */
.proof {
  display: grid; gap: 3px; padding: var(--s2) var(--s3); margin: 0 calc(-1 * var(--s1));
  border-radius: var(--r1); background: var(--signal-wash); border-left: 2px solid var(--signal-fill);
}
.proof code { font-size: 14.5px; color: var(--signal); letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proof .sup { font-family: var(--sans); font-size: 17px; margin: 0 5px; }
.proof small { font-size: 12px; color: var(--ink-3); }
.proof.big { padding: var(--s4) var(--s5); gap: var(--s1); margin: 0; }
.proof.big code { font-size: 26px; }
.proof.big .sup { font-size: 30px; margin: 0 var(--s3); }
.proof.big small { font-size: 13.5px; }

/* activity log */
.log { border-left: 1px solid var(--line); padding-left: var(--s4); min-width: 0; }
.log .col-h .n { font-size: 13px; }
.log ol { display: grid; gap: 2px; font-size: 13px; }
.log li { display: grid; grid-template-columns: 4.6em 1fr; column-gap: var(--s2); padding: 3px 0; color: var(--ink-2); }
.log time { color: var(--ink-3); }
.log .ev { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.log .ev a { color: var(--ink); text-decoration: none; font-weight: 600; }
.log .ev a:hover { text-decoration: underline; }
.log .d { grid-column: 2; color: var(--ink-3); font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log li[data-kind="lane.landed"] .k { color: var(--signal); font-weight: 600; }
.log li[data-kind="lane.behind"] .k, .log li[data-kind="lane.failed"] .k { color: var(--alert); }

/* change highlight: only cards whose state changed since the last refresh */
.moved { animation: moved 1.8s ease-out; }
.moved[data-state="LANDED"] { animation-name: moved-landed; }
@keyframes moved { from { background: var(--raise); border-color: var(--ink-3); } }
@keyframes moved-landed { from { background: var(--signal-wash); border-color: var(--signal-fill); } }

/* pages: lane detail + candidates */
.page { padding: var(--s6) var(--s5) var(--s7); max-width: 1680px; }
.page-h { display: grid; gap: var(--s2); margin-bottom: var(--s5); }
.page-h h1 { font-size: 28px; line-height: 1.15; max-width: 48ch; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s4); color: var(--ink-2); font-size: 14px; }
.state { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; color: var(--ink); }
.split { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: var(--s6); align-items: start; }
.panel { display: grid; gap: var(--s5); }
.sec h2 { font-size: 15px; padding-bottom: var(--s2); border-bottom: 1px solid var(--line); margin-bottom: var(--s3); display: flex; gap: var(--s2); align-items: baseline; }
.sec h2 .n { color: var(--ink-3); font-weight: 400; }
.dl { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: var(--s2) var(--s4); margin: 0; font-size: 14px; }
.dl dt { color: var(--ink-3); }
.dl dd { margin: 0; overflow-wrap: anywhere; }
.ticks { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s4); }
.ticks span[data-ok="0"] { color: var(--alert); }
.ticks span[data-ok="-"] { color: var(--ink-3); }
.files li { display: flex; gap: var(--s2); align-items: baseline; padding: 3px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.files li:last-child { border-bottom: 0; }
.files li code { overflow-wrap: anywhere; }
.files li[data-drift] code { color: var(--alert); }
.files li[data-drift]::after { content: "outside claims"; margin-left: auto; color: var(--alert); font-size: 12px; white-space: nowrap; }
.ok-line { color: var(--ink); display: flex; align-items: center; gap: var(--s2); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--ink-3); font-size: 13px; padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line-2); white-space: nowrap; }
td { padding: var(--s3); border-bottom: 1px solid var(--line); vertical-align: middle; }
th.num, td.num { text-align: right; }
tr[data-winner] td { background: var(--raise); }
tr[data-winner] td:first-child { box-shadow: inset 2px 0 0 var(--ink); }
.yes { color: var(--ink); }
.no { color: var(--alert); }
.score { display: inline-flex; align-items: center; gap: var(--s2); justify-content: flex-end; }
.tag { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: var(--r1); background: var(--ink); color: var(--bg); font-size: 12px; font-weight: 700; }
.lede { color: var(--ink-2); max-width: 70ch; }

/* toasts + dialog */
.toasts { position: fixed; right: var(--s5); bottom: var(--s5); display: grid; gap: var(--s2); z-index: 20; max-width: min(28rem, calc(100vw - 32px)); }
.toast { background: var(--raise); color: var(--ink); border: 1px solid var(--line-2); border-left: 3px solid var(--ink-2); border-radius: var(--r1); padding: var(--s3) var(--s4); font-size: 14px; animation: toast-in 0.18s ease-out; }
.toast[data-tone="err"] { border-left-color: var(--alert); }
.toast[data-tone="err"] b { color: var(--alert); }
@keyframes toast-in { from { transform: translateY(6px); opacity: 0; } }
dialog { border: 1px solid var(--line-2); border-radius: var(--r2); background: var(--surface); color: var(--ink); padding: var(--s5); width: min(30rem, calc(100vw - 32px)); }
dialog::backdrop { background: rgba(8, 10, 14, 0.6); }
dialog form { display: grid; gap: var(--s3); }
dialog h2 { font-size: 18px; }
dialog p { color: var(--ink-2); font-size: 14px; }
dialog label { font-size: 13px; color: var(--ink-2); }
dialog input { font: 14px var(--mono); padding: var(--s2) var(--s3); border-radius: var(--r1); border: 1px solid var(--line-2); background: var(--bg); color: var(--ink); }
.row { display: flex; gap: var(--s2); align-items: center; margin-top: var(--s2); }
.row .grow { flex: 1; }

/* landing */
.land { max-width: 1180px; padding: var(--s8) var(--s5) var(--s7); margin: 0 auto; display: grid; gap: var(--s7); }
.hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 33rem); gap: var(--s5) var(--s8); align-items: end; }
.pitch { display: grid; gap: var(--s5); }
.hero h1 { font-size: clamp(34px, 4.4vw, 56px); line-height: 1.04; letter-spacing: -0.03em; max-width: 17ch; font-weight: 700; }
.hero .lede { font-size: 18px; line-height: 1.5; max-width: 58ch; }
.specimen { display: grid; gap: var(--s3); margin: 0; }
.specimen figcaption { color: var(--ink-3); font-size: 14px; max-width: 46ch; }
.steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s5); counter-reset: step; }
.steps li { counter-increment: step; display: grid; gap: var(--s2); align-content: start; padding-top: var(--s3); border-top: 1px solid var(--line-2); }
.steps li::before { content: counter(step); font-weight: 700; color: var(--ink-3); font-size: 14px; }
.steps h2 { font-size: 18px; }
.steps p { color: var(--ink-2); font-size: 15px; }
.projects h2 { font-size: 18px; margin-bottom: var(--s3); }
.projects ul { border-top: 1px solid var(--line); }
.projects li { display: flex; align-items: baseline; gap: var(--s4); padding: var(--s3) 0; border-bottom: 1px solid var(--line); }
.projects li a { font-weight: 650; font-size: 17px; }
.projects li code { color: var(--ink-3); }
.foot { color: var(--ink-3); font-size: 14px; display: flex; gap: var(--s5); flex-wrap: wrap; }

@media (max-width: 1500px) {
  .deck { grid-template-columns: minmax(0, 1fr); }
  .log { border-left: 0; padding-left: 0; }
  .log ol { grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr)); column-gap: var(--s5); }
}
@media (max-width: 1100px) {
  .cols { grid-template-columns: minmax(0, 1fr) !important; }
  .rail { min-height: 0; }
  .rail .col-h { writing-mode: horizontal-tb; padding: var(--s2) var(--s3); }
  .rail .col-h .n { margin: 0 0 0 auto; }
  .rail .g, .rail .g[data-g="FAILED"] { transform: none; }
  .split, .steps, .hero { grid-template-columns: minmax(0, 1fr); }
  .proof.big code { font-size: 18px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
