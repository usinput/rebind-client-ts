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
    screenPixel(x: number, y: number, signal?: AbortSignal): Promise<Pixel>;
    screenResolution(signal?: AbortSignal): Promise<Resolution>;
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