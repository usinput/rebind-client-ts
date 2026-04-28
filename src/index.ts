/**
 * Rebind Remote Access — TypeScript client.
 *
 * Elegant, dependency-free client for the JSON-RPC WebSocket protocol
 * exposed by the canonical `remote_access.lua` script. Runs on Node 22+,
 * Bun, Deno, and browsers using the native `WebSocket` API.
 *
 * Typical use:
 *
 *     const r = new RebindRemote("ws://127.0.0.1:19561");
 *     await r.connect();
 *
 *     // one-shot HID writes (fire and forget)
 *     r.hidType("hello from typescript");
 *
 *     // typed RPCs with AbortSignal support
 *     const { x, y } = await r.systemMouse();
 *     const pixel = await r.screenPixel(x, y);
 *
 *     // async iteration over push events (auto-subscribes on first read)
 *     for await (const pos of r.mouseEvents()) {
 *         console.log(pos.x, pos.y);
 *         if (pos.x > 500) break; // iterators clean up on break
 *     }
 *
 *     r.close();
 *
 * Compatible with protocol version 1.0.
 */

// ── types ────────────────────────────────────────────────────────────────────

export interface Pixel {
  r: number;
  g: number;
  b: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Resolution {
  width: number;
  height: number;
}

export interface WindowInfo {
  title: string;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  win: boolean;
}

export interface InputState {
  keys: string[];
  modifiers: Modifiers;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface RebindRemoteOptions {
  /** shared auth token. leave empty for no auth. */
  token?: string;
  /** RPC timeout in ms. default 5000. */
  timeoutMs?: number;
  /** auto-reconnect on unexpected close. default true. */
  autoReconnect?: boolean;
  /** initial reconnect delay in ms. doubles each attempt up to `reconnectMaxDelayMs`. default 100. */
  reconnectDelayMs?: number;
  /** cap on reconnect delay. default 10000. */
  reconnectMaxDelayMs?: number;
  /** max reconnect attempts. `"infinite"` means retry forever. default `"infinite"`. */
  reconnectMaxAttempts?: number | "infinite";
  /** called whenever connection state transitions. errors in handler are swallowed. */
  onStateChange?: (state: ConnectionState) => void;
}

// ── errors ───────────────────────────────────────────────────────────────────

export class RebindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** thrown when a connection cannot be established, is lost, or is closed while RPCs are pending. */
export class ConnectionError extends RebindError {}

/** thrown when an RPC doesn't receive a response within `timeoutMs`. */
export class TimeoutError extends RebindError {}

/** thrown when the server reports an error response to an RPC. carries the server's error code. */
export class ServerError extends RebindError {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

// ── internals ────────────────────────────────────────────────────────────────

type PendingRpc = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

type EventName = "mouse" | "window" | "input";

type EventEnvelope = {
  mouse: { t: "mouse"; x: number; y: number };
  window: { t: "window"; window: WindowInfo };
  input: { t: "input"; keys: string[]; modifiers: Modifiers };
};

/** per-event-type iterator state: bounded queue + "next message" signaler. */
type EventStream = {
  queue: unknown[];
  waiters: Array<() => void>;
  /** active iterator count. when this drops to 0 and we've been asked to unsubscribe, we stop buffering. */
  refCount: number;
};

// ── client ───────────────────────────────────────────────────────────────────

export class RebindRemote {
  // config
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectMaxAttempts: number | "infinite";
  private readonly onStateChange?: (s: ConnectionState) => void;

  // state
  private ws: WebSocket | null = null;
  private _state: ConnectionState = "disconnected";
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private closeExplicit = false;
  private reconnectAttempt = 0;
  private streams = new Map<EventName, EventStream>();

  constructor(
    public readonly url: string,
    options: RebindRemoteOptions = {},
  ) {
    this.token = options.token ?? "";
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 100;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 10000;
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? "infinite";
    this.onStateChange = options.onStateChange;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** true while the client has an open, authenticated connection. */
  get connected(): boolean {
    return this._state === "connected";
  }

  /** current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Open the connection, authenticate, and re-subscribe to any previously
   * active event streams. Idempotent: calling while connecting waits for
   * the in-flight attempt; calling while connected is a no-op.
   */
  async connect(): Promise<void> {
    this.closeExplicit = false;
    if (this._state === "connected") return;
    if (this._state === "connecting" || this._state === "reconnecting") {
      // wait for the in-flight attempt to resolve
      return new Promise((resolve, reject) => {
        const check = () => {
          if (this._state === "connected") resolve();
          else if (this._state === "disconnected") reject(new ConnectionError("connect cancelled"));
          else setTimeout(check, 10);
        };
        check();
      });
    }
    await this.openSocket(/* isReconnect */ false);
  }

  /**
   * Close the connection. Pending RPCs reject with {@link ConnectionError}.
   * Active iterators terminate on their next read. Disables auto-reconnect
   * for this instance.
   */
  close(): void {
    this.closeExplicit = true;
    this.setState("disconnected");
    this.ws?.close();
    this.ws = null;
    this.rejectPending(new ConnectionError("client closed"));
    this.endAllStreams();
  }

  // ── HID (one-shot) ───────────────────────────────────────────────────────

  hidDown(code: string): void {
    this.sendOneShot("hid.down", { code });
  }
  hidUp(code: string): void {
    this.sendOneShot("hid.up", { code });
  }
  hidPress(code: string, holdMs = 20): void {
    this.sendOneShot("hid.press", { code, hold_ms: holdMs });
  }
  hidType(text: string): void {
    this.sendOneShot("hid.type", { text });
  }
  hidMove(dx: number, dy: number): void {
    this.sendOneShot("hid.move", { dx, dy });
  }
  hidMoveTo(x: number, y: number): void {
    this.sendOneShot("hid.move_to", { x, y });
  }
  hidScroll(delta: number): void {
    this.sendOneShot("hid.scroll", { delta });
  }

  // ── reads (RPC) ──────────────────────────────────────────────────────────

  async screenPixel(x: number, y: number, signal?: AbortSignal): Promise<Pixel> {
    return this.rpc<Pixel>("screen.pixel", { x, y }, signal);
  }

  async screenResolution(signal?: AbortSignal): Promise<Resolution> {
    return this.rpc<Resolution>("screen.resolution", {}, signal);
  }

  async systemMouse(signal?: AbortSignal): Promise<Point> {
    return this.rpc<Point>("system.mouse", {}, signal);
  }

  async systemWindow(signal?: AbortSignal): Promise<WindowInfo> {
    const r = await this.rpc<{ window: WindowInfo }>("system.window", {}, signal);
    return r.window;
  }

  async systemTime(signal?: AbortSignal): Promise<number> {
    const r = await this.rpc<{ time_ms: number }>("system.time", {}, signal);
    return r.time_ms;
  }

  async inputKeys(signal?: AbortSignal): Promise<string[]> {
    const r = await this.rpc<{ keys: string[] }>("input.keys", {}, signal);
    return r.keys;
  }

  async inputIsDown(code: string, signal?: AbortSignal): Promise<boolean> {
    const r = await this.rpc<{ down: boolean }>("input.is_down", { code }, signal);
    return r.down;
  }

  async inputModifiers(signal?: AbortSignal): Promise<Modifiers> {
    const r = await this.rpc<{ modifiers: Modifiers }>("input.modifiers", {}, signal);
    return r.modifiers;
  }

  async clipboardGet(signal?: AbortSignal): Promise<string> {
    const r = await this.rpc<{ text: string }>("clipboard.get", {}, signal);
    return r.text;
  }

  async clipboardSet(text: string, signal?: AbortSignal): Promise<void> {
    await this.rpc("clipboard.set", { text }, signal);
  }

  async windowList(filter?: string, signal?: AbortSignal): Promise<WindowInfo[]> {
    const args = filter ? { filter } : {};
    const r = await this.rpc<{ windows: WindowInfo[] }>("window.list", args, signal);
    return r.windows;
  }

  async windowFind(title: string, signal?: AbortSignal): Promise<number | null> {
    const r = await this.rpc<{ handle: number | null }>("window.find", { title }, signal);
    return r.handle;
  }

  async windowActivate(handle: number, signal?: AbortSignal): Promise<void> {
    await this.rpc("window.activate", { handle }, signal);
  }

  async windowMove(
    handle: number,
    opts: { x?: number; y?: number; width?: number; height?: number } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await this.rpc("window.move", { handle, ...opts }, signal);
  }

  async ping(signal?: AbortSignal): Promise<number> {
    const r = await this.rpc<{ time_ms: number }>("ping", {}, signal);
    return r.time_ms;
  }

  async luaExec(source: string, signal?: AbortSignal): Promise<unknown> {
    const r = await this.rpc<{ result: unknown }>("lua.exec", { source }, signal);
    return r.result;
  }

  // ── event streams ────────────────────────────────────────────────────────

  /**
   * Async iterable of mouse position updates. Auto-subscribes on first read;
   * auto-unsubscribes when the iterator ends or is broken out of. Multiple
   * concurrent iterators of the same stream are safe.
   */
  mouseEvents(signal?: AbortSignal): AsyncIterable<Point> {
    return this.iterate("mouse", (ev: EventEnvelope["mouse"]) => ({ x: ev.x, y: ev.y }), signal);
  }

  /** Async iterable of window info snapshots fired when the foreground window changes. */
  windowEvents(signal?: AbortSignal): AsyncIterable<WindowInfo> {
    return this.iterate("window", (ev: EventEnvelope["window"]) => ev.window, signal);
  }

  /** Async iterable of input state snapshots (active keys + modifiers) fired each tick. */
  inputEvents(signal?: AbortSignal): AsyncIterable<InputState> {
    return this.iterate(
      "input",
      (ev: EventEnvelope["input"]) => ({ keys: ev.keys, modifiers: ev.modifiers }),
      signal,
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async openSocket(isReconnect: boolean): Promise<void> {
    this.setState(isReconnect ? "reconnecting" : "connecting");

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = async () => {
        try {
          if (this.token) {
            const r = await this.rpc<{ ok: boolean }>("auth", { token: this.token });
            if (!r.ok) throw new ConnectionError("auth failed: server rejected token");
          }
          // re-subscribe to any active event streams
          const active = [...this.streams.keys()];
          if (active.length > 0) {
            await this.rpc("subscribe", { events: active });
          }
          this.reconnectAttempt = 0;
          this.setState("connected");
          resolve();
        } catch (err) {
          reject(err as Error);
          ws.close();
        }
      };

      ws.onerror = () => {
        /* delivered via onclose */
      };

      ws.onclose = () => {
        this.handleClose();
        if (this._state !== "connected") {
          reject(new ConnectionError("connection failed"));
        }
      };

      ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    });
  }

  private handleClose(): void {
    this.rejectPending(new ConnectionError("connection closed"));
    this.ws = null;

    if (this.closeExplicit || !this.autoReconnect) {
      this.setState("disconnected");
      return;
    }

    this.reconnectAttempt++;
    const max = this.reconnectMaxAttempts;
    if (max !== "infinite" && this.reconnectAttempt > max) {
      this.setState("disconnected");
      return;
    }

    const delay = Math.min(
      this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1),
      this.reconnectMaxDelayMs,
    );
    this.setState("reconnecting");
    setTimeout(() => {
      if (this.closeExplicit) return;
      this.openSocket(true).catch(() => {
        /* onclose handles the retry chain */
      });
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (state === this._state) return;
    this._state = state;
    try {
      this.onStateChange?.(state);
    } catch {
      /* swallow listener errors */
    }
  }

  private sendOneShot(command: string, fields: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new ConnectionError("not connected");
    }
    this.ws.send(JSON.stringify({ t: command, ...fields }));
  }

  private rpc<T = Record<string, unknown>>(
    command: string,
    fields: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new ConnectionError("not connected"));
        return;
      }
      if (signal?.aborted) {
        reject(new DOMException("RPC aborted", "AbortError"));
        return;
      }

      const id = this.nextId++;
      const entry: PendingRpc = {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          entry.abort?.();
          reject(new TimeoutError(`RPC '${command}' timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs),
      };

      if (signal) {
        const onAbort = () => {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(new DOMException("RPC aborted", "AbortError"));
        };
        entry.abort = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort);
      }

      this.pending.set(id, entry);
      this.ws.send(JSON.stringify({ t: command, id, ...fields }));
    });
  }

  private rejectPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.abort?.();
      entry.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;

    // RPC response
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.abort?.();
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) {
        const e = msg.error as { code?: string; message?: string };
        entry.reject(new ServerError(e.code ?? "unknown", e.message ?? ""));
      } else {
        // strip the protocol-level `id` field so callers see only the
        // payload shape their typed wrapper promised.
        const { id, ...payload } = msg;
        void id;
        entry.resolve(payload);
      }
      return;
    }

    // push event
    const t = msg.t;
    if (t === "mouse" || t === "window" || t === "input") {
      const stream = this.streams.get(t);
      if (!stream) return;
      stream.queue.push(msg);
      while (stream.waiters.length > 0) stream.waiters.shift()!();
    }
  }

  private iterate<N extends EventName, T>(
    name: N,
    project: (ev: EventEnvelope[N]) => T,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return self.createIterator<N, T>(name, project, signal);
      },
    };
  }

  private async *createIterator<N extends EventName, T>(
    name: N,
    project: (ev: EventEnvelope[N]) => T,
    signal?: AbortSignal,
  ): AsyncGenerator<T, void, void> {
    const stream = this.acquireStream(name);
    await this.ensureSubscribed(name);

    try {
      while (true) {
        if (signal?.aborted) return;
        while (stream.queue.length > 0) {
          const ev = stream.queue.shift() as EventEnvelope[N];
          yield project(ev);
        }
        if (!this.connected && this._state !== "reconnecting") return;
        if (signal?.aborted) return;
        // wait for next event, abort signal, or disconnect. check
        // signal.aborted synchronously inside the executor because
        // addEventListener("abort") does NOT fire if abort already happened
        // before the listener was attached.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const wake = () => resolve();
          stream.waiters.push(wake);
          signal?.addEventListener("abort", wake, { once: true });
        });
      }
    } finally {
      this.releaseStream(name);
    }
  }

  private acquireStream(name: EventName): EventStream {
    let s = this.streams.get(name);
    if (!s) {
      s = { queue: [], waiters: [], refCount: 0 };
      this.streams.set(name, s);
    }
    s.refCount++;
    return s;
  }

  private releaseStream(name: EventName): void {
    const s = this.streams.get(name);
    if (!s) return;
    s.refCount--;
    if (s.refCount <= 0) {
      this.streams.delete(name);
      // best-effort unsubscribe; ignore errors (server may be disconnected)
      if (this.connected) {
        this.rpc("unsubscribe", { events: [name] }).catch(() => {});
      }
    }
  }

  private async ensureSubscribed(name: EventName): Promise<void> {
    if (!this.connected) return; // will subscribe on next connect
    await this.rpc("subscribe", { events: [name] });
  }

  private endAllStreams(): void {
    for (const s of this.streams.values()) {
      while (s.waiters.length > 0) s.waiters.shift()!();
    }
    this.streams.clear();
  }
}
