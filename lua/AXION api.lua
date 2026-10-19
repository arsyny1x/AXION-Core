--=====================================================================
-- AXION
--=====================================================================
local NativePrint = print

-- Lua client CONFIG (แก้ไขค่าตรงนี้)
--=====================================================================
local CONFIG = {
    -- WebSocket Host
    WebSocketHost      = 5242,              -- Port ของ WebSocket Host ใน AXION
    AutoConnect       = true,              -- เชื่อมต่ออัตโนมัติเมื่อโหลด
    HeartbeatInterval = 10,                -- วินาที ระหว่าง heartbeat
    gamescope         = "AXION_TEST",     -- Game scope สำหรับข้อมูลและ Server Scripts
    ScriptApiPort     = 5243,              -- พอร์ต Server Scripts API ใน AXION

    -- Shutdown
    ShutdownTime          = 45,            -- วินาที รอก่อน shutdown เมื่อเกิด error
    ShutdownOnTeleportError = true,        -- shutdown เมื่อ teleport error
    AutoShutdownOnLoadFail  = true,        -- shutdown ถ้าโหลดเกมไม่สำเร็จใน 60 วิ
    LoadTimeout             = 60,          -- วินาที รอเกมโหลด

    -- Performance command
    DefaultFPS        = 8,                 -- FPS ตอน performance mode
    NormalFPS         = 60,                -- FPS ตอน window focused

    -- Debug
    Debug             = true,             -- แสดง log ใน console
}
assert(
    type(CONFIG.WebSocketHost) == "number"
        and CONFIG.WebSocketHost >= 1
        and CONFIG.WebSocketHost <= 65535
        and CONFIG.WebSocketHost % 1 == 0,
    "CONFIG.WebSocketHost must be a port number between 1 and 65535"
)
local MAX_MESSAGE_BYTES = 16 * 1024
local MAX_INVENTORY_ITEMS = 500
local MAX_INVENTORY_STATE_BYTES = 64 * 1024
local MAX_INVENTORY_NODES = 4096

local function IsValidInventoryCategory(Category)
    if type(Category) ~= 'string' then
        return false
    end
    local Length = utf8.len(Category)
    if not Length or Length < 1 or Length > 64 then
        return false
    end

    for _, Codepoint in utf8.codes(Category) do
        if Codepoint < 128 then
            if not string.char(Codepoint):match('^[A-Za-z0-9_-]$') then
                return false
            end
        elseif Codepoint <= 0x1F
            or (Codepoint >= 0x7F and Codepoint <= 0x9F)
            or Codepoint == 0x85
            or Codepoint == 0xA0
            or Codepoint == 0x1680
            or (Codepoint >= 0x2000 and Codepoint <= 0x200A)
            or Codepoint == 0x2028
            or Codepoint == 0x2029
            or Codepoint == 0x202F
            or Codepoint == 0x205F
            or Codepoint == 0x3000 then
            return false
        end
    end
    return true
end

--=====================================================================
-- END CONFIG — อย่าแก้ไขด้านล่างนี้
--=====================================================================

if AXION then AXION:Stop() end

-- รอเกมโหลด
if not game:IsLoaded() then
    if CONFIG.AutoShutdownOnLoadFail then
        task.delay(CONFIG.LoadTimeout, function()
            if NoShutdown then return end
            if not game:IsLoaded() then
                return game:Shutdown()
            end

            local Code = game:GetService'GuiService':GetErrorCode().Value
            if Code >= Enum.ConnectionError.DisconnectErrors.Value then
                return game:Shutdown()
            end
        end)
    end

    game.Loaded:Wait()
end

--=====================================================================
-- Services
--=====================================================================
local TeleportService = game:GetService'TeleportService'
local InputService    = game:GetService'UserInputService'
local HttpService     = game:GetService'HttpService'
local RunService      = game:GetService'RunService'
local GuiService      = game:GetService'GuiService'
local Players         = game:GetService'Players'
local LocalPlayer     = Players.LocalPlayer

if not LocalPlayer then
    repeat LocalPlayer = Players.LocalPlayer task.wait() until LocalPlayer
    task.wait(0.5)
end

local UGS = UserSettings():GetService'UserGameSettings'
local OldVolume = UGS.MasterVolume

--=====================================================================
-- WebSocket
--=====================================================================
local WSConnect = WebSocket and WebSocket.connect

if not WSConnect then
    if messagebox then
        messagebox(
            ('AXION encountered an error while launching!\n\n%s'):format(
                'Potassium WebSocket.connect is unavailable in ' .. (identifyexecutor and identifyexecutor() or 'UNKNOWN')
            ),
            'AXION', 0
        )
    end
    return
end

--=====================================================================
-- Signal
--=====================================================================
local Signal = {}
Signal.__index = Signal

function Signal.new()
    return setmetatable({ _BindableEvent = Instance.new'BindableEvent' }, Signal)
end

function Signal:Connect(Callback)
    assert(typeof(Callback) == 'function', 'function expected, got ' .. typeof(Callback))
    return self._BindableEvent.Event:Connect(Callback)
end

function Signal:Fire(...)      self._BindableEvent:Fire(...) end
function Signal:Wait()          return self._BindableEvent.Event:Wait() end
function Signal:Disconnect()
    if self._BindableEvent then self._BindableEvent:Destroy() end
end

--=====================================================================
-- AXION core
--=====================================================================
AXION = {}
AXION.gamescope = CONFIG.gamescope
AXION.Connected       = Signal.new()
AXION.Disconnected    = Signal.new()
AXION.MessageReceived = Signal.new()

AXION.Commands    = {}
AXION.Connections = {}

AXION.ShutdownTime            = CONFIG.ShutdownTime
AXION.ShutdownOnTeleportError = CONFIG.ShutdownOnTeleportError

LocalPlayer.OnTeleport:Connect(function(State)
    if State == Enum.TeleportState.Started and AXION.IsConnected then
        AXION:Stop()
    end
end)

--=====================================================================
-- Methods
--=====================================================================
local function SendEncodedMessage(self, Message)
    assert(self.Socket ~= nil, 'websocket is nil')
    assert(self.IsConnected, 'websocket not connected')
    self.Socket:Send(Message)
end

function AXION:Send(Command, Payload)
    assert(self.Socket ~= nil, 'websocket is nil')
    assert(self.IsConnected, 'websocket not connected')
    assert(typeof(Command) == 'string', 'Command must be a string, got ' .. typeof(Command))
    assert(
        Command == 'ping'
            or Command == 'Log'
            or Command == 'SetPlaceId'
            or Command == 'SetJobId'
            or Command == 'Echo'
            or Command == 'InventoryUpdate',
        'Unsupported AXION command: ' .. Command
    )

    if Payload then
        assert(typeof(Payload) == 'table', 'Payload must be a table, got ' .. typeof(Payload))
    end

    local Message = HttpService:JSONEncode({
        Name = Command,
        Payload = Payload
    })
    assert(#Message <= MAX_MESSAGE_BYTES, 'AXION message exceeds the 16 KiB limit')
    SendEncodedMessage(self, Message)
end

local function InventoryValuesEqual(Left, Right, Compared)
    if Left == Right then
        return true
    end
    if typeof(Left) ~= typeof(Right) or typeof(Left) ~= 'table' then
        return false
    end

    Compared = Compared or {}
    Compared[Left] = Compared[Left] or {}
    if Compared[Left][Right] then
        return true
    end
    Compared[Left][Right] = true

    local LeftCount = 0
    for Key, Value in pairs(Left) do
        LeftCount += 1
        if Right[Key] == nil or not InventoryValuesEqual(Value, Right[Key], Compared) then
            return false
        end
    end
    local RightCount = 0
    for _ in pairs(Right) do
        RightCount += 1
    end
    return LeftCount == RightCount
end

local function CloneInventoryValue(Value, Clones)
    if typeof(Value) ~= 'table' then
        return Value
    end

    Clones = Clones or {}
    if Clones[Value] then
        return Clones[Value]
    end
    local Copy = {}
    Clones[Value] = Copy
    for Key, Child in pairs(Value) do
        Copy[Key] = CloneInventoryValue(Child, Clones)
    end
    return Copy
end

local function IsArrayTable(Value)
    local Count = 0
    local Maximum = 0
    for Key in pairs(Value) do
        if typeof(Key) ~= 'number' or Key % 1 ~= 0 or Key < 1 then
            return false
        end
        Count += 1
        if Key > Maximum then Maximum = Key end
    end
    return Count > 0 and Count == Maximum
end

local function ValidateInventoryState(Value, State, Depth, Active)
    State.nodes += 1
    assert(State.nodes <= MAX_INVENTORY_NODES, 'AXIONInventory contains too many values')
    assert(Depth <= 32, 'AXIONInventory nesting cannot exceed 32 levels')

    local ValueType = typeof(Value)
    if ValueType == 'string' then
        State.bytes += #Value
    elseif ValueType == 'number' then
        assert(Value == Value and Value ~= math.huge and Value ~= -math.huge, 'AXIONInventory numbers must be finite')
        State.bytes += 16
    elseif ValueType == 'boolean' then
        State.bytes += 5
    elseif ValueType == 'table' then
        assert(not Active[Value], 'AXIONInventory cannot contain cyclic tables')
        Active[Value] = true
        State.bytes += 16
        for Key, Child in pairs(Value) do
            local KeyType = typeof(Key)
            assert(KeyType == 'string' or KeyType == 'number', 'AXIONInventory table keys must be strings or numbers')
            State.nodes += 1
            State.bytes += KeyType == 'string' and #Key or 16
            ValidateInventoryState(Child, State, Depth + 1, Active)
        end
        Active[Value] = nil
    else
        error('AXIONInventory values must contain only JSON-compatible values')
    end

    assert(State.bytes <= MAX_INVENTORY_STATE_BYTES, 'AXIONInventory state exceeds the 64 KiB memory budget')
end

local function DiffInventoryValue(Previous, Current, Category, Name, Path, Changes)
    if InventoryValuesEqual(Previous, Current) then
        return
    end
    if #Path >= 32 then
        table.insert(Changes, {
            category = Category,
            name = Name,
            path = Path,
            value = Current,
        })
        return
    end

    if typeof(Previous) == 'table'
        and typeof(Current) == 'table'
        and IsArrayTable(Previous) == IsArrayTable(Current)
        and not IsArrayTable(Current) then
        local PreviousCount = 0
        local CurrentCount = 0
        for _ in pairs(Previous) do PreviousCount += 1 end
        for _ in pairs(Current) do CurrentCount += 1 end
        if PreviousCount == 0 and CurrentCount == 0 then
            table.insert(Changes, {
                category = Category,
                name = Name,
                path = Path,
                value = Current,
            })
            return
        end

        for Key, Value in pairs(Current) do
            local ChildPath = table.clone(Path)
            table.insert(ChildPath, tostring(Key))
            if Previous[Key] == nil then
                table.insert(Changes, {
                    category = Category,
                    name = Name,
                    path = ChildPath,
                    value = Value,
                })
            else
                DiffInventoryValue(Previous[Key], Value, Category, Name, ChildPath, Changes)
            end
        end
        for Key in pairs(Previous) do
            if Current[Key] == nil then
                local ChildPath = table.clone(Path)
                table.insert(ChildPath, tostring(Key))
                table.insert(Changes, {
                    category = Category,
                    name = Name,
                    path = ChildPath,
                    remove = true,
                })
            end
        end
        return
    end

    table.insert(Changes, {
        category = Category,
        name = Name,
        path = Path,
        value = Current,
    })
end

local function ApplyInventoryChange(Inventory, Change)
    local CategoryItems = Inventory[Change.category]
    if not CategoryItems then
        CategoryItems = {}
        Inventory[Change.category] = CategoryItems
    end

    if #Change.path == 0 then
        CategoryItems[Change.name] = CloneInventoryValue(Change.value)
        return
    end

    local Item = CategoryItems[Change.name]
    if typeof(Item) ~= 'table' then
        Item = {}
        CategoryItems[Change.name] = Item
    end
    local Parent = Item
    for Index = 1, #Change.path - 1 do
        local Key = Change.path[Index]
        if typeof(Parent[Key]) ~= 'table' then
            Parent[Key] = {}
        end
        Parent = Parent[Key]
    end
    local Key = Change.path[#Change.path]
    if Change.remove then
        Parent[Key] = nil
    else
        Parent[Key] = CloneInventoryValue(Change.value)
    end
end

local function BuildHeartbeatWorkspace(PreviousInventory)
    if typeof(getgenv) ~= 'function' then
        return nil, PreviousInventory, false
    end

    local GlobalEnvironment = getgenv()
    assert(typeof(GlobalEnvironment) == 'table', 'getgenv did not return a table')
    local SourceInventory = GlobalEnvironment.AXIONInventory
    if SourceInventory == nil then
        return nil, PreviousInventory, false
    end
    assert(typeof(SourceInventory) == 'table', 'getgenv().AXIONInventory must be a table')

    local Inventory = {}
    if #SourceInventory > 0 then
        for _, Item in ipairs(SourceInventory) do
            assert(typeof(Item) == 'table', 'AXIONInventory entries must be tables')
            local Name = Item.name or Item.Name
            assert(typeof(Name) == 'string' and Name ~= '' and #Name <= 80, 'AXIONInventory item name must contain 1-80 bytes')
            local Category = Item.category or Item.Category or 'materials'
            assert(IsValidInventoryCategory(Category), 'Invalid inventory category name: ' .. tostring(Category))
            local Quantity = Item.quantity or Item.Quantity or Item.count or Item.Count or 1
            assert(
                typeof(Quantity) == 'number'
                    and Quantity % 1 == 0
                    and Quantity >= 0
                    and Quantity <= 1000000000,
                'AXIONInventory item quantity must be an integer from 0 to 1000000000'
            )
            local ItemId = Item.itemId or Item.ItemId
            assert(ItemId == nil or (typeof(ItemId) == 'string' and #ItemId <= 128), 'AXIONInventory item ID must be a string up to 128 bytes')

            Inventory[Category] = Inventory[Category] or {}
            local ItemDetails = { quantity = Quantity, itemId = ItemId }
            local ItemValue = Item.value
            if ItemValue == nil then
                ItemValue = Item.Value
            end
            if ItemValue ~= nil then
                local ValueType = typeof(ItemValue)
                assert(
                    ValueType == 'string' or ValueType == 'number' or ValueType == 'boolean',
                    'AXIONInventory item value must be a string, number, or boolean'
                )
                ItemDetails.value = ItemValue
            end
            Inventory[Category][Name] = ItemDetails
        end
    else
        for Category, Items in pairs(SourceInventory) do
            assert(IsValidInventoryCategory(Category), 'Invalid inventory category name: ' .. tostring(Category))
            assert(typeof(Items) == 'table', 'AXIONInventory categories must contain item tables')
            Inventory[Category] = Items
        end
    end

    ValidateInventoryState(Inventory, { nodes = 0, bytes = 0 }, 0, {})

    local InventoryChanges = {}
    local RemovedInventory = {}
    local CurrentNames = {}
    local ItemCount = 0
    local CategoryCount = 0
    for Category, Items in pairs(Inventory) do
        CategoryCount += 1
        assert(CategoryCount <= MAX_INVENTORY_ITEMS, 'AXIONInventory is limited to 500 categories')
        local PreviousItems = PreviousInventory and PreviousInventory[Category]
        CurrentNames[Category] = {}
        for Name, Item in pairs(Items) do
            assert(typeof(Name) == 'string' and Name ~= '' and #Name <= 80, 'AXIONInventory item names must contain 1-80 bytes')
            ItemCount += 1
            assert(ItemCount <= MAX_INVENTORY_ITEMS, 'AXIONInventory is limited to 500 items')

            CurrentNames[Category][Name] = true
            if not PreviousItems or PreviousItems[Name] == nil then
                table.insert(InventoryChanges, {
                    category = Category,
                    name = Name,
                    path = {},
                    value = Item,
                })
            else
                DiffInventoryValue(PreviousItems[Name], Item, Category, Name, {}, InventoryChanges)
            end
        end
    end

    if PreviousInventory then
        for Category, PreviousItems in pairs(PreviousInventory) do
            for Name in pairs(PreviousItems) do
                if not CurrentNames[Category] or not CurrentNames[Category][Name] then
                    RemovedInventory[Category] = RemovedInventory[Category] or {}
                    table.insert(RemovedInventory[Category], Name)
                end
            end
        end
    end

    local Changed = PreviousInventory == nil
        or #InventoryChanges > 0
        or next(RemovedInventory) ~= nil
    if not Changed then
        return nil, nil, false, Inventory
    end

    local IsFullSnapshot = PreviousInventory == nil
    local CandidateInventory = IsFullSnapshot
        and Inventory
        or { changes = InventoryChanges, removed = RemovedInventory }
    return {
        customGameId = CONFIG.gamescope,
        accountId = tostring(LocalPlayer.UserId),
        world = 'Unknown',
        inventory = IsFullSnapshot and Inventory or {},
        inventoryDelta = not IsFullSnapshot,
        inventorySnapshot = IsFullSnapshot,
        inventoryChanges = not IsFullSnapshot and InventoryChanges or nil,
        inventoryRemoved = not IsFullSnapshot and next(RemovedInventory) and RemovedInventory or nil,
    }, CandidateInventory, IsFullSnapshot, Inventory
end

function AXION:SetPlaceId(PlaceId)  self:Send('SetPlaceId', { Content = PlaceId }) end
function AXION:SetJobId(JobId)      self:Send('SetJobId',   { Content = JobId })   end
function AXION:Echo(Message)        self:Send('Echo',       { Content = Message }) end

function AXION:ReportWorkspace(Data)
    assert(typeof(Data) == 'table', 'Data must be a table')
    Data.customGameId = Data.customGameId or CONFIG.gamescope
    Data.accountId = tostring(Data.accountId or LocalPlayer.UserId)
    Data.world = Data.world or "Unknown"
    Data.profile = Data.profile or {}
    Data.worldProgress = Data.worldProgress or {}
    Data.inventory = Data.inventory or {}

    assert(typeof(Data.customGameId) == 'string' and Data.customGameId ~= '', 'customGameId must be a non-empty string')
    assert(typeof(Data.accountId) == 'string' and Data.accountId ~= '', 'accountId must be a non-empty string')
    assert(typeof(Data.world) == 'string' and Data.world ~= '', 'world must be a non-empty string')
    assert(typeof(Data.profile) == 'table', 'profile must be a table')
    assert(typeof(Data.worldProgress) == 'table', 'worldProgress must be a table')
    assert(typeof(Data.inventory) == 'table', 'inventory must be a table')
    for Category in pairs(Data.inventory) do
        assert(
            IsValidInventoryCategory(Category),
            'Invalid inventory category name: ' .. tostring(Category)
        )
    end

    self:Send('InventoryUpdate', Data)
end

function AXION:ReportInventory(Items)
    assert(typeof(Items) == 'table', 'Items must be a table')
    local Materials = {}
    for _, Item in pairs(Items) do
        if typeof(Item) == 'table' then
            local Name = Item.name or Item.Name
            local Quantity = Item.quantity or Item.Quantity or Item.count or Item.Count or 1
            if typeof(Name) == 'string' and Name ~= '' then
                Materials[Name] = { quantity = Quantity, itemId = Item.itemId or Item.ItemId }
            end
        end
    end
    self:ReportWorkspace({
        inventory = { materials = Materials }
    })
end

function AXION:Fetch(FunctionName, Arguments, Token)
    assert(typeof(FunctionName) == 'string' and FunctionName ~= '', 'FunctionName must be a non-empty string')
    assert(typeof(Token) == 'string' and Token ~= '', 'Token must be a non-empty string')

    local RequestBody = HttpService:JSONEncode({
        functionName = FunctionName,
        customGameId = CONFIG.gamescope,
        args = Arguments or {}
    })
    assert(#RequestBody <= MAX_MESSAGE_BYTES, 'Server Scripts request exceeds the 16 KiB body limit')

    local RequestOptions = {
        Url = 'http://localhost:' .. tostring(CONFIG.ScriptApiPort) .. '/api/v1/call',
        Method = 'POST',
        Headers = {
            ['Content-Type'] = 'application/json',
            ['Authorization'] = 'Bearer ' .. Token
        },
        Body = RequestBody
    }
    assert(typeof(request) == 'function', 'Potassium request API is unavailable')
    local Response = request(RequestOptions)

    assert(typeof(Response) == 'table', 'HTTP request did not return a response table')
    local StatusCode = tonumber(Response.StatusCode)
    local Success = Response.Success
    local Body = Response.Body
    assert(typeof(Body) == 'string', 'HTTP response did not include a body')
    assert(#Body <= MAX_MESSAGE_BYTES, 'Server Scripts response exceeds the 16 KiB body limit')
    local Decoded = HttpService:JSONDecode(Body)
    assert(typeof(Decoded) == 'table', 'Server Scripts response was not a JSON object')
    if not Success or Decoded.ok ~= true then
        error(Decoded.error or ('Server Scripts request failed with HTTP ' .. tostring(StatusCode or 'unknown status')))
    end
    return Decoded.result
end

function AXION:FetchOnlineInventory(Token, AgentId)
    assert(typeof(Token) == 'string' and Token ~= '', 'Token must be a non-empty string')
    assert(AgentId == nil or typeof(AgentId) == 'string', 'AgentId must be a string')

    local Arguments = {}
    if AgentId ~= nil then
        Arguments.agentId = AgentId
    end
    return self:Fetch('get_online_inventory', Arguments, Token)
end

function AXION:FetchAsync(FunctionName, Arguments, Token, Callback)
    assert(typeof(Callback) == 'function', 'Callback must be a function')
    return task.spawn(function()
        local Success, Result = pcall(self.Fetch, self, FunctionName, Arguments, Token)
        local CallbackSuccess, CallbackError
        if Success then
            CallbackSuccess, CallbackError = pcall(Callback, Result, nil)
        else
            CallbackSuccess, CallbackError = pcall(Callback, nil, Result)
        end
        if not CallbackSuccess then
            NativePrint('[AXION] FetchAsync callback error:', tostring(CallbackError))
        end
    end)
end

function AXION:Log(...)
    local T = {}
    for _, Value in pairs{ ... } do
        table.insert(T, tostring(Value))
    end
    self:Send('Log', { Content = table.concat(T, ' ') })

    if CONFIG.Debug then
        NativePrint('[AXION]', ...)
    end
end

function AXION:Connect(Host, Bypass)
    if not Bypass and (self.IsConnected or self.Connecting) then
        return 'Ignoring connection request, AXION is already connected or connecting'
    end

    Host = Host or ('localhost:' .. tostring(CONFIG.WebSocketHost))
    self.Connecting = true

    while true do
        if self.Terminated then break end

        local Success, Socket = pcall(WSConnect,
            ('ws://%s/AXION?name=%s&id=%s&jobId=%s'):format(
                Host, LocalPlayer.Name, LocalPlayer.UserId, game.JobId
            )
        )

        if not Success then
            if CONFIG.Debug then
                NativePrint('[AXION] WebSocket connection failed:', tostring(Socket))
            end
            break
        end

        self.Socket      = Socket
        self.IsConnected = true

        table.insert(self.Connections, Socket.OnMessage:Connect(function(Message)
            local IsPong = Message == 'pong'
            if not IsPong then
                local Decoded, Packet = pcall(HttpService.JSONDecode, HttpService, Message)
                IsPong = Decoded and typeof(Packet) == 'table' and Packet.Name == 'pong'
            end
            if not IsPong then
                self.MessageReceived:Fire(Message)
            end
        end))

        table.insert(self.Connections, Socket.OnClose:Connect(function()
            if self.Socket == Socket and self.IsConnected then
                self.IsConnected = false
                self.Disconnected:Fire()
            end
        end))

        self.Connected:Fire()
        self:SetPlaceId(game.PlaceId)

        local LastReportedInventory
        while self.IsConnected do
            local HeartbeatPayload
            local CandidateInventory
            local IsFullSnapshot = false
            local FullInventory
            local FullSnapshotFallback
            local InventoryChanged = false
            local PayloadSuccess, PayloadResult, PendingInventory, IsSnapshot, CurrentInventory =
                pcall(BuildHeartbeatWorkspace, LastReportedInventory)
            if PayloadSuccess then
                HeartbeatPayload = PayloadResult
                CandidateInventory = PendingInventory
                IsFullSnapshot = IsSnapshot
                InventoryChanged = PendingInventory ~= nil
                FullInventory = CurrentInventory
            else
                NativePrint('[AXION] Could not prepare inventory heartbeat:', tostring(PayloadResult))
            end

            local EncodedHeartbeat
            local EncodeSuccess, EncodeResult = pcall(HttpService.JSONEncode, HttpService, {
                Name = 'ping',
                Payload = HeartbeatPayload,
            })
            if EncodeSuccess and #EncodeResult <= MAX_MESSAGE_BYTES then
                EncodedHeartbeat = EncodeResult
            elseif HeartbeatPayload then
                if HeartbeatPayload.inventoryDelta then
                    local FullSnapshot = {
                        customGameId = HeartbeatPayload.customGameId,
                        accountId = HeartbeatPayload.accountId,
                        world = HeartbeatPayload.world,
                        inventory = FullInventory,
                        inventorySnapshot = true,
                    }
                    local SnapshotSuccess, EncodedSnapshot = pcall(HttpService.JSONEncode, HttpService, {
                        Name = 'ping',
                        Payload = FullSnapshot,
                    })
                    if SnapshotSuccess and #EncodedSnapshot <= MAX_MESSAGE_BYTES then
                        HeartbeatPayload = FullSnapshot
                        EncodedHeartbeat = EncodedSnapshot
                        FullSnapshotFallback = FullInventory
                    end
                end
                if not EncodedHeartbeat then
                    NativePrint('[AXION] Inventory cannot fit in the heartbeat message; sending heartbeat without inventory')
                    HeartbeatPayload = nil
                    InventoryChanged = false
                end
            else
                NativePrint('[AXION] Could not encode heartbeat:', tostring(EncodeResult))
                break
            end

            if not EncodedHeartbeat then
                local EncodeSuccess, EncodeResult = pcall(HttpService.JSONEncode, HttpService, {
                    Name = 'ping',
                })
                if not EncodeSuccess then
                    NativePrint('[AXION] Could not encode heartbeat:', tostring(EncodeResult))
                    break
                end
                EncodedHeartbeat = EncodeResult
            end
            local PingSuccess, PingError = pcall(SendEncodedMessage, self, EncodedHeartbeat)
            if not PingSuccess then
                if CONFIG.Debug then
                    NativePrint('[AXION] WebSocket heartbeat send failed:', tostring(PingError))
                end
                break
            end
            if HeartbeatPayload and InventoryChanged then
                if IsFullSnapshot then
                    LastReportedInventory = CloneInventoryValue(CandidateInventory)
                elseif FullSnapshotFallback then
                    LastReportedInventory = CloneInventoryValue(FullSnapshotFallback)
                else
                    for _, Change in ipairs(CandidateInventory.changes) do
                        ApplyInventoryChange(LastReportedInventory, Change)
                    end
                    for Category, Names in pairs(CandidateInventory.removed) do
                        local Items = LastReportedInventory[Category]
                        if Items then
                            for _, Name in ipairs(Names) do
                                Items[Name] = nil
                            end
                            if next(Items) == nil then
                                LastReportedInventory[Category] = nil
                            end
                        end
                    end
                end
            end
            if self.Terminated then break end
            task.wait(CONFIG.HeartbeatInterval)
        end

        if self.IsConnected then
            self.IsConnected = false
            self.Disconnected:Fire()
        end
        if self.Socket == Socket then
            self.Socket = nil
        end
        for _, Connection in pairs(self.Connections) do
            Connection:Disconnect()
        end
        table.clear(self.Connections)
        pcall(function() Socket:Close() end)
        break
    end

    self.Connecting = false
end

function AXION:Stop()
    self.IsConnected = false
    self.Terminated  = true
    self.Disconnected:Fire()

    if self.Socket then
        pcall(function() self.Socket:Close() end)
    end
end

function AXION:AddCommand(Name, Function)    self.Commands[Name] = Function end
function AXION:RemoveCommand(Name)           self.Commands[Name] = nil      end

AXION.MessageReceived:Connect(function(Message)
    local S = Message:find(' ')

    if S then
        local Command, Msg = Message:sub(1, S - 1):lower(), Message:sub(S + 1)
        if AXION.Commands[Command] then
            local Success, Error = pcall(AXION.Commands[Command], Msg)
            if not Success and Error then
                AXION:Log(('Error with command `%s`: %s'):format(Command, Error))
            end
        end
    elseif AXION.Commands[Message] then
        local Success, Error = pcall(AXION.Commands[Message], Message)
        if not Success and Error then
            AXION:Log(('Error with command `%s`: %s'):format(Message, Error))
        end
    end
end)

--=====================================================================
-- Default Commands
--=====================================================================
AXION:AddCommand('execute', function(Message)
    local function Report(Text)
        pcall(function()
            AXION:Send('Log', { Content = Text })
        end)
    end

    Report('Execute command received')
    local Function, Error = loadstring(Message)

    if Function then
        local OriginalEnv = getfenv(Function)
        local Env = setmetatable({
            Player = LocalPlayer,
            print = function(...)
                local T = {}
                for _, Value in pairs{ ... } do
                    table.insert(T, tostring(Value))
                end
                NativePrint(...)
                Report(table.concat(T, ' '))
            end
        }, { __index = OriginalEnv })
        setfenv(Function, Env)

        local S, E = pcall(Function)
        if S then
            Report('Execute completed')
        else
            NativePrint('[AXION execute error]', E)
            Report(tostring(E))
        end
    else
        NativePrint('[AXION compile error]', Error)
        Report(tostring(Error))
    end
end)

AXION:AddCommand('teleport', function(Message)
    local S = Message:find(' ')
    local PlaceId, JobId = S and Message:sub(1, S - 1) or Message, S and Message:sub(S + 1)

    if JobId then
        TeleportService:TeleportToPlaceInstance(tonumber(PlaceId), JobId)
    else
        TeleportService:Teleport(tonumber(PlaceId))
    end
end)

AXION:AddCommand('rejoin', function()
    TeleportService:TeleportToPlaceInstance(game.PlaceId, game.JobId)
end)

AXION:AddCommand('mute', function()
    if (UGS.MasterVolume - OldVolume) > 0.01 then
        OldVolume = UGS.MasterVolume
    end
    UGS.MasterVolume = 0
end)

AXION:AddCommand('unmute', function()
    UGS.MasterVolume = OldVolume
end)

AXION:AddCommand('performance', function(Message)
    if _PERF then return end

    _PERF = true
    _TARGETFPS = tonumber(Message) or CONFIG.DefaultFPS

    local OldLevel = settings().Rendering.QualityLevel

    RunService:Set3dRenderingEnabled(false)
    settings().Rendering.QualityLevel = 1

    InputService.WindowFocused:Connect(function()
        RunService:Set3dRenderingEnabled(true)
        settings().Rendering.QualityLevel = OldLevel
        setfpscap(CONFIG.NormalFPS)
    end)

    InputService.WindowFocusReleased:Connect(function()
        OldLevel = settings().Rendering.QualityLevel
        RunService:Set3dRenderingEnabled(false)
        settings().Rendering.QualityLevel = 1
        setfpscap(_TARGETFPS)
    end)

    setfpscap(_TARGETFPS)
end)

--=====================================================================
-- Shutdown handling
--=====================================================================
GuiService.ErrorMessageChanged:Connect(function()
    if NoShutdown then return end

    local Code = GuiService:GetErrorCode().Value

    if Code >= Enum.ConnectionError.DisconnectErrors.Value then
        if not AXION.ShutdownOnTeleportError 
           and Code > Enum.ConnectionError.PlacelaunchOtherError.Value then
            return
        end
        task.delay(AXION.ShutdownTime, game.Shutdown, game)
    end
end)

--=====================================================================
-- Export & auto-connect
--=====================================================================
local GEnv = getgenv()
GEnv.AXION       = AXION
GEnv.performance = AXION.Commands.performance

if CONFIG.AutoConnect and not AXION_Version then
    AXION:Connect()
end