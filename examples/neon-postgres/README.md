# Veto decision receipts in Neon Postgres

Run two real `Veto.local()` policy checks against synthetic report metadata:
allow a public report export and deny a confidential one. The example builds
portable `veto.receipt/1` receipts from those returned decisions, stores the
receipts as JSONB in Neon Postgres, reads them back, compares their canonical
hashes with the originals, and verifies the receipt chain.

The example only evaluates policy. It does not export reports or execute an
external tool. Neon is optional for Veto itself; this example requires Neon
because it demonstrates database-backed receipt storage. See the
[Neon guide](../../docs/neon.md) and [self-hosting guide](../../docs/self-hosting.md).

## Run

Use Node.js 20.19 or later and pnpm 9.15.0. From the repository root, build the
two local packages used by this example:

```bash
pnpm install --frozen-lockfile
pnpm --filter veto-receipt-protocol build
pnpm --filter veto-sdk build
cd examples/neon-postgres
npm ci
npm test
```

Create a development branch/database in [Neon](https://console.neon.tech),
open **Connect**, and copy its PostgreSQL connection string. Use a database role
with `CREATE`, `INSERT`, and `SELECT` privileges. Put the connection string in
an ignored `.env` file using `.env.example` as a template, then run:

```bash
node --env-file=.env demo.mjs
```

Alternatively, supply `DATABASE_URL` through your shell or secret manager and run:

```bash
npm start
```

Do not commit your connection string. `.env` is ignored; `npm start` reads the
process environment and does not automatically load `.env`.

Successful output includes:

```json
{
  "ok": true,
  "receiptCount": 2,
  "decisions": ["allow", "deny"],
  "verified": true
}
```

The real output also includes a unique `runId` and `finalReceiptHash`. Each run
appends two synthetic receipts to `veto_neon_demo_receipts`; the table is created
only if absent. Both inserts use a single transaction, and readback filters by
the unique run ID. Repeating the demo preserves previous runs.

## Implementation and limits

- Uses Neon's official [`@neondatabase/serverless`](https://github.com/neondatabase/serverless)
  driver over HTTPS with parameterized queries. This connection mode targets
  Neon; a generic local PostgreSQL server requires a different transport.
- Stores the actual receipt objects built from local validation results, with
  their decision, receipt ID, canonical hash, run ID, and sequence number.
- Rejects missing configuration, database failures, incomplete readback, and
  receipts that differ from the originals. Database errors are sanitized so the
  connection string is not printed. Database work has a 30-second deadline.
- `npm test` exercises real local policy evaluation and a simulated SQL boundary,
  including corruption and connection failure. It does **not** contact Neon.
  Running the demo with your connection string is the live integration check.
- This is an application-level persistence example, not a PostgreSQL storage
  backend for Veto's hosted/control-plane service. The transaction covers audit
  inserts only. It does not make external tool execution atomic with logging.
- Hash comparison and chain verification detect changes relative to the original
  receipts in this run. They do not make a database immutable or authenticate a
  writer. Production deployments need their own access controls, retention,
  independent integrity anchors, and durable retry handling.

No Veto API key, model provider, or paid action is needed. The example retains its
synthetic rows so you can inspect them in Neon's SQL editor.
