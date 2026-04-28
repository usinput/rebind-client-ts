// In-memory WebSocket mock server speaking the Rebind remote-access protocol.
// Uses Bun.serve for zero external deps. Provides just enough surface for
// unit tests: handshake, RPC dispatch, event pushing, programmable drops.

import type { Server, ServerWebSocket } from "bun";

export interface MockServerOptions {
  /** require clients to send `{ t: "auth", token }` before any other command. default: no auth. */
  token?: string;
  /** ms to delay before replying to RPCs. default: 0 (immediate). */
  replyDelayMs?: number;
  /** if true, the server responds to ping with an error. for error-path tests. */
  pingReturnsError?: boolean;
}

type ClientState = {
  authed: boolean;
  subscriptions: Set<"mouse" | "window" | "input">;
};

export type MockServer = {
  url: string;
  port: number;
  /** close all open connections — simulates a server crash. */
  dropConnections(): void;
  /** push a mouse event to all subscribers. */
  pushMouse(x: number, y: number): void;
  /** push a window event to all subscribers. */
  pushWindow(win: Record<string, unknown>): void;
  /** how many clients are currently connected. */
  clientCount(): number;
  /** how many times the server received an "auth" command (for testing re-auth on reconnect). */
  readonly authCount: number;
  /** how many times the server received a "subscribe" command. */
  readonly subscribeCount: number;
  /** shut the server down. */
  stop(): Promise<void>;
};

export function createMockServer(opts: MockServerOptions = {}): MockServer {
  const clients = new Map<ServerWebSocket<ClientState>, ClientState>();
  let authCount = 0;
  let subscribeCount = 0;

  const handlers: Record<
    string,
    (
      ws: ServerWebSocket<ClientState>,
      req: Record<string, unknown>,
    ) => void | Promise<void>
  > = {
    hello(ws, req) {
      reply(ws, req, { protocol: "1.0.0" });
    },

    auth(ws, req) {
      authCount++;
      const state = clients.get(ws)!;
      if (!opts.token) {
        state.authed = true;
        reply(ws, req, { ok: true, note: "no token required" });
        return;
      }
      if (req.token === opts.token) {
        state.authed = true;
        reply(ws, req, { ok: true });
      } else {
        errReply(ws, req, "bad_token", "token does not match");
      }
    },

    ping(ws, req) {
      if (opts.pingReturnsError) {
        errReply(ws, req, "simulated", "ping error for test");
        return;
      }
      reply(ws, req, { pong: true, time_ms: Date.now() });
    },

    "screen.pixel"(ws, req) {
      const x = Number(req.x);
      const y = Number(req.y);
      if (x < 0 || y < 0) {
        errReply(ws, req, "screen_error", "negative coordinates");
        return;
      }
      reply(ws, req, { r: (x * y) & 0xff, g: x & 0xff, b: y & 0xff });
    },

    "screen.resolution"(ws, req) {
      reply(ws, req, { width: 1920, height: 1080 });
    },

    "system.mouse"(ws, req) {
      reply(ws, req, { x: 100, y: 200 });
    },

    "system.window"(ws, req) {
      reply(ws, req, {
        window: {
          title: "Mock Window",
          process: "mock.exe",
          x: 0,
          y: 0,
          width: 800,
          height: 600,
        },
      });
    },

    "system.time"(ws, req) {
      reply(ws, req, { time_ms: Date.now() });
    },

    "input.keys"(ws, req) {
      reply(ws, req, { keys: [] });
    },

    "input.is_down"(ws, req) {
      reply(ws, req, { down: false });
    },

    "input.modifiers"(ws, req) {
      reply(ws, req, {
        modifiers: { shift: false, ctrl: false, alt: false, win: false },
      });
    },

    "clipboard.get"(ws, req) {
      reply(ws, req, { text: "mock clipboard" });
    },

    "clipboard.set"(ws, req) {
      reply(ws, req, { ok: true });
    },

    subscribe(ws, req) {
      subscribeCount++;
      const state = clients.get(ws)!;
      const events = (req.events as Array<"mouse" | "window" | "input">) ?? [];
      for (const e of events) state.subscriptions.add(e);
      reply(ws, req, { ok: true, subscribed: events });
    },

    unsubscribe(ws, req) {
      const state = clients.get(ws)!;
      const events = (req.events as Array<"mouse" | "window" | "input">) ?? [];
      for (const e of events) state.subscriptions.delete(e);
      reply(ws, req, { ok: true });
    },

    // fire-and-forget HID (no reply)
    "hid.down": () => {},
    "hid.up": () => {},
    "hid.press": () => {},
    "hid.type": () => {},
    "hid.move": () => {},
    "hid.move_to": () => {},
    "hid.scroll": () => {},
  };

  async function reply(
    ws: ServerWebSocket<ClientState>,
    req: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
    if (req.id === undefined) return;
    if (opts.replyDelayMs) {
      await new Promise((r) => setTimeout(r, opts.replyDelayMs));
    }
    ws.send(JSON.stringify({ id: req.id, ...payload }));
  }

  function errReply(
    ws: ServerWebSocket<ClientState>,
    req: Record<string, unknown>,
    code: string,
    message: string,
  ): void {
    if (req.id === undefined) return;
    ws.send(JSON.stringify({ id: req.id, error: { code, message } }));
  }

  const server: Server = Bun.serve<ClientState, {}>({
    port: 0, // let the OS pick a free port
    fetch(req, server) {
      if (
        server.upgrade(req, {
          data: { authed: false, subscriptions: new Set() },
        })
      ) {
        return;
      }
      return new Response("expected WebSocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        clients.set(ws, ws.data);
        ws.send(
          JSON.stringify({
            t: "hello",
            protocol: "1.0.0",
            auth_required: !!opts.token,
          }),
        );
      },
      async message(ws, data) {
        let req: Record<string, unknown>;
        try {
          req = JSON.parse(typeof data === "string" ? data : String(data));
        } catch {
          return;
        }
        const cmd = req.t as string;
        const handler = handlers[cmd];
        if (!handler) {
          errReply(ws, req, "unknown_command", `unknown command '${cmd}'`);
          return;
        }
        // auth gate: everything except hello/auth/ping requires authed state
        // when token is configured
        if (opts.token && !ws.data.authed && cmd !== "auth" && cmd !== "hello") {
          errReply(ws, req, "unauthenticated", "send auth first");
          return;
        }
        try {
          await handler(ws, req);
        } catch (e) {
          errReply(ws, req, "handler_error", String(e));
        }
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    port: server.port,
    dropConnections() {
      for (const ws of clients.keys()) ws.close();
    },
    pushMouse(x, y) {
      for (const [ws, state] of clients) {
        if (state.subscriptions.has("mouse")) {
          ws.send(JSON.stringify({ t: "mouse", x, y }));
        }
      }
    },
    pushWindow(win) {
      for (const [ws, state] of clients) {
        if (state.subscriptions.has("window")) {
          ws.send(JSON.stringify({ t: "window", window: win }));
        }
      }
    },
    clientCount: () => clients.size,
    get authCount() {
      return authCount;
    },
    get subscribeCount() {
      return subscribeCount;
    },
    async stop() {
      server.stop(true);
    },
  };
}
