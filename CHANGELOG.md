# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]

### Fixed

- `remote_access.lua`: `screen.pixel` now returns `r`, `g`, `b` as separate
  integers (0–255). Previously the handler misread the single hex string
  returned by `Screen.GetPixelColor` (`"RRGGBB"`) as three separate return
  values, sending `{"r":"RRGGBB"}` to the client instead of
  `{"r":R,"g":G,"b":B}`.
- `remote_access.lua`: `input.keys` now always returns a JSON array. Previously
  an empty Lua table serialized as `{}` instead of `[]` when no keys were held,
  causing the client's `inputKeys()` return value to fail array checks.
- `packages/lua-sdk` (`Input.GetActiveKeys`): mouse buttons (`Mouse1`,
  `Mouse2`, etc.) were omitted from the result. The Lua binding was reading
  `state.keys` directly instead of calling `state.get_active_keys()`, which
  includes both keyboard keys and mouse buttons.

## [0.1.0]

### Added

- Initial public release.
- Typed TypeScript client for the Rebind Remote Access WebSocket protocol.
- Full surface: HID writes, screen reads, system state, input state,
  clipboard, window queries/manipulation, `lua.exec` escape hatch.
- Auto-reconnect with exponential backoff (100 ms → 10 s), disabled or
  tuned via options. Re-authenticates and re-subscribes to event streams
  on reconnect.
- Async iterators for push events: `mouseEvents()`, `windowEvents()`,
  `inputEvents()`. Auto-subscribe on first read, auto-unsubscribe on
  iterator end. Multiple concurrent iterators share a single subscription
  via refcounting.
- `AbortSignal` cancellation on every RPC method.
- Structured error hierarchy: `RebindError`, `ConnectionError`,
  `TimeoutError`, `ServerError`.
- Connection state machine with `onStateChange` callback.
- Reference server implementation bundled at `server/remote_access.lua`
  (Lua script that runs inside Rebind).
- 32-test unit suite with in-memory mock server (no real Rebind required
  for tests).
- Zero runtime dependencies. Ships ESM + TypeScript declarations.
- Compatible with protocol version 1.0.0.
