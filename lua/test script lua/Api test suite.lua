--[[
    AXION · Comprehensive API Test Suite (v4.1 · Stable)
    ------------------------------------------------------------------
    วิธีใช้:
      1. โหลด lua/AXION api.lua ใน executor ก่อน
      2. ข้อมูล ReportWorkspace ของชุดทดสอบจะแยกไปที่ AXION_TEST/{UserId}_APITEST
      3. ใน AXION > Server Scripts โหลด script ที่ export ฟังก์ชัน find_item
         (Server Script ใช้ scope ปัจจุบันของ AXION API ไม่จำเป็นต้องเปลี่ยน scope จริง)
      4. รันไฟล์นี้ แล้ววาง API token ในช่องด้านบน หรือกำหนด API_TOKEN ด้านล่าง
      5. กด "Run Safe Tests" หรือ "Run All Tests"
         ทั้งสองโหมดจะไม่เรียก AXION:Stop และไม่ตัด connection
         report ที่ใช้ข้อมูลจำลองใช้ account suffix _APITEST; ReportInventory ถูก mock ไม่เขียนข้อมูลจริง
]]

local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local LocalPlayer = Players.LocalPlayer
local PlayerGui = LocalPlayer:WaitForChild("PlayerGui")

--==============================================================
-- CONFIG
--==============================================================
local TEST_GAME_ID   = "AXION_TEST"
local ACCOUNT_ID     = tostring(LocalPlayer.UserId)
-- Set this only if pasting into the in-game textbox is unavailable.
-- Keep real tokens private; do not share or commit this file with a token in it.
local API_TOKEN      = ""

local FETCH_WAIT     = 0.55
local UI_ROW_WAIT    = 0.05
local CONNECT_TIMEOUT = 120

--==============================================================
-- GUARD
--==============================================================
if type(AXION) ~= "table" then
    error("AXION API is not loaded. Load lua/AXION api.lua first.")
end

local Existing = PlayerGui:FindFirstChild("AXIONApiTestSuite")
if Existing then Existing:Destroy() end

local HasNativeFetchAsync = type(AXION.FetchAsync) == "function"
local ServerScriptApiReady = nil
local ServerScriptApiFailure = nil

local function fetchWithCooldown(callback)
    local ok, result = pcall(callback)
    task.wait(FETCH_WAIT)
    if not ok then
        error(result, 2)
    end
    return result
end

--==============================================================
-- AUTO-CONNECT HELPER
--==============================================================
local function ensureConnection(timeout)
    timeout = timeout or CONNECT_TIMEOUT

    if AXION.IsConnected then
        return true, "already connected"
    end

    local connectionError
    if not AXION.Connecting then
        task.spawn(function()
            local ok, err = pcall(function()
                AXION:Connect()
            end)
            if not ok then
                connectionError = tostring(err)
            end
        end)
    end

    local t0 = os.clock()
    while os.clock() - t0 < timeout do
        if AXION.IsConnected then
            return true, string.format("connected in %.1fs", os.clock() - t0)
        end
        if connectionError then
            return false, "Connect() threw: " .. connectionError
        end
        if AXION.Terminated then
            return false, "AXION was terminated during connect"
        end
        task.wait(0.25)
    end

    return false, string.format(
        "timeout after %.0fs (Connecting=%s, Terminated=%s)",
        timeout, tostring(AXION.Connecting), tostring(AXION.Terminated))
end

--==============================================================
-- THEME
--==============================================================
local C = {
    bg        = Color3.fromRGB(14, 17, 33),
    panel2    = Color3.fromRGB(22, 27, 52),
    stroke    = Color3.fromRGB(91, 94, 160),
    accent    = Color3.fromRGB(91, 77, 207),
    accentDim = Color3.fromRGB(58, 52, 130),
    text      = Color3.fromRGB(224, 226, 255),
    subtext   = Color3.fromRGB(164, 172, 204),
    pass      = Color3.fromRGB(126, 231, 165),
    fail      = Color3.fromRGB(255, 143, 153),
    warn      = Color3.fromRGB(255, 209, 128),
    info      = Color3.fromRGB(146, 199, 255),
    logBg     = Color3.fromRGB(8, 11, 25),
}

--==============================================================
-- UI
--==============================================================
local ScreenGui = Instance.new("ScreenGui")
ScreenGui.Name = "AXIONApiTestSuite"
ScreenGui.ResetOnSpawn = false
ScreenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
ScreenGui.DisplayOrder = 100
ScreenGui.IgnoreGuiInset = true
ScreenGui.Parent = PlayerGui

-- Fit to viewport so nothing gets clipped off-screen
local ViewportX, ViewportY = 1280, 720
do
    local cam = workspace.CurrentCamera
    if cam then
        ViewportX = cam.ViewportSize.X
        ViewportY = cam.ViewportSize.Y
    end
end

-- FIX #1: clamp panel size so it never collapses into a tiny box
local PANEL_W = math.clamp(ViewportX - 40, 340, 560)
local PANEL_H = math.clamp(ViewportY - 60, 380, 620)

local Panel = Instance.new("Frame")
Panel.AnchorPoint = Vector2.new(0.5, 0.5)
Panel.Position = UDim2.fromScale(0.5, 0.5)
Panel.Size = UDim2.fromOffset(PANEL_W, PANEL_H)
Panel.BackgroundColor3 = C.bg
Panel.BorderSizePixel = 0
Panel.ClipsDescendants = true
Panel.ZIndex = 1
Panel.Parent = ScreenGui
Instance.new("UICorner", Panel).CornerRadius = UDim.new(0, 12)
do
    local s = Instance.new("UIStroke", Panel)
    s.Color = C.stroke; s.Transparency = 0.35
    local p = Instance.new("UIPadding", Panel)
    p.PaddingTop = UDim.new(0, 12); p.PaddingBottom = UDim.new(0, 14)
    p.PaddingLeft = UDim.new(0, 14); p.PaddingRight = UDim.new(0, 14)
end

-- Header -----------------------------------------------------
local Header = Instance.new("Frame")
Header.Position = UDim2.new(0, 0, 0, 0)
Header.Size = UDim2.new(1, 0, 0, 30)
Header.BackgroundTransparency = 1
Header.ZIndex = 3
Header.Parent = Panel

local Title = Instance.new("TextLabel")
Title.Size = UDim2.new(1, -30, 1, 0)
Title.BackgroundTransparency = 1
Title.Font = Enum.Font.GothamBold
Title.Text = "AXION · API Test Suite"
Title.TextColor3 = C.text
Title.TextSize = 15
Title.TextXAlignment = Enum.TextXAlignment.Left
Title.ZIndex = 3
Title.Parent = Header

local ConnDot = Instance.new("TextLabel")
ConnDot.AnchorPoint = Vector2.new(1, 0)
ConnDot.Position = UDim2.new(1, 0, 0, 0)
ConnDot.Size = UDim2.fromOffset(20, 30)
ConnDot.BackgroundTransparency = 1
ConnDot.Font = Enum.Font.GothamBold
ConnDot.Text = "●"
ConnDot.TextColor3 = C.fail
ConnDot.TextSize = 16
ConnDot.TextXAlignment = Enum.TextXAlignment.Right
ConnDot.ZIndex = 3
ConnDot.Parent = Header

-- Body -------------------------------------------------------
local Body = Instance.new("Frame")
Body.Position = UDim2.new(0, 0, 0, 38)
Body.Size = UDim2.new(1, 0, 1, -38)
Body.BackgroundTransparency = 1
Body.ClipsDescendants = false
Body.Parent = Panel

local function place(inst, y, h)
    inst.Position = UDim2.new(0, 0, 0, y)
    inst.Size     = UDim2.new(1, 0, 0, h)
    return inst
end

-- InfoLabel --------------------------------------------------
local InfoLabel = Instance.new("TextLabel")
InfoLabel.BackgroundTransparency = 1
InfoLabel.Font = Enum.Font.Gotham
InfoLabel.Text = ""
InfoLabel.TextColor3 = C.subtext
InfoLabel.TextSize = 11
InfoLabel.TextXAlignment = Enum.TextXAlignment.Left
InfoLabel.TextTruncate = Enum.TextTruncate.AtEnd
InfoLabel.Parent = Body
place(InfoLabel, 0, 22)

-- TokenBox ---------------------------------------------------
local TokenBox = Instance.new("TextBox")
TokenBox.BackgroundColor3 = C.logBg
TokenBox.BorderSizePixel = 0
TokenBox.Active = true
TokenBox.Selectable = true
TokenBox.TextEditable = true
TokenBox.MultiLine = false
TokenBox.ClearTextOnFocus = false
TokenBox.Font = Enum.Font.Code
TokenBox.PlaceholderText = "Paste Server Scripts API token here (required for Fetch tests)"
TokenBox.Text = API_TOKEN
TokenBox.TextColor3 = C.text
TokenBox.PlaceholderColor3 = Color3.fromRGB(120, 128, 158)
TokenBox.TextSize = 11
TokenBox.TextXAlignment = Enum.TextXAlignment.Left
TokenBox.ZIndex = 4
TokenBox.Parent = Body
place(TokenBox, 26, 34)
Instance.new("UICorner", TokenBox).CornerRadius = UDim.new(0, 7)
do
    local p = Instance.new("UIPadding", TokenBox)
    p.PaddingLeft = UDim.new(0, 8); p.PaddingRight = UDim.new(0, 8)
end

--==============================================================
-- FIX #2: Buttons — swap UIGridLayout for UIListLayout (stable on mobile)
--==============================================================
local BtnRow = Instance.new("Frame")
BtnRow.BackgroundTransparency = 1
BtnRow.ClipsDescendants = false
BtnRow.ZIndex = 5
BtnRow.Parent = Body
place(BtnRow, 68, 38)

local BtnList = Instance.new("UIListLayout")
BtnList.FillDirection = Enum.FillDirection.Horizontal
BtnList.HorizontalAlignment = Enum.HorizontalAlignment.Center
BtnList.VerticalAlignment = Enum.VerticalAlignment.Center
BtnList.SortOrder = Enum.SortOrder.LayoutOrder
BtnList.Padding = UDim.new(0, 6)
BtnList.Parent = BtnRow

local function mkBtn(name, text, order, color)
    local b = Instance.new("TextButton")
    b.Name = name
    b.LayoutOrder = order
    b.BackgroundColor3 = color or C.accent
    b.BorderSizePixel = 0
    b.Font = Enum.Font.GothamSemibold
    b.Text = text
    b.TextColor3 = C.text
    b.TextSize = 11
    b.TextWrapped = true
    b.AutoButtonColor = true
    b.ZIndex = 5
    -- 4 ปุ่มพอดี: (1 - padding) / 4
    b.Size = UDim2.new(0.25, -6, 1, 0)
    b.Parent = BtnRow
    Instance.new("UICorner", b).CornerRadius = UDim.new(0, 8)
    return b
end

local BtnSafe  = mkBtn("RunSafe",  "Run Safe Tests",        1)
local BtnAll   = mkBtn("RunAll",   "Run All Tests",          2, C.accent)
local BtnClear = mkBtn("Clear",    "Clear",                 3, C.accentDim)
local BtnCopy  = mkBtn("Copy",     "Copy Log",              4, C.accentDim)

-- ProgressLabel ---------------------------------------------
local ProgressLabel = Instance.new("TextLabel")
ProgressLabel.BackgroundTransparency = 1
ProgressLabel.Font = Enum.Font.Code
ProgressLabel.Text = "Ready."
ProgressLabel.TextColor3 = C.subtext
ProgressLabel.TextSize = 11
ProgressLabel.TextXAlignment = Enum.TextXAlignment.Left
ProgressLabel.TextTruncate = Enum.TextTruncate.AtEnd
ProgressLabel.Parent = Body
place(ProgressLabel, 112, 20)

-- Scroll (log area) -----------------------------------------
local SCROLL_Y = 138
local Scroll = Instance.new("ScrollingFrame")
Scroll.Position = UDim2.new(0, 0, 0, SCROLL_Y)
Scroll.Size     = UDim2.new(1, 0, 1, -SCROLL_Y - 4)
Scroll.BackgroundColor3 = C.logBg
Scroll.BorderSizePixel = 0
Scroll.ScrollBarThickness = 4
Scroll.ScrollBarImageColor3 = C.accent
Scroll.CanvasSize = UDim2.new()
Scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
Scroll.ScrollingDirection = Enum.ScrollingDirection.Y
Scroll.ElasticBehavior = Enum.ElasticBehavior.Never
Scroll.ClipsDescendants = true
Scroll.ZIndex = 1
Scroll.Parent = Body
Instance.new("UICorner", Scroll).CornerRadius = UDim.new(0, 8)
do
    local p = Instance.new("UIPadding", Scroll)
    p.PaddingTop = UDim.new(0, 6); p.PaddingBottom = UDim.new(0, 6)
    p.PaddingLeft = UDim.new(0, 8); p.PaddingRight = UDim.new(0, 8)
end

local Rows = Instance.new("UIListLayout", Scroll)
Rows.Padding = UDim.new(0, 3)
Rows.SortOrder = Enum.SortOrder.LayoutOrder
Rows.FillDirection = Enum.FillDirection.Vertical

--==============================================================
-- ROW HELPERS
--==============================================================
local RowCount = 0
local function addRow(status, cat, name, message)
    local color = C.subtext
    if status == "PASS" then color = C.pass
    elseif status == "FAIL" then color = C.fail
    elseif status == "SKIP" or status == "WARN" then color = C.warn
    elseif status == "INFO" then color = C.info end

    local row = Instance.new("TextLabel")
    row.Name = "Row"
    row.LayoutOrder = RowCount
    row.Size = UDim2.new(1, 0, 0, 0)
    row.AutomaticSize = Enum.AutomaticSize.Y
    row.BackgroundTransparency = 1
    row.Font = Enum.Font.Code
    row.Text = string.format("[%s] %s :: %s%s",
        status, cat, name,
        (message and message ~= "") and ("\n    " .. message) or "")
    row.TextColor3 = color
    row.TextSize = 11
    row.TextWrapped = true
    row.TextXAlignment = Enum.TextXAlignment.Left
    row.TextYAlignment = Enum.TextYAlignment.Top
    row.Parent = Scroll
    RowCount += 1

    task.defer(function()
        if Scroll and Scroll.Parent then
            Scroll.CanvasPosition = Vector2.new(0, math.huge)
        end
    end)
end

local function clearRows()
    for _, c in ipairs(Scroll:GetChildren()) do
        if c:IsA("TextLabel") then c:Destroy() end
    end
    RowCount = 0
end

--==============================================================
-- TEST FRAMEWORK
--==============================================================
local REGISTRY = {}
local Stats = { pass = 0, fail = 0, skip = 0 }
local Busy = false
local AllowDestructive = false

local function reg(category, name, fn, opts)
    opts = opts or {}
    table.insert(REGISTRY, {
        category = category,
        name = name,
        fn = fn,
        destructive = opts.destructive or false,
        needsConn   = opts.needsConn   or false,
        needsToken  = opts.needsToken  or false,
        needsNativeFetchAsync = opts.needsNativeFetchAsync or false,
        skipWhen = opts.skipWhen,
        skipReason = opts.skipReason,
    })
end

local function expectOk(fn)
    local ok, err = pcall(fn)
    if not ok then
        error("expected success but got: " .. tostring(err), 2)
    end
end

local function expectRaise(fn)
    local ok, err = pcall(fn)
    if ok then
        error("expected an error but the call succeeded", 2)
    end
    return tostring(err)
end

local function captureSend(fn)
    local originalSend = AXION.Send
    local calls = {}
    AXION.Send = function(_, command, payload)
        table.insert(calls, { command = command, payload = payload })
    end

    local ok, err = pcall(fn)
    AXION.Send = originalSend
    if not ok then
        error(err, 2)
    end
    return calls
end

local function getToken()
    local t = TokenBox.Text:match("^%s*(.-)%s*$")
    if t == "" then
        return nil
    end
    return t
end

--==============================================================
-- TESTS — STATE
--==============================================================
reg("State", "AXION global is a table", function()
    assert(type(AXION) == "table", "AXION is not a table")
end)

reg("State", "AXION.gamescope is a string", function()
    assert(type(AXION.gamescope) == "string", "gamescope not string")
end)

reg("State", "AXION.IsConnected is boolean or nil", function()
    local t = type(AXION.IsConnected)
    assert(t == "boolean" or t == "nil", "unexpected type: " .. t)
end)

reg("State", "AXION.Connecting is boolean or nil", function()
    local t = type(AXION.Connecting)
    assert(t == "boolean" or t == "nil", "unexpected type: " .. t)
end)

reg("State", "AXION.Terminated is boolean or nil", function()
    local t = type(AXION.Terminated)
    assert(t == "boolean" or t == "nil", "unexpected type: " .. t)
end)

reg("State", "AXION.Commands is a table", function()
    assert(type(AXION.Commands) == "table", "Commands not table")
end)

reg("State", "os.clock is a function", function()
    assert(type(os.clock) == "function", "os.clock global is not a function")
end)

reg("State", "FetchAsync is provided by AXION API", function()
    assert(HasNativeFetchAsync,
        "AXION:FetchAsync is missing; reload the current lua/AXION api.lua")
end)

--==============================================================
-- TESTS — SIGNALS
--==============================================================
reg("Signal", "Connected signal has :Connect/:Wait", function()
    assert(type(AXION.Connected) == "table", "Connected signal missing")
    assert(type(AXION.Connected.Connect) == "function", "Connected:Connect missing")
    assert(type(AXION.Connected.Wait) == "function", "Connected:Wait missing")
end)

reg("Signal", "Disconnected signal has :Connect/:Wait", function()
    assert(type(AXION.Disconnected) == "table", "Disconnected signal missing")
    assert(type(AXION.Disconnected.Connect) == "function", "Disconnected:Connect missing")
end)

reg("Signal", "MessageReceived has :Connect/:Wait", function()
    assert(type(AXION.MessageReceived) == "table", "MessageReceived missing")
    assert(type(AXION.MessageReceived.Connect) == "function", "MessageReceived:Connect missing")
    assert(type(AXION.MessageReceived.Wait) == "function", "MessageReceived:Wait missing")
end)

reg("Signal", "Signal:Connect returns handle with :Disconnect", function()
    local h = AXION.MessageReceived:Connect(function() end)
    assert(h ~= nil, "Connect returned nil")
    assert(type(h.Disconnect) == "function", "handle has no :Disconnect")
    h:Disconnect()
end)

reg("Signal", "Signal:Connect raises on non-function", function()
    expectRaise(function() AXION.MessageReceived:Connect("not a function") end)
end)

--==============================================================
-- TESTS — CONNECTION
--==============================================================
reg("Connect", "AXION:Connect is a function", function()
    assert(type(AXION.Connect) == "function", ":Connect missing")
end, { needsConn = false })

reg("Connect", "Reconnect while connected returns a message", function()
    if not AXION.IsConnected then
        error("not connected; cannot test re-entrancy")
    end
    local msg = AXION:Connect()
    assert(type(msg) == "string", "expected a message string when already connected")
end, { needsConn = true })

reg("Connect", "AXION:Connect accepts bypass argument (documented)", function()
    assert(type(AXION.Connect) == "function", "Connect missing")
    local info = (debug and debug.info) and debug.info(AXION.Connect, "a") or nil
    if info then
        assert(type(info) == "number" and info >= 1,
            "Connect arity looks wrong: " .. tostring(info))
    end
end, { needsConn = true })

--==============================================================
-- TESTS — SEND
--==============================================================
reg("Send", ":Send is a function", function()
    assert(type(AXION.Send) == "function", ":Send missing")
end)

reg("Send", "Send('ping') with no payload", function()
    expectOk(function() AXION:Send("ping") end)
    task.wait(0.2)
end, { needsConn = true })

reg("Send", "Send('ping', {})", function()
    expectOk(function() AXION:Send("ping", {}) end)
    task.wait(0.2)
end, { needsConn = true })

reg("Send", "Send('Echo', {Content='test'})", function()
    expectOk(function() AXION:Send("Echo", { Content = "test" }) end)
    task.wait(0.2)
end, { needsConn = true })

reg("Send", "Send('Log', {Content='test'})", function()
    expectOk(function() AXION:Send("Log", { Content = "test" }) end)
    task.wait(0.2)
end, { needsConn = true })

reg("Send", "Send('SetPlaceId', {Content=number})", function()
    expectOk(function() AXION:Send("SetPlaceId", { Content = game.PlaceId }) end)
    task.wait(0.2)
end, { needsConn = true })

reg("Send", "Send('SetJobId', {Content=string})", function()
    expectOk(function() AXION:Send("SetJobId", { Content = tostring(game.JobId) }) end)
    task.wait(0.2)
end, { needsConn = true })

reg("Send", "Send('UnknownCmd') raises", function()
    local err = expectRaise(function() AXION:Send("NopeCommand", {}) end)
    assert(err:lower():find("unsupported") or err:lower():find("command"),
        "unexpected error text: " .. err)
end, { needsConn = true })

reg("Send", "Send('ping', 'string') raises (payload not table)", function()
    expectRaise(function() AXION:Send("ping", "not-a-table") end)
end, { needsConn = true })

reg("Send", "Send() with no args raises", function()
    expectRaise(function() AXION:Send() end)
end, { needsConn = true })

--==============================================================
-- TESTS — LOG / ECHO / SETPLACEID / SETJOBID
--==============================================================
reg("Log", ":Log is a function", function()
    assert(type(AXION.Log) == "function", ":Log missing")
end)

reg("Log", "Log('test')", function()
    expectOk(function() AXION:Log("test") end)
    task.wait(0.2)
end, { needsConn = true })

reg("Log", "Log() with no arguments", function()
    expectOk(function() AXION:Log() end)
    task.wait(0.2)
end, { needsConn = true })

reg("Log", "Log with mixed types", function()
    expectOk(function() AXION:Log("str", 1, true, { a = 1 }) end)
    task.wait(0.2)
end, { needsConn = true })

reg("Echo", "Echo('hello')", function()
    expectOk(function() AXION:Echo("hello") end)
    task.wait(0.2)
end, { needsConn = true })

reg("Echo", "Echo({a=1})", function()
    expectOk(function() AXION:Echo({ a = 1 }) end)
    task.wait(0.2)
end, { needsConn = true })

reg("PlaceId", "SetPlaceId(number)", function()
    expectOk(function() AXION:SetPlaceId(game.PlaceId) end)
    task.wait(0.2)
end, { needsConn = true })

reg("PlaceId", "SetPlaceId(string)", function()
    expectOk(function() AXION:SetPlaceId(tostring(game.PlaceId)) end)
    task.wait(0.2)
end, { needsConn = true })

reg("JobId", "SetJobId(string)", function()
    expectOk(function() AXION:SetJobId(tostring(game.JobId)) end)
    task.wait(0.2)
end, { needsConn = true })

reg("JobId", "SetJobId(number)", function()
    local originalSend = AXION.Send
    local sentCommand, sentPayload
    AXION.Send = function(_, command, payload)
        sentCommand, sentPayload = command, payload
    end
    local ok, err = pcall(function() AXION:SetJobId(123456) end)
    AXION.Send = originalSend

    assert(ok, "SetJobId(number) raised: " .. tostring(err))
    assert(sentCommand == "SetJobId", "SetJobId did not send the expected command")
    assert(type(sentPayload) == "table" and sentPayload.Content == 123456,
        "SetJobId did not preserve the numeric value")
end)

--==============================================================
-- TESTS — REPORT WORKSPACE
--==============================================================
local function minimalReport()
    return {
        customGameId = TEST_GAME_ID,
        accountId = ACCOUNT_ID,
        world = "Test World",
        profile = {},
        worldProgress = {},
        inventory = {},
    }
end

local function fullReport()
    return {
        customGameId = TEST_GAME_ID,
        accountId = ACCOUNT_ID,
        world = "Test World",
        profile = { level = 999, race = "AXION_TEST" },
        worldProgress = { ["Test World"] = { visited = true } },
        inventory = {
            fruits = { ["Test Fruit"] = { quantity = 1, itemId = "test-fruit" } },
            swords = {},
            guns = {},
            accessories = {},
            materials = {
                ["AXION_TEST_ITEM1"] = { quantity = 7, itemId = "axion_test_item1" },
                ["AXION_TEST_ITEM2"] = { quantity = 14, itemId = "axion_test_item2" },
            },
        },
    }
end

reg("ReportWorkspace", "ReportWorkspace is a function", function()
    assert(type(AXION.ReportWorkspace) == "function", "ReportWorkspace missing")
end)

reg("ReportWorkspace", "Send minimal report", function()
    expectOk(function() AXION:ReportWorkspace(minimalReport()) end)
end, { needsConn = true })

reg("ReportWorkspace", "Send full report", function()
    expectOk(function() AXION:ReportWorkspace(fullReport()) end)
end, { needsConn = true })

reg("ReportWorkspace", "Non-table raises", function()
    expectRaise(function() AXION:ReportWorkspace("not-a-table") end)
end)

reg("ReportWorkspace", "Defaults scope and optional report fields", function()
    local calls = captureSend(function()
        AXION:ReportWorkspace({})
    end)
    assert(#calls == 1, "ReportWorkspace should send exactly one message")
    assert(calls[1].command == "InventoryUpdate", "unexpected report message name")
    local payload = calls[1].payload
    assert(payload.customGameId == AXION.gamescope, "default game scope was not applied")
    assert(payload.accountId == tostring(LocalPlayer.UserId),
        "ReportWorkspace default account ID should be the local player's UserId")
    assert(payload.world == "Unknown", "default world was not applied")
    assert(type(payload.profile) == "table", "default profile was not applied")
    assert(type(payload.worldProgress) == "table", "default worldProgress was not applied")
    assert(type(payload.inventory) == "table", "default inventory was not applied")
end)

reg("ReportWorkspace", "Immediate repeated reports are accepted", function()
    expectOk(function() AXION:ReportWorkspace(minimalReport()) end)
    expectOk(function() AXION:ReportWorkspace(fullReport()) end)
end, { needsConn = true })

reg("ReportWorkspace", "Custom inventory category is accepted", function()
    local report = fullReport()
    report.inventory = {
        custom_category_2 = { ["x"] = { quantity = 1 } },
        ["pets🎒"] = { ["Example Pet"] = { quantity = 1 } }
    }
    local ok, callsOrError = pcall(function()
        return captureSend(function()
            AXION:ReportWorkspace(report)
        end)
    end)

    assert(ok, "ReportWorkspace rejected a valid custom category: " .. tostring(callsOrError))
    assert(#callsOrError == 1, "valid custom-category report was not sent")
end)

reg("ReportWorkspace", "Invalid inventory category raises before sending", function()
    local bad = fullReport()
    bad.inventory = { ["invalid/category"] = { ["x"] = { quantity = 1 } } }
    local ok, err = pcall(function()
        return captureSend(function()
            AXION:ReportWorkspace(bad)
        end)
    end)

    assert(not ok, "ReportWorkspace accepted an invalid inventory category")
    assert(err:find("Invalid inventory category name", 1, true),
        "unexpected invalid-category error: " .. err)
end)

--==============================================================
-- TESTS — REPORT INVENTORY
--==============================================================
reg("ReportInventory", "ReportInventory is a function", function()
    assert(type(AXION.ReportInventory) == "function", "ReportInventory missing")
end)

reg("ReportInventory", "Send valid item list", function()
    local calls = captureSend(function()
        AXION:ReportInventory({
            { name = "AXION_TEST_ITEM1", quantity = 7, itemId = "axion_test_item1" },
            { name = "AXION_TEST_ITEM2", quantity = 14 },
        })
    end)
    assert(#calls == 1, "ReportInventory should send exactly one message")
    assert(calls[1].command == "InventoryUpdate", "ReportInventory used an unexpected message")
    local payload = calls[1].payload
    assert(payload.customGameId == AXION.gamescope, "ReportInventory should use configured scope")
    assert(payload.accountId == tostring(LocalPlayer.UserId), "ReportInventory should use local account ID")
    assert(payload.inventory.materials.AXION_TEST_ITEM1.quantity == 7,
        "first material quantity was not preserved")
    assert(payload.inventory.materials.AXION_TEST_ITEM1.itemId == "axion_test_item1",
        "first material itemId was not preserved")
    assert(payload.inventory.materials.AXION_TEST_ITEM2.quantity == 14,
        "second material quantity was not preserved")
end)

reg("ReportInventory", "Non-table raises", function()
    expectRaise(function() AXION:ReportInventory("not-a-list") end)
end)

--==============================================================
-- TESTS — COMMANDS
--==============================================================
reg("Commands", "AddCommand + dispatch + RemoveCommand", function()
    local got = nil
    AXION:AddCommand("axion_test_cmd", function(msg) got = msg end)
    assert(type(AXION.Commands["axion_test_cmd"]) == "function",
        "handler not registered")
    AXION.Commands["axion_test_cmd"]("hello")
    assert(got == "hello", "handler was not invoked with expected message")
    AXION:RemoveCommand("axion_test_cmd")
    assert(AXION.Commands["axion_test_cmd"] == nil, "handler still present after remove")
end)

reg("Commands", "AddCommand replaces existing handler", function()
    local which = nil
    AXION:AddCommand("axion_test_replace", function() which = "first" end)
    AXION:AddCommand("axion_test_replace", function() which = "second" end)
    AXION.Commands["axion_test_replace"]("x")
    assert(which == "second", "second handler did not replace the first")
    AXION:RemoveCommand("axion_test_replace")
end)

reg("Commands", "RemoveCommand on missing key does not raise", function()
    expectOk(function() AXION:RemoveCommand("axion_test_does_not_exist") end)
end)

--==============================================================
-- TESTS — FETCH
--==============================================================
reg("Fetch", "Fetch is a function", function()
    assert(type(AXION.Fetch) == "function", "Fetch missing")
end)

reg("FetchOnlineInventory", "Fetches online inventory without getgenv arguments", function()
    local originalFetch = AXION.Fetch
    local captured
    local expected = { customGameId = TEST_GAME_ID, count = 0, items = {} }
    AXION.Fetch = function(_, functionName, arguments, token)
        captured = { functionName = functionName, arguments = arguments, token = token }
        return expected
    end

    local ok, result = pcall(function()
        return AXION:FetchOnlineInventory("test-token")
    end)
    AXION.Fetch = originalFetch

    assert(ok, "FetchOnlineInventory failed without getgenv: " .. tostring(result))
    assert(result == expected, "FetchOnlineInventory did not return the export result")
    assert(captured.functionName == "get_online_inventory", "unexpected Server Script function")
    assert(captured.token == "test-token", "API token was not forwarded")
    assert(type(captured.arguments) == "table" and next(captured.arguments) == nil,
        "inventory data should not be sent as HTTP fetch arguments")
end)

reg("FetchOnlineInventory", "Forwards optional agent filter", function()
    local originalFetch = AXION.Fetch
    local captured
    AXION.Fetch = function(_, functionName, arguments, token)
        captured = { functionName = functionName, arguments = arguments, token = token }
        return {}
    end

    local ok, err = pcall(function()
        AXION:FetchOnlineInventory("test-token", "agent-test")
    end)
    AXION.Fetch = originalFetch

    assert(ok, "FetchOnlineInventory with agent filter failed: " .. tostring(err))
    assert(captured.functionName == "get_online_inventory", "unexpected Server Script function")
    assert(captured.arguments.agentId == "agent-test", "agent filter was not forwarded")
    assert(captured.token == "test-token", "API token was not forwarded")
end)

reg("Fetch", "Empty function name raises", function()
    expectRaise(function()
        AXION:Fetch("", {}, getToken() or "x")
    end)
end, { needsToken = true })

reg("Fetch", "Non-string token raises", function()
    expectRaise(function()
        AXION:Fetch("find_item", {}, 123)
    end)
end)

reg("Fetch", "DIAG :: find_item reachable", function()
    ServerScriptApiReady = false
    ServerScriptApiFailure = nil
    local token = getToken()
    if not token then
        ServerScriptApiFailure = "No API token was provided."
        error(ServerScriptApiFailure)
    end
    local ok, res = pcall(function()
        return fetchWithCooldown(function()
            return AXION:Fetch("find_item", {
                query = "AXION_TEST_ITEM",
                includeOffline = true,
            }, token)
        end)
    end)
    if not ok then
        ServerScriptApiFailure = tostring(res)
        error("find_item failed for scope " .. tostring(AXION.gamescope)
            .. ". Runtime response: " .. ServerScriptApiFailure)
    end
    if type(res) ~= "table" then
        ServerScriptApiFailure = "find_item returned " .. type(res) .. ", expected a table."
        error(ServerScriptApiFailure)
    end
    if type(res.customGameId) ~= "string"
        or type(res.count) ~= "number"
        or type(res.items) ~= "table" then
        ServerScriptApiFailure = "find_item must return customGameId, count, and items."
        error(ServerScriptApiFailure)
    end
    if res.customGameId ~= AXION.gamescope then
        ServerScriptApiFailure = string.format("SCOPE MISMATCH: client=%q server=%q",
            tostring(AXION.gamescope), tostring(res.customGameId))
        error(ServerScriptApiFailure)
    end
    ServerScriptApiReady = true
end, { needsToken = true })

--==============================================================
-- TESTS — FETCH ASYNC
--==============================================================
reg("FetchAsync", "FetchAsync is provided by AXION API", function()
    assert(type(AXION.FetchAsync) == "function", "FetchAsync missing")
end, { needsNativeFetchAsync = true })

reg("FetchAsync", "Non-function callback raises", function()
    expectRaise(function()
        AXION:FetchAsync("find_item", {}, "test-token", "not-a-function")
    end)
end, { needsNativeFetchAsync = true })

reg("Fetch", "Real 'find_item' call", function()
    local token = getToken()
    if not token then error("no token; paste a real token") end
    local result = fetchWithCooldown(function()
        return AXION:Fetch("find_item", {
            query = "AXION_TEST_ITEM",
            includeOffline = true,
        }, token)
    end)
    assert(type(result) == "table", "find_item did not return a table")
    assert(type(result.customGameId) == "string", "result.customGameId missing")
    assert(type(result.count) == "number", "result.count missing")
    assert(type(result.items) == "table", "result.items missing")
end, { needsToken = true, skipWhen = function() return ServerScriptApiReady == false end })

reg("FetchAsync", "Async find_item resolves", function()
    local token = getToken()
    if not token then error("no token; paste a real token") end
    local done, okFlag, errMsg = false, false, nil
    AXION:FetchAsync("find_item", {
        query = "AXION_TEST_ITEM",
        includeOffline = true,
    }, token,
        function(result, err)
            if err then errMsg = tostring(err) else okFlag = true end
            if okFlag and (type(result) ~= "table"
                or result.customGameId ~= AXION.gamescope) then
                okFlag = false
                errMsg = "find_item returned an invalid result or scope"
            end
            done = true
        end)
    local t0 = os.clock()
    while not done and os.clock() - t0 < 10 do task.wait(0.1) end
    task.wait(FETCH_WAIT)
    assert(done, "callback never fired within 10s")
    if not okFlag then error("FetchAsync failed: " .. tostring(errMsg)) end
end, {
    needsToken = true,
    needsNativeFetchAsync = true,
    skipWhen = function() return ServerScriptApiReady == false end,
})

--==============================================================
-- TESTS — DESTRUCTIVE (opt-in)
--==============================================================
reg("Destructive", "os.clock is callable", function()
    assert(type(os.clock) == "function", "os.clock not a function")
end, { destructive = false })

reg("Destructive", "Signal:Disconnect removes handler safely", function()
    local fired = 0
    local h = AXION.MessageReceived:Connect(function() fired += 1 end)
    assert(type(h.Disconnect) == "function", "handle has no Disconnect")
    h:Disconnect()
    assert(fired == 0, "handler fired unexpectedly before disconnect")
end, { destructive = true, needsConn = true })

reg("Destructive", "AXION:Stop is available (not invoked)", function()
    assert(type(AXION.Stop) == "function", ":Stop missing")
end)

--==============================================================
-- RUNNER
--==============================================================
local function setBusy(state)
    Busy = state
    BtnSafe.Active  = not state
    BtnAll.Active   = not state
    BtnClear.Active = not state
    BtnCopy.Active  = not state
end

local function runOne(test)
    if test.skipReason then
        return "SKIP", test.skipReason
    end
    if test.needsNativeFetchAsync and not HasNativeFetchAsync then
        return "SKIP", "AXION API has no FetchAsync; reload the latest lua/AXION api.lua"
    end
    if test.needsConn and not AXION.IsConnected then
        return "SKIP", "AXION not connected"
    end
    if test.needsToken and not getToken() then
        return "SKIP", "Paste the token from AXION > Server Scripts into the token field above"
    end
    if test.skipWhen and test.skipWhen() then
        return "SKIP", "Not run because find_item failed: "
            .. tostring(ServerScriptApiFailure or "see the DIAG :: find_item reachable result above")
    end
    if test.destructive and not AllowDestructive then
        return "SKIP", "destructive test disabled"
    end

    local ok, err = pcall(test.fn)
    if ok then
        return "PASS", ""
    end
    err = tostring(err)
    if err:find("skipped-by-design") then
        return "SKIP", err
    end
    return "FAIL", err
end

local function runSuite(includeDestructive)
    if Busy then return end
    setBusy(true)
    AllowDestructive = includeDestructive
    clearRows()
    Stats.pass, Stats.fail, Stats.skip = 0, 0, 0

    addRow("INFO", "RUN", includeDestructive and "Full test mode" or "Safe mode",
        "Running " .. #REGISTRY .. " tests + 1 connection check")

    if not HasNativeFetchAsync then
        addRow("WARN", "API", "FetchAsync unavailable",
            "No shim was installed; reload the current lua/AXION api.lua to test this method")
    end

    if not AXION.IsConnected then
        addRow("INFO", "CONN", "Auto-connecting",
            string.format("รอสูงสุด %d วินาที...", CONNECT_TIMEOUT))
        ProgressLabel.Text = "Connecting to AXION..."

        local spin = task.spawn(function()
            local frames = { "|", "/", "-", "\\" }
            local i = 1
            while not AXION.IsConnected and not AXION.Terminated do
                if not ProgressLabel.Parent then break end
                ProgressLabel.Text = string.format("Connecting to AXION %s (Connecting=%s)",
                    frames[i], tostring(AXION.Connecting))
                i = (i % #frames) + 1
                task.wait(0.12)
            end
        end)

        local ok, msg = ensureConnection(CONNECT_TIMEOUT)
        if spin then pcall(task.cancel, spin) end

        if ok then
            addRow("PASS", "CONN", "Auto-connect", msg)
            Stats.pass += 1
        else
            addRow("FAIL", "CONN", "Auto-connect", msg)
            Stats.fail += 1
        end
        ProgressLabel.Text = "Connected: " .. tostring(AXION.IsConnected)
    else
        addRow("PASS", "CONN", "Auto-connect", "already connected")
        Stats.pass += 1
    end

    local total = #REGISTRY
    for i, test in ipairs(REGISTRY) do
        ProgressLabel.Text = string.format("Running %d/%d · %s :: %s",
            i, total, test.category, test.name)
        local status, message = runOne(test)
        if status == "PASS" then Stats.pass += 1
        elseif status == "FAIL" then Stats.fail += 1
        else Stats.skip += 1 end
        addRow(status, test.category, test.name, message)
        task.wait(UI_ROW_WAIT)
    end

    local grand = Stats.pass + Stats.fail + Stats.skip
    local outcome = Stats.fail > 0 and "FAILED"
        or (Stats.skip > 0 and "INCOMPLETE" or "DONE")
    local summary = string.format("%s · pass %d · fail %d · skip %d · total %d",
        outcome,
        Stats.pass, Stats.fail, Stats.skip, grand)
    local summaryStatus = Stats.fail > 0 and "FAIL" or (Stats.skip > 0 and "WARN" or "PASS")
    ProgressLabel.Text = summary
    addRow(summaryStatus, "SUMMARY", "Final", summary)

    setBusy(false)
end

--==============================================================
-- BUTTONS
--==============================================================
BtnSafe.Activated:Connect(function()
    task.spawn(function() runSuite(false) end)
end)

BtnAll.Activated:Connect(function()
    addRow("INFO", "RUN", "Full test mode",
        "ทดสอบครบโดยไม่เรียก AXION:Stop หรือปิดการเชื่อมต่อ")
    task.spawn(function() runSuite(true) end)
end)

BtnClear.Activated:Connect(function()
    clearRows()
    ProgressLabel.Text = "Ready."
end)

BtnCopy.Activated:Connect(function()
    local lines = {}
    for _, c in ipairs(Scroll:GetChildren()) do
        if c:IsA("TextLabel") then table.insert(lines, c.Text) end
    end
    local text = table.concat(lines, "\n")
    if setclipboard then
        setclipboard(text)
        ProgressLabel.Text = "Log copied (" .. #lines .. " lines)"
    else
        ProgressLabel.Text = "setclipboard unavailable"
    end
end)

--==============================================================
-- CONNECTION POLL + INFO
--==============================================================
task.spawn(function()
    local was = nil
    while ScreenGui.Parent do
        local connected = AXION.IsConnected and true or false
        if connected ~= was then
            ConnDot.TextColor3 = connected and C.pass or C.fail
            addRow("INFO", "CONN", connected and "connected" or "disconnected",
                "IsConnected = " .. tostring(AXION.IsConnected))
            was = connected
        end
        InfoLabel.Text = string.format(
            "Scope: %s · Account: %s · WS: %s · Connecting: %s · Terminated: %s",
            tostring(AXION.gamescope or "nil"),
            ACCOUNT_ID,
            connected and "connected" or "offline",
            tostring(AXION.Connecting),
            tostring(AXION.Terminated)
        )
        task.wait(1)
    end
end)

--==============================================================
-- DRAG
--==============================================================
do
    local dragging, start, startPos = false, nil, nil
    Header.InputBegan:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1
            or input.UserInputType == Enum.UserInputType.Touch then
            dragging = true
            start = input.Position
            startPos = Panel.Position
        end
    end)
    Header.InputEnded:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1
            or input.UserInputType == Enum.UserInputType.Touch then
            dragging = false
        end
    end)
    UserInputService.InputChanged:Connect(function(input)
        if not dragging then return end
        if input.UserInputType ~= Enum.UserInputType.MouseMovement
            and input.UserInputType ~= Enum.UserInputType.Touch then return end
        local d = input.Position - start
        Panel.Position = UDim2.new(
            startPos.X.Scale, startPos.X.Offset + d.X,
            startPos.Y.Scale, startPos.Y.Offset + d.Y
        )
    end)
end

--==============================================================
-- BOOT
--==============================================================
addRow("INFO", "BOOT", "AXION API Test Suite (v4.1 · Stable)",
    "Paste the token from AXION > Server Scripts into the field above, then run tests.")
if not HasNativeFetchAsync then
    addRow("WARN", "API", "FetchAsync unavailable",
        "โหลด lua/AXION api.lua เวอร์ชันล่าสุด; suite จะไม่สร้าง shim แทน API")
end