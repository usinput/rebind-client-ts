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
 * Works with both remote_access.lua (protocol 1.1) and remote.luau
 * (protocol 1.2 — a backward-compatible superset). The methods added for 1.2
 * (hidCombo, hidTypewriter, hidMoveSmooth, hidSetMouseMode, hidGetMouseMode,
 * screenCaptureWindow, authenticate) plus the generic `call()` require a
 * remote.luau server; against a 1.1 server they resolve `unknown_command`.
 */
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
export interface Display {
    /** 1-based index, stable for the lifetime of the session. */
    index: number;
    /** signed origin in virtual-desktop space (negative left of / above primary). */
    x: number;
    y: number;
    /** logical size in screen points. */
    width: number;
    height: number;
    primary: boolean;
}
export interface CaptureRegion {
    /** display-local logical coords. */
    x: number;
    y: number;
    w: number;
    h: number;
}
export interface ScreenCaptureResult {
    /** base64 lossless PNG at native (physical) resolution. */
    image: string;
    /** native pixel dims of the returned frame. */
    width: number;
    height: number;
    /** geometry of the captured display, for mapping image -> screen coords. */
    display: Display;
    /** cursor position in screen coords, read adjacent to the frame grab. */
    cursor: Point;
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
export declare class RebindError extends Error {
    constructor(message: string);
}
/** thrown when a connection cannot be established, is lost, or is closed while RPCs are pending. */
export declare class ConnectionError extends RebindError {
}
/** thrown when an RPC doesn't receive a response within `timeoutMs`. */
export declare class TimeoutError extends RebindError {
}
/** thrown when the server reports an error response to an RPC. carries the server's error code. */
export declare class ServerError extends RebindError {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class RebindRemote {
    readonly url: string;
    private readonly token;
    private readonly timeoutMs;
    private readonly autoReconnect;
    private readonly reconnectDelayMs;
    private readonly reconnectMaxDelayMs;
    private readonly reconnectMaxAttempts;
    private readonly onStateChange?;
    private ws;
    private _state;
    private nextId;
    private pending;
    private closeExplicit;
    private reconnectAttempt;
    private streams;
    constructor(url: string, options?: RebindRemoteOptions);
    /** true while the client has an open, authenticated connection. */
    get connected(): boolean;
    /** current connection state. */
    get state(): ConnectionState;
    /**
     * Open the connection, authenticate, and re-subscribe to any previously
     * active event streams. Idempotent: calling while connecting waits for
     * the in-flight attempt; calling while connected is a no-op.
     */
    connect(): Promise<void>;
    /**
     * Close the connection. Pending RPCs reject with {@link ConnectionError}.
     * Active iterators terminate on their next read. Disables auto-reconnect
     * for this instance.
     */
    close(): void;
    hidDown(code: string): void;
    hidUp(code: string): void;
    hidPress(code: string, holdMs?: number): void;
    hidType(text: string): void;
    hidMove(dx: number, dy: number): void;
    hidMoveTo(x: number, y: number): void;
    hidScroll(delta: number): void;
    /** fire a whole chord in one call — press left-to-right, release right-to-left. */
    hidCombo(code: string): void;
    /** type text one character at a time with a per-character delay. */
    hidTypewriter(text: string, delayMs?: number): void;
    screenPixel(x: number, y: number, signal?: AbortSignal): Promise<Pixel>;
    screenResolution(signal?: AbortSignal): Promise<Resolution>;
    screenCapture(opts?: {
        display?: number;
        region?: CaptureRegion;
    }, signal?: AbortSignal): Promise<ScreenCaptureResult>;
    screenDisplays(signal?: AbortSignal): Promise<Display[]>;
    /**
     * Capture exactly one window by handle or title (no need to compute a region).
     * Resolves the window rect, picks the display it sits on, and returns the same
     * shape as {@link screenCapture}.
     */
    screenCaptureWindow(target: {
        handle?: number;
        title?: string;
    }, signal?: AbortSignal): Promise<ScreenCaptureResult>;
    /**
     * Glide the cursor to (x, y) over `durationMs` across `steps` eased moves,
     * server-side — one call instead of streaming dozens of {@link hidMove}
     * frames. Resolves with the final landed position.
     */
    hidMoveSmooth(x: number, y: number, opts?: {
        durationMs?: number;
        steps?: number;
    }, signal?: AbortSignal): Promise<Point>;
    /** set the mouse mode ("relative" | "absolute"); returns the active mode. */
    hidSetMouseMode(mode: "relative" | "absolute", signal?: AbortSignal): Promise<string>;
    /** read the current mouse mode. */
    hidGetMouseMode(signal?: AbortSignal): Promise<string>;
    systemMouse(signal?: AbortSignal): Promise<Point>;
    systemWindow(signal?: AbortSignal): Promise<WindowInfo>;
    systemTime(signal?: AbortSignal): Promise<number>;
    inputKeys(signal?: AbortSignal): Promise<string[]>;
    inputIsDown(code: string, signal?: AbortSignal): Promise<boolean>;
    inputModifiers(signal?: AbortSignal): Promise<Modifiers>;
    clipboardGet(signal?: AbortSignal): Promise<string>;
    clipboardSet(text: string, signal?: AbortSignal): Promise<void>;
    windowList(filter?: string, signal?: AbortSignal): Promise<WindowInfo[]>;
    windowFind(title: string, signal?: AbortSignal): Promise<number | null>;
    windowActivate(handle: number, signal?: AbortSignal): Promise<void>;
    windowMove(handle: number, opts?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
    }, signal?: AbortSignal): Promise<void>;
    ping(signal?: AbortSignal): Promise<number>;
    luaExec(source: string, signal?: AbortSignal): Promise<unknown>;
    /**
     * Authenticate against a token-protected server. Only needed for manual
     * flows — when a `token` is passed to the constructor, `connect()` already
     * authenticates automatically (and re-authenticates on reconnect).
     */
    authenticate(token: string, signal?: AbortSignal): Promise<boolean>;
    /**
     * Escape hatch for any command not covered by a typed method — the full
     * remote.luau surface (app.*, process.*, env.*, hash.*, codec.*, regex.*,
     * config.*, file.*, net.*, dialog.*, math.*, macro.*, audio.*, timer.*,
     * registry.*, ui.*). Returns the raw reply object (minus the correlation id).
     *
     *     const { pid } = await r.call("process.exists", { name: "chrome" });
     *     const { digest } = await r.call("hash.sha256", { data: "hello" });
     */
    call<T = Record<string, unknown>>(command: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
    /** Fire-and-forget a command with no reply (skips the id round-trip). */
    send(command: string, args?: Record<string, unknown>): void;
    /**
     * Async iterable of mouse position updates. Auto-subscribes on first read;
     * auto-unsubscribes when the iterator ends or is broken out of. Multiple
     * concurrent iterators of the same stream are safe.
     */
    mouseEvents(signal?: AbortSignal): AsyncIterable<Point>;
    /** Async iterable of window info snapshots fired when the foreground window changes. */
    windowEvents(signal?: AbortSignal): AsyncIterable<WindowInfo>;
    /** Async iterable of input state snapshots (active keys + modifiers) fired each tick. */
    inputEvents(signal?: AbortSignal): AsyncIterable<InputState>;
    private openSocket;
    private handleClose;
    private setState;
    private sendOneShot;
    private rpc;
    private rejectPending;
    private handleMessage;
    private iterate;
    private createIterator;
    private acquireStream;
    private releaseStream;
    private ensureSubscribed;
    private endAllStreams;
}
//# sourceMappingURL=index.d.ts.map