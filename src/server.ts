// @amplerun/mcp: MCP tools over the AmpleRun business API (@amplerun/sdk).
//
// Read tools always run. create_rental and stop_rental refuse unless the
// process was started with AMPLERUN_MCP_ALLOW_SPEND=1. Money stays in the
// API's decimal micro-unit strings; the only arithmetic (the quote fee split)
// is BigInt with the ledger's floor formula (packages/core computeCharge).
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { AmpleRunError, type AmpleRun, type Schemas } from "@amplerun/sdk";
import { z } from "zod";

/** The slice of the SDK the tools call; tests pass a stub. */
export type Api = {
  templates: Pick<AmpleRun["templates"], "list" | "get">;
  offers: Pick<AmpleRun["offers"], "list">;
  quotes: Pick<AmpleRun["quotes"], "create">;
  jobs: Pick<AmpleRun["jobs"], "create" | "get" | "list" | "access" | "stop">;
  billing: Pick<AmpleRun["billing"], "get" | "topUp">;
  agents: { accounts: Pick<AmpleRun["agents"]["accounts"], "challenge" | "register"> };
};

/** A wallet that signs locally (stdio with AMPLERUN_AGENT_WALLET_KEY). The key never leaves the process. */
export interface WalletSigner {
  address: string;
  signMessage(message: string): Promise<string>;
}

export interface Options {
  /** stdio: true only when AMPLERUN_MCP_ALLOW_SPEND=1. Hosted: true when the API key has the renter scope. */
  allowSpend: boolean;
  /** True only when spending is allowed AND an operator wallet is configured
   * (AMPLERUN_MCP_WALLET_KEY_FILE): then `api` pays x402 top-ups itself. */
  canPay?: boolean;
  version: string;
  /** How spending is enabled, for tool descriptions and refusals. Defaults to the stdio env flag. */
  spendGate?: { enable: string; refused: string };
  /** Hosted, no API key: only the two agent-registration tools are served. */
  registrationOnly?: boolean;
  /** stdio: register_agent_account signs the challenge itself with this wallet. */
  signer?: WalletSigner;
  /** stdio: called with a newly issued API key so later tools use it. */
  onApiKey?: (secret: string) => void;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SSH_PUBLIC_KEY_RE =
  /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
const GIB = 1024n ** 3n;

const uuid = z.string().regex(UUID_RE, "expected a UUID");
const micro = z.string().regex(/^[1-9][0-9]{0,17}$/, 'expected a positive integer string of micro-units, e.g. "5000000" for 5 USDC');
const templateRef = z
  .string()
  .regex(new RegExp(`${SLUG_RE.source}|${UUID_RE.source}`), "expected a template slug or UUID")
  .describe('Template slug such as "pytorch-cuda", or its id (UUID), from list_templates.');
const duration = z.number().int().min(60).max(31_536_000).describe("Maximum runtime in seconds (60 to 31536000), e.g. 7200 for two hours.");
const budget = micro.describe(
  'Spending cap in micro-units of the asset ("1000000" = 1 USDC). The rental is never charged more than this.',
);
const asset = z.enum(["USDC", "USDT"]).optional().describe("Balance to pay from. USDC when omitted.");
const limit = (dflt: number) => z.number().int().min(1).max(100).default(dflt).describe("Page size, 1 to 100.");
const cursor = z.string().min(1).optional().describe("next_cursor from the previous page.");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const STDIO_GATE = {
  enable: "the server was started with AMPLERUN_MCP_ALLOW_SPEND=1 (the default is read-only)",
  refused:
    "Refused: this AmpleRun MCP server is read-only. Restart it with AMPLERUN_MCP_ALLOW_SPEND=1 in its environment to allow creating and stopping rentals.",
};

/** The host one-liner in JSON mode (the installer at amplerun.com/host answers; checked 2026-09-30). */
export const HOST_COMMAND = "curl -fsSL https://amplerun.com/host | sudo AMPLERUN_OUTPUT=json bash";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (text: string): Result => ({ isError: true, content: [{ type: "text", text }] });

/** Error text for the model. Never includes request headers, so never the API key. */
function explain(e: unknown): string {
  if (e instanceof AmpleRunError) {
    const hint =
      e.status === 401 ? " Set AMPLERUN_API_KEY to an AmpleRun API key with the renter scope (https://amplerun.com/account/security)." : "";
    const id = e.requestId ? `, request_id ${e.requestId}` : "";
    return `AmpleRun API error ${e.status} ${e.code}: ${e.message.slice(0, 500)} (retryable: ${e.retryable}${id}).${hint}`;
  }
  const cause = (e as { cause?: { code?: string } } | null)?.cause?.code;
  return `AmpleRun request failed: ${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause})` : ""}.`;
}

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(explain(e));
  }
}

/** Drop undefined values: exactOptionalPropertyTypes forbids passing them to the SDK. */
const defined = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Upper bound of what a quote can charge and its split, with the ledger's
 * formula: fee = floor(charge * bps / 10000), host = charge - fee.
 */
export function feeSplit(q: Pick<Schemas["Quote"], "budget_micro" | "estimated_total_micro" | "platform_fee_bps">) {
  const cap = BigInt(q.budget_micro);
  const estimate = q.estimated_total_micro === undefined ? cap : BigInt(q.estimated_total_micro);
  const charge = estimate < cap ? estimate : cap;
  const fee = (charge * BigInt(q.platform_fee_bps)) / 10_000n;
  return {
    max_charge_micro: charge.toString(),
    platform_fee_micro: fee.toString(),
    host_micro: (charge - fee).toString(),
    platform_fee_bps: q.platform_fee_bps,
    note: "Upper bound: the smaller of estimated_total_micro and budget_micro. The fee comes out of the charge, never on top. Metering starts at verified readiness, so the final charge can be lower.",
  };
}

const templateSummary = (t: Schemas["Template"]) => ({
  id: t.id,
  template_id: t.template_id,
  name: t.name,
  kind: t.kind,
  engine: t.engine,
  quantization: t.quantization,
  min_vram_bytes: t.vram_fit.min_vram_bytes,
  min_gpu_count: t.min_gpu_count,
  required_runtime: t.required_runtime,
  exposes: t.exposes,
});

const offerSummary = (o: Schemas["OfferSummary"]) => ({
  offer_id: o.offer_id,
  model: o.model,
  gpu_count: o.gpu_count,
  vram_bytes: o.vram_bytes,
  region: o.region,
  total_rate_micro_per_hour: o.total_rate_micro_per_hour,
  platform_fee_bps: o.platform_fee_bps,
  readiness: o.readiness,
  verification_level: o.verification_level,
  reliability_score: o.reliability?.score,
  included_quotas: o.included_quotas,
  available_until: o.available_until,
  fit: o.fit,
});

const rentalSummary = (j: Schemas["Job"]) => ({
  rental_id: j.job_id,
  state: j.state,
  cumulative_charge_micro: j.cumulative_charge_micro,
  rate_micro_per_hour: j.rate_micro_per_hour,
  funded_through: j.funded_through,
  meter_started_at: j.meter_started_at,
  template: j.template?.template_id,
});

export function createServer(api: Api, opts: Options): McpServer {
  const gate = opts.spendGate ?? STDIO_GATE;
  const WRITE_NOTE = `Write tool: refused unless ${gate.enable}.`;
  const REFUSED = gate.refused;
  const server = new McpServer(
    { name: "amplerun", title: "AmpleRun GPU rentals", version: opts.version },
    {
      instructions: [
        "AmpleRun rents GPUs from independent hosts, paid from a prepaid USDC or USDT balance.",
        'Money values are integer strings in micro-units: "1000000" is 1 USDC. Offer prices are per hour for the whole machine, fee included.',
        "Renting goes list_templates, search_offers, get_quote (optional), create_rental, get_rental; stop_rental ends a rental.",
        "No account yet? get_agent_account_challenge then register_agent_account opens one for this agent with a wallet signature, no email.",
        "host_this_machine explains how to add this machine's GPU to AmpleRun so its owner earns from it; the owner must approve.",
        opts.canPay
          ? "top_up pays USDC into the balance from this server's wallet (x402); the credit lands after Base finality."
          : "top_up returns the x402 payment requirements for adding USDC; this server has no wallet to pay them.",
        opts.allowSpend
          ? "Spending is enabled: create_rental and stop_rental act on the account."
          : `This server is read-only: create_rental and stop_rental are refused. ${REFUSED}`,
      ].join(" "),
    },
  );

  registerAgentTools(server, api, opts);
  if (opts.registrationOnly) return server;

  const templateUuid = async (ref: string) => (UUID_RE.test(ref) ? ref : (await api.templates.get(ref)).id);

  server.registerTool(
    "list_templates",
    {
      title: "List GPU templates",
      description:
        "List published AmpleRun templates: pinned container images a rental runs, such as an inference server with fixed model weights or a PyTorch or Jupyter runtime. Returns each template's id, slug (template_id), name, kind, engine, minimum VRAM in bytes and minimum GPU count, plus next_cursor. Read-only; no API key needed. search_offers finds machines for a template.",
      inputSchema: z.object({
        kind: z.enum(["model", "classical", "custom"]).optional().describe("model: an inference server with pinned weights; classical: a general runtime; custom: other images."),
        gpu_vram_gib: z.number().int().min(1).max(4096).optional().describe("Only templates that fit on a GPU with this much VRAM, in GiB (e.g. 24)."),
        limit: limit(20),
        cursor,
      }),
      annotations: READ,
    },
    (a) =>
      run(async () => {
        const vram = a.gpu_vram_gib === undefined ? undefined : (BigInt(a.gpu_vram_gib) * GIB).toString();
        const page = await api.templates.list(defined({ kind: a.kind, min_vram_bytes: vram, limit: a.limit, cursor: a.cursor }));
        return { items: page.items.map(templateSummary), next_cursor: page.next_cursor };
      }),
  );

  server.registerTool(
    "search_offers",
    {
      title: "Search GPU offers",
      description:
        "Search GPU machines that can be rented now on AmpleRun. gpu_model, gpu_count and max_rate_micro_per_hour filter on the server. min_vram_gib and region filter each fetched page here because the API has no such filters, so a page can return fewer than limit matches: scanned is how many offers were checked, and next_cursor continues. Prices are micro-units per hour for the whole machine, fee included; cheapest first. With template, each offer carries fit {fits, reason}. Read-only; no API key needed.",
      inputSchema: z.object({
        gpu_model: z.string().min(1).max(64).optional().describe('Case-insensitive part of the GPU model name, e.g. "4090" or "A100".'),
        min_vram_gib: z.number().int().min(1).max(4096).optional().describe("Minimum VRAM per GPU in GiB. Offers with unmeasured VRAM are excluded."),
        max_rate_micro_per_hour: micro.optional().describe('Highest machine price per hour in micro-units, e.g. "500000" for 0.50 USDC/h.'),
        region: z.string().min(1).max(64).optional().describe('Case-insensitive part of the host\'s cloud region, e.g. "us-east". Offers without a reported region are excluded.'),
        gpu_count: z.number().int().min(1).max(64).optional().describe("Minimum number of GPUs in the machine."),
        template: templateRef.optional(),
        limit: limit(20),
        cursor,
      }),
      annotations: READ,
    },
    (a) =>
      run(async () => {
        const template_id = a.template === undefined ? undefined : await templateUuid(a.template);
        const page = await api.offers.list(
          defined({
            model: a.gpu_model,
            gpu_count: a.gpu_count,
            max_rate_micro_per_hour: a.max_rate_micro_per_hour,
            template_id,
            limit: a.limit,
            cursor: a.cursor,
          }),
        );
        const minVram = a.min_vram_gib === undefined ? undefined : BigInt(a.min_vram_gib) * GIB;
        const region = a.region?.toLowerCase();
        const items = page.items.filter(
          (o) =>
            (minVram === undefined || (o.vram_bytes !== undefined && BigInt(o.vram_bytes) >= minVram)) &&
            (region === undefined || (o.region ?? "").toLowerCase().includes(region)),
        );
        return { items: items.map(offerSummary), scanned: page.items.length, next_cursor: page.next_cursor };
      }),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Get a rental quote",
      description:
        "Price a rental without committing: creates a free, non-binding AmpleRun quote (valid 60 seconds; nothing is reserved or charged) for a template on an offer, capped by budget_micro. Returns the quote exactly as the API sent it plus fee_split: the most the rental can cost and how that divides into the platform fee (platform_fee_bps) and the host's share. Needs AMPLERUN_API_KEY with the renter scope. create_rental quotes again when it reserves, so this step is optional.",
      inputSchema: z.object({
        template: templateRef,
        offer_id: uuid.describe("offer_id from search_offers."),
        duration_limit_s: duration,
        budget_micro: budget,
        asset,
      }),
      // A new quote id per call, but nothing is reserved or charged.
      annotations: { ...READ, idempotentHint: false },
    },
    (a) =>
      run(async () => {
        const quote = await api.quotes.create({
          offer_id: a.offer_id,
          template_id: await templateUuid(a.template),
          duration_limit_s: a.duration_limit_s,
          budget_micro: a.budget_micro,
          ...(a.asset ? { asset: a.asset } : {}),
        });
        return { quote, fee_split: feeSplit(quote) };
      }),
  );

  server.registerTool(
    "create_rental",
    {
      title: "Rent a GPU (spends balance)",
      description: `Rent a GPU on AmpleRun: quotes the template on the offer and reserves the machine in one step, holding up to budget_micro from the account balance. budget_micro is required and is a hard cap: the rental is never charged more, and metering starts only once the machine is verified ready. Returns rental_id, state, the quote, fee_split and the idempotency_key used; retrying with the same idempotency_key never creates a second rental. get_rental reports state and access. Spends money. ${WRITE_NOTE}`,
      inputSchema: z.object({
        template: templateRef,
        offer_id: uuid.describe("offer_id from search_offers."),
        duration_limit_s: duration,
        budget_micro: budget,
        ssh_public_key: z
          .string()
          .max(4096)
          .regex(SSH_PUBLIC_KEY_RE, "expected a one-line OpenSSH public key such as ssh-ed25519 AAAA... (never a private key)")
          .describe('One-line OpenSSH public key (the .pub file), e.g. "ssh-ed25519 AAAA... you@laptop". Installed for SSH access.'),
        asset,
        idempotency_key: uuid.optional().describe("UUID that makes retries safe. Generated when omitted and returned in the result."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      if (!opts.allowSpend) return fail(REFUSED);
      // One key covers both POSTs: the server scopes keys per (principal, route, key).
      const key = a.idempotency_key ?? randomUUID();
      try {
        const quote = await api.quotes.create(
          {
            offer_id: a.offer_id,
            template_id: await templateUuid(a.template),
            duration_limit_s: a.duration_limit_s,
            budget_micro: a.budget_micro,
            ...(a.asset ? { asset: a.asset } : {}),
          },
          { idempotencyKey: key },
        );
        const job = await api.jobs.create({ quote_id: quote.quote_id, ssh_public_key: a.ssh_public_key }, { idempotencyKey: key });
        return ok({ rental_id: job.job_id, state: job.state, idempotency_key: key, quote, fee_split: feeSplit(quote) });
      } catch (e) {
        // A retry after a lost response usually fails at quoting (the machine is now
        // taken) rather than with IDEMPOTENCY_CONFLICT, so hint whenever the caller chose the key.
        const replay =
          e instanceof AmpleRunError && e.code === "IDEMPOTENCY_CONFLICT"
            ? " No new rental was created: this idempotency_key already belongs to an earlier request, which may have succeeded; list_rentals shows it."
            : a.idempotency_key
              ? " If an earlier attempt with this idempotency_key timed out, it may have reserved; list_rentals shows it."
              : "";
        return fail(`${explain(e)}${replay} idempotency_key: ${key}`);
      }
    },
  );

  server.registerTool(
    "get_rental",
    {
      title: "Get rental status and access",
      description:
        "Get one AmpleRun rental by rental_id: state, cumulative charge (micro-units), rate and funded-through time. While it is RUNNING (verified ready), and read-only for a limited window after STOPPED, also returns access: endpoints, SSH host-key fingerprint, a ready-made command and, for model templates, the endpoint's per-rental API key. Read-only. list_rentals finds rental ids.",
      inputSchema: z.object({ rental_id: uuid.describe("rental_id from create_rental or list_rentals.") }),
      annotations: READ,
    },
    ({ rental_id }) =>
      run(async () => {
        const rental = await api.jobs.get(rental_id);
        if (rental.state !== "RUNNING" && rental.state !== "STOPPED") {
          return {
            rental,
            access: null,
            access_note: `No access in state ${rental.state}: it opens when the rental is RUNNING (verified ready), and read-only for a limited window after STOPPED.`,
          };
        }
        try {
          return { rental, access: await api.jobs.access(rental_id) };
        } catch (e) {
          return { rental, access: null, access_note: explain(e) };
        }
      }),
  );

  server.registerTool(
    "list_rentals",
    {
      title: "List my rentals",
      description:
        "List the account's AmpleRun rentals with state, charge so far (micro-units), rate and funded-through time. Ordered by id, not by time; page with next_cursor. Read-only. get_rental gives details and access for one rental.",
      inputSchema: z.object({ limit: limit(20), cursor }),
      annotations: READ,
    },
    (a) =>
      run(async () => {
        const page = await api.jobs.list(defined({ limit: a.limit, cursor: a.cursor }));
        return { items: page.items.map(rentalSummary), next_cursor: page.next_cursor };
      }),
  );

  server.registerTool(
    "stop_rental",
    {
      title: "Stop a rental",
      description: `Stop an AmpleRun rental: ends the workload and its metering. Files inside the machine stay reachable read-only only for a limited retrieval window. Stopping again is harmless. Returns rental_id and the new state (STOPPING or a later state). ${WRITE_NOTE}`,
      inputSchema: z.object({
        rental_id: uuid.describe("rental_id from create_rental or list_rentals."),
        reason: z.string().min(1).max(500).default("stopped by an AI agent via @amplerun/mcp").describe("Recorded with the stop."),
        idempotency_key: uuid.optional().describe("UUID that makes retries safe. Generated when omitted."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ rental_id, reason, idempotency_key }) => {
      if (!opts.allowSpend) return fail(REFUSED);
      return run(async () => {
        const r = await api.jobs.stop(rental_id, { reason }, idempotency_key ? { idempotencyKey: idempotency_key } : undefined);
        return { rental_id: r.job_id, state: r.state };
      });
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get account balance",
      description:
        "Get the AmpleRun account's USDC and USDT balances as micro-unit strings: spendable (available for new rentals), held by live rentals, pending, disputed and withdrawable, plus the last 30 days' spend. Read-only; needs AMPLERUN_API_KEY.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    () =>
      run(async () => {
        const [USDC, USDT] = await Promise.all([api.billing.get({ asset: "USDC" }), api.billing.get({ asset: "USDT" })]);
        return { USDC, USDT };
      }),
  );

  server.registerTool(
    "host_this_machine",
    {
      title: "Earn with this machine's GPU",
      description:
        "Explains how to add the GPU of the machine this agent runs on to AmpleRun, so its owner earns from rentals. Returns the one-line installer command, the steps and the earnings links. It runs nothing itself. The installer needs root, so ask the machine's owner before running it, and the owner must approve the machine from the approve_url it prints: nothing is listed without that approval.",
      inputSchema: z.object({}),
      annotations: { ...READ, openWorldHint: false },
    },
    async () =>
      ok({
        status:
          "DEPLOYED: the installer answers at https://amplerun.com/host. Linux with an NVIDIA GPU, rented whole, for now. If it fails, send the owner to https://amplerun.com/earn.",
        command: HOST_COMMAND,
        steps: [
          "Ask the machine's owner before running anything: the installer needs root (sudo).",
          "Run the command. With AMPLERUN_OUTPUT=json it prints one JSON object per line: hardware checks first, then pairing_code and approve_url, then live.",
          "Send approve_url and pairing_code to the owner. The owner signs in and approves the machine. Owner approval is required; the machine is never listed without it.",
          "Wait for the line that reports live. The machine is then listed, and rentals earn the owner 95% of the rate after the flat 5% fee.",
        ],
        earn_url: "https://amplerun.com/earn",
        earnings_url: "https://amplerun.com/host/earnings",
      }),
  );

  server.registerTool(
    "top_up",
    {
      title: opts.canPay ? "Top up the balance (pays from the wallet)" : "Get top-up payment instructions",
      description: opts.canPay
        ? "Top up the AmpleRun USDC balance by amount_micro with an x402 payment signed by this server's configured wallet (native USDC on Base, straight to AmpleRun's treasury). The payment is the authorization; nothing else is asked. Returns the funding intent, the payer and the transaction. The credit lands after Base finality: state PENDING_FINALITY first, then get_balance shows it. Spends money."
        : "Get what it takes to top up the AmpleRun USDC balance by amount_micro with x402: the payment requirements (network, USDC contract, treasury payTo, amount, EIP-712 domain). A wallet signs them as an EIP-3009 transferWithAuthorization and repeats POST /api/v1/billing/x402/top-up with the PAYMENT-SIGNATURE header (@amplerun/sdk does this with its x402 option). This server holds no wallet, so it pays nothing; an operator who configures AMPLERUN_MCP_WALLET_KEY_FILE and allows spending lets it pay.",
      inputSchema: z.object({
        amount_micro: micro.describe('Top-up amount in micro-USDC, e.g. "5000000" for 5 USDC.'),
      }),
      annotations: opts.canPay
        ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
        : READ,
    },
    ({ amount_micro }) =>
      run(async () => {
        const r = await api.billing.topUp(amount_micro);
        if (r.status !== "payment_required") return r;
        return {
          ...r,
          how_to_pay:
            "Sign accepts[0] as an EIP-3009 TransferWithAuthorization (domain from extra.name/extra.version, chainId from network, verifyingContract = asset; to = payTo; value = amount), then repeat POST /api/v1/billing/x402/top-up?amount_micro=" +
            amount_micro +
            " with the base64 x402 v2 payload in the PAYMENT-SIGNATURE header.",
        };
      }),
  );

  return server;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Agent self-registration (POST /api/v1/agents/accounts): an agent opens its
 * OWN account with a wallet signature, no email. Served without an API key.
 * Private keys are never tool input: the agent signs the challenge itself, or
 * the local server signs with AMPLERUN_AGENT_WALLET_KEY from its environment.
 */
function registerAgentTools(server: McpServer, api: Api, opts: Options) {
  const signer = opts.signer;
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool(
    "get_agent_account_challenge",
    {
      title: "Start registering this agent's own AmpleRun account",
      description: `Step 1 of 2. Returns an EIP-4361 (Sign-In with Ethereum) message for a wallet address this agent controls, valid five minutes, single use. Signing it accepts the AmpleRun Terms version it names. Sign the message exactly as returned with personal_sign (EIP-191), then call register_agent_account with message and signature. Never send a private key to any tool.${signer ? ` This server holds a wallet (${signer.address}); register_agent_account can do both steps itself.` : ""}`,
      inputSchema: z.object({
        address: z.string().regex(EVM_ADDRESS, "expected a 0x-prefixed 20-byte address").optional().describe("The agent's wallet address (0x...). Defaults to this server's wallet when it has one."),
      }),
      annotations: WRITE,
    },
    (a) =>
      run(async () => {
        const address = a.address ?? signer?.address;
        if (!address) throw new Error("address is required: give the wallet address this agent will sign with");
        return api.agents.accounts.challenge({ address });
      }),
  );

  server.registerTool(
    "register_agent_account",
    {
      title: "Register this agent's own AmpleRun account",
      description: `Step 2 of 2. Opens an AmpleRun account for this AI agent, tagged as agent-created, with its wallet as the verified payout wallet, and returns an API key (shown once; keep it secret). The same wallet again returns the same account and a new key. There is no free credit: renting needs a deposit first. Pass message and signature from get_agent_account_challenge${signer ? ", or omit both and this server signs with its own wallet" : ""}. scopes defaults to ["renter"]; add "host" to host machines.`,
      inputSchema: z.object({
        agent: z.object({
          name: z.string().min(1).max(100).describe("This agent's name."),
          vendor: z.string().min(1).max(64).describe('Who made the agent or its model, e.g. "grok".'),
          model: z.string().min(1).max(100).optional(),
          operator_contact: z.string().min(1).max(254).optional().describe("How to reach the person or business running this agent."),
          homepage: z.string().url().max(2048).optional(),
        }),
        message: z.string().min(1).max(2048).optional().describe("The challenge message, exactly as returned."),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(1024).optional().describe("0x-prefixed EIP-191 signature of message."),
        scopes: z.array(z.enum(["renter", "host"])).min(1).max(2).optional(),
      }),
      annotations: WRITE,
    },
    async (a) => {
      let { message, signature } = a;
      if (!message !== !signature) return fail("Pass both message and signature, or neither.");
      if (!message) {
        if (!signer) return fail("Pass message and signature: call get_agent_account_challenge, sign its message with your wallet (personal_sign), then call this again.");
        try {
          message = (await api.agents.accounts.challenge({ address: signer.address })).message;
          signature = await signer.signMessage(message);
        } catch (e) {
          return fail(explain(e));
        }
      }
      return run(async () => {
        const out = await api.agents.accounts.register({
          message: message!,
          signature: signature!,
          agent: defined(a.agent) as { name: string; vendor: string },
          ...(a.scopes ? { scopes: a.scopes } : {}),
        });
        opts.onApiKey?.(out.api_key.secret);
        return {
          ...out,
          use_key: opts.onApiKey
            ? "This server now uses the new key for its other tools. Save it: it is not shown again."
            : "Save the key: it is not shown again. Send it as Authorization: Bearer <secret> (hosted MCP: https://amplerun.com/api/mcp).",
        };
      });
    },
  );
}
