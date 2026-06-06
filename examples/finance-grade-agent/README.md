# Financial-grade agent demo

This demo shows the smallest useful trust-kernel shape for irreversible finance actions:

- allow a low-risk purchase order,
- deny an unapproved vendor payment,
- require finance-controller approval for a material refund,
- write portable `veto.receipt/1` receipts, and
- verify the receipt chain offline.

It runs locally. No Veto Cloud, provider SDK, payment rail, or API key is required.

```bash
pnpm install --frozen-lockfile
pnpm build
node examples/finance-grade-agent/finance-demo.mjs
node packages/sdk/dist/cli/bin.js receipts verify examples/finance-grade-agent/demo-output/receipts.ndjson
```

Generated files are written to `examples/finance-grade-agent/demo-output/`:

- `policy-bundle.json` - the local policy bundle used by `Veto.local(...)`
- `approval-request.json` - the local approval artifact for the refund scenario
- `receipts.ndjson` - chained decision receipts
- `summary.json` - receipt hashes and decisions for automation

Run the smoke check with:

```bash
pnpm smoke:finance-demo
```
