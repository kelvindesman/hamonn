import type { CandidateRow, CheckResult, Lane, LaneState, Readiness, Reason } from "@hamonn/core";
import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { normalizeError } from "./errors.ts";
import type { Board, Service } from "./service.ts";

const CLIENT_JS = `
document.addEventListener('htmx:configRequest', function (e) {
  var k = localStorage.getItem('hamonn-key');
  if (k) e.detail.headers['Authorization'] = 'Bearer ' + k;
});
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var key = localStorage.getItem('hamonn-key') || '';
  fetch(b.dataset.act, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: b.dataset.body || '{}'
  }).then(function (r) { return r.json().then(function (j) { if (!r.ok) alert(j.error.code + ': ' + j.error.message); }); })
    .then(function () { if (window.htmx) htmx.trigger(document.body, 'refresh'); });
});
function hamonnKey() {
  var v = prompt('HAMONN_ADMIN_KEY (stored in this browser only)', localStorage.getItem('hamonn-key') || '');
  if (v !== null) localStorage.setItem('hamonn-key', v);
}
`;

const COLUMNS: LaneState[] = ["OPEN", "PUSHED", "READY", "BEHIND", "LANDED"];
const EXTRA: LaneState[] = ["LANDING", "FAILED", "ARCHIVED"];

const TONE: Record<LaneState, string> = {
  OPEN: "border-sky-500/50",
  PUSHED: "border-amber-500/50",
  READY: "border-emerald-500/60",
  LANDING: "border-violet-500/60",
  LANDED: "border-emerald-700/60",
  BEHIND: "border-orange-500/60",
  FAILED: "border-red-600/60",
  ARCHIVED: "border-slate-700",
};

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

const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 7) : "–");

function Layout(props: { title: string; refresh: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <script src="https://cdn.tailwindcss.com/3.4.16" />
        <script src="https://unpkg.com/htmx.org@2.0.4" />
      </head>
      <body class="bg-slate-950 text-slate-100 font-mono text-sm min-h-screen">
        <header class="flex items-center gap-4 border-b border-slate-800 px-4 py-2">
          <span class="font-bold tracking-wide text-emerald-400">hamonn</span>
          <span class="text-slate-400">{props.title}</span>
          <button type="button" class="ml-auto text-xs text-slate-400 underline" onclick="hamonnKey()">
            set admin key
          </button>
        </header>
        <main class="p-4" hx-get={props.refresh} hx-trigger="every 2s, refresh from:body" hx-swap="innerHTML">
          {props.children}
        </main>
        <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
      </body>
    </html>
  );
}

function Act(props: { url: string; body?: unknown; tone?: string; children?: Child }) {
  return (
    <button
      type="button"
      data-act={props.url}
      data-body={props.body === undefined ? undefined : JSON.stringify(props.body)}
      class={`rounded px-2 py-0.5 text-xs font-semibold ${props.tone ?? "bg-slate-700 hover:bg-slate-600"}`}
    >
      {props.children}
    </button>
  );
}

function LaneCard(props: { project: string; lane: Lane; readiness: Readiness }) {
  const { lane: l, project: p, readiness } = props;
  const base = `/api/projects/${p}/lanes/${l.id}`;
  const blocked = l.state === "PUSHED" || l.state === "OPEN" ? readiness.reasons : [];
  return (
    <div class={`rounded border-l-4 bg-slate-900 p-2 ${TONE[l.state]}`} data-lane={l.id}>
      <div class="flex items-center gap-2">
        <a class="font-bold hover:underline" href={`/l/${p}/${l.id}`}>
          #{l.id}
        </a>
        <span class="text-slate-300">{l.agent}</span>
        <a class="ml-auto text-xs text-slate-500 hover:underline" href={`/t/${p}/${l.taskId}`}>
          {l.taskId}
        </a>
      </div>
      <div class="mt-1 text-slate-200">{l.intent}</div>
      <div class="mt-1 text-xs text-slate-500">claims {l.claims.join(" ")}</div>
      {l.overlaps.length > 0 && (
        <div class="mt-1 text-xs text-amber-400">⚠ overlaps {l.overlaps.map((o) => `#${o}`).join(" ")}</div>
      )}
      {l.drift.length > 0 && <div class="mt-1 text-xs text-red-400">⚠ DRIFT {l.drift.join(", ")}</div>}
      {l.state === "BEHIND" && (
        <div class="mt-1 text-xs text-orange-400">conflicts: {(l.conflictFiles as string[]).join(", ")}</div>
      )}
      {l.state === "FAILED" && <div class="mt-1 text-xs text-red-400">{l.failure}</div>}
      {l.state === "LANDED" && <div class="mt-1 text-xs text-emerald-400">@ {short(l.landedSha)}</div>}
      {blocked.length > 0 && (
        <ul class="mt-1 text-xs text-slate-400">
          {blocked.map((r) => (
            <li>· {reasonText(r)}</li>
          ))}
        </ul>
      )}
      <div class="mt-2 flex flex-wrap items-center gap-1 text-xs text-slate-400">
        {l.mergePreview && <span>merge: {l.mergePreview}</span>}
        <span>
          {l.gateRequired ? (l.gateSignedBy ? `gate ✓ ${l.gateSignedBy}` : "gate: unsigned") : "gate: –"}
        </span>
        <span class="ml-auto flex gap-1">
          {l.gateRequired && !l.gateSignedBy && (
            <Act url={`${base}/sign`} body={{ by: "owner" }}>
              sign
            </Act>
          )}
          {l.state === "READY" && (
            <Act url={`${base}/land`} tone="bg-emerald-600 hover:bg-emerald-500">
              LAND
            </Act>
          )}
          {l.state !== "LANDED" && l.state !== "ARCHIVED" && l.state !== "LANDING" && (
            <Act url={`${base}/archive`}>archive</Act>
          )}
        </span>
      </div>
    </div>
  );
}

export function BoardView(props: { board: Board }) {
  const { board: b } = props;
  const p = b.project.name;
  const counters = Object.entries(b.events)
    .sort(([a], [c]) => a.localeCompare(c))
    .map(([k, n]) => `${n} ${k.replace("lane.", "")}`)
    .join(" · ");
  const columns = [...COLUMNS, ...EXTRA.filter((s) => b.lanes[s].length > 0)];
  return (
    <div id="board">
      <div class="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-slate-400">
        <span>
          {p} · <span class="text-slate-200">{b.project.integrationBranch}</span> @{" "}
          <span class="text-emerald-400">{short(b.integrationHead)}</span>
        </span>
        <span>queue: {b.queue.length > 0 ? b.queue.map((id) => `#${id}`).join(" → ") : "∅"}</span>
        <span>events: {counters || "–"}</span>
      </div>
      <div
        class="grid gap-3"
        style={`grid-template-columns: repeat(${columns.length}, minmax(14rem, 1fr)); overflow-x: auto`}
      >
        {columns.map((state) => (
          <section>
            <h2 class="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">
              {state} ({b.lanes[state].length})
            </h2>
            <div class="flex flex-col gap-2">
              {b.lanes[state].map((lane) => (
                <LaneCard project={p} lane={lane} readiness={b.readiness[lane.id] as Readiness} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function CandidatesView(props: {
  project: string;
  taskId: string;
  title: string;
  winner?: number;
  rows: CandidateRow[];
}) {
  const yes = (v: boolean) => (v ? "✓" : "✗");
  return (
    <div id="candidates">
      <h1 class="mb-3 text-lg">
        {props.taskId} <span class="text-slate-400">{props.title}</span>
        {props.winner !== undefined && <span class="ml-2 text-emerald-400">winner #{props.winner}</span>}
      </h1>
      <table class="w-full text-left">
        <thead class="text-xs uppercase text-slate-500">
          <tr>
            <th>lane</th>
            <th>agent</th>
            <th>state</th>
            <th>touched</th>
            <th>claims kept</th>
            <th>checks ✓/✗/…</th>
            <th>merge</th>
            <th>ledger</th>
            <th>score</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr class="border-t border-slate-800">
              <td>
                <a class="hover:underline" href={`/l/${props.project}/${r.laneId}`}>
                  #{r.laneId}
                </a>
              </td>
              <td>{r.agent}</td>
              <td>{r.state}</td>
              <td>{r.touchedCount}</td>
              <td>{yes(r.claimsKept)}</td>
              <td>
                {r.checksPassed}/{r.checksFailed}/{r.checksPending}
              </td>
              <td>{r.mergePreview ?? "–"}</td>
              <td>{yes(r.ledgerOk)}</td>
              <td>{r.score}</td>
              <td>
                {r.state === "READY" && props.winner === undefined && (
                  <Act
                    url={`/api/projects/${props.project}/tasks/${props.taskId}/pick`}
                    body={{ lane: r.laneId }}
                    tone="bg-emerald-600 hover:bg-emerald-500"
                  >
                    pick winner
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
  lane: Lane;
  checks: CheckResult[];
  readiness: Readiness;
}) {
  const { lane: l, project: p } = props;
  const base = `/api/projects/${p}/lanes/${l.id}`;
  return (
    <div id="lane" class="space-y-3">
      <h1 class="text-lg">
        #{l.id} <span class="text-slate-400">{l.agent}</span> ·{" "}
        <span class="text-emerald-400">{l.state}</span>
      </h1>
      <p>{l.intent}</p>
      <dl class="grid grid-cols-[8rem_1fr] gap-y-1 text-slate-300">
        <dt class="text-slate-500">task</dt>
        <dd>
          <a class="hover:underline" href={`/t/${p}/${l.taskId}`}>
            {l.taskId}
          </a>
        </dd>
        <dt class="text-slate-500">repo</dt>
        <dd>
          {l.repo.name} @ {l.branch}
        </dd>
        <dt class="text-slate-500">base → head</dt>
        <dd>
          {short(l.base)} → {short(l.head)}
        </dd>
        <dt class="text-slate-500">claims</dt>
        <dd>{l.claims.join(" ")}</dd>
        <dt class="text-slate-500">ledger</dt>
        <dd>
          intent {l.ledger.intent ? "✓" : "✗"} · handoff {l.ledger.handoff ? "✓" : "✗"}
          {l.ledger.handoffTooLong ? " (too long)" : ""} · evidence {l.ledger.evidence ? "✓" : "–"}
        </dd>
        <dt class="text-slate-500">token</dt>
        <dd>{l.tokenExpires ? `expires ${new Date(l.tokenExpires * 1000).toISOString()}` : "–"}</dd>
        <dt class="text-slate-500">landed</dt>
        <dd>{short(l.landedSha)}</dd>
      </dl>
      <section>
        <h2 class="text-xs uppercase text-slate-500">readiness</h2>
        {props.readiness.ready ? (
          <p class="text-emerald-400">ready to land</p>
        ) : (
          <ul>
            {props.readiness.reasons.map((r) => (
              <li class="text-amber-400">· {reasonText(r)}</li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 class="text-xs uppercase text-slate-500">checks</h2>
        <ul>
          {props.checks.map((c) => (
            <li>
              {c.name}: {c.status} {c.head ? `@ ${short(c.head)}` : ""}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 class="text-xs uppercase text-slate-500">touched ({l.touched.length})</h2>
        <ul class="text-slate-300">
          {l.touched.map((t) => (
            <li class={l.drift.includes(t) ? "text-red-400" : ""}>{t}</li>
          ))}
        </ul>
      </section>
      <div class="flex gap-2">
        {l.state === "READY" && (
          <Act url={`${base}/land`} tone="bg-emerald-600 hover:bg-emerald-500">
            LAND
          </Act>
        )}
        {l.gateRequired && !l.gateSignedBy && (
          <Act url={`${base}/sign`} body={{ by: "owner" }}>
            sign
          </Act>
        )}
        <Act url={`${base}/archive`}>archive</Act>
      </div>
    </div>
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

  ui.get("/p/:project", async (c) => {
    const p = c.req.param("project");
    const board = await service.board(p);
    const partial = c.req.query("partial") === "1";
    return c.html(
      partial ? (
        <BoardView board={board} />
      ) : (
        <Layout title={p} refresh={`/p/${p}?partial=1`}>
          <BoardView board={board} />
        </Layout>
      ),
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
      c.req.query("partial") === "1" ? (
        view
      ) : (
        <Layout title={`${p} / ${t}`} refresh={`/t/${p}/${t}?partial=1`}>
          {view}
        </Layout>
      ),
    );
  });

  ui.get("/l/:project/:id", async (c) => {
    const p = c.req.param("project");
    const id = Number(c.req.param("id"));
    const v = await service.lane(p, id);
    const view = <LaneDetail project={p} lane={v.lane} checks={v.checks} readiness={v.readiness} />;
    return c.html(
      c.req.query("partial") === "1" ? (
        view
      ) : (
        <Layout title={`${p} / lane ${id}`} refresh={`/l/${p}/${id}?partial=1`}>
          {view}
        </Layout>
      ),
    );
  });

  return ui;
}
