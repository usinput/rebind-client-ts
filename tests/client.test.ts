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

  test("screenDisplays unwraps the envelope", async () => {
    const displays = await client.screenDisplays();
    expect(displays).toHaveLength(1);
    expect(displays[0]).toMatchObject({ index: 1, primary: true });
  });

  test("screenCapture returns frame, geometry, and cursor", async () => {
    const cap = await client.screenCapture();
    expect(cap.image.length).toBeGreaterThan(0);
    expect(cap.width).toBe(1920);
    expect(cap.height).toBe(1080);
    expect(cap.display.index).toBe(1);
    expect(cap.cursor).toEqual({ x: 100, y: 200 });
  });

  test("screenCapture forwards region", async () => {
    const cap = await client.screenCapture({
      region: { x: 10, y: 20, w: 300, h: 150 },
    });
    expect(cap.width).toBe(300);
    expect(cap.height).toBe(150);
  });

  test("screenCapture sends maxEdge as max_edge", async () => {
    const cap = await client.screenCapture({ maxEdge: 640 });
    expect(cap.width).toBe(640);
  });

  test("call args cannot override the command or correlation id", async () => {
    const r = await client.call<{ time_ms: number }>("ping", {
      t: "bogus",
      id: "x",
    });
    expect(r.time_ms).toBeGreaterThan(0);
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

  test("HID methods send exact ordered frames without request IDs", async () => {
    client.hidDown("A");
    client.hidUp("A");
    client.hidPress("A", 10);
    client.hidPress("B");
    client.hidType("hello");
    client.hidMove(10, 20);
    client.hidMoveTo(100, 200);
    client.hidScroll(3);
    await client.ping(); // ordered RPC barrier after the fire-and-forget frames
    expect(server.hidFrames).toEqual([
      { t: "hid.down", code: "A" },
      { t: "hid.up", code: "A" },
      { t: "hid.press", code: "A", hold_ms: 10 },
      { t: "hid.press", code: "B", hold_ms: 20 },
      { t: "hid.type", text: "hello" },
      { t: "hid.move", dx: 10, dy: 20 },
      { t: "hid.move_to", x: 100, y: 200 },
      { t: "hid.scroll", delta: 3 },
    ]);
  });

  test("fire-and-forget on disconnected client throws ConnectionError", () => {
    client.close();
    expect(() => client.hidMove(10, 20)).toThrow(ConnectionError);
  });
});
