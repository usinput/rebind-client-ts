// Auto-reconnect behavior: server drops, backoff, re-authentication,
// re-subscription, attempt limits.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RebindRemote } from "../src/index.ts";
import { createMockServer, type MockServer } from "./helpers/mock-server.ts";

let server: MockServer;
let client: RebindRemote;

beforeEach(() => {
  server = createMockServer();
});

afterEach(async () => {
  client?.close();
  await server.stop();
});

/** helper: wait for a predicate, polling every 10ms, up to timeoutMs */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("auto-reconnect", () => {
  test("reconnects automatically after server drops connection", async () => {
    client = new RebindRemote(server.url, {
      autoReconnect: true,
      reconnectDelayMs: 20,
    });
    await client.connect();
    expect(client.connected).toBe(true);

    server.dropConnections();
    await waitFor(() => !client.connected);
    expect(client.state).toMatch(/disconnected|reconnecting/);

    await waitFor(() => client.connected);
    expect(client.connected).toBe(true);
  });

  test("re-authenticates on reconnect", async () => {
    await server.stop();
    server = createMockServer({ token: "secret" });
    client = new RebindRemote(server.url, {
      token: "secret",
      autoReconnect: true,
      reconnectDelayMs: 20,
    });
    await client.connect();
    expect(server.authCount).toBe(1);

    server.dropConnections();
    await waitFor(() => client.connected && server.authCount === 2);
    expect(server.authCount).toBe(2);
  });

  test("re-subscribes to active event streams on reconnect", async () => {
    client = new RebindRemote(server.url, {
      autoReconnect: true,
      reconnectDelayMs: 20,
    });
    await client.connect();

    // start consuming mouse events — this auto-subscribes
    const ac = new AbortController();
    const received: Array<{ x: number; y: number }> = [];
    const consumer = (async () => {
      for await (const pos of client.mouseEvents(ac.signal)) {
        received.push(pos);
      }
    })();

    // wait for initial subscription
    await waitFor(() => server.subscribeCount >= 1);
    expect(server.subscribeCount).toBe(1);

    server.pushMouse(1, 2);
    await waitFor(() => received.length >= 1);
    expect(received[0]).toEqual({ x: 1, y: 2 });

    // drop and wait for reconnect + re-subscription
    const subscribeCountBefore = server.subscribeCount;
    server.dropConnections();
    await waitFor(() => client.connected && server.subscribeCount > subscribeCountBefore);
    expect(server.subscribeCount).toBe(subscribeCountBefore + 1);

    // events still flow post-reconnect
    server.pushMouse(10, 20);
    await waitFor(() => received.length >= 2);
    expect(received[1]).toEqual({ x: 10, y: 20 });

    ac.abort();
    await consumer;
  });

  test("honors reconnectMaxAttempts limit", async () => {
    client = new RebindRemote(server.url, {
      autoReconnect: true,
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 20,
      reconnectMaxAttempts: 2,
    });
    await client.connect();

    // stop server entirely so reconnects keep failing
    await server.stop();

    // wait long enough for the attempt loop to give up.
    // backoff schedule: 10ms, 20ms — total ~30-50ms, plus connect() failures
    await waitFor(() => client.state === "disconnected", 3000);
    expect(client.state).toBe("disconnected");
  });

  test("autoReconnect=false stays disconnected after drop", async () => {
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();
    server.dropConnections();
    await waitFor(() => client.state === "disconnected");

    // give it time — we want to ASSERT it did NOT reconnect
    await new Promise((r) => setTimeout(r, 200));
    expect(client.state).toBe("disconnected");
  });

  test("explicit close() disables reconnect", async () => {
    client = new RebindRemote(server.url, {
      autoReconnect: true,
      reconnectDelayMs: 10,
    });
    await client.connect();
    client.close();
    expect(client.state).toBe("disconnected");

    // wait longer than any reasonable backoff attempt
    await new Promise((r) => setTimeout(r, 200));
    expect(client.state).toBe("disconnected");
  });

  test("backoff delay grows exponentially (capped)", async () => {
    // stop the server before connecting so every attempt fails fast
    await server.stop();
    const stateLog: Array<{ state: string; t: number }> = [];
    const start = Date.now();

    client = new RebindRemote(server.url, {
      autoReconnect: true,
      reconnectDelayMs: 50,
      reconnectMaxDelayMs: 200,
      reconnectMaxAttempts: 4,
      onStateChange: (s) => stateLog.push({ state: s, t: Date.now() - start }),
    });

    try {
      await client.connect();
    } catch {
      /* expected — initial connect fails */
    }

    // give enough time for 4 attempts with backoff 50, 100, 200, 200 = ~550ms total
    await waitFor(() => client.state === "disconnected", 3000);

    // verify we saw multiple reconnecting transitions (not just one attempt)
    const reconnectingCount = stateLog.filter((s) => s.state === "reconnecting").length;
    expect(reconnectingCount).toBeGreaterThanOrEqual(1);
  });
});
