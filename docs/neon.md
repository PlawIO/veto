# Store Veto decision receipts in Neon Postgres

We recommend [Neon](https://neon.com) as the managed Postgres service for the
[Neon decision-receipt example](../examples/neon-postgres/). It evaluates local
Veto policy, creates portable receipts from the resulting decisions, stores them
in Postgres, and reads them back for verification.

This is an application-level SDK integration. The default Docker Compose server
continues to use SQLite; this guide does not introduce a server storage driver.
Local policy evaluation does not need a database. Running this persistence example
does require a Neon database connection.

## Prerequisites

- Node.js 20.19.0 or newer and pnpm 9.15.0, as used by this checkout.
- A Neon account and a project you can use for development.
- The Veto source checkout. The example uses the SDK and receipt-protocol packages
  built from this checkout.

## 1. Create a development database

In the [Neon console](https://console.neon.tech), create a project or select an
existing development project. Create a separate development branch for the
example. Use a schema-only branch if the parent contains data you should not copy.
Neon's [branching guide](https://neon.com/docs/introduction/branching) explains how
to keep development work separate from production.

Use **Connect** to select that branch, a database, and a role with permission to
create the example's table and insert/select its rows. Copy the connection string
into an untracked `examples/neon-postgres/.env` file:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@YOUR-NEON-HOST/neondb?sslmode=require
```

Use the actual connection string from the console. Keep it out of Git, screenshots,
logs, and support emails. The example uses Neon's serverless driver over HTTPS.
For deployment, inject `DATABASE_URL` through your host's secret manager.

## 2. Install and build

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter veto-receipt-protocol build
pnpm --filter veto-sdk build
npm --prefix examples/neon-postgres ci
npm --prefix examples/neon-postgres test
```

## 3. Run the example

From the repository root, using the `.env` file created above:

```bash
cd examples/neon-postgres
node --env-file=.env demo.mjs
```

See the [example README](../examples/neon-postgres/README.md) for the schema,
expected output, and integration checks. The example evaluates synthetic
tool calls: one allowed by policy and one denied. It persists receipts describing
those decisions; it does not execute a payment or any other external tool action.

The run succeeds only after it reads back the stored receipts and verifies them.
A missing connection string or failed database operation fails the run. The
database records are retained so you can inspect them in Neon's SQL editor.

## Use it in your own agent

Keep policy evaluation and persistence as separate, explicit steps in your
application. Run Veto's policy check, create a receipt for the actual result, and
persist that receipt with the example's storage code. Decide how your application
handles persistence failures before executing an allowed external action.

This example is not a transactional outbox, an immutable audit service, or proof
that a real-world action executed. Receipt verification detects content/chain
changes; a database owner can still change or delete rows. Do not treat it as the
complete financial-grade receipt service described in the implementation spec.

Only synthetic example data should be used for the walkthrough. In a real
deployment, review which receipt fields are appropriate to store, use least-
privilege database roles, and keep production secrets and data out of preview
branches.
