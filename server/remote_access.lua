-- rebind: name=Remote Access
-- rebind: version=1.0.0
-- rebind: author=Rebind
-- rebind: description=JSON-RPC WebSocket server exposing HID, Screen, Window, Clipboard, Input, and System surfaces for remote control.
-- rebind: instance=single
-- rebind: tick_rate=1000
-- rebind: permission=net
--
-- Reference server implementation for the @rebind.gg/client-ts client.
-- Install this file in your Rebind scripts directory to accept connections
-- from the TypeScript client or any other conforming client.
--
-- Protocol version: 1.0.0 (matches @rebind.gg/client-ts semver contract).
--
-- Canonical remote access protocol. Edit this file to extend the surface;
-- every change is local and requires no SDK update.
--
-- Protocol: JSON messages over WebSocket. Every request may include an `id`
-- field — if present, the server replies with the same id so the client can
-- correlate responses.
--
--   {"t":"hid.down", "code":"A"}                  one-shot
--   {"t":"screen.pixel", "id":7, "x":100, "y":50} request/response
--   {"t":"subscribe", "events":["mouse","input"]} push stream
--
-- See docs/sdk-reference.md#remote-access for the full command table.

-- USER CONFIG ----------------------------------------------------------------
-- Edit these constants before installing. They cannot be changed from the UI
-- because `UI.Input` for free-text does not exist in the SDK; editing the
-- script is the explicit, auditable path.
--
-- AUTH_TOKEN: leave "" to disable auth (safe on localhost; risky on LAN).
--             when set, clients must send { t = "auth", token = "..." } first.
-- ALLOW_LUA_EXEC: when true, the server accepts arbitrary Lua via lua.exec.
--                 keep this OFF unless you understand the risk.
local AUTH_TOKEN = ""
local ALLOW_LUA_EXEC = false
-------------------------------------------------------------------------------

local cfg = UI.Schema({
    port = UI.Slider(19561, { min = 1024, max = 65535, label = "WS port" }),
})

local server = nil
local subscribers = {} -- client_id -> { mouse=bool, input=bool, window=bool }
local authed = {} -- client_id -> true once token verified (or AUTH_TOKEN empty)
local last_mouse_x = nil
local last_mouse_y = nil
local last_window_title = nil

local PROTOCOL_VERSION = "1.0.0"

-- ── helpers ──────────────────────────────────────────────────────────────────

local function send(client, obj)
    local ok, encoded = pcall(JSON.Stringify, obj)
    if ok then
        client:Send(encoded)
    else
        Log.Warn(string.format("remote_access: JSON.Stringify failed: %s", tostring(encoded)))
    end
end

local function reply(client, req, payload)
    if req.id == nil then
        return
    end
    payload.id = req.id
    send(client, payload)
end

local function err(client, req, code, message)
    if req.id == nil then
        Log.Warn(string.format("remote_access: client %d error (%s): %s", client.id, code, message))
        return
    end
    send(client, { id = req.id, error = { code = code, message = message } })
end

local function requires_auth(client, req)
    if AUTH_TOKEN == "" then
        return true
    end
    if authed[client.id] then
        return true
    end
    err(client, req, "unauthenticated", 'send { t = "auth", token = "..." } first')
    return false
end

-- ── command dispatch ─────────────────────────────────────────────────────────
-- each handler receives (client, req) and is responsible for replying when
-- req.id is present. handlers that mutate state (HID writes) are one-shot;
-- handlers that read state return a result.

local handlers = {}

-- handshake ------------------------------------------------------------------

handlers["hello"] = function(client, req)
    reply(client, req, { protocol = PROTOCOL_VERSION })
end

handlers["auth"] = function(client, req)
    if AUTH_TOKEN == "" then
        authed[client.id] = true
        reply(client, req, { ok = true, note = "no token required" })
        return
    end
    if req.token == AUTH_TOKEN then
        authed[client.id] = true
        reply(client, req, { ok = true })
    else
        err(client, req, "bad_token", "token does not match")
    end
end

-- HID writes (one-shot) ------------------------------------------------------

handlers["hid.down"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.Down(req.code)
end

handlers["hid.up"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.Up(req.code)
end

handlers["hid.press"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.Press(req.code, req.hold_ms or 20)
end

handlers["hid.type"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.Type(req.text or "")
end

handlers["hid.move"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.Move(req.dx or 0, req.dy or 0)
end

handlers["hid.move_to"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.MoveTo(req.x or 0, req.y or 0)
end

handlers["hid.scroll"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    HID.Scroll(req.delta or 0)
end

-- Screen reads ---------------------------------------------------------------

handlers["screen.pixel"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    local ok, hex = pcall(Screen.GetPixelColor, req.x, req.y)
    if not ok then
        err(client, req, "screen_error", tostring(hex))
        return
    end
    -- GetPixelColor returns a 6-char hex string "RRGGBB"
    local r = tonumber(hex:sub(1, 2), 16) or 0
    local g = tonumber(hex:sub(3, 4), 16) or 0
    local b = tonumber(hex:sub(5, 6), 16) or 0
    reply(client, req, { r = r, g = g, b = b })
end

handlers["screen.resolution"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    local w, h = System.Screen()
    reply(client, req, { width = w, height = h })
end

-- System reads ---------------------------------------------------------------

handlers["system.mouse"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    local x, y = System.Mouse()
    reply(client, req, { x = x, y = y })
end

handlers["system.window"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { window = System.Window() })
end

handlers["system.time"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { time_ms = System.Time() })
end

-- Input state ----------------------------------------------------------------

handlers["input.keys"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    if req.id == nil then return end
    local keys = Input.GetActiveKeys()
    -- JSON.Stringify encodes an empty Lua table as {} not [] so we build the
    -- array manually to guarantee a JSON array regardless of how many keys are held.
    local parts = {}
    for _, k in ipairs(keys) do
        parts[#parts + 1] = string.format("%q", k):gsub("\n", "\\n")
    end
    local json = string.format('{"id":%d,"keys":[%s]}', req.id, table.concat(parts, ","))
    client:Send(json)
end

handlers["input.is_down"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { down = Input.IsDown(req.code) })
end

handlers["input.modifiers"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { modifiers = Input.GetModifiers() })
end

-- Clipboard ------------------------------------------------------------------

handlers["clipboard.get"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { text = Clipboard.Get() or "" })
end

handlers["clipboard.set"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    Clipboard.Set(req.text or "")
    reply(client, req, { ok = true })
end

-- Window manipulation --------------------------------------------------------

handlers["window.list"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { windows = Window.List(req.filter) })
end

handlers["window.find"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    reply(client, req, { handle = Window.Find(req.title or "") })
end

handlers["window.activate"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    Window.Activate(req.handle)
    reply(client, req, { ok = true })
end

handlers["window.move"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    Window.Move(req.handle, req.x, req.y, req.width, req.height)
    reply(client, req, { ok = true })
end

-- Subscriptions --------------------------------------------------------------

handlers["subscribe"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    local events = req.events or {}
    -- stash the client handle itself so OnTick can call :Send() on it without
    -- waiting for a round-trip. the handle's closures look up the live
    -- connection by client_id at call time; dead clients become no-ops.
    subscribers[client.id] = subscribers[client.id] or { client = client }
    subscribers[client.id].client = client
    for _, name in ipairs(events) do
        subscribers[client.id][name] = true
    end
    reply(client, req, { ok = true, subscribed = events })
end

handlers["unsubscribe"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    local events = req.events or {}
    if subscribers[client.id] then
        for _, name in ipairs(events) do
            subscribers[client.id][name] = nil
        end
    end
    reply(client, req, { ok = true })
end

-- Escape hatch ---------------------------------------------------------------
-- dangerous: runs arbitrary Lua in the script's sandbox. guarded by a config flag.

handlers["lua.exec"] = function(client, req)
    if not requires_auth(client, req) then
        return
    end
    if not ALLOW_LUA_EXEC then
        err(client, req, "disabled", "lua.exec is disabled in config")
        return
    end
    local fn, parse_err = loadstring(req.source or "")
    if not fn then
        err(client, req, "parse_error", tostring(parse_err))
        return
    end
    local ok, result = pcall(fn)
    if ok then
        reply(client, req, { result = result })
    else
        err(client, req, "runtime_error", tostring(result))
    end
end

-- Meta -----------------------------------------------------------------------

handlers["ping"] = function(client, req)
    reply(client, req, { pong = true, time_ms = System.Time() })
end

-- ── WS server lifecycle ──────────────────────────────────────────────────────

function OnStart()
    server = Net.WSListen(cfg.port, {
        OnConnect = function(client)
            Log.Info(string.format("Remote Access: client %d connected", client.id))
            -- send protocol banner so clients can verify version without a round-trip
            send(client, { t = "hello", protocol = PROTOCOL_VERSION, auth_required = AUTH_TOKEN ~= "" })
        end,

        OnMessage = function(client, payload, is_binary)
            if is_binary then
                err(client, { id = nil }, "no_binary", "binary frames are not supported in v1")
                return
            end

            local ok, req = pcall(JSON.Parse, payload)
            if not ok or type(req) ~= "table" then
                err(client, { id = nil }, "bad_json", "could not parse JSON object")
                return
            end

            local handler = handlers[req.t or ""]
            if handler then
                local ok2, e = pcall(handler, client, req)
                if not ok2 then
                    err(client, req, "handler_error", tostring(e))
                end
            else
                err(client, req, "unknown_command", string.format("unknown command '%s'", tostring(req.t)))
            end
        end,

        OnClose = function(client)
            Log.Info(string.format("Remote Access: client %d disconnected", client.id))
            subscribers[client.id] = nil
            authed[client.id] = nil
        end,
    })

    Log.Info(
        string.format(
            "Remote Access server listening on ws://0.0.0.0:%d (auth=%s)",
            cfg.port,
            AUTH_TOKEN ~= "" and "required" or "open"
        )
    )
    UI.Notify(string.format("Remote Access: ws://0.0.0.0:%d", cfg.port), "success")
end

function OnStop()
    if server then
        server:Stop()
        server = nil
    end
    subscribers = {}
    authed = {}
end

-- ── subscription streams ─────────────────────────────────────────────────────
-- drive pushed events from OnTick. each stream is published only to clients
-- that have subscribed to it and only when the underlying state has changed.

function OnTick()
    if not server then
        return
    end
    if next(subscribers) == nil then
        return
    end

    -- mouse: only emit when position has changed (cheap — raw coords compare)
    local mouse_msg = nil
    local x, y = System.Mouse()
    if x ~= last_mouse_x or y ~= last_mouse_y then
        last_mouse_x, last_mouse_y = x, y
        local ok, encoded = pcall(JSON.Stringify, { t = "mouse", x = x, y = y })
        if ok then
            mouse_msg = encoded
        end
    end

    -- window: only emit when title has changed
    local window_msg = nil
    local win = System.Window()
    if win.title ~= last_window_title then
        last_window_title = win.title
        local ok, encoded = pcall(JSON.Stringify, { t = "window", window = win })
        if ok then
            window_msg = encoded
        end
    end

    -- input: snapshot every tick (cheap enough; subscribers opt in explicitly)
    local input_msg = nil
    local any_input = false
    for _, subs in pairs(subscribers) do
        if subs.input then
            any_input = true
            break
        end
    end
    if any_input then
        local ok, encoded = pcall(JSON.Stringify, {
            t = "input",
            keys = Input.GetActiveKeys(),
            modifiers = Input.GetModifiers(),
        })
        if ok then
            input_msg = encoded
        end
    end

    -- fan out: send each message only to clients subscribed to that stream.
    -- a closed client's :Send() is a silent no-op, so no cleanup needed here;
    -- OnClose handles the table removal.
    for _, subs in pairs(subscribers) do
        if mouse_msg and subs.mouse then
            subs.client:Send(mouse_msg)
        end
        if window_msg and subs.window then
            subs.client:Send(window_msg)
        end
        if input_msg and subs.input then
            subs.client:Send(input_msg)
        end
    end
end
