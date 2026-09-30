#!/usr/bin/env node
// amplerun-mcp: stdio entry. Configuration comes only from the environment:
//   AMPLERUN_API_KEY            ark_... key (renter scope); read tools on the public catalog work without it
//   AMPLERUN_BASE_URL           defaults to https://amplerun.com
//   AMPLERUN_MCP_ALLOW_SPEND=1  enables create_rental, stop_rental and paying top_up (read-only otherwise)
//   AMPLERUN_MCP_WALLET_KEY_FILE  file holding a 0x private key; with ALLOW_SPEND=1, top_up pays x402 from it
//   AMPLERUN_MCP_MAX_TOPUP_MICRO  optional per-payment cap for that wallet, in micro-USDC
//   AMPLERUN_AGENT_WALLET_KEY   0x... EVM private key; register_agent_account signs with it locally (never pays)
// stdout is the MCP channel, so diagnostics go to stderr, and never a key itself.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createAmpleRun, type X402Options } from "@amplerun/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, type Api, type WalletSigner } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const baseUrl = process.env.AMPLERUN_BASE_URL?.trim();
const allowSpend = process.env.AMPLERUN_MCP_ALLOW_SPEND === "1";
const walletKey = process.env.AMPLERUN_AGENT_WALLET_KEY?.trim();

const walletFile = process.env.AMPLERUN_MCP_WALLET_KEY_FILE?.trim();
const maxTopUp = process.env.AMPLERUN_MCP_MAX_TOPUP_MICRO?.trim();
// The paying wallet is loaded only when spending is allowed: no key in memory otherwise.
let x402: X402Options | undefined;
if (allowSpend && walletFile) {
  const payer = privateKeyToAccount(readFileSync(walletFile, "utf8").trim() as `0x${string}`);
  x402 = { signer: payer, ...(maxTopUp ? { maxAmountMicro: maxTopUp } : {}) };
}

let apiKey = process.env.AMPLERUN_API_KEY?.trim();
const connect = () =>
  createAmpleRun({ ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}), ...(x402 ? { x402 } : {}) });
let current = connect();
// Tools read the client through these getters, so a key issued by
// register_agent_account is used from the next call on.
const api: Api = {
  get templates() { return current.templates; },
  get offers() { return current.offers; },
  get quotes() { return current.quotes; },
  get jobs() { return current.jobs; },
  get billing() { return current.billing; },
  get agents() { return current.agents; },
};

// The registration signer only signs a sign-in message; it never pays.
let signer: WalletSigner | undefined;
if (walletKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(walletKey)) {
    console.error("amplerun-mcp: AMPLERUN_AGENT_WALLET_KEY must be a 0x-prefixed 32-byte hex private key; ignoring it.");
  } else {
    const account = privateKeyToAccount(walletKey as `0x${string}`);
    signer = { address: account.address, signMessage: (message) => account.signMessage({ message }) };
  }
}

serveStdio(() =>
  createServer(api, {
    allowSpend,
    canPay: x402 !== undefined,
    version,
    ...(signer ? { signer } : {}),
    onApiKey: (secret) => {
      apiKey = secret;
      current = connect();
    },
  }),
);
console.error(
  `amplerun-mcp ${version} on stdio: ${allowSpend ? "spending enabled" : "read-only"}, API key ${apiKey ? "set" : "not set"}, ` +
    `x402 wallet ${x402 ? `${x402.signer.address}${maxTopUp ? ` (cap ${maxTopUp} micro)` : ""}` : "not configured"}, ` +
    `registration wallet ${signer ? signer.address : "not set"}, ${baseUrl ?? "https://amplerun.com"}`,
);
