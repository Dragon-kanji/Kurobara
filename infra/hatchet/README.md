# Local Hatchet qualification harness

This harness runs a loopback-only, auth-disabled Hatchet environment for
`RUNTIME-001`. It is a local integration-test fixture, not a production
deployment template.

The topology follows Hatchet's official local Docker driver at `v0.95.3`:
PostgreSQL 17.9 plus `hatchet-lite-dev`, dashboard/API on port `8888`, gRPC on
`7077`, and container readiness at `http://127.0.0.1:8733/ready`. A second,
isolated PostgreSQL 17.9 service exposes a loopback-only disposable Kurobara
application database on port `54329`. Both images are pinned by version and
multi-platform registry digest. The Hatchet image is
the upstream auth-disabled image specifically intended for local development;
the committed database password is a synthetic fixture. The harness obtains
the image's embedded auth-disabled worker token from
`/config/authdisabled-token` at runtime, keeps it only in a process variable,
and never prints or persists it outside the image-managed local volume.

`v0.95.3` is a published upstream tag and container candidate, but Hatchet has
not published a matching GitHub Release. It is deliberately not described here
as stable or supported. `v0.94.10` cannot qualify this repository's SDK
`1.26.0` idempotency contract because the required server-side implementation
and migrations first appear in the `v0.95.x` line.

## Commands

```sh
npm run hatchet:up
npm run hatchet:status
npm run hatchet:smoke
npm run hatchet:worker
npm run hatchet:down
```

`hatchet:smoke` starts or reconciles the pinned services before it starts the
existing Kurobara Hatchet adapter worker, submits a unique run through the real
Hatchet API, observes execution, reads the run back, and verifies idempotency
collision handling. It then restarts only the Hatchet service, preserving the
PostgreSQL and Hatchet configuration volumes, and proves that the completed run
is still discoverable and that the same start key does not create another run
inside the configured 120-second TTL. The restart handoff file contains only
synthetic identifiers, uses mode `0600`, and is removed automatically.
Adapter REST calls use a real Axios transport timeout; a separate blackhole
test proves that a connected endpoint which never responds is interrupted.

`hatchet:worker` starts the same fixture plus the isolated application database,
then launches the real `apps/worker/src/index.ts` child process with an explicit
allowlist of synthetic configuration. It creates a valid plan and run through
the application layer. The plan explicitly admits the synthetic
`test.kurobara.deterministic-leaf@1` capability and its `deterministic-local`
route; the real worker then claims the run, automatically routes and claims the
leaf attempt, and proves the complete callback, zero-cost settlement, outbox
dispatch, recovery-job creation and terminal reap. The plan references the
exact canonical `deterministic-output-fixture@1.0.0` contract. The worker checks
its generated catalog fingerprint at startup and validates the local effect's
JSON output with strict JSON Schema 2020-12 through Ajv 8.20.0.
A second case blocks `recordStarted`, waits for the Hatchet task to complete,
sends `SIGKILL`, then terminates the crashed client's blocked PostgreSQL
backends before releasing the barrier. It proves that the restarted worker
adopts the same Hatchet execution identifier without another settlement or
business event. A third case proves durable DAG materialization across
`root → left/right → join`: only the root is initially ready, both branches
appear after its success, and the join stays absent until both predecessors
succeed. The qualifier proves four immutable routing decisions, reservations
and automatic claims, then four distinct completed Hatchet executions,
settlements and ledger entries at zero cost. Only the unique sink, `join`, is a
run output: its normalized JSON payload is stored as one immutable local
PostgreSQL artifact after validation. The DAG scheduler then atomically records
one result manifest, `RunResultManifestRecorded`, `RunCompleted` and
`CompleteRun`, and the run reaches `completed/complete`. The case stops and
restarts the worker, requeues that terminal DAG job and verifies the
`stale-terminal` outcome without a duplicate artifact, manifest, command or
event. Every run uses and drops its own application database.

Together these commands prove persistence through a clean Hatchet service
restart, server-side idempotency inside the configured TTL, and one bounded
worker-process crash window after Hatchet completion but before PostgreSQL
records the external identifier. They also prove scheduler ordering for roots,
fan-out and fan-in plus automatic routing/claim against the single synthetic
adapter, strict validation of the local sink output and successful global run
completion with restart-safe result evidence, but not adaptive multi-provider
fallback, partial results, pause/resume or cancellation. The inline artifact is
a bounded local fixture, not object-storage qualification or a public artifact
delivery contract. These commands do not qualify a Hatchet container crash, a
PostgreSQL restart, the other external-effect crash windows, expiry behavior
after the TTL, or long-term retention policy. The application database uses a
container-scoped `tmpfs` and is removed with its container by `hatchet:down`;
the two named Hatchet/PostgreSQL volumes are preserved. To reset only this
harness's retained local state, run:

```sh
docker compose --env-file infra/hatchet/.env.example \
  -f infra/hatchet/compose.yaml down --volumes
```

To change local ports or the Compose project name, copy the synthetic example
outside the repository and point the harness at it:

```sh
KUROBARA_HATCHET_ENV_FILE=/absolute/path/to/hatchet.env npm run hatchet:up
```

The custom file must define `HATCHET_POSTGRES_PASSWORD` and
`KUROBARA_POSTGRES_PASSWORD`; use only disposable local values. Do not place a
Hatchet production token in this harness.

## Upstream evidence

- Hatchet candidate tag: <https://github.com/hatchet-dev/hatchet/tree/v0.95.3>
- Official local Docker driver at that tag: <https://github.com/hatchet-dev/hatchet/blob/v0.95.3/cmd/hatchet-cli/cli/internal/drivers/docker/hatchet_lite.go>
- Official self-hosting repository: <https://github.com/hatchet-dev/hatchet>

The pinned registry digests were read from the published multi-platform image
indexes. A future upgrade must update the human-readable version, digest, and
smoke evidence together.
