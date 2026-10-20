import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, Account, TransactionBuilder, Networks, Asset, Operation } from "@stellar/stellar-sdk";
import { StellarRpcProvider } from "../verification/evidenceProviders/stellarRpcProvider.ts";
import type { Requirement, WorkerClaim } from "../types/domain.ts";

// Helper to generate a valid base64 envelope XDR for Stellar Soroban RPC tests
function createSampleEnvelopeXdr(amount = "10"): { xdr: string; source: string; destination: string } {
  const source = Keypair.random();
  const dest = Keypair.random();
  const account = new Account(source.publicKey(), "100");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: dest.publicKey(),
        asset: Asset.native(),
        amount,
      })
    )
    .setTimeout(30)
    .build();
  tx.sign(source);
  return {
    xdr: tx.toXDR(),
    source: source.publicKey(),
    destination: dest.publicKey(),
  };
}

const fastRetryConfig = {
  maxNotFoundRetries: 3,
  notFoundRetryIntervalMs: 5,
  maxTransientRetries: 3,
  transientBackoffDelaysMs: [5, 10, 15],
};

test("Soroban RPC Retry: Eventual ledger confirmation after NOT_FOUND polling", async () => {
  const originalFetch = globalThis.fetch;
  const sample = createSampleEnvelopeXdr("25");
  let callCount = 0;

  try {
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 3) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "NOT_FOUND" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "SUCCESS",
            txHash: "a1b2c3d4e5f67890",
            ledger: 500123,
            createdAt: new Date().toISOString(),
            envelopeXdr: sample.xdr,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const tx = await provider.getTransaction("0xa1b2c3d4e5f67890");

    assert.ok(tx, "Transaction must resolve");
    assert.equal(tx.exists, true, "Transaction exists after ledger confirmation");
    assert.equal(tx.successful, true, "Transaction succeeded");
    assert.equal(tx.attempts, 3, "Captured exactly 3 attempts (2 NOT_FOUND + 1 SUCCESS)");
    assert.equal(tx.lastRpcStatus, 200, "Final RPC status is 200");
    assert.ok(typeof tx.rpcResponseTimeMs === "number" && tx.rpcResponseTimeMs >= 0, "Response time tracked");
    assert.equal(tx.amount, 25, "Transferred amount matches decoded XDR");
    assert.equal(tx.destinationAccount, sample.destination, "Destination matches decoded XDR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Retry: Immediate SUCCESS on first attempt without extra retries", async () => {
  const originalFetch = globalThis.fetch;
  const sample = createSampleEnvelopeXdr("50");
  let callCount = 0;

  try {
    globalThis.fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "SUCCESS",
            txHash: "immediate123456",
            ledger: 500124,
            createdAt: new Date().toISOString(),
            envelopeXdr: sample.xdr,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const tx = await provider.getTransaction("0ximmediate123456");

    assert.ok(tx);
    assert.equal(tx.exists, true);
    assert.equal(tx.attempts, 1, "Only 1 attempt needed");
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Retry: Transient HTTP 5xx errors recover with backoff", async () => {
  const originalFetch = globalThis.fetch;
  const sample = createSampleEnvelopeXdr("15");
  let callCount = 0;

  try {
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Bad Gateway", { status: 502 });
      }
      if (callCount === 2) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "SUCCESS",
            txHash: "transient5xx1234",
            ledger: 500125,
            createdAt: new Date().toISOString(),
            envelopeXdr: sample.xdr,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const tx = await provider.getTransaction("0xtransient5xx1234");

    assert.ok(tx);
    assert.equal(tx.exists, true);
    assert.equal(tx.attempts, 3, "Recovered after 2 transient 5xx attempts");
    assert.equal(tx.lastRpcStatus, 200);
    assert.equal(callCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Retry: Transient network connection error recovers", async () => {
  const originalFetch = globalThis.fetch;
  const sample = createSampleEnvelopeXdr("10");
  let callCount = 0;

  try {
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new TypeError("fetch failed: ECONNRESET");
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "SUCCESS",
            txHash: "neterror1234",
            ledger: 500126,
            createdAt: new Date().toISOString(),
            envelopeXdr: sample.xdr,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const tx = await provider.getTransaction("0xneterror1234");

    assert.ok(tx);
    assert.equal(tx.exists, true);
    assert.equal(tx.attempts, 2, "2 attempts made after network retry");
    assert.equal(callCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Retry: NOT_FOUND retry exhaustion marks transaction as not found", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  try {
    globalThis.fetch = async (url) => {
      callCount++;
      // RPC endpoint returning NOT_FOUND
      if (String(url).includes("soroban")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "NOT_FOUND" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Horizon fallback also 404
      return new Response("Not Found", { status: 404 });
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const tx = await provider.getTransaction("0xunknownhash99999999");

    assert.ok(tx);
    assert.equal(tx.exists, false, "Marked as not existing after retry exhaustion");
    assert.equal(tx.attempts, 4, "Initial attempt + 3 retries = 4 total attempts");
    assert.equal(tx.lastRpcStatus, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Retry: Transient HTTP 5xx exhaustion halts cleanly", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  try {
    globalThis.fetch = async () => {
      callCount++;
      return new Response("Internal Server Error", { status: 500 });
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const tx = await provider.getTransaction("0xexhausted500hash");

    assert.ok(tx);
    assert.equal(tx.exists, false);
    assert.equal(tx.attempts, 4, "Initial attempt + 3 retries = 4 total attempts");
    assert.equal(tx.lastRpcStatus, 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Diagnostic Telemetry: Attached to Payment Evidence records", async () => {
  const originalFetch = globalThis.fetch;
  const sample = createSampleEnvelopeXdr("100");
  let callCount = 0;

  try {
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "NOT_FOUND" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "SUCCESS",
            txHash: "telemetrypay123",
            ledger: 500127,
            createdAt: new Date().toISOString(),
            envelopeXdr: sample.xdr,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const requirement: Requirement = {
      id: "req_pay_1",
      type: "transaction",
      description: "Pay 100 XLM",
      expected: { amount: 100, token: "XLM" },
      critical: true,
    };

    const claims: WorkerClaim[] = [
      {
        id: "claim_1",
        requirementId: "req_pay_1",
        type: "output",
        source: "worker",
        value: { txHash: "0xtelemetrypay123", amount: 100, token: "XLM" },
      },
    ];

    const result = await provider.verify(requirement, claims, {} as any);

    assert.equal(result.status, "passed");
    assert.equal(result.evidence.length, 1);

    const ev = result.evidence[0];
    assert.equal(ev.source, "stellar_rpc");
    assert.equal(ev.type, "blockchain");

    // Diagnostic metadata assertions
    assert.equal(ev.metadata?.attempts, 2, "Metadata includes attempts");
    assert.equal(ev.metadata?.lastRpcStatus, 200, "Metadata includes lastRpcStatus");
    assert.ok(typeof ev.metadata?.rpcResponseTimeMs === "number", "Metadata includes rpcResponseTimeMs");

    // Diagnostic value assertions
    const val = ev.value as Record<string, unknown>;
    assert.equal(val.attempts, 2, "Value includes attempts");
    assert.equal(val.lastRpcStatus, 200, "Value includes lastRpcStatus");
    assert.ok(typeof val.rpcResponseTimeMs === "number", "Value includes rpcResponseTimeMs");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC Diagnostic Telemetry: Attached to Trade Evidence records", async () => {
  const originalFetch = globalThis.fetch;
  const sample = createSampleEnvelopeXdr("50");

  try {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            status: "SUCCESS",
            txHash: "telemetrytrade123",
            ledger: 500128,
            createdAt: new Date().toISOString(),
            envelopeXdr: sample.xdr,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new StellarRpcProvider(
      "https://soroban-mock.stellar.org",
      "https://horizon-mock.stellar.org",
      Networks.TESTNET,
      fastRetryConfig
    );

    const requirement: Requirement = {
      id: "req_trade_1",
      type: "trade",
      description: "DEX trade swap",
      expected: { inputAmount: 50, inputToken: "USDC", outputToken: "XLM" },
      critical: true,
    };

    const claims: WorkerClaim[] = [
      {
        id: "claim_trade_1",
        requirementId: "req_trade_1",
        type: "output",
        source: "worker",
        value: { txHash: "0xtelemetrytrade123", inputAmount: 50 },
      },
    ];

    const result = await provider.verify(requirement, claims, {} as any);

    assert.equal(result.status, "passed");
    const ev = result.evidence[0];
    assert.equal(ev.metadata?.attempts, 1);
    assert.equal(ev.metadata?.lastRpcStatus, 200);
    assert.ok(typeof ev.metadata?.rpcResponseTimeMs === "number");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Soroban RPC: Per-call overrideConfig is respected", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  try {
    globalThis.fetch = async (url) => {
      callCount++;
      if (String(url).includes("soroban")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "NOT_FOUND" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const provider = new StellarRpcProvider();

    // Override with maxNotFoundRetries = 1
    const tx = await provider.getTransaction("0xoverridetest", {
      maxNotFoundRetries: 1,
      notFoundRetryIntervalMs: 5,
    });

    assert.ok(tx);
    assert.equal(tx.exists, false);
    assert.equal(tx.attempts, 2, "1 initial + 1 override retry = 2 total attempts");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
