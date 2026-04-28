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
// ── errors ───────────────────────────────────────────────────────────────────
export class RebindError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
/** thrown when a connection cannot be established, is lost, or is closed while RPCs are pending. */
export class ConnectionError extends RebindError {
}
/** thrown when an RPC doesn't receive a response within `timeoutMs`. */
export class TimeoutError extends RebindError {
}
/** thrown when the server reports an error response to an RPC. carries the server's error code. */
export class ServerError extends RebindError {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}
// ── client ───────────────────────────────────────────────────────────────────
export class RebindRemote {
    url;
    // config
    token;
    timeoutMs;
    autoReconnect;
    reconnectDelayMs;
    reconnectMaxDelayMs;
    reconnectMaxAttempts;
    onStateChange;
    // state
    ws = null;
    _state = "disconnected";
    nextId = 1;
    pending = new Map();
    closeExplicit = false;
    reconnectAttempt = 0;
    streams = new Map();
    constructor(url, options = {}) {
        this.url = url;
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
    get connected() {
        return this._state === "connected";
    }
    /** current connection state. */
    get state() {
        return this._state;
    }
    /**
     * Open the connection, authenticate, and re-subscribe to any previously
     * active event streams. Idempotent: calling while connecting waits for
     * the in-flight attempt; calling while connected is a no-op.
     */
    async connect() {
        this.closeExplicit = false;
        if (this._state === "connected")
            return;
        if (this._state === "connecting" || this._state === "reconnecting") {
            // wait for the in-flight attempt to resolve
            return new Promise((resolve, reject) => {
                const check = () => {
                    if (this._state === "connected")
                        resolve();
                    else if (this._state === "disconnected")
                        reject(new ConnectionError("connect cancelled"));
                    else
                        setTimeout(check, 10);
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
    close() {
        this.closeExplicit = true;
        this.setState("disconnected");
        this.ws?.close();
        this.ws = null;
        this.rejectPending(new ConnectionError("client closed"));
        this.endAllStreams();
    }
    // ── HID (one-shot) ───────────────────────────────────────────────────────
    hidDown(code) {
        this.sendOneShot("hid.down", { code });
    }
    hidUp(code) {
        this.sendOneShot("hid.up", { code });
    }
    hidPress(code, holdMs = 20) {
        this.sendOneShot("hid.press", { code, hold_ms: holdMs });
    }
    hidType(text) {
        this.sendOneShot("hid.type", { text });
    }
    hidMove(dx, dy) {
        this.sendOneShot("hid.move", { dx, dy });
    }
    hidMoveTo(x, y) {
        this.sendOneShot("hid.move_to", { x, y });
    }
    hidScroll(delta) {
        this.sendOneShot("hid.scroll", { delta });
    }
    // ── reads (RPC) ──────────────────────────────────────────────────────────
    async screenPixel(x, y, signal) {
        return this.rpc("screen.pixel", { x, y }, signal);
    }
    async screenResolution(signal) {
        return this.rpc("screen.resolution", {}, signal);
    }
    async systemMouse(signal) {
        return this.rpc("system.mouse", {}, signal);
    }
    async systemWindow(signal) {
        const r = await this.rpc("system.window", {}, signal);
        return r.window;
    }
    async systemTime(signal) {
        const r = await this.rpc("system.time", {}, signal);
        return r.time_ms;
    }
    async inputKeys(signal) {
        const r = await this.rpc("input.keys", {}, signal);
        return r.keys;
    }
    async inputIsDown(code, signal) {
        const r = await this.rpc("input.is_down", { code }, signal);
        return r.down;
    }
    async inputModifiers(signal) {
        const r = await this.rpc("input.modifiers", {}, signal);
        return r.modifiers;
    }
    async clipboardGet(signal) {
        const r = await this.rpc("clipboard.get", {}, signal);
        return r.text;
    }
    async clipboardSet(text, signal) {
        await this.rpc("clipboard.set", { text }, signal);
    }
    async windowList(filter, signal) {
        const args = filter ? { filter } : {};
        const r = await this.rpc("window.list", args, signal);
        return r.windows;
    }
    async windowFind(title, signal) {
        const r = await this.rpc("window.find", { title }, signal);
        return r.handle;
    }
    async windowActivate(handle, signal) {
        await this.rpc("window.activate", { handle }, signal);
    }
    async windowMove(handle, opts = {}, signal) {
        await this.rpc("window.move", { handle, ...opts }, signal);
    }
    async ping(signal) {
        const r = await this.rpc("ping", {}, signal);
        return r.time_ms;
    }
    async luaExec(source, signal) {
        const r = await this.rpc("lua.exec", { source }, signal);
        return r.result;
    }
    // ── event streams ────────────────────────────────────────────────────────
    /**
     * Async iterable of mouse position updates. Auto-subscribes on first read;
     * auto-unsubscribes when the iterator ends or is broken out of. Multiple
     * concurrent iterators of the same stream are safe.
     */
    mouseEvents(signal) {
        return this.iterate("mouse", (ev) => ({ x: ev.x, y: ev.y }), signal);
    }
    /** Async iterable of window info snapshots fired when the foreground window changes. */
    windowEvents(signal) {
        return this.iterate("window", (ev) => ev.window, signal);
    }
    /** Async iterable of input state snapshots (active keys + modifiers) fired each tick. */
    inputEvents(signal) {
        return this.iterate("input", (ev) => ({ keys: ev.keys, modifiers: ev.modifiers }), signal);
    }
    // ── internals ────────────────────────────────────────────────────────────
    async openSocket(isReconnect) {
        this.setState(isReconnect ? "reconnecting" : "connecting");
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.onopen = async () => {
                try {
                    if (this.token) {
                        const r = await this.rpc("auth", { token: this.token });
                        if (!r.ok)
                            throw new ConnectionError("auth failed: server rejected token");
                    }
                    // re-subscribe to any active event streams
                    const active = [...this.streams.keys()];
                    if (active.length > 0) {
                        await this.rpc("subscribe", { events: active });
                    }
                    this.reconnectAttempt = 0;
                    this.setState("connected");
                    resolve();
                }
                catch (err) {
                    reject(err);
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
    handleClose() {
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
        const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), this.reconnectMaxDelayMs);
        this.setState("reconnecting");
        setTimeout(() => {
            if (this.closeExplicit)
                return;
            this.openSocket(true).catch(() => {
                /* onclose handles the retry chain */
            });
        }, delay);
    }
    setState(state) {
        if (state === this._state)
            return;
        this._state = state;
        try {
            this.onStateChange?.(state);
        }
        catch {
            /* swallow listener errors */
        }
    }
    sendOneShot(command, fields) {
        if (!this.ws || this.ws.readyState !== 1) {
            throw new ConnectionError("not connected");
        }
        this.ws.send(JSON.stringify({ t: command, ...fields }));
    }
    rpc(command, fields = {}, signal) {
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
            const entry = {
                resolve: resolve,
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
    rejectPending(err) {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.abort?.();
            entry.reject(err);
        }
        this.pending.clear();
    }
    handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (typeof msg !== "object" || msg === null)
            return;
        // RPC response
        if (typeof msg.id === "number") {
            const entry = this.pending.get(msg.id);
            if (!entry)
                return;
            clearTimeout(entry.timer);
            entry.abort?.();
            this.pending.delete(msg.id);
            if ("error" in msg && msg.error) {
                const e = msg.error;
                entry.reject(new ServerError(e.code ?? "unknown", e.message ?? ""));
            }
            else {
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
            if (!stream)
                return;
            stream.queue.push(msg);
            while (stream.waiters.length > 0)
                stream.waiters.shift()();
        }
    }
    iterate(name, project, signal) {
        const self = this;
        return {
            [Symbol.asyncIterator]() {
                return self.createIterator(name, project, signal);
            },
        };
    }
    async *createIterator(name, project, signal) {
        const stream = this.acquireStream(name);
        await this.ensureSubscribed(name);
        try {
            while (true) {
                if (signal?.aborted)
                    return;
                while (stream.queue.length > 0) {
                    const ev = stream.queue.shift();
                    yield project(ev);
                }
                if (!this.connected && this._state !== "reconnecting")
                    return;
                if (signal?.aborted)
                    return;
                // wait for next event, abort signal, or disconnect. check
                // signal.aborted synchronously inside the executor because
                // addEventListener("abort") does NOT fire if abort already happened
                // before the listener was attached.
                await new Promise((resolve) => {
                    if (signal?.aborted) {
                        resolve();
                        return;
                    }
                    const wake = () => resolve();
                    stream.waiters.push(wake);
                    signal?.addEventListener("abort", wake, { once: true });
                });
            }
        }
        finally {
            this.releaseStream(name);
        }
    }
    acquireStream(name) {
        let s = this.streams.get(name);
        if (!s) {
            s = { queue: [], waiters: [], refCount: 0 };
            this.streams.set(name, s);
        }
        s.refCount++;
        return s;
    }
    releaseStream(name) {
        const s = this.streams.get(name);
        if (!s)
            return;
        s.refCount--;
        if (s.refCount <= 0) {
            this.streams.delete(name);
            // best-effort unsubscribe; ignore errors (server may be disconnected)
            if (this.connected) {
                this.rpc("unsubscribe", { events: [name] }).catch(() => { });
            }
        }
    }
    async ensureSubscribed(name) {
        if (!this.connected)
            return; // will subscribe on next connect
        await this.rpc("subscribe", { events: [name] });
    }
    endAllStreams() {
        for (const s of this.streams.values()) {
            while (s.waiters.length > 0)
                s.waiters.shift()();
        }
        this.streams.clear();
    }
}
//# sourceMappingURL=index.js.map