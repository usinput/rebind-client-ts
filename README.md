# @rebind.gg/client-ts

Elegant TypeScript client for the [Rebind](https://rebind.gg) Remote Access
WebSocket protocol. Typed, auto-reconnecting, zero runtime dependencies.

Works in Node 22+, Bun, Deno, and browsers using the native `WebSocket` API.

> Rebind is a physical input-forwarding device that exposes a scripting SDK
> and remote-control surface. Learn more at [rebind.gg](https://rebind.gg).
> Built by [US Input Company](https://usinput.com).

## Install

```bash
npm install @rebind.gg/client-ts
# or
bun add @rebind.gg/client-ts
# or
pnpm add @rebind.gg/client-ts
```

## Install the server

The client speaks the JSON-RPC protocol defined by a reference Lua script
that runs inside Rebind. The script is bundled in this package at
`node_modules/@rebind.gg/client-ts/server/remote_access.lua` so you don't
need the Rebind source to use it.

1. Locate your Rebind scripts directory:
   - Windows: `%APPDATA%\Rebind\save_data\scripts\`
   - macOS/Linux: `~/.config/Rebind/save_data/scripts/` (varies by platform)
2. Copy `server/remote_access.lua` from the package into that directory.
3. Open Rebind → Scripts → start **Remote Access**.
4. The UI logs will show `Remote Access server listening on ws://0.0.0.0:19561`.

The script works out of the box with no auth. To require a token, edit
`AUTH_TOKEN` at the top of the script before installing, and pass the same
value to the client as `{ token: "..." }`.

To extend the protocol with your own commands, copy the script, add entries
to the `handlers` table, and point your client at the new port. The
`lua.exec` command (disabled by default) provides an escape hatch for
interactive debugging.

## Quick start

```ts
import { RebindRemote } from "@rebind.gg/client-ts";

const r = new RebindRemote("ws://127.0.0.1:19561", { token: "" });
await r.connect();

// fire-and-forget HID writes
r.hidType("hello from typescript\n");
r.hidMove(100, 50);

// typed RPCs — fully autocompleted, AbortSignal-aware
const { x, y } = await r.systemMouse();
const { r: red, g, b } = await r.screenPixel(x, y);
console.log(`pixel at (${x},${y}) = #${red.toString(16)}${g.toString(16)}${b.toString(16)}`);

// async iteration — auto-subscribes on first read, auto-unsubscribes on break
for await (const { x, y } of r.mouseEvents()) {
  console.log(`mouse ${x},${y}`);
  if (x > 500) break;
}

r.close();
```

## Features

- **Fully typed.** Every protocol message has a real TypeScript interface. No
  `unknown` in the public API, full autocomplete.
- **Auto-reconnect.** Transparent exponential backoff on unexpected
  disconnect. Re-subscribes to any active event streams automatically.
- **Async iterators for events.** Modern, composable `for await` pattern.
  Auto-subscribes on first read, auto-unsubscribes when the iterator ends or
  is broken out of. Multiple concurrent iterators of the same stream share
  the subscription.
- **AbortSignal on every RPC.** Standard Node/browser cancellation pattern.
- **Structured errors.** Four error classes cover every failure mode:
  `RebindError`, `ConnectionError`, `TimeoutError`, `ServerError`.
- **Zero runtime dependencies.** Native `WebSocket` everywhere.

## Auto-reconnect

Enabled by default. Reconnects with exponential backoff (100 ms → 10 s) and
re-subscribes to any active event streams. Tune or disable via options:

```ts
const r = new RebindRemote("ws://127.0.0.1:19561", {
  autoReconnect: true,              // default
  reconnectDelayMs: 100,            // initial delay
  reconnectMaxDelayMs: 10000,       // cap
  reconnectMaxAttempts: "infinite", // or a number
  onStateChange: (state) => console.log("state:", state),
});
```

Connection state is one of `disconnected | connecting | connected | reconnecting`
and is available via `r.state` or the `onStateChange` callback.

## Error handling

```ts
import {
  RebindRemote,
  RebindError,          // base class
  ConnectionError,      // can't connect, disconnected, closed
  TimeoutError,         // RPC didn't reply within timeoutMs
  ServerError,          // server returned { error: { code, message } }
} from "@rebind.gg/client-ts";

try {
  await r.screenPixel(9999, 9999);
} catch (e) {
  if (e instanceof ServerError && e.code === "screen_error") {
    // handle the specific server-side failure
  } else if (e instanceof TimeoutError) {
    // retry or escalate
  } else {
    throw e;
  }
}
```

## Cancellation

Every RPC accepts an optional `AbortSignal`:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 100);

try {
  await r.clipboardGet(ac.signal);
} catch (e) {
  if ((e as Error).name === "AbortError") {
    // user cancelled
  }
}
```

## Event streams

Three push events are exposed as async iterables:

```ts
for await (const { x, y } of r.mouseEvents()) { /* ... */ }
for await (const window of r.windowEvents()) { /* ... */ }
for await (const { keys, modifiers } of r.inputEvents()) { /* ... */ }
```

Each iterator call auto-subscribes on first read and auto-unsubscribes when
the iterator ends. Multiple iterators of the same stream share the
underlying subscription via refcounting — no duplicate server traffic.

Pass an `AbortSignal` to terminate iteration externally:

```ts
const ac = new AbortController();
// stop after 5 seconds
setTimeout(() => ac.abort(), 5000);

for await (const { x, y } of r.mouseEvents(ac.signal)) {
  console.log(x, y);
}
```

## Full API

See TypeScript types for the full surface. Summary:

| Category | Methods |
|---|---|
| Lifecycle | `connect()`, `close()`, `connected`, `state` |
| HID writes (fire-and-forget) | `hidDown`, `hidUp`, `hidPress`, `hidType`, `hidMove`, `hidMoveTo`, `hidScroll` |
| Screen | `screenPixel`, `screenResolution` |
| System | `systemMouse`, `systemWindow`, `systemTime` |
| Input | `inputKeys`, `inputIsDown`, `inputModifiers` |
| Clipboard | `clipboardGet`, `clipboardSet` |
| Window | `windowList`, `windowFind`, `windowActivate`, `windowMove` |
| Events | `mouseEvents()`, `windowEvents()`, `inputEvents()` |
| Meta | `ping`, `luaExec` |

## Performance

Measured on localhost (Windows host, release build):

| Metric | Value |
|---|---|
| RPC p50 | ~1 ms |
| RPC p99 | ~2 ms |
| Sustained RPC (16 in-flight) | ~10,000 req/s |
| Fire-and-forget wire throughput | ~100,000 msg/s |

## Development

```bash
bun install
bun test              # unit tests with in-memory mock server
bun run typecheck     # tsc --noEmit
bun run build         # emit dist/
```

## Support

- Product: [rebind.gg](https://rebind.gg)
- Documentation: [docs.rebind.gg](https://docs.rebind.gg)
- Email: [support@rebind.gg](mailto:support@rebind.gg)
- Company: [US Input Company](https://usinput.com)

## License

MIT © US Input Company
