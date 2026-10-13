import type { CandidateRow, CheckResult, Lane, LaneState, Readiness, Reason } from "@hamonn/core";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { normalizeError } from "./errors.ts";
import type { ProjectEvent } from "./ports.ts";
import type { Board, Service } from "./service.ts";
import { CLIENT_JS } from "./ui-client.ts";
import { STYLES } from "./ui-style.ts";

export const REPO_URL = "https://github.com/kelvindesman/hamonn";
const HTMX_SRC = "https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js";
const HTMX_SRI = "sha384-HGfztofotfshcF7+8n44JQL2oJmowVChPTg48S+jvZoztPfvwD79OC/LTtG6dMp+";

const COLUMNS: LaneState[] = ["OPEN", "PUSHED", "READY", "BEHIND", "LANDED"];
const EXTRA: LaneState[] = ["LANDING", "FAILED", "ARCHIVED"];

export const STATE_LABEL: Record<LaneState, string> = {
  OPEN: "Open",
  PUSHED: "Pushed",
  READY: "Ready",
  LANDING: "Landing",
  LANDED: "Landed",
  BEHIND: "Behind",
  FAILED: "Failed",
  ARCHIVED: "Archived",
};

/** Reasons that mean "something is wrong" rather than "something is still to do". */
const ALERT_REASONS = new Set<Reason["code"]>(["CHECK_FAILING", "DRIFT"]);

export function reasonText(r: Reason): string {
  switch (r.code) {
    case "WRONG_STATE":
      return `state ${r.state}`;
    case "NO_PUSH":
      return "nothing pushed yet";
    case "CHECK_MISSING":
      return `check ${r.name}: missing`;
    case "CHECK_FAILING":
      return `check ${r.name}: failing`;
    case "CHECK_PENDING":
      return `check ${r.name}: pending`;
    case "INTENT_MISSING":
      return ".lane/intent.md missing";
    case "HANDOFF_MISSING":
      return ".lane/handoff.md missing";
    case "DRIFT":
      return `drift: ${r.paths.join(", ")}`;
    case "GATE_UNSIGNED":
      return "gate: needs sign-off";
  }
}

const SHA = /^[0-9a-f]{40}$/;
const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 7) : "–");
/** UTC wall-clock time from unix milliseconds, e.g. `14:02:11`. */
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const doc = (node: unknown) => `<!doctype html>${String(node)}`;

interface Crumb {
  label: string;
  href?: string;
}

function Glyph(props: { state: LaneState }) {
  return <span class="g" data-g={props.state} aria-hidden="true" />;
}

function Head(props: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="dark light" />
      <title>{props.title}</title>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
    </head>
  );
}

function Layout(props: { title: string; crumbs: Crumb[]; refresh: string; children?: Child }) {
  return (
    <html lang="en">
      <Head title={props.title} />
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <header class="top">
          <a class="mark" href="/" aria-label="hamonn home">
            <b aria-hidden="true">⊇</b>hamonn
          </a>
          <nav class="crumbs" aria-label="Breadcrumb">
            <ol>
              {props.crumbs.map((c) => (
                <li>
                  {c.href ? <a href={c.href}>{c.label}</a> : <span aria-current="page">{c.label}</span>}
                </li>
              ))}
            </ol>
          </nav>
          <div class="top-r">
            <span id="live" class="live" data-live="on" title="Refreshes every 2 seconds">
              <i aria-hidden="true" />
              <span>Live</span>
            </span>
            <button type="button" id="keybtn" class="btn keybtn" data-key-open="1" data-set="0">
              <i aria-hidden="true" />
              Admin key
            </button>
          </div>
        </header>
        <main
          id="main"
          hx-get={props.refresh}
          hx-trigger="every 2s, refresh from:body"
          hx-swap="innerHTML settle:0ms"
        >
          {props.children}
        </main>
        <div id="toasts" class="toasts" role="status" aria-live="polite" />
        <dialog id="keydlg" aria-labelledby="keydlg-h">
          <form method="dialog">
            <h2 id="keydlg-h">Admin key</h2>
            <p>
              Signing, landing, archiving and picking a winner need the server's <code>HAMONN_ADMIN_KEY</code>
              . The key stays in this browser's local storage.
            </p>
            <label for="keyin">Key</label>
            <input id="keyin" type="password" autocomplete="off" spellcheck={false} />
            <div class="row">
              <button type="submit" value="clear" class="btn quiet">
                Forget key
              </button>
              <span class="grow" />
              <button type="submit" value="cancel" class="btn" formnovalidate>
                Cancel
              </button>
              <button type="submit" value="save" class="btn primary">
                Save key
              </button>
            </div>
          </form>
        </dialog>
        <script src={HTMX_SRC} integrity={HTMX_SRI} crossorigin="anonymous" />
        <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
      </body>
    </html>
  );
}

function Act(props: {
  id: string;
  url: string;
  done: string;
  body?: unknown;
  kind?: "primary" | "quiet";
  label?: string;
  children?: Child;
}) {
  return (
    <button
      type="button"
      id={props.id}
      class={props.kind ? `btn ${props.kind}` : "btn"}
      data-act={props.url}
      data-done={props.done}
      data-body={props.body === undefined ? undefined : JSON.stringify(props.body)}
      aria-label={props.label}
    >
      {props.children}
    </button>
  );
}

function Proof(props: { branch: string; landed?: string; head?: string; big?: boolean }) {
  return (
    <div class={props.big ? "proof big" : "proof"}>
      <code>
        {props.branch}@{short(props.landed)}
        <span class="sup" aria-hidden="true">
          ⊇
        </span>
        <span class="sr">contains</span>
        lane@{short(props.head)}
      </code>
      <small>Ancestor proof: {props.branch} contains the lane head</small>
    </div>
  );
}

function Chip(props: { tone?: "alert"; children?: Child }) {
  return (
    <li class="chip" data-tone={props.tone}>
      {props.children}
    </li>
  );
}

function LaneActions(props: { project: string; lane: Lane; detail?: boolean }) {
  const { lane: l } = props;
  const base = `/api/projects/${props.project}/lanes/${l.id}`;
  const sfx = props.detail ? "-d" : "";
  return (
    <div class="acts">
      {l.state !== "LANDED" && l.state !== "ARCHIVED" && l.state !== "LANDING" && (
        <Act
          id={`archive-${l.id}${sfx}`}
          url={`${base}/archive`}
          done={`Archived lane #${l.id}.`}
          kind="quiet"
          label={`Archive lane #${l.id}`}
        >
          Archive
        </Act>
      )}
      {l.gateRequired && !l.gateSignedBy && (
        <Act
          id={`sign-${l.id}${sfx}`}
          url={`${base}/sign`}
          body={{ by: "owner" }}
          done={`Signed the gate on lane #${l.id}.`}
          label={`Sign gate on lane #${l.id}`}
        >
          Sign gate
        </Act>
      )}
      {l.state === "READY" && (
        <Act
          id={`land-${l.id}${sfx}`}
          url={`${base}/land`}
          done={`Lane #${l.id} queued for landing.`}
          kind="primary"
          label={`Land lane #${l.id}`}
        >
          Land
        </Act>
      )}
    </div>
  );
}

function LaneCard(props: { project: string; branch: string; lane: Lane; readiness: Readiness }) {
  const { lane: l, project: p, readiness } = props;
  const blocked = l.state === "PUSHED" ? readiness.reasons : [];
  return (
    <article class="card" data-lane={l.id} data-state={l.state} aria-label={`Lane #${l.id}, ${l.state}`}>
      <div class="card-top">
        <a class="id" href={`/l/${p}/${l.id}`}>
          #{l.id}
        </a>
        <span>{l.agent}</span>
        <a class="task" href={`/t/${p}/${l.taskId}`}>
          {l.taskId}
        </a>
      </div>
      <p class="intent">{l.intent}</p>
      {l.state === "LANDED" && <Proof branch={props.branch} landed={l.landedSha} head={l.head} />}
      {l.state !== "LANDED" && (
        <p class="fork">
          <code>{l.head ? `${l.repo.name}@${short(l.head)}` : l.repo.name}</code>
          {!l.head && " waiting for the first push"}
        </p>
      )}
      <p class="facts">
        <span>
          {l.touched.length} {l.touched.length === 1 ? "file" : "files"}
        </span>
        <span>
          claims <code>{l.claims.join(" ")}</code>
        </span>
        {l.mergePreview && <span>merge {l.mergePreview}</span>}
        {l.gateSignedBy && <span>gate signed by {l.gateSignedBy}</span>}
      </p>
      {(blocked.length > 0 || l.overlaps.length > 0 || l.state === "BEHIND") && (
        <ul class="chips" aria-label="Blocking reasons">
          {l.overlaps.length > 0 && <Chip>overlaps {l.overlaps.map((o) => `#${o}`).join(" ")}</Chip>}
          {l.state === "BEHIND" && (
            <Chip tone="alert">
              conflicts: <code>{(l.conflictFiles as string[]).join(", ")}</code>
            </Chip>
          )}
          {blocked.map((r) => (
            <Chip tone={ALERT_REASONS.has(r.code) ? "alert" : undefined}>{reasonText(r)}</Chip>
          ))}
        </ul>
      )}
      {l.state === "FAILED" && <p class="note">{l.failure}</p>}
      <LaneActions project={p} lane={l} />
    </article>
  );
}

function Column(props: { state: LaneState; children?: Child; count: number }) {
  const label = STATE_LABEL[props.state];
  const h = (
    <h2 class="col-h">
      <Glyph state={props.state} />
      {label}
      <span class="n">{props.count}</span>
    </h2>
  );
  if (props.count === 0) {
    return (
      <section class="col rail" data-col={props.state} aria-label={`${label}: no lanes`}>
        {h}
      </section>
    );
  }
  return (
    <section class="col" data-col={props.state} aria-label={`${label}: ${props.count}`}>
      {h}
      <div class="stack">{props.children}</div>
    </section>
  );
}

function eventLabel(kind: string): string {
  return kind.replace(/^lane\./, "").replace(".", " ");
}

function Activity(props: { project: string; recent: ProjectEvent[]; total: number }) {
  return (
    <aside class="log" aria-labelledby="log-h">
      <h2 class="col-h" id="log-h">
        Activity <span class="n">{props.total} events, UTC</span>
      </h2>
      <ol>
        {props.recent.slice(0, 16).map((e) => (
          <li data-kind={e.kind}>
            <time datetime={new Date(e.at).toISOString()}>{clock(e.at)}</time>
            <span class="ev">
              {e.laneId !== undefined && <a href={`/l/${props.project}/${e.laneId}`}>#{e.laneId}</a>}
              <span class="k">{eventLabel(e.kind)}</span>
            </span>
            {e.detail && <span class="d">{SHA.test(e.detail) ? short(e.detail) : e.detail}</span>}
          </li>
        ))}
      </ol>
    </aside>
  );
}

export function BoardView(props: { board: Board }) {
  const { board: b } = props;
  const p = b.project.name;
  const branch = b.project.integrationBranch;
  const columns = [...COLUMNS, ...EXTRA.filter((s) => b.lanes[s].length > 0)];
  const tracks = columns.map((s) => (b.lanes[s].length > 0 ? "minmax(15rem, 1fr)" : "2.75rem")).join(" ");
  const total = Object.values(b.events).reduce((a, n) => a + n, 0);
  return (
    <div id="board">
      <header class="strip">
        <h1>{p}</h1>
        <span class="head">
          <code>{branch}</code>
          <span class="muted">at</span>
          <code>{short(b.integrationHead)}</code>
        </span>
        <ul class="tally" aria-label="Lanes by state">
          {columns.map((s) => (
            <li data-zero={b.lanes[s].length === 0 ? "" : undefined}>
              <Glyph state={s} />
              <b>{b.lanes[s].length}</b> {STATE_LABEL[s].toLowerCase()}
            </li>
          ))}
        </ul>
        <span class="queue">
          Landing queue
          {b.queue.length > 0 ? (
            <ol>
              {b.queue.map((id) => (
                <li>
                  <a href={`/l/${p}/${id}`}>#{id}</a>
                </li>
              ))}
            </ol>
          ) : (
            <span class="muted">empty</span>
          )}
        </span>
      </header>
      <div class="deck">
        <div class="cols" style={`grid-template-columns: ${tracks}`}>
          {columns.map((state) => (
            <Column state={state} count={b.lanes[state].length}>
              {b.lanes[state].map((lane) => (
                <LaneCard
                  project={p}
                  branch={branch}
                  lane={lane}
                  readiness={b.readiness[lane.id] as Readiness}
                />
              ))}
            </Column>
          ))}
        </div>
        <Activity project={p} recent={b.recent} total={total} />
      </div>
    </div>
  );
}

function YesNo(props: { ok: boolean; yes?: string; no?: string }) {
  return props.ok ? (
    <span class="yes">{props.yes ?? "yes"}</span>
  ) : (
    <span class="no">{props.no ?? "no"}</span>
  );
}

export function CandidatesView(props: {
  project: string;
  taskId: string;
  title: string;
  winner?: number;
  rows: CandidateRow[];
}) {
  const { project: p } = props;
  return (
    <div id="candidates" class="page">
      <header class="page-h">
        <h1>{props.title}</h1>
        <p class="meta">
          <span>
            Task <code>{props.taskId}</code>
          </span>
          <span>
            {props.rows.length} {props.rows.length === 1 ? "candidate lane" : "candidate lanes"}
          </span>
          {props.winner !== undefined ? (
            <span class="tag">Winner #{props.winner}</span>
          ) : (
            <span class="muted">Pick one Ready lane; the others are archived.</span>
          )}
        </p>
      </header>
      <table>
        <caption class="sr">Candidate lanes for {props.taskId}, ranked by score</caption>
        <thead>
          <tr>
            <th scope="col">Lane</th>
            <th scope="col">Agent</th>
            <th scope="col">State</th>
            <th scope="col" class="num">
              Files
            </th>
            <th scope="col" class="num">
              Drift
            </th>
            <th scope="col">Claims kept</th>
            <th scope="col">Checks pass / fail / pending</th>
            <th scope="col">Merge</th>
            <th scope="col">Ledger</th>
            <th scope="col" class="num">
              Score
            </th>
            <th scope="col">
              <span class="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr data-winner={props.winner === r.laneId ? "1" : undefined}>
              <td>
                <a href={`/l/${p}/${r.laneId}`}>
                  <b>#{r.laneId}</b>
                </a>
              </td>
              <td>{r.agent}</td>
              <td>
                <span class="state">
                  <Glyph state={r.state} />
                  {STATE_LABEL[r.state]}
                </span>
              </td>
              <td class="num">{r.touchedCount}</td>
              <td class="num">{r.driftCount > 0 ? <span class="no">{r.driftCount}</span> : r.driftCount}</td>
              <td>
                <YesNo ok={r.claimsKept} />
              </td>
              <td>
                {r.checksPassed} / <span class={r.checksFailed > 0 ? "no" : undefined}>{r.checksFailed}</span>{" "}
                / {r.checksPending}
              </td>
              <td>{r.mergePreview ?? "–"}</td>
              <td>
                <YesNo ok={r.ledgerOk} yes="complete" no="incomplete" />
              </td>
              <td class="num">
                <b>{r.score}</b>
              </td>
              <td class="num">
                {r.state === "READY" && props.winner === undefined && (
                  <Act
                    id={`pick-${r.laneId}`}
                    url={`/api/projects/${p}/tasks/${props.taskId}/pick`}
                    body={{ lane: r.laneId }}
                    done={`Picked lane #${r.laneId} for ${props.taskId}.`}
                    kind="primary"
                  >
                    Pick winner
                  </Act>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LaneDetail(props: {
  project: string;
  branch: string;
  lane: Lane;
  checks: CheckResult[];
  readiness: Readiness;
}) {
  const { lane: l, project: p } = props;
  const branch = props.branch;
  const drift = new Set(l.drift);
  // The state is already in the page header; the remaining reasons say what is left to do.
  const blockers = props.readiness.reasons.filter((r) => r.code !== "WRONG_STATE");
  return (
    <div id="lane" class="page" data-lane={l.id} data-state={l.state}>
      <header class="page-h">
        <h1>{l.intent}</h1>
        <p class="meta">
          <span class="state">
            <Glyph state={l.state} />
            {STATE_LABEL[l.state]}
          </span>
          <span>Lane #{l.id}</span>
          <span>{l.agent}</span>
          <a href={`/t/${p}/${l.taskId}`}>Task {l.taskId}</a>
        </p>
      </header>
      {l.state === "LANDED" && <Proof big branch={branch} landed={l.landedSha} head={l.head} />}
      <div class="split" style={l.state === "LANDED" ? "margin-top: 24px" : undefined}>
        <div class="panel">
          <section class="sec" aria-labelledby="h-ready">
            <h2 id="h-ready">Readiness</h2>
            {props.readiness.ready ? (
              <p class="ok-line">
                <Glyph state="READY" />
                Ready to land
              </p>
            ) : blockers.length > 0 ? (
              <ul class="chips">
                {blockers.map((r) => (
                  <Chip tone={ALERT_REASONS.has(r.code) ? "alert" : undefined}>{reasonText(r)}</Chip>
                ))}
              </ul>
            ) : (
              <p class="muted">Nothing to land while the lane is {STATE_LABEL[l.state].toLowerCase()}.</p>
            )}
            {l.state === "BEHIND" && (
              <p class="note">
                Conflicts with {branch}: {(l.conflictFiles as string[]).join(", ")}
              </p>
            )}
            {l.state === "FAILED" && <p class="note">{l.failure}</p>}
          </section>
          <section class="sec" aria-labelledby="h-facts">
            <h2 id="h-facts">Lane</h2>
            <dl class="dl">
              <dt>Fork</dt>
              <dd>
                <code>{l.repo.name}</code> on <code>{l.branch}</code>
              </dd>
              <dt>Base to head</dt>
              <dd>
                <code>{short(l.base)}</code> to <code>{short(l.head)}</code>
              </dd>
              <dt>Claims</dt>
              <dd>
                <code>{l.claims.join(" ")}</code>
              </dd>
              <dt>Overlaps</dt>
              <dd>{l.overlaps.length > 0 ? l.overlaps.map((o) => `#${o}`).join(" ") : "none"}</dd>
              <dt>Ledger</dt>
              <dd class="ticks">
                <span data-ok={l.ledger.intent ? "1" : "0"}>intent {l.ledger.intent ? "✓" : "✗"}</span>
                <span data-ok={l.ledger.handoff ? "1" : "0"}>
                  handoff {l.ledger.handoff ? "✓" : "✗"}
                  {l.ledger.handoffTooLong ? " (too long)" : ""}
                </span>
                <span data-ok={l.ledger.evidence ? "1" : "-"}>evidence {l.ledger.evidence ? "✓" : "–"}</span>
              </dd>
              <dt>Gate</dt>
              <dd>
                {l.gateRequired
                  ? l.gateSignedBy
                    ? `signed by ${l.gateSignedBy}`
                    : "needs sign-off"
                  : "not gated"}
              </dd>
              <dt>Merge preview</dt>
              <dd>{l.mergePreview ?? "–"}</dd>
              <dt>Push token</dt>
              <dd>
                {l.tokenExpires
                  ? `expires ${new Date(l.tokenExpires * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`
                  : "–"}
              </dd>
              <dt>Landed at</dt>
              <dd>
                <code>{short(l.landedSha)}</code>
              </dd>
            </dl>
          </section>
          <section class="sec" aria-labelledby="h-checks">
            <h2 id="h-checks">
              Checks <span class="n">{props.checks.length}</span>
            </h2>
            {props.checks.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">At head</th>
                  </tr>
                </thead>
                <tbody>
                  {props.checks.map((c) => (
                    <tr>
                      <td>{c.name}</td>
                      <td class={c.status === "fail" ? "no" : undefined}>{c.status}</td>
                      <td>
                        <code>{short(c.head)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p class="empty">No checks reported yet.</p>
            )}
          </section>
        </div>
        <div class="panel">
          <section class="sec" aria-labelledby="h-files">
            <h2 id="h-files">
              Touched files <span class="n">{l.touched.length}</span>
            </h2>
            {l.touched.length > 0 ? (
              <ul class="files">
                {l.touched.map((t) => (
                  <li data-drift={drift.has(t) ? "" : undefined}>
                    <code>{t}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="empty">Nothing pushed yet.</p>
            )}
          </section>
          <LaneActions project={p} lane={l} detail />
        </div>
      </div>
    </div>
  );
}

/** The public front page: what hamonn is, how a lane lands, and the projects on this server. */
export function landingPage(projects: { name: string; repo?: string }[]): string {
  return doc(
    <html lang="en">
      <Head title="hamonn: a landing layer for concurrent coding agents" />
      <body>
        <header class="top">
          <a class="mark" href="/" aria-label="hamonn home">
            <b aria-hidden="true">⊇</b>hamonn
          </a>
          <div class="top-r">
            <a href={REPO_URL}>Source on GitHub</a>
          </div>
        </header>
        <main class="land">
          <section class="hero" aria-labelledby="pitch">
            <div class="pitch">
              <h1 id="pitch">A landing layer for concurrent coding agents.</h1>
              <p class="lede">
                Every agent works in its own Cloudflare Artifacts fork. hamonn lands their work on main one
                lane at a time, and records proof that main contains each lane it landed.
              </p>
            </div>
            <figure class="specimen">
              <Proof big branch="main" landed="9f3c2e1" head="4b7a0d2" />
              <figcaption>
                Every landed lane carries this line: the main commit it landed in, and the lane head that
                commit is checked to contain.
              </figcaption>
            </figure>
          </section>
          <ol class="steps" aria-label="How a lane lands">
            <li>
              <h2>Open a lane</h2>
              <p>
                The agent gets its own Artifacts fork and declares the paths it claims. Overlapping claims are
                flagged when the lane opens, not at merge time.
              </p>
            </li>
            <li>
              <h2>Push, check, hand off</h2>
              <p>
                Pushes go to the fork only. Checks, drift outside the claims, gated paths and a handoff note
                in <code>.lane/</code> decide whether the lane is ready.
              </p>
            </li>
            <li>
              <h2>Land with proof</h2>
              <p>
                The coordinator merges ready lanes server-side, one at a time. A lane is marked landed only
                after git confirms main contains its head.
              </p>
            </li>
          </ol>
          <section class="projects" aria-labelledby="projects-h">
            <h2 id="projects-h">Projects on this server</h2>
            {projects.length > 0 ? (
              <ul>
                {projects.map((r) => (
                  <li>
                    <a href={`/p/${encodeURIComponent(r.name)}`}>{r.name}</a>
                    {r.repo && <code>{r.repo}</code>}
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted">
                There are no projects yet. Create one with <code>POST /api/projects</code>.
              </p>
            )}
          </section>
          <footer class="foot">
            <a href={REPO_URL}>github.com/kelvindesman/hamonn</a>
            <span>Read-only without the admin key.</span>
          </footer>
        </main>
      </body>
    </html>,
  );
}

/** Server-rendered pages. htmx re-fetches the `?partial=1` fragment every 2 s. */
export function createUi(service: Service): Hono {
  const ui = new Hono();

  ui.onError((e, c) => {
    const err = normalizeError(e);
    return c.text(`${err.code}: ${err.message}`, err.status);
  });

  ui.get("/", (c) => c.redirect("/p/demo"));

  const respond = (partial: boolean, view: unknown, title: string, crumbs: Crumb[], refresh: string) =>
    partial
      ? String(view)
      : doc(
          <Layout title={title} crumbs={crumbs} refresh={refresh}>
            {view as Child}
          </Layout>,
        );

  ui.get("/p/:project", async (c) => {
    const p = c.req.param("project");
    const board = await service.board(p);
    const view = <BoardView board={board} />;
    return c.html(
      respond(c.req.query("partial") === "1", view, `${p}: hamonn`, [{ label: p }], `/p/${p}?partial=1`),
    );
  });

  ui.get("/t/:project/:task", async (c) => {
    const p = c.req.param("project");
    const t = c.req.param("task");
    const v = await service.task(p, t);
    const view = (
      <CandidatesView project={p} taskId={t} title={v.task.title} winner={v.task.winnerLane} rows={v.rows} />
    );
    return c.html(
      respond(
        c.req.query("partial") === "1",
        view,
        `${t} candidates: ${p}`,
        [{ label: p, href: `/p/${p}` }, { label: `Task ${t}` }],
        `/t/${p}/${t}?partial=1`,
      ),
    );
  });

  ui.get("/l/:project/:id", async (c) => {
    const p = c.req.param("project");
    const id = Number(c.req.param("id"));
    const v = await service.lane(p, id);
    const view = (
      <LaneDetail
        project={p}
        branch={v.integrationBranch}
        lane={v.lane}
        checks={v.checks}
        readiness={v.readiness}
      />
    );
    return c.html(
      respond(
        c.req.query("partial") === "1",
        view,
        `Lane #${id}: ${p}`,
        [
          { label: p, href: `/p/${p}` },
          { label: `Task ${v.lane.taskId}`, href: `/t/${p}/${v.lane.taskId}` },
          { label: `Lane #${id}` },
        ],
        `/l/${p}/${id}?partial=1`,
      ),
    );
  });

  return ui;
}
