// Core client behavior: connect, RPCs, errors, AbortSignal, fire-and-forget.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ConnectionError,
  RebindRemote,
  ServerError,
  TimeoutError,
} from "../src/index.ts";
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

describe("connection lifecycle", () => {
  test("connect resolves when server accepts handshake", async () => {
    client = new RebindRemote(server.url, { autoReconnect: false });
    expect(client.state).toBe("disconnected");
    await client.connect();
    expect(client.state).toBe("connected");
    expect(client.connected).toBe(true);
  });

  test("connect is idempotent while already connected", async () => {
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();
    await client.connect(); // no-op
    expect(client.state).toBe("connected");
  });

  test("close transitions to disconnected", async () => {
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();
    client.close();
    expect(client.state).toBe("disconnected");
    expect(client.connected).toBe(false);
  });

  test("onStateChange fires for every transition", async () => {
    const states: string[] = [];
    client = new RebindRemote(server.url, {
      autoReconnect: false,
      onStateChange: (s) => states.push(s),
    });
    await client.connect();
    client.close();
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
  });

  test("auth is sent when token provided, required by server", async () => {
    await server.stop();
    server = createMockServer({ token: "secret" });
    client = new RebindRemote(server.url, {
      autoReconnect: false,
      token: "secret",
    });
    await client.connect();
    expect(client.connected).toBe(true);
    expect(server.authCount).toBe(1);
  });

  test("auth failure rejects connect", async () => {
    await server.stop();
    server = createMockServer({ token: "secret" });
    client = new RebindRemote(server.url, {
      autoReconnect: false,
      token: "wrong",
    });
    await expect(client.connect()).rejects.toBeInstanceOf(ServerError);
  });
});

describe("RPC", () => {
  beforeEach(async () => {
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();
  });

  test("ping returns time_ms", async () => {
    const t = await client.ping();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(0);
  });

  test("screenPixel returns typed RGB", async () => {
    const px = await client.screenPixel(10, 20);
    expect(px).toEqual({ r: 200 & 0xff, g: 10, b: 20 });
  });

  test("systemMouse returns typed Point", async () => {
    const pos = await client.systemMouse();
    expect(pos).toEqual({ x: 100, y: 200 });
  });

  test("systemWindow unwraps the envelope", async () => {
    const win = await client.systemWindow();
    expect(win.title).toBe("Mock Window");
    expect(win.process).toBe("mock.exe");
  });

  test("clipboardSet returns void (resolves)", async () => {
    const result = await client.clipboardSet("hello");
    expect(result).toBeUndefined();
  });

  test("server error becomes ServerError with code", async () => {
    try {
      await client.screenPixel(-1, -1);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ServerError);
      expect((e as ServerError).code).toBe("screen_error");
      expect((e as ServerError).message).toContain("negative");
    }
  });

  test("many concurrent RPCs all resolve correctly", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => client.screenPixel(i, i * 2)),
    );
    expect(results).toHaveLength(50);
    results.forEach((px, i) => {
      expect(px).toEqual({ r: (i * (i * 2)) & 0xff, g: i, b: (i * 2) & 0xff });
    });
  });

  test("RPC on disconnected client throws ConnectionError", async () => {
    client.close();
    await expect(client.ping()).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("AbortSignal", () => {
  test("pre-aborted signal rejects immediately", async () => {
    await server.stop();
    server = createMockServer({ replyDelayMs: 100 });
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();

    const ac = new AbortController();
    ac.abort();
    try {
      await client.clipboardGet(ac.signal);
      throw new Error("should have aborted");
    } catch (e) {
      expect((e as Error).name).toBe("AbortError");
    }
  });

  test("signal aborted during flight rejects the RPC", async () => {
    await server.stop();
    server = createMockServer({ replyDelayMs: 200 });
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();

    const ac = new AbortController();
    const promise = client.clipboardGet(ac.signal);
    setTimeout(() => ac.abort(), 30);

    try {
      await promise;
      throw new Error("should have aborted");
    } catch (e) {
      expect((e as Error).name).toBe("AbortError");
    }
  });
});

describe("timeouts", () => {
  test("RPC rejects with TimeoutError when reply never comes", async () => {
    await server.stop();
    server = createMockServer({ replyDelayMs: 500 });
    client = new RebindRemote(server.url, {
      autoReconnect: false,
      timeoutMs: 50,
    });
    await client.connect();
    await expect(client.clipboardGet()).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("fire-and-forget (HID)", () => {
  beforeEach(async () => {
    client = new RebindRemote(server.url, { autoReconnect: false });
    await client.connect();
  });

  test("hidMove does not throw and does not wait for reply", () => {
    // no-op on the server, but we're asserting no errors from the client side
    expect(() => client.hidMove(10, 20)).not.toThrow();
    expect(() => client.hidType("hello")).not.toThrow();
    expect(() => client.hidPress("A")).not.toThrow();
  });

  test("fire-and-forget on disconnected client throws ConnectionError", () => {
    client.close();
    expect(() => client.hidMove(10, 20)).toThrow(ConnectionError);
  });
});
