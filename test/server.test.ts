// Tool behaviour through a real MCP client over an in-memory transport, with
// the AmpleRun SDK replaced by vi.fn stubs: schema validation, annotations,
// the spend gate, idempotency keys, verbatim money strings and the fee split.
import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AmpleRunError } from "@amplerun/sdk";
import { createServer, feeSplit, type Api } from "../src/server.js";

const TEMPLATE_ID = "a35d15fe-ab57-4283-87f8-a00528d1d631";
const OFFER_ID = "8b0c2f4e-1d3a-4c5b-9e6f-7a8b9c0d1e2f";
const RENTAL_ID = "7e8f9a0b-1c2d-4e3f-9a4b-5c6d7e8f9a0b";
const KEY = "22222222-2222-4222-8222-222222222222";
const SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVxYW1wbGU you@laptop";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TEMPLATE = {
  id: TEMPLATE_ID,
  template_id: "pytorch-cuda",
  name: "PyTorch (CUDA)",
  kind: "classical",
  engine: "pytorch",
  image_digest: "registry.amplerun.com/templates/pytorch-cuda@sha256:" + "a".repeat(64),
  vram_fit: { min_vram_bytes: "8589934592", est_weights_bytes: "0", est_kv_bytes_per_1k_tokens: "0" },
  min_gpu_count: 1,
  required_runtime: "cuda",
  exposes: [{ name: "jupyter", port: 8888, protocol: "http" }],
  env: {},
  setup_notes: "",
};
const offer = (id: string, vram: string | undefined, region: string | undefined) => ({
  offer_id: id,
  model: "NVIDIA GeForce RTX 4090",
  gpu_count: 1,
  ...(vram ? { vram_bytes: vram } : {}),
  ...(region ? { region } : {}),
  total_rate_micro_per_hour: "450000",
  platform_fee_bps: 500,
  readiness: "ready",
  included_quotas: { included_disk_gib: 100, included_egress_gib: 50 },
  available_until: "2026-10-25T00:00:00Z",
});
const QUOTE = {
  quote_id: "0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5",
  expires_at: "2026-09-25T12:01:00Z",
  machine_rate_micro_per_hour: "1234567",
  platform_fee_bps: 500,
  budget_micro: "5000000",
  duration_limit_s: 7200,
  estimated_total_micro: "2469134",
  template_id: TEMPLATE_ID,
  asset: "USDC",
};
const JOB = { job_id: RENTAL_ID, state: "RUNNING", cumulative_charge_micro: "112500", funded_through: "2026-09-25T14:00:00Z", budget_version: "1", rate_micro_per_hour: "450000" };

const CHALLENGE = "amplerun.com wants you to sign in with your Ethereum account:\n0x...\n\nRegister ...";
const REGISTERED = {
  account_id: "agent-1",
  account_kind: "agent",
  created: true,
  address: "0xabc",
  terms_version: "rental-v1",
  api_key: { key_id: KEY, secret: "ark_new_agent_key", prefix: "ark_new_agen", scopes: ["renter"] },
  next_steps: { fund: "f", rent: "r", mcp: "m" },
};
const AGENT = { name: "ops-bot", vendor: "grok" };

function stubApi() {
  return {
    templates: { list: vi.fn(), get: vi.fn().mockResolvedValue(TEMPLATE) },
    offers: { list: vi.fn() },
    quotes: { create: vi.fn().mockResolvedValue(QUOTE) },
    jobs: { create: vi.fn().mockResolvedValue({ job_id: RENTAL_ID, state: "RESERVED" }), get: vi.fn(), list: vi.fn(), access: vi.fn(), stop: vi.fn() },
    billing: { get: vi.fn(), topUp: vi.fn() },
    agents: {
      accounts: {
        challenge: vi.fn().mockResolvedValue({ message: CHALLENGE, expires_at: "2026-09-26T12:05:00Z", terms_version: "rental-v1", terms_url: "https://amplerun.com/terms" }),
        register: vi.fn().mockResolvedValue(REGISTERED),
      },
    },
  };
}
type Stub = ReturnType<typeof stubApi>;

async function connect(api: Stub, allowSpend = false, spendGate?: { enable: string; refused: string }, canPay = false) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(api as unknown as Api, { allowSpend, canPay, version: "0.0.0-test", ...(spendGate ? { spendGate } : {}) }).connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;
const text = (r: CallResult) => (r.content as { type: string; text: string }[])[0]!.text;
const body = (r: CallResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r)) as Record<string, any>;
};
const errorText = (r: CallResult) => {
  expect(r.isError).toBe(true);
  return text(r);
};
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

const RENT = { template: "pytorch-cuda", offer_id: OFFER_ID, duration_limit_s: 7200, budget_micro: "5000000", ssh_public_key: SSH };
const WRITE_TOOLS = ["create_rental", "stop_rental"];
const REGISTRATION_TOOLS = ["get_agent_account_challenge", "register_agent_account"];

describe("tool surface", () => {
  it("lists the twelve tools, each titled and annotated, write tools flagged destructive and env-gated", async () => {
    const { tools } = await (await connect(stubApi())).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["create_rental", "get_agent_account_challenge", "get_balance", "get_quote", "get_rental", "host_this_machine", "list_rentals", "list_templates", "register_agent_account", "search_offers", "stop_rental", "top_up"],
    );
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.title, t.name).toBeTruthy();
      const write = WRITE_TOOLS.includes(t.name);
      expect(t.annotations?.readOnlyHint, t.name).toBe(!write && !REGISTRATION_TOOLS.includes(t.name));
      expect(t.annotations?.destructiveHint, t.name).toBe(write);
      expect(t.description!.includes("AMPLERUN_MCP_ALLOW_SPEND=1"), t.name).toBe(write);
    }
    const rent = tools.find((t) => t.name === "create_rental")!;
    expect(rent.inputSchema.required).toEqual(expect.arrayContaining(["budget_micro", "template", "offer_id", "ssh_public_key"]));
  });

  it("host_this_machine returns the installer steps, names owner approval and calls no API", async () => {
    const api = stubApi();
    const r = await call(await connect(api), "host_this_machine", {});
    const body = JSON.parse((r.content as { text: string }[])[0]!.text);
    expect(body.command).toContain("AMPLERUN_OUTPUT=json");
    expect(body.status).toMatch(/^DEPLOYED/);
    expect(body.steps.join(" ")).toMatch(/approval is required/i);
    expect(body.earn_url).toBe("https://amplerun.com/earn");
    const { agents, ...rest } = api;
    for (const group of [...Object.values(rest), agents.accounts]) for (const fn of Object.values(group)) expect(fn).not.toHaveBeenCalled();
  });

  it("uses a custom spend gate in descriptions and refusals", async () => {
    const client = await connect(stubApi(), false, { enable: "the API key has the renter scope", refused: "Refused: key lacks renter." });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "create_rental")!.description).toContain("the API key has the renter scope");
    expect(errorText(await call(client, "create_rental", RENT))).toBe("Refused: key lacks renter.");
  });

  it("states the spend mode in the server instructions", async () => {
    expect((await connect(stubApi())).getInstructions()).toContain("read-only");
    expect((await connect(stubApi(), true)).getInstructions()).toContain("Spending is enabled");
  });
});

describe("catalog tools", () => {
  it("list_templates converts GiB exactly and projects the catalog", async () => {
    const api = stubApi();
    api.templates.list.mockResolvedValue({ items: [TEMPLATE], next_cursor: "c2" });
    const out = body(await call(await connect(api), "list_templates", { kind: "classical", gpu_vram_gib: 24, limit: 5 }));
    expect(api.templates.list).toHaveBeenCalledWith({ kind: "classical", min_vram_bytes: "25769803776", limit: 5 });
    expect(out.next_cursor).toBe("c2");
    expect(out.items[0]).toMatchObject({ id: TEMPLATE_ID, template_id: "pytorch-cuda", min_vram_bytes: "8589934592", min_gpu_count: 1 });
  });

  it("list_templates reports API errors with code, retryability and request id", async () => {
    const api = stubApi();
    api.templates.list.mockRejectedValue(new AmpleRunError(503, "UNAVAILABLE", "database unavailable", true, "req-1"));
    const msg = errorText(await call(await connect(api), "list_templates"));
    expect(msg).toContain("503 UNAVAILABLE: database unavailable");
    expect(msg).toContain("retryable: true, request_id req-1");
  });

  it("search_offers resolves the slug, filters server-side and applies VRAM and region to the page", async () => {
    const api = stubApi();
    api.offers.list.mockResolvedValue({
      items: [offer("o-fits", "25757220864", "us-east-1"), offer("o-small", "17179869184", "us-east-1"), offer("o-noregion", "25757220864", undefined)],
      next_cursor: "n2",
    });
    const out = body(
      await call(await connect(api), "search_offers", {
        gpu_model: "4090",
        max_rate_micro_per_hour: "500000",
        template: "pytorch-cuda",
        min_vram_gib: 20,
        region: "US-EAST",
      }),
    );
    expect(api.templates.get).toHaveBeenCalledWith("pytorch-cuda");
    expect(api.offers.list).toHaveBeenCalledWith({ model: "4090", max_rate_micro_per_hour: "500000", template_id: TEMPLATE_ID, limit: 20 });
    expect(out.items.map((o: { offer_id: string }) => o.offer_id)).toEqual(["o-fits"]);
    expect(out.items[0].total_rate_micro_per_hour).toBe("450000");
    expect({ scanned: out.scanned, next_cursor: out.next_cursor }).toEqual({ scanned: 3, next_cursor: "n2" });
  });

  it("search_offers skips the lookup for a template UUID and surfaces an unknown slug as an error", async () => {
    const api = stubApi();
    api.offers.list.mockResolvedValue({ items: [], next_cursor: null });
    body(await call(await connect(api), "search_offers", { template: TEMPLATE_ID }));
    expect(api.templates.get).not.toHaveBeenCalled();

    api.templates.get.mockRejectedValue(new AmpleRunError(404, "NOT_FOUND", "template not found", false));
    expect(errorText(await call(await connect(api), "search_offers", { template: "no-such-template" }))).toContain("404 NOT_FOUND");
  });

  it("rejects malformed money and counts before any API call", async () => {
    const api = stubApi();
    const client = await connect(api);
    for (const args of [{ max_rate_micro_per_hour: "0.5" }, { max_rate_micro_per_hour: "0" }, { gpu_count: 0 }, { limit: 101 }]) {
      expect(errorText(await call(client, "search_offers", args)), JSON.stringify(args)).toMatch(/validation/i);
    }
    expect(api.offers.list).not.toHaveBeenCalled();
  });
});

describe("get_quote", () => {
  it("returns the quote verbatim plus the ledger fee split", async () => {
    const api = stubApi();
    const out = body(await call(await connect(api), "get_quote", { template: "pytorch-cuda", offer_id: OFFER_ID, duration_limit_s: 7200, budget_micro: "5000000" }));
    expect(api.quotes.create).toHaveBeenCalledWith({ offer_id: OFFER_ID, template_id: TEMPLATE_ID, duration_limit_s: 7200, budget_micro: "5000000" });
    expect(out.quote).toEqual(QUOTE);
    expect(out.fee_split).toMatchObject({ max_charge_micro: "2469134", platform_fee_micro: "123456", host_micro: "2345678", platform_fee_bps: 500 });
  });

  it("caps the split at the budget and passes the asset", async () => {
    const api = stubApi();
    api.quotes.create.mockResolvedValue({ ...QUOTE, budget_micro: "2000000", asset: "USDT" });
    const out = body(
      await call(await connect(api), "get_quote", { template: TEMPLATE_ID, offer_id: OFFER_ID, duration_limit_s: 7200, budget_micro: "2000000", asset: "USDT" }),
    );
    expect(api.quotes.create.mock.calls[0]![0]).toMatchObject({ asset: "USDT" });
    expect(out.fee_split).toMatchObject({ max_charge_micro: "2000000", platform_fee_micro: "100000", host_micro: "1900000" });
  });

  it("refuses without a budget and reports API errors", async () => {
    const api = stubApi();
    const client = await connect(api);
    expect(errorText(await call(client, "get_quote", { template: "pytorch-cuda", offer_id: OFFER_ID, duration_limit_s: 7200 }))).toMatch(/budget_micro/);
    expect(api.quotes.create).not.toHaveBeenCalled();
    api.quotes.create.mockRejectedValue(new AmpleRunError(422, "INVALID_INPUT", "offer does not fit template", false));
    expect(
      errorText(await call(client, "get_quote", { template: "pytorch-cuda", offer_id: OFFER_ID, duration_limit_s: 7200, budget_micro: "1" })),
    ).toContain("422 INVALID_INPUT: offer does not fit template");
  });

  it("feeSplit stays exact beyond 2^53", () => {
    expect(feeSplit({ budget_micro: "1000000000000000000", estimated_total_micro: "90071992547409930", platform_fee_bps: 500 })).toMatchObject({
      max_charge_micro: "90071992547409930",
      platform_fee_micro: "4503599627370496",
      host_micro: "85568392920039434",
    });
  });
});

describe("spend gate (AMPLERUN_MCP_ALLOW_SPEND)", () => {
  it("create_rental and stop_rental refuse by default and never touch the API", async () => {
    const api = stubApi();
    const client = await connect(api);
    expect(errorText(await call(client, "create_rental", RENT))).toContain("AMPLERUN_MCP_ALLOW_SPEND=1");
    expect(errorText(await call(client, "stop_rental", { rental_id: RENTAL_ID }))).toContain("AMPLERUN_MCP_ALLOW_SPEND=1");
    expect(api.templates.get).not.toHaveBeenCalled();
    expect(api.quotes.create).not.toHaveBeenCalled();
    expect(api.jobs.create).not.toHaveBeenCalled();
    expect(api.jobs.stop).not.toHaveBeenCalled();
  });

  it("create_rental refuses without a budget, or with a private key, even when enabled", async () => {
    const api = stubApi();
    const client = await connect(api, true);
    const { budget_micro: _omit, ...noBudget } = RENT;
    expect(errorText(await call(client, "create_rental", noBudget))).toMatch(/budget_micro/);
    const priv = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    expect(errorText(await call(client, "create_rental", { ...RENT, ssh_public_key: priv }))).toMatch(/ssh_public_key/);
    expect(api.quotes.create).not.toHaveBeenCalled();
    expect(api.jobs.create).not.toHaveBeenCalled();
  });

  it("create_rental quotes and reserves under one idempotency key and returns the rental id", async () => {
    const api = stubApi();
    const out = body(await call(await connect(api, true), "create_rental", { ...RENT, idempotency_key: KEY }));
    expect(api.quotes.create).toHaveBeenCalledWith(
      { offer_id: OFFER_ID, template_id: TEMPLATE_ID, duration_limit_s: 7200, budget_micro: "5000000" },
      { idempotencyKey: KEY },
    );
    expect(api.jobs.create).toHaveBeenCalledWith({ quote_id: QUOTE.quote_id, ssh_public_key: SSH }, { idempotencyKey: KEY });
    expect(out).toMatchObject({ rental_id: RENTAL_ID, state: "RESERVED", idempotency_key: KEY, quote: QUOTE });
    expect(out.fee_split.platform_fee_micro).toBe("123456");
  });

  it("create_rental generates a key when omitted and returns it", async () => {
    const api = stubApi();
    const out = body(await call(await connect(api, true), "create_rental", RENT));
    expect(out.idempotency_key).toMatch(UUID_RE);
    expect(api.quotes.create.mock.calls[0]![1]).toEqual({ idempotencyKey: out.idempotency_key });
    expect(api.jobs.create.mock.calls[0]![1]).toEqual({ idempotencyKey: out.idempotency_key });
  });

  it("create_rental explains an idempotency conflict without claiming a new rental", async () => {
    const api = stubApi();
    api.jobs.create.mockRejectedValue(new AmpleRunError(409, "IDEMPOTENCY_CONFLICT", "same Idempotency-Key with a different request body", false));
    const msg = errorText(await call(await connect(api, true), "create_rental", { ...RENT, idempotency_key: KEY }));
    expect(msg).toContain("409 IDEMPOTENCY_CONFLICT");
    expect(msg).toContain("No new rental was created");
    expect(msg).toContain(`idempotency_key: ${KEY}`);

    // Seen live: after a lost response, the retry fails at quoting because the machine is taken.
    api.quotes.create.mockRejectedValue(new AmpleRunError(409, "CONFLICT", "machine is not available", false));
    const retried = errorText(await call(await connect(api, true), "create_rental", { ...RENT, idempotency_key: KEY }));
    expect(retried).toContain("409 CONFLICT: machine is not available");
    expect(retried).toContain("may have reserved; list_rentals shows it");
    const fresh = errorText(await call(await connect(api, true), "create_rental", RENT));
    expect(fresh).not.toContain("may have reserved");
  });

  it("stop_rental stops with a default reason when enabled and reports API errors", async () => {
    const api = stubApi();
    api.jobs.stop.mockResolvedValue({ job_id: RENTAL_ID, state: "STOPPING" });
    const client = await connect(api, true);
    expect(body(await call(client, "stop_rental", { rental_id: RENTAL_ID }))).toEqual({ rental_id: RENTAL_ID, state: "STOPPING" });
    expect(api.jobs.stop).toHaveBeenCalledWith(RENTAL_ID, { reason: "stopped by an AI agent via @amplerun/mcp" }, undefined);
    api.jobs.stop.mockRejectedValue(new AmpleRunError(404, "NOT_FOUND", "job not found", false));
    expect(errorText(await call(client, "stop_rental", { rental_id: RENTAL_ID, idempotency_key: KEY }))).toContain("404 NOT_FOUND");
    expect(api.jobs.stop).toHaveBeenLastCalledWith(RENTAL_ID, { reason: "stopped by an AI agent via @amplerun/mcp" }, { idempotencyKey: KEY });
  });
});

describe("rentals and balance", () => {
  it("get_rental adds access only while RUNNING or STOPPED", async () => {
    const api = stubApi();
    const access = { mode: "execution", endpoints: [{ endpoint_id: "e1", kind: "ssh", external_host: "h.example", external_port: 2222 }], ssh_command: "ssh -p 2222 tenant@h.example" };
    api.jobs.get.mockResolvedValue(JOB);
    api.jobs.access.mockResolvedValue(access);
    const client = await connect(api);
    expect(body(await call(client, "get_rental", { rental_id: RENTAL_ID }))).toEqual({ rental: JOB, access });

    api.jobs.get.mockResolvedValue({ ...JOB, state: "RESERVED" });
    const reserved = body(await call(client, "get_rental", { rental_id: RENTAL_ID }));
    expect(reserved.access).toBeNull();
    expect(reserved.access_note).toContain("RESERVED");
    expect(api.jobs.access).toHaveBeenCalledTimes(1);

    api.jobs.get.mockResolvedValue({ ...JOB, state: "STOPPED" });
    api.jobs.access.mockRejectedValue(new AmpleRunError(403, "FORBIDDEN", "retrieval window has expired", false));
    expect(body(await call(client, "get_rental", { rental_id: RENTAL_ID })).access_note).toContain("retrieval window has expired");

    api.jobs.get.mockRejectedValue(new AmpleRunError(404, "NOT_FOUND", "job not found", false));
    expect(errorText(await call(client, "get_rental", { rental_id: RENTAL_ID }))).toContain("404 NOT_FOUND");
    expect(errorText(await call(client, "get_rental", { rental_id: "not-a-uuid" }))).toMatch(/rental_id/);
  });

  it("list_rentals projects rentals and pages", async () => {
    const api = stubApi();
    api.jobs.list.mockResolvedValue({ items: [{ ...JOB, template: { template_id: "pytorch-cuda", name: "PyTorch", kind: "classical" } }], next_cursor: null });
    const client = await connect(api);
    const out = body(await call(client, "list_rentals", { limit: 50, cursor: "c1" }));
    expect(api.jobs.list).toHaveBeenCalledWith({ limit: 50, cursor: "c1" });
    expect(out.items[0]).toEqual({
      rental_id: RENTAL_ID,
      state: "RUNNING",
      cumulative_charge_micro: "112500",
      rate_micro_per_hour: "450000",
      funded_through: "2026-09-25T14:00:00Z",
      template: "pytorch-cuda",
    });
    api.jobs.list.mockRejectedValue(new AmpleRunError(403, "FORBIDDEN", "API key lacks the renter scope", false));
    expect(errorText(await call(client, "list_rentals"))).toContain("403 FORBIDDEN");
  });

  it("get_balance returns USDC and USDT exactly as the API sent them", async () => {
    const api = stubApi();
    const usdc = { spendable_micro: "4000000", held_micro: "1000000", withdrawable_micro: "4000000" };
    const usdt = { spendable_micro: "0", held_micro: "0", withdrawable_micro: "0" };
    api.billing.get.mockImplementation(async (q: { asset: string }) => (q.asset === "USDC" ? usdc : usdt));
    expect(body(await call(await connect(api), "get_balance"))).toEqual({ USDC: usdc, USDT: usdt });
    expect(api.billing.get.mock.calls.map((c) => c[0])).toEqual([{ asset: "USDC" }, { asset: "USDT" }]);
  });

  it("get_balance on 401 points at AMPLERUN_API_KEY", async () => {
    const api = stubApi();
    api.billing.get.mockRejectedValue(new AmpleRunError(401, "UNAUTHENTICATED", "authentication required", false));
    expect(errorText(await call(await connect(api), "get_balance"))).toContain("Set AMPLERUN_API_KEY");
  });
});

describe("top_up (x402)", () => {
  const REQUIRED = { x402Version: 2, error: "payment required", accepts: [{ scheme: "exact", network: "eip155:8453", amount: "5000000" }] };

  it("without a wallet it is read-only and returns the payment requirements plus how to pay", async () => {
    const api = stubApi();
    api.billing.topUp.mockResolvedValue({ status: "payment_required", payment_required: REQUIRED });
    const client = await connect(api, true, undefined, false);
    const tool = (await client.listTools()).tools.find((t) => t.name === "top_up")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    const out = body(await call(client, "top_up", { amount_micro: "5000000" }));
    expect(out.payment_required).toEqual(REQUIRED);
    expect(out.how_to_pay).toContain("PAYMENT-SIGNATURE");
    expect(api.billing.topUp).toHaveBeenCalledWith("5000000");
  });

  it("with a wallet (spend allowed) it is a destructive write that returns the paid result", async () => {
    const api = stubApi();
    const paid = { status: "paid", result: { intent_id: RENTAL_ID, state: "PENDING_FINALITY", amount_micro: "5000000", payer: "0xabc", tx_hash: "0x01", log_index: 5, network: "eip155:8453" } };
    api.billing.topUp.mockResolvedValue(paid);
    const client = await connect(api, true, undefined, true);
    const tool = (await client.listTools()).tools.find((t) => t.name === "top_up")!;
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toContain("top_up pays USDC");
    expect(body(await call(client, "top_up", { amount_micro: "5000000" }))).toEqual(paid);
  });

  it("rejects a non-integer amount before calling the API", async () => {
    const api = stubApi();
    const r = await call(await connect(api), "top_up", { amount_micro: "1.5" });
    expect(r.isError).toBe(true);
    expect(api.billing.topUp).not.toHaveBeenCalled();
  });
});

describe("agent self-registration", () => {
  async function connectWith(api: Stub, opts: Partial<Parameters<typeof createServer>[1]>) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(api as unknown as Api, { allowSpend: false, version: "0.0.0-test", ...opts }).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("registrationOnly serves just the two registration tools", async () => {
    const { tools } = await (await connectWith(stubApi(), { registrationOnly: true })).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(REGISTRATION_TOOLS);
  });

  it("passes a signed challenge through and never asks for a private key", async () => {
    const api = stubApi();
    const client = await connectWith(api, { registrationOnly: true });
    const { tools } = await client.listTools();
    for (const t of tools) expect(JSON.stringify(t.inputSchema)).not.toMatch(/private|secret_key|mnemonic/i);
    const r = body(await call(client, "register_agent_account", { agent: AGENT, message: CHALLENGE, signature: "0xabcdef" }));
    expect(r.api_key.secret).toBe("ark_new_agent_key");
    expect(api.agents.accounts.register).toHaveBeenCalledWith({ message: CHALLENGE, signature: "0xabcdef", agent: AGENT });
  });

  it("without a signer and without a signature, explains the steps and registers nothing", async () => {
    const api = stubApi();
    const client = await connectWith(api, {});
    expect(errorText(await call(client, "register_agent_account", { agent: AGENT }))).toMatch(/get_agent_account_challenge/);
    expect(errorText(await call(client, "register_agent_account", { agent: AGENT, message: CHALLENGE }))).toMatch(/both/);
    expect(api.agents.accounts.register).not.toHaveBeenCalled();
  });

  it("with a local signer does both steps and hands the new key to onApiKey", async () => {
    const api = stubApi();
    const signMessage = vi.fn().mockResolvedValue("0xsigned");
    const onApiKey = vi.fn();
    const client = await connectWith(api, { signer: { address: "0x1111111111111111111111111111111111111111", signMessage }, onApiKey });
    const r = body(await call(client, "register_agent_account", { agent: AGENT, scopes: ["renter", "host"] }));
    expect(api.agents.accounts.challenge).toHaveBeenCalledWith({ address: "0x1111111111111111111111111111111111111111" });
    expect(signMessage).toHaveBeenCalledWith(CHALLENGE);
    expect(api.agents.accounts.register).toHaveBeenCalledWith({ message: CHALLENGE, signature: "0xsigned", agent: AGENT, scopes: ["renter", "host"] });
    expect(onApiKey).toHaveBeenCalledWith("ark_new_agent_key");
    expect(r.use_key).toMatch(/now uses the new key/);
  });

  it("the challenge tool defaults to the signer's address and otherwise needs one", async () => {
    const api = stubApi();
    expect(errorText(await call(await connectWith(api, {}), "get_agent_account_challenge", {}))).toMatch(/address is required/);
    const signer = { address: "0x2222222222222222222222222222222222222222", signMessage: vi.fn() };
    body(await call(await connectWith(api, { signer }), "get_agent_account_challenge", {}));
    expect(api.agents.accounts.challenge).toHaveBeenCalledWith({ address: signer.address });
  });
});
