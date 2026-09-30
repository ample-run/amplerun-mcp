// Integration: the built bin (dist/index.js, what `npx @amplerun/mcp` runs)
// spawned over stdio by the official MCP client, pointed at an in-process
// node:http stub of the AmpleRun API. Proves env wiring, the real SDK HTTP
// layer (Bearer key, Idempotency-Key) and that the key never leaks.
// Spawns happen inside each test, not in beforeAll: a failing beforeAll
// would report this file as skipped while the run stays green.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const SECRET = "ark_stdio_sentinel_never_printed_0123456789";
const TEMPLATE_ID = "a35d15fe-ab57-4283-87f8-a00528d1d631";
const OFFER_ID = "8b0c2f4e-1d3a-4c5b-9e6f-7a8b9c0d1e2f";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

const X402_REQUIRED = {
  x402Version: 2,
  error: "payment required",
  resource: { url: "u", description: "d", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "5000000", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } }],
};
// Test-only key (never funded). Its address is what the stub echoes as payer.
const WALLET_KEY = `0x${"5a".repeat(32)}`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Canned AmpleRun API: just the routes these tests drive, error envelope otherwise. */
async function stubApi() {
  const seen: Seen[] = [];
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers });
      const route = `${req.method} ${req.url!.split("?")[0]}`;
      const reply = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (route === "GET /api/v1/templates/pytorch-cuda") return reply(200, { id: TEMPLATE_ID, template_id: "pytorch-cuda" });
      if (route === "GET /api/v1/offers")
        return reply(200, { items: [{ offer_id: OFFER_ID, total_rate_micro_per_hour: "450000", platform_fee_bps: 500, readiness: "ready" }], next_cursor: null });
      if (route === "POST /api/v1/quotes")
        return reply(201, { quote_id: "0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5", machine_rate_micro_per_hour: "450000", platform_fee_bps: 500, budget_micro: "1000000", duration_limit_s: 7200, estimated_total_micro: "900000" });
      if (route === "POST /api/v1/jobs") return reply(202, { job_id: "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b", state: "RESERVED" });
      if (route === "GET /api/v1/billing") return reply(200, { spendable_micro: "4000000", held_micro: "1000000" });
      if (route === "POST /api/v1/billing/x402/top-up") {
        const pay = req.headers["payment-signature"];
        if (!pay) return reply(402, X402_REQUIRED);
        const p = JSON.parse(Buffer.from(String(pay), "base64").toString("utf8"));
        return reply(200, { intent_id: TEMPLATE_ID, state: "PENDING_FINALITY", amount_micro: "5000000", payer: p.payload.authorization.from.toLowerCase(), tx_hash: "0x01", log_index: 5, network: "eip155:8453" });
      }
      reply(404, { error: { code: "NOT_FOUND", message: `no stub for ${route}`, retryable: false, request_id: "00000000-0000-4000-8000-000000000000" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { seen, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

/** Spawn the built bin with only the given AmpleRun env (plus the SDK's safe defaults). */
async function spawnMcp(env: Record<string, string>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...getDefaultEnvironment(), ...env }, stderr: "pipe" });
  const log = { stderr: "" };
  transport.stderr?.on("data", (d: Buffer) => (log.stderr += d.toString("utf8")));
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, log };
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (r: CallResult) => (r.content as { text: string }[])[0]!.text;
const RENT = {
  template: "pytorch-cuda",
  offer_id: OFFER_ID,
  duration_limit_s: 7200,
  budget_micro: "1000000",
  ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVxYW1wbGU you@laptop",
};

describe("amplerun-mcp over stdio", () => {
  it("serves the tools, authenticates with the env key, shares one Idempotency-Key and never prints the key", { timeout: 30_000 }, async () => {
    const api = await stubApi();
    const { client, log } = await spawnMcp({ AMPLERUN_API_KEY: SECRET, AMPLERUN_BASE_URL: api.url, AMPLERUN_MCP_ALLOW_SPEND: "1" });

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(12);
    const results: CallResult[] = [
      await client.callTool({ name: "search_offers", arguments: {} }),
      await client.callTool({ name: "create_rental", arguments: RENT }),
      await client.callTool({ name: "get_balance", arguments: {} }),
    ];
    for (const r of results) expect(r.isError, text(r)).toBeFalsy();

    const rental = JSON.parse(text(results[1]!));
    expect(rental).toMatchObject({ rental_id: "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b", state: "RESERVED" });
    expect(rental.fee_split).toMatchObject({ max_charge_micro: "900000", platform_fee_micro: "45000", host_micro: "855000" });
    expect(JSON.parse(text(results[2]!)).USDC.spendable_micro).toBe("4000000");

    const quote = api.seen.find((s) => s.method === "POST" && s.url === "/api/v1/quotes")!;
    const job = api.seen.find((s) => s.method === "POST" && s.url === "/api/v1/jobs")!;
    expect(quote.headers["idempotency-key"]).toBe(rental.idempotency_key);
    expect(job.headers["idempotency-key"]).toBe(rental.idempotency_key);
    expect(api.seen.map((s) => s.url)).toContain("/api/v1/billing?asset=USDT");
    for (const s of api.seen) expect(s.headers.authorization).toBe(`Bearer ${SECRET}`);

    expect(log.stderr).toContain("spending enabled, API key set");
    const everything = JSON.stringify(tools) + results.map(text).join("") + log.stderr;
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("stdio_sentinel");
  });

  it("is read-only without AMPLERUN_MCP_ALLOW_SPEND=1: no reservation reaches the API", { timeout: 30_000 }, async () => {
    const api = await stubApi();
    const { client, log } = await spawnMcp({ AMPLERUN_API_KEY: SECRET, AMPLERUN_BASE_URL: api.url });
    const refused = await client.callTool({ name: "create_rental", arguments: RENT });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("AMPLERUN_MCP_ALLOW_SPEND=1");
    const stop = await client.callTool({ name: "stop_rental", arguments: { rental_id: "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b" } });
    expect(stop.isError).toBe(true);
    expect(api.seen.filter((s) => s.method !== "GET")).toEqual([]);
    expect(log.stderr).toContain("read-only");
  });

  it("top_up pays from the configured wallet only when spending is allowed, and never prints the key", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amplerun-mcp-wallet-"));
    const keyFile = path.join(dir, "wallet.key");
    writeFileSync(keyFile, WALLET_KEY + "\n", { mode: 0o600 });

    const api = await stubApi();
    const paying = await spawnMcp({ AMPLERUN_API_KEY: SECRET, AMPLERUN_BASE_URL: api.url, AMPLERUN_MCP_ALLOW_SPEND: "1", AMPLERUN_MCP_WALLET_KEY_FILE: keyFile });
    const r = await paying.client.callTool({ name: "top_up", arguments: { amount_micro: "5000000" } });
    expect(r.isError, text(r)).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ status: "paid", result: { state: "PENDING_FINALITY" } });
    expect(out.result.payer).toMatch(/^0x[0-9a-f]{40}$/);
    expect(paying.log.stderr).toContain(`x402 wallet 0x`);
    const posts = api.seen.filter((s) => s.url.startsWith("/api/v1/billing/x402/top-up"));
    expect(posts.map((s) => Boolean(s.headers["payment-signature"]))).toEqual([false, true]);

    const api2 = await stubApi();
    const readOnly = await spawnMcp({ AMPLERUN_API_KEY: SECRET, AMPLERUN_BASE_URL: api2.url, AMPLERUN_MCP_WALLET_KEY_FILE: keyFile });
    const r2 = await readOnly.client.callTool({ name: "top_up", arguments: { amount_micro: "5000000" } });
    expect(JSON.parse(text(r2))).toMatchObject({ status: "payment_required", payment_required: X402_REQUIRED });
    expect(api2.seen.some((s) => s.headers["payment-signature"])).toBe(false);
    expect(readOnly.log.stderr).toContain("x402 wallet not configured");

    const everything = text(r) + text(r2) + paying.log.stderr + readOnly.log.stderr;
    expect(everything).not.toContain(WALLET_KEY.slice(2));
  });
});

describe("agent self-registration over stdio", () => {
  it("signs the challenge with AMPLERUN_AGENT_WALLET_KEY, uses the new key next, and never prints the wallet key", { timeout: 30_000 }, async () => {
    const { privateKeyToAccount } = await import("viem/accounts");
    const { verifyMessage } = await import("viem");
    const WALLET_KEY = `0x${"4d".repeat(32)}` as const;
    const address = privateKeyToAccount(WALLET_KEY).address;
    const MESSAGE = `test wants you to sign in with your Ethereum account:\n${address}\n\nRegister this AI agent`;
    const NEW_KEY = "ark_issued_by_registration_0123456789";
    const seen: { url: string; auth: string | undefined; body: string }[] = [];
    let verified = false;
    const server = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString("utf8")));
      req.on("end", async () => {
        seen.push({ url: req.url!, auth: req.headers.authorization, body });
        const reply = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
        if (req.url === "/api/v1/agents/accounts/challenge") {
          return reply(200, { message: MESSAGE, expires_at: "2026-09-26T12:05:00Z", terms_version: "rental-v1", terms_url: "x" });
        }
        if (req.url === "/api/v1/agents/accounts") {
          const b = JSON.parse(body) as { message: string; signature: `0x${string}` };
          verified = b.message === MESSAGE && (await verifyMessage({ address, message: b.message, signature: b.signature }));
          return reply(verified ? 201 : 401, {
            account_id: "a1",
            account_kind: "agent",
            created: true,
            address: address.toLowerCase(),
            terms_version: "rental-v1",
            api_key: { key_id: "22222222-2222-4222-8222-222222222222", secret: NEW_KEY, prefix: "ark_issued_b", scopes: ["renter"] },
            next_steps: { fund: "f", rent: "r", mcp: "m" },
          });
        }
        if (req.url?.startsWith("/api/v1/billing")) return reply(200, { spendable_micro: "0" });
        reply(404, { error: { code: "NOT_FOUND", message: "no stub", retryable: false, request_id: null } });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const { client, log } = await spawnMcp({ AMPLERUN_BASE_URL: url, AMPLERUN_AGENT_WALLET_KEY: WALLET_KEY });
    const r = await client.callTool({ name: "register_agent_account", arguments: { agent: { name: "ops-bot", vendor: "grok" } } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(verified).toBe(true);
    expect(JSON.parse(seen[0]!.body)).toEqual({ address });

    // The key the registration issued is used for the next call.
    await client.callTool({ name: "get_balance", arguments: {} });
    expect(seen.find((s) => s.url.startsWith("/api/v1/billing"))!.auth).toBe(`Bearer ${NEW_KEY}`);
    expect(log.stderr).toContain(`wallet ${address}`);
    const everything = log.stderr + seen.map((s) => s.body).join("") + text(r);
    expect(everything).not.toContain(WALLET_KEY.slice(2));
  });
});
