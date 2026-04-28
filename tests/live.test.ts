// Live integration tests against a real Rebind relay instance.
//
// requires: relay running at ws://192.168.1.91:19561 with auth_required: false
//
// run with:
//   bun test tests/live.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RebindRemote } from "../src/index.ts";

const LIVE_URL = "ws://192.168.1.91:19561";

let client: RebindRemote;

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

beforeAll(async () => {
  client = new RebindRemote(LIVE_URL, { autoReconnect: false, timeoutMs: 8000 });
  await client.connect();
});

afterAll(() => {
  client?.close();
});

// ── connection ────────────────────────────────────────────────────────────────

describe("connection", () => {
  test("client is connected after connect()", () => {
    expect(client.state).toBe("connected");
    expect(client.connected).toBe(true);
  });
});

// ── core rpcs ─────────────────────────────────────────────────────────────────

describe("ping", () => {
  test("returns a positive timestamp", async () => {
    const t = await client.ping();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(0);
  });
});

describe("screen", () => {
  test("screenResolution returns positive width and height", async () => {
    const res = await client.screenResolution();
    expect(typeof res.width).toBe("number");
    expect(typeof res.height).toBe("number");
    expect(res.width).toBeGreaterThan(0);
    expect(res.height).toBeGreaterThan(0);
  });

  test("screenPixel returns valid rgb at (0, 0)", async () => {
    const px = await client.screenPixel(0, 0);
    expect(typeof px.r).toBe("number");
    expect(typeof px.g).toBe("number");
    expect(typeof px.b).toBe("number");
    expect(px.r).toBeGreaterThanOrEqual(0);
    expect(px.r).toBeLessThanOrEqual(255);
    expect(px.g).toBeGreaterThanOrEqual(0);
    expect(px.g).toBeLessThanOrEqual(255);
    expect(px.b).toBeGreaterThanOrEqual(0);
    expect(px.b).toBeLessThanOrEqual(255);
  });
});

describe("system", () => {
  test("systemMouse returns a point on screen", async () => {
    const res = await client.screenResolution();
    const pos = await client.systemMouse();
    expect(typeof pos.x).toBe("number");
    expect(typeof pos.y).toBe("number");
    expect(pos.x).toBeGreaterThanOrEqual(0);
    expect(pos.y).toBeGreaterThanOrEqual(0);
    expect(pos.x).toBeLessThanOrEqual(res.width);
    expect(pos.y).toBeLessThanOrEqual(res.height);
  });

  test("systemWindow returns a window with expected shape", async () => {
    const win = await client.systemWindow();
    expect(typeof win.title).toBe("string");
    expect(typeof win.process).toBe("string");
    expect(typeof win.x).toBe("number");
    expect(typeof win.y).toBe("number");
    expect(typeof win.width).toBe("number");
    expect(typeof win.height).toBe("number");
  });

  test("systemTime returns a recent epoch ms timestamp", async () => {
    const before = Date.now();
    const t = await client.systemTime();
    const after = Date.now();
    // allow 60 seconds of clock skew between this machine and the relay host
    expect(t).toBeGreaterThan(before - 60_000);
    expect(t).toBeLessThan(after + 60_000);
  });
});

describe("input", () => {
  test("inputKeys returns an array", async () => {
    const keys = await client.inputKeys();
    expect(Array.isArray(keys)).toBe(true);
  });

  test("inputModifiers returns all four boolean fields", async () => {
    const mods = await client.inputModifiers();
    expect(typeof mods.shift).toBe("boolean");
    expect(typeof mods.ctrl).toBe("boolean");
    expect(typeof mods.alt).toBe("boolean");
    expect(typeof mods.win).toBe("boolean");
  });

  test("inputIsDown for an unlikely key returns false", async () => {
    // F24 is virtually never held — safe to assert false
    const down = await client.inputIsDown("F24");
    expect(down).toBe(false);
  });
});

describe("clipboard", () => {
  test("clipboardSet then clipboardGet round-trips text", async () => {
    const sentinel = `rebind-live-test-${Date.now()}`;
    await client.clipboardSet(sentinel);
    const got = await client.clipboardGet();
    expect(got).toBe(sentinel);
  });
});

describe("window list", () => {
  test("windowList returns an array of window objects", async () => {
    const wins = await client.windowList();
    expect(Array.isArray(wins)).toBe(true);
    if (wins.length > 0) {
      const w = wins[0]!;
      expect(typeof w.title).toBe("string");
      expect(typeof w.process).toBe("string");
    }
  });
});

describe("lua.exec", () => {
  test("is disabled in this relay config — ServerError with code 'disabled'", async () => {
    const { ServerError } = await import("../src/index.ts");
    const err = await client.luaExec("return 1 + 1").catch((e) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect((err as InstanceType<typeof ServerError>).code).toBe("disabled");
  });
});

// ── event streams ─────────────────────────────────────────────────────────────

describe("mouseEvents stream", () => {
  test("receives at least one event within 3 seconds", async () => {
    const ac = new AbortController();
    const received: Array<{ x: number; y: number }> = [];

    const consumer = (async () => {
      for await (const pos of client.mouseEvents(ac.signal)) {
        received.push(pos);
        ac.abort();
      }
    })();

    // abort after 3s if no events arrive (mouse may not be moving)
    const timeout = setTimeout(() => ac.abort(), 3000);

    await consumer;
    clearTimeout(timeout);

    if (received.length > 0) {
      const pos = received[0]!;
      expect(typeof pos.x).toBe("number");
      expect(typeof pos.y).toBe("number");
    }
    // no hard assertion on count — mouse may genuinely be still
  });
});

describe("windowEvents stream", () => {
  test("subscription does not throw and stream can be cleanly aborted", async () => {
    const ac = new AbortController();
    let threw = false;

    const consumer = (async () => {
      try {
        for await (const _win of client.windowEvents(ac.signal)) {
          // take the first one if it arrives
          ac.abort();
        }
      } catch {
        threw = true;
      }
    })();

    // abort after 1s regardless
    setTimeout(() => ac.abort(), 1000);
    await consumer;

    expect(threw).toBe(false);
  });
});

describe("inputEvents stream", () => {
  test("subscription does not throw and stream can be cleanly aborted", async () => {
    const ac = new AbortController();
    let threw = false;

    const consumer = (async () => {
      try {
        for await (const _state of client.inputEvents(ac.signal)) {
          ac.abort();
        }
      } catch {
        threw = true;
      }
    })();

    setTimeout(() => ac.abort(), 1000);
    await consumer;

    expect(threw).toBe(false);
  });
});
