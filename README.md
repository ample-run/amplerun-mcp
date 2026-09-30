# @amplerun/mcp

An MCP server that lets AI agents find and rent GPUs on [AmpleRun](https://amplerun.com): browse templates and offers, price a rental, rent within a budget you set, check its state and access, and stop it. It runs locally over stdio and wraps the TypeScript SDK, `@amplerun/sdk`.

**Read-only by default.** Nothing can be rented or stopped until you start the server with `AMPLERUN_MCP_ALLOW_SPEND=1`.

**No install needed:** the same tools are hosted at `https://amplerun.com/api/mcp` (Streamable HTTP, `Authorization: Bearer ark_...`). There, a key with the renter scope can rent and stop on its own and any other key is read-only; `AMPLERUN_MCP_ALLOW_SPEND` applies only to this local server. See https://amplerun.com/docs/agents.


## Configure

| Variable | Required | Meaning |
|---|---|---|
| `AMPLERUN_API_KEY` | For account tools | An API key with the **renter** scope, from [Account → Security](https://amplerun.com/account/security). `list_templates` and `search_offers` work without it. |
| `AMPLERUN_MCP_ALLOW_SPEND` | No | `1` enables `create_rental`, `stop_rental` and a paying `top_up`. Any other value, or unset, keeps the server read-only. |
| `AMPLERUN_MCP_WALLET_KEY_FILE` | No | File holding a Base wallet's private key (`0x…`). With `AMPLERUN_MCP_ALLOW_SPEND=1`, `top_up` pays USDC from it with x402. Without spend allowed the key is never read. |
| `AMPLERUN_MCP_MAX_TOPUP_MICRO` | No | Cap per top-up payment, in micro-USDC. |
| `AMPLERUN_BASE_URL` | No | API origin. Defaults to `https://amplerun.com`. |
| `AMPLERUN_AGENT_WALLET_KEY` | No | A 0x-prefixed EVM private key. `register_agent_account` signs its challenge with it, so the agent opens its own account with no email, and the server then uses the key it was issued. The private key never leaves this process and is never printed. |

`top_up` without a wallet returns the x402 payment requirements for your own wallet to sign. See [docs/integrations/x402.md](../../docs/integrations/x402.md). Use a dedicated wallet holding only what the agent may spend.

The key is sent only as the `Authorization` header to the API. The server never writes it to its output, logs or error messages. It does live in your client's config file: use a renter-scoped key with an expiry, and revoke it at Account → Security when you are done.

### Claude Code

```sh
# Read-only: browse and price
claude mcp add amplerun -e AMPLERUN_API_KEY=ark_... -- npx -y @amplerun/mcp

# Allow renting and stopping
claude mcp add amplerun -e AMPLERUN_API_KEY=ark_... -e AMPLERUN_MCP_ALLOW_SPEND=1 -- npx -y @amplerun/mcp
```

For a shared `.mcp.json`, add `-s project` and pass `-e 'AMPLERUN_API_KEY=${AMPLERUN_API_KEY}'` in single quotes: the file then stores a reference, and each person exports their own key.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "amplerun": {
      "command": "npx",
      "args": ["-y", "@amplerun/mcp"],
      "env": { "AMPLERUN_API_KEY": "ark_..." }
    }
  }
}
```

Add `"AMPLERUN_MCP_ALLOW_SPEND": "1"` to `env` to allow renting.

### Other MCP clients

Any client that launches stdio servers works. Command `npx`, arguments `-y @amplerun/mcp`, plus the environment above. Node.js 20 or later is required. Pin a version (`@amplerun/mcp@0.1.0`) where reproducibility matters.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `list_templates` | read | Published templates (pinned images such as PyTorch or an inference server), with minimum VRAM and GPU count. Filter by kind or by the VRAM you have. |
| `search_offers` | read | Machines you can rent now, cheapest first. Filters: GPU model, minimum VRAM, maximum hourly price, region, GPU count, template fit. |
| `get_quote` | read | A free, non-binding 60-second quote for a template on an offer, with the fee split. Nothing is reserved. |
| `create_rental` | **write** | Quotes and reserves in one step. Requires an explicit `budget_micro`; returns the `rental_id`. |
| `get_rental` | read | State, charge so far and, once running, access details (endpoints, SSH command, per-rental endpoint key for model templates). |
| `list_rentals` | read | Your rentals with state and charge, to find a `rental_id` again. |
| `stop_rental` | **write** | Stops a rental and its metering. Stopping again is harmless. |
| `get_balance` | read | USDC and USDT balances: spendable, held, pending, disputed, withdrawable, 30-day spend. |
| `top_up` | read, or **write** with a wallet | Adds USDC with x402. Without a wallet it returns the payment requirements; with `AMPLERUN_MCP_WALLET_KEY_FILE` and spending allowed it pays them. The credit lands after Base finality. |
| `host_this_machine` | read | How to list this machine's GPU so its owner earns: the installer command, steps and earnings links. Runs nothing; the owner must approve. The installer answers at amplerun.com/host (Linux with an NVIDIA GPU, rented whole, for now). |
| `get_agent_account_challenge` | write | Step 1 of an agent opening its own account: an EIP-4361 message for its wallet to sign. |
| `register_agent_account` | write | Step 2: the signed message returns an agent-tagged account and an API key (shown once). No free credit. On the hosted server both work without a key, and they are the only tools served without one. |

Read tools carry `readOnlyHint`; write tools carry `destructiveHint`, so clients that honour annotations can ask before each write. In an auto-approve mode the environment flag and the budget are the guards, so leave `AMPLERUN_MCP_ALLOW_SPEND` unset unless the agent may spend.

### Money

- Amounts are integer strings in micro-units of the asset: `"1000000"` is 1 USDC. They are passed through exactly as the API returns them, never converted to floats.
- Offer prices are per hour for the whole machine, fee included. The platform fee is a flat 5%, shown on every quote and receipt, and it comes out of the charge rather than on top.
- `fee_split` in `get_quote` and `create_rental` is the most a rental can cost (the smaller of the full-duration estimate and your budget) split with the ledger's formula: `fee = floor(charge × platform_fee_bps / 10000)`, host share = charge − fee.
- `budget_micro` is a hard cap. AmpleRun holds it from your balance and meters from verified readiness, so the final charge can be lower.

### Retries

`create_rental` sends one `Idempotency-Key` for its quote and its reservation and returns it. Retrying with the same `idempotency_key` never creates a second rental. If the first attempt reserved, the retry is refused, usually because the machine is now taken and otherwise with `IDEMPOTENCY_CONFLICT`, and `list_rentals` shows the rental. If the first attempt failed or never reached AmpleRun, the retry reserves normally.

## Why a local stdio server

The MCP deployment options are a hosted remote server, a bundled local server (MCPB), or a local stdio process. This package is the third, distributed through npm, because:

- **The key can spend money.** An AmpleRun API key with the renter scope spends a prepaid balance. Running locally keeps it on your machine, sent only to the AmpleRun API. A hosted MCP server would have to receive and hold every user's key, a new custodial surface, until AmpleRun offers OAuth for third-party clients.
- **The spend switch belongs to the person who owns the balance.** `AMPLERUN_MCP_ALLOW_SPEND` is a per-install setting. A shared remote server could only offer one policy for everyone.
- **No new service to run.** The package ships alongside the SDKs; a remote server would need its own hosting and release path.
- **Who uses it.** Agents in Claude Code and similar tools, on machines that already have Node.js.

Update 2026-09-26: the hosted Streamable HTTP server now exists (`apps/web/server/mcp.ts`), authenticated with the caller's own API key per request and holding no keys; the owner chose scope-gated spending there. Still open: OAuth for clients that only accept OAuth connectors, and an MCPB bundle for Claude Desktop users without Node.js.

## Development

This repository mirrors the MCP server that AmpleRun ships as [`@amplerun/mcp`](https://www.npmjs.com/package/@amplerun/mcp). Issues and pull requests are welcome here.

```sh
npm install
npm test               # builds this package, then runs the tests
npm run typecheck
node dist/index.js     # speaks MCP on stdin/stdout; diagnostics on stderr
```

`test/server.test.ts` drives every tool through a real MCP client with the SDK stubbed. `test/stdio.test.ts` spawns the built server over stdio against a local HTTP stub of the API.

Built on `@modelcontextprotocol/server` 2.1.0 (the official TypeScript SDK, v2).
