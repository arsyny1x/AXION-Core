import { useLayoutEffect, useState } from "react";
import { BookOpen, Check, Copy, Database, FileCode2, Link2, Settings, ShieldAlert, Wifi, Zap } from "lucide-react";
import { useLanguage } from "../i18n/LanguageContext";
import { SyntaxCodeBlock, type SyntaxLanguage } from "./SyntaxCode";

type DocsSection = "start" | "client" | "scripts" | "workspace" | "protocol" | "config" | "errors";

const SECTIONS: Array<{ id: DocsSection; icon: typeof BookOpen }> = [
  { id: "start", icon: Zap },
  { id: "client", icon: BookOpen },
  { id: "scripts", icon: FileCode2 },
  { id: "workspace", icon: Database },
  { id: "protocol", icon: Wifi },
  { id: "config", icon: Settings },
  { id: "errors", icon: ShieldAlert },
];

const TOKEN = "YOUR_64_CHARACTER_API_TOKEN";
const FIND_ITEM_SERVER_SCRIPT = `return {
  find_item = function(args)
    args = args or {}
    local query = args.query or ""
    local includeOffline = args.includeOffline == true
    local matches = Server.Items.search(query, includeOffline)

    return {
      customGameId = Server.Game.customGameId,
      count = #matches,
      items = matches
    }
  end
}`;
const ONLINE_INVENTORY_SERVER_SCRIPT = `return {
  get_online_inventory = function(args)
    args = args or {}
    local items = Server.Items.getOnline(args.agentId)
    return {
      customGameId = Server.Game.customGameId,
      count = #items,
      items = items,
    }
  end
}`;

interface Parameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface ClientMethod {
  name: string;
  signature: string;
  description: string;
  params: Parameter[];
  returns: string;
  example: string;
  setupExample?: string;
  errors: string;
  related: string[];
}

const CLIENT_METHODS: ClientMethod[] = [
  {
    name: "AXION:Connect",
    signature: "AXION:Connect(host?, bypass?) -> string?",
    description: "Attempts one WebSocket connection. On startup the bundled API calls this only when CONFIG.AutoConnect is true and AXION_Version is not set. Without an explicit host, it connects to localhost using CONFIG.WebSocketHost as the port. A successful connection starts the heartbeat loop; this method does not retry after a disconnect.",
    params: [
      { name: "host", type: "string", required: false, description: "Optional complete WebSocket host. By default, the client connects to localhost using CONFIG.WebSocketHost as the port (5242 in the bundled API)." },
      { name: "bypass", type: "boolean", required: false, description: "When true, skip the already-connected/connecting guard. Does not add reconnect behavior." },
    ],
    returns: "string when a connection is already active/starting and bypass is false; otherwise nil after the attempt or connection loop ends. A successful connection waits in the heartbeat loop until disconnected.",
    example: `if AXION.IsConnected or AXION.Connecting then
  print("AXION is already connected or connecting")
else
  task.spawn(function()
    local message = AXION:Connect("localhost:5242")
    if message then
      print(message)
    else
      print("AXION connection attempt ended")
    end
  end)
end`,
    errors: "The second call while connected or connecting returns a message unless bypass is true. The WebSocket connect error is caught internally and printed only when CONFIG.Debug is true. Socket-send failures stop the loop; there is no automatic reconnect.",
    related: ["AXION:Stop", "AXION.Connected", "AXION.Disconnected"],
  },
  {
    name: "AXION:Stop",
    signature: "AXION:Stop() -> nil",
    description: "Stops heartbeat sending, marks the client terminated, fires the Disconnected signal even if already disconnected, and closes the current socket if one exists.",
    params: [],
    returns: "nil.",
    example: `if AXION.IsConnected then
  AXION:Stop()
  print("AXION connection stopped")
else
  print("AXION is not connected")
end`,
    errors: "Socket close errors are caught internally. Disconnected is fired even if the client is already disconnected.",
    related: ["AXION:Connect", "AXION.Disconnected"],
  },
  {
    name: "AXION:Send",
    signature: "AXION:Send(command, payload?) -> nil",
    description: "Sends one JSON message to the local WebSocket listener. This is a one-way protocol operation; there is no request ID or correlated response.",
    params: [
      { name: "command", type: "string", required: true, description: "One of: ping, Log, SetPlaceId, SetJobId, Echo, InventoryUpdate." },
      { name: "payload", type: "table", required: false, description: "JSON-compatible payload for the selected message. ping may omit it." },
    ],
    returns: "nil.",
    example: `local ok, err = pcall(function()
  AXION:Send("Echo", { Content = "hello from AXION" })
end)
if ok then
  print("Echo message sent")
else
  warn("Could not send AXION message:", err)
end`,
    errors: "Raises when the socket is unavailable, the client is disconnected, the command is not allowlisted, the payload is not a table, JSON encoding fails, or the encoded message exceeds 16 KiB.",
    related: ["AXION:Echo", "AXION:Log", "AXION:ReportWorkspace"],
  },
  {
    name: "AXION:Log",
    signature: "AXION:Log(...) -> nil",
    description: "Converts arguments to text, joins them with spaces, and sends a Log message. It also prints to the local executor console when CONFIG.Debug is true.",
    params: [
      { name: "...", type: "any", required: false, description: "Values converted with tostring and joined by spaces." },
    ],
    returns: "nil.",
    example: `local level = 42
AXION:Log("Example status", "level =", level)`,
    errors: "Raises the same send errors as AXION:Send when disconnected, encoding fails, or the message exceeds 16 KiB.",
    related: ["AXION:Send"],
  },
  {
    name: "AXION:Echo",
    signature: "AXION:Echo(message) -> nil",
    description: "Convenience wrapper that sends an Echo message with the supplied value in Payload.Content. AXION emits it as a UI event; it does not return a reply to the client.",
    params: [
      { name: "message", type: "any", required: true, description: "Value serialized as Payload.Content." },
    ],
    returns: "nil.",
    example: `local ok, err = pcall(function()
  AXION:Echo("example event")
end)
if not ok then warn("Echo failed:", err) end`,
    errors: "Raises the same send errors as AXION:Send.",
    related: ["AXION:Send"],
  },
  {
    name: "AXION:SetPlaceId",
    signature: "AXION:SetPlaceId(placeId) -> nil",
    description: "Reports a place identifier for the currently connected Agent. This updates the live session used by workspace reports; it is not a standalone workspace write.",
    params: [
      { name: "placeId", type: "string | number", required: true, description: "Place identifier. The backend accepts a string or JSON number in Content." },
    ],
    returns: "nil.",
    example: `local placeId = game.PlaceId
AXION:SetPlaceId(placeId)
print("Reported place:", placeId)`,
    errors: "Raises the same send errors as AXION:Send. The helper does not validate placeId before serialization.",
    related: ["AXION:SetJobId", "AXION:ReportWorkspace"],
  },
  {
    name: "AXION:SetJobId",
    signature: "AXION:SetJobId(jobId) -> nil",
    description: "Reports a job identifier for the currently connected Agent. This updates live session context used by later workspace reports.",
    params: [
      { name: "jobId", type: "string | number", required: true, description: "Job identifier. The backend accepts a string or JSON number in Content." },
    ],
    returns: "nil.",
    example: `local jobId = game.JobId
AXION:SetJobId(jobId)
print("Reported job:", jobId)`,
    errors: "Raises the same send errors as AXION:Send. The helper does not validate jobId before serialization.",
    related: ["AXION:SetPlaceId", "AXION:ReportWorkspace"],
  },
  {
    name: "AXION:ReportWorkspace",
    signature: "AXION:ReportWorkspace(data) -> nil",
    description: "Sends an InventoryUpdate over WebSocket. AXION validates and stores the report in the local workspace database under its customGameId/accountId. Inventory categories are dynamic: include a new valid category key and AXION creates it automatically. Supply only data your integration can actually read.",
    params: [
      { name: "data", type: "table", required: true, description: "Fields: customGameId, accountId, world, profile, worldProgress, inventory. Inventory category keys can be custom names containing 1-64 Unicode characters; emoji are supported, but spaces and control characters are not. ASCII names may use letters, digits, underscores, or hyphens. customGameId defaults from CONFIG, accountId to LocalPlayer.UserId, and world to 'Unknown'; profile/worldProgress/inventory default to empty tables." },
    ],
    returns: "nil. Persistence is confirmed only when AXION accepts the report; this one-way API does not return a save acknowledgement.",
    example: `local players = game:GetService("Players")
local localPlayer = players.LocalPlayer

local ok, err = pcall(function()
  AXION:ReportWorkspace({
    customGameId = AXION.gamescope,
    accountId = tostring(localPlayer.UserId) .. "_DOCS_TEST",
    world = "Example World",
    profile = { note = "Replace with data read by your integration" },
    worldProgress = {
      ["Example World"] = { visited = true }
    },
    inventory = {
      fruits = { Dragon = { quantity = 1 } },
      materials = { ["Example Material"] = { quantity = 3 } },
      pets = { ["Example Pet"] = { quantity = 1, itemId = "pet-001" } }
    }
  })
end)

if ok then
  print("Workspace report sent; confirm it in AXION > Server Scripts")
else
  warn("Workspace report failed:", err)
end`,
    errors: "Raises for non-table input, invalid top-level or inventory category types, disconnection, JSON encoding/send failures, or a message larger than 16 KiB. The client does not wait for backend validation or persistence acknowledgement. The default profile is {}, so omitting profile clears the stored profile.",
    related: ["AXION:ReportInventory", "AXION:SetPlaceId", "AXION:SetJobId", "Server.Items.search"],
  },
  {
    name: "AXION:ReportInventory",
    signature: "AXION:ReportInventory(items) -> nil",
    description: "Compatibility helper that converts a list of item records into the materials category and calls ReportWorkspace. It reports under LocalPlayer.UserId and supplies no profile.",
    params: [
      { name: "items", type: "table[]", required: true, description: "List entries may use name/Name, quantity/Quantity/count/Count, and itemId/ItemId. Entries without a non-empty string name are ignored." },
    ],
    returns: "nil. AXION persists the report asynchronously; this API does not return a save acknowledgement.",
    example: `local ok, err = pcall(function()
  AXION:ReportInventory({
    { name = "Example Item", quantity = 2, itemId = "example-item" },
    { name = "Another Item", quantity = 1 }
  })
end)

if ok then
  print("Inventory report sent")
else
  warn("Inventory report failed:", err)
end`,
    errors: "Raises for non-table input, connection/send failures, or message-size errors. Entries that are not tables or do not have a non-empty string name are ignored; backend validation is asynchronous and has no client acknowledgement. This helper targets the current LocalPlayer account and resets its saved profile to {} because the profile is omitted; use ReportWorkspace when you need an isolated accountId or to retain profile data.",
    related: ["AXION:ReportWorkspace"],
  },
  {
    name: "AXION:Fetch",
    signature: "AXION:Fetch(functionName, arguments?, token) -> JSON value",
    description: "Calls a named export from a saved Server Script through HTTP POST to localhost:CONFIG.ScriptApiPort. The request includes CONFIG.gamescope automatically. It is not a WebSocket request.",
    params: [
      { name: "functionName", type: "string", required: true, description: "Name of an exported function in a saved Server Script." },
      { name: "arguments", type: "table", required: false, description: "JSON-compatible function arguments; defaults to {}." },
      { name: "token", type: "string", required: true, description: "64-character hexadecimal API token shown in AXION > Server Scripts." },
    ],
    returns: "The exported function's JSON-compatible result. A Lua nil result is returned as JSON null and decodes to the executor's JSON null representation.",
    setupExample: FIND_ITEM_SERVER_SCRIPT,
    example: `-- First save the Server Script shown below in AXION > Server Scripts.
local token = "${TOKEN}" -- Replace with the token shown in AXION.
local ok, result = pcall(function()
  return AXION:Fetch("find_item", {
    query = "Example Item",
    includeOffline = true
  }, token)
end)

if not ok then
  warn("Fetch failed:", result)
  return
end

print("Scope:", result.customGameId)
print("Matches:", result.count)
for _, item in ipairs(result.items) do
  print(item.playerName, item.itemName, item.quantity, item.online)
end`,
    errors: "Raises for an empty/invalid function name or token type, missing executor request support, HTTP errors (including invalid token, function not found, rate limit, and timeout), invalid JSON, or a request/response over 16 KiB. Token validity is checked by the server. Calls are limited to one every 500 ms; the server-side execution timeout is 5 seconds.",
    related: ["AXION:FetchAsync", "Server.Items.search", "Server.Game.customGameId"],
  },
  {
    name: "AXION:FetchAsync",
    signature: "AXION:FetchAsync(functionName, arguments?, token, callback) -> thread",
    description: "Runs AXION:Fetch in a task and calls the callback once. Use it instead of a synchronous HTTP wait in frame-sensitive code.",
    params: [
      { name: "functionName", type: "string", required: true, description: "Name of an exported function in a saved Server Script." },
      { name: "arguments", type: "table", required: false, description: "JSON-compatible function arguments; defaults to {}." },
      { name: "token", type: "string", required: true, description: "64-character hexadecimal API token shown in AXION > Server Scripts." },
      { name: "callback", type: "function", required: true, description: "Called with (result, nil) on success or (nil, error) on failure." },
    ],
    returns: "The thread returned by task.spawn. The callback receives the exported function's result and nil, or nil and the error.",
    setupExample: FIND_ITEM_SERVER_SCRIPT,
    example: `-- First save the Server Script shown below in AXION > Server Scripts.
local token = "${TOKEN}" -- Replace with the token shown in AXION.
local thread = AXION:FetchAsync("find_item", {
  query = "Example Item",
  includeOffline = true
}, token, function(result, err)
  if err then
    warn("FetchAsync failed:", err)
    return
  end

  print("Matches:", result.count)
  for _, item in ipairs(result.items) do
    print(item.playerName, item.itemName, item.quantity)
  end
end)
print("Request task:", thread)`,
    errors: "A non-function callback raises before starting the task. Fetch failures are passed as the callback's second argument. Errors thrown by the callback are printed by the API.",
    related: ["AXION:Fetch"],
  },
  {
    name: "AXION:FetchOnlineInventory",
    signature: "AXION:FetchOnlineInventory(token, agentId?) -> InventoryResult",
    description: "Fetches online inventory from the get_online_inventory Server Script export in CONFIG.gamescope. Inventory assigned to getgenv().AXIONInventory is sent automatically with WebSocket heartbeats and is not part of this HTTP fetch.",
    params: [
      { name: "token", type: "string", required: true, description: "64-character hexadecimal API token shown in AXION > Server Scripts." },
      { name: "agentId", type: "string", required: false, description: "Optional Agent ID to limit the result to one online Agent." },
    ],
    returns: "The JSON-compatible result returned by the get_online_inventory Server Script export.",
    setupExample: ONLINE_INVENTORY_SERVER_SCRIPT,
    example: `local token = "${TOKEN}" -- Replace with the token shown in AXION.
local ok, inventory = pcall(function()
  return AXION:FetchOnlineInventory(token)
end)

if not ok then
  warn("Online inventory fetch failed:", inventory)
  return
end

print("Scope:", inventory.customGameId)
print("Items:", inventory.count)
for _, item in ipairs(inventory.items) do
  print(item.playerName, item.itemName, item.quantity)
end`,
    errors: "Raises if the named Server Script export is not saved in the configured scope, the token/request is invalid, or the result exceeds the 16 KiB response limit.",
    related: ["AXION:Fetch", "Server.Items.getOnline", "CONFIG.gamescope"],
  },
  {
    name: "AXION:AddCommand",
    signature: "AXION:AddCommand(name, callback) -> nil",
    description: "Registers a handler for an incoming plain-text command. When a message includes a payload, the dispatcher lowercases the command name and passes the remaining text as one string; a message without a space is looked up verbatim. It is not JSON-RPC.",
    params: [
      { name: "name", type: "string", required: true, description: "Command key; use lowercase to match the dispatcher's normalized name." },
      { name: "callback", type: "function", required: true, description: "Handler called with the command's text payload." },
    ],
    returns: "nil.",
    example: `local commandName = "docs_status"
AXION:AddCommand(commandName, function(message)
  print("Received:", message)
end)

-- Local self-test; the app does not expose a custom command sender.
AXION.Commands[commandName]("copy-paste test")
AXION:RemoveCommand(commandName)`,
    errors: "A callback error is caught by the dispatcher and reported through AXION:Log. Registering the same name replaces the existing handler, including a built-in handler.",
    related: ["AXION:RemoveCommand", "AXION.MessageReceived", "AXION:Log"],
  },
  {
    name: "AXION:RemoveCommand",
    signature: "AXION:RemoveCommand(name) -> nil",
    description: "Removes the command handler stored under the specified key. Removing a built-in command disables its handler for this API instance.",
    params: [
      { name: "name", type: "string", required: true, description: "Command key previously registered in AXION.Commands." },
    ],
    returns: "nil.",
    example: `local commandName = "docs_temporary"
AXION:AddCommand(commandName, function(message)
  print("Received:", message)
end)

AXION:RemoveCommand(commandName)
print("Handler removed:", AXION.Commands[commandName] == nil)`,
    errors: "No error is raised when the key is absent. Avoid removing built-in command handlers unless that change is intentional.",
    related: ["AXION:AddCommand"],
  },
  {
    name: "performance",
    signature: "performance(fps?) -> nil",
    description: "Global alias for the built-in AXION performance command. Disables 3D rendering and lowers graphics quality until the window regains focus; on focus it restores rendering and uses CONFIG.NormalFPS.",
    params: [
      { name: "fps", type: "string | number", required: false, description: "Target FPS cap while unfocused. Invalid/omitted input falls back to CONFIG.DefaultFPS." },
    ],
    returns: "nil. Subsequent calls are ignored after the first call in the current API instance.",
    example: `if type(performance) == "function" then
  performance("8")
  print("Performance mode enabled; focus the window to restore rendering")
else
  warn("The AXION performance alias is not available")
end`,
    errors: "Calls executor-specific settings(), RunService:Set3dRenderingEnabled, and setfpscap functions. Those calls may raise if the runtime does not provide them; no error is caught by this handler.",
    related: ["CONFIG.DefaultFPS", "CONFIG.NormalFPS"],
  },
];

interface ServerMethod {
  name: string;
  signature: string;
  description: string;
  params: Parameter[];
  returns: string;
  serverExample: string;
  clientExample: string;
  errors: string;
  related: string[];
}

const SERVER_METHODS: ServerMethod[] = [
  {
    name: "Server.Items.search",
    signature: "Server.Items.search(query, includeOffline?) -> ItemMatch[]",
    description: "Searches cached inventory item names in the current Server Script's customGameId scope. Matching is case-insensitive substring search; an empty/whitespace query returns an empty array.",
    params: [
      { name: "query", type: "string", required: true, description: "Text to find in an item name." },
      { name: "includeOffline", type: "boolean", required: false, description: "Include cached inventories for disconnected agents only when exactly true; default false." },
    ],
    returns: "Array of { playerId: string, accountId: string, customGameId: string, playerName: string, itemName: string, itemId: string | null, category: string, quantity: number, value?: string | number | boolean, online: boolean, updatedAt: number }. updatedAt is Unix time in milliseconds.",
    serverExample: FIND_ITEM_SERVER_SCRIPT,
    clientExample: `local token = "${TOKEN}" -- Replace with the token shown in AXION.
local ok, result = pcall(function()
  return AXION:Fetch("find_item", {
    query = "Example Item",
    includeOffline = true
  }, token)
end)

if not ok then
  warn("Item search failed:", result)
  return
end

for _, item in ipairs(result.items) do
  print(item.playerName, item.accountId, item.itemName, item.quantity, item.category)
end`,
    errors: "Throws if query is not a string. Fetch also fails if the function is not saved/exported, the token is invalid, the HTTP request is rate-limited, or a Server Script times out.",
    related: ["Server.Game.customGameId", "Server.Players.isOnline", "AXION:Fetch"],
  },
  {
    name: "Server.Items.getOnline",
    signature: "Server.Items.getOnline(agentId?) -> ItemMatch[]",
    description: "Returns cached inventory item records for currently connected Agents in the current Server Script's customGameId scope.",
    params: [
      { name: "agentId", type: "string", required: false, description: "Optional Agent ID used to filter the results to one online Agent." },
    ],
    returns: "An array with the same item record shape as Server.Items.search; empty when no matching online inventory is available.",
    serverExample: ONLINE_INVENTORY_SERVER_SCRIPT,
    clientExample: `local token = "${TOKEN}" -- Replace with the token shown in AXION.
local ok, inventory = pcall(function()
  return AXION:FetchOnlineInventory(token)
end)

if not ok then
  warn("Online inventory fetch failed:", inventory)
  return
end

print(inventory.customGameId, inventory.count)
for _, item in ipairs(inventory.items) do
  print(item.playerName, item.itemName, item.quantity, item.online)
end`,
    errors: "Throws if agentId is provided but is not a string. Fetch can also fail if the result exceeds 16 KiB.",
    related: ["Server.Items.search", "Server.Players.isOnline", "AXION:FetchOnlineInventory"],
  },
  {
    name: "Server.Players.isOnline",
    signature: "Server.Players.isOnline(playerId) -> boolean",
    description: "Returns true only when the Agent is connected and has a cached workspace/inventory in this script's customGameId scope. An online Agent without a workspace report returns false.",
    params: [
      { name: "playerId", type: "string", required: true, description: "Agent ID from the AXION WebSocket handshake; not an arbitrary account display name." },
    ],
    returns: "boolean.",
    serverExample: `return {
  check_online = function(args)
    args = args or {}
    local playerId = args.playerId
    if type(playerId) ~= "string" then
      error("playerId must be a string")
    end

    return {
      playerId = playerId,
      online = Server.Players.isOnline(playerId)
    }
  end
}`,
    clientExample: `local playerId = tostring(game:GetService("Players").LocalPlayer.UserId)
local token = "${TOKEN}" -- Replace with the token shown in AXION.
local ok, result = pcall(function()
  return AXION:Fetch("check_online", { playerId = playerId }, token)
end)

if not ok then
  warn("Online check failed:", result)
else
  print(result.playerId, result.online)
end`,
    errors: "The function itself returns false for a non-string or unknown playerId. The wrapper above rejects a non-string argument. Fetch-level errors follow the Server Scripts HTTP contract.",
    related: ["Server.Game.customGameId", "AXION:Fetch"],
  },
  {
    name: "Server.Game.customGameId",
    signature: "Server.Game.customGameId -> string",
    description: "Read-only scope value assigned to the Server Script in the Server Scripts editor. The same function name can be exported in separate scopes.",
    params: [],
    returns: "string.",
    serverExample: `return {
  get_scope = function(_args)
    return { customGameId = Server.Game.customGameId }
  end
}`,
    clientExample: `local token = "${TOKEN}" -- Replace with the token shown in AXION.
local ok, result = pcall(function()
  return AXION:Fetch("get_scope", {}, token)
end)

if not ok then
  warn("Could not read script scope:", result)
else
  print("Server Script scope:", result.customGameId)
end`,
    errors: "No direct error is defined for reading the property. The wrapper can fail if it is not saved/loaded under the requested scope or the HTTP call fails.",
    related: ["Server.Items.search", "AXION:Fetch"],
  },
];

const SIGNAL_EXAMPLE = `local connected = AXION.Connected:Connect(function()
  print("AXION WebSocket connected")
end)

local disconnected = AXION.Disconnected:Connect(function()
  print("AXION WebSocket disconnected")
end)

print("Listeners installed; keep these connections until you no longer need the events.")

-- Later, disconnect just these callback connections:
-- connected:Disconnect()
-- disconnected:Disconnect()`;

const WORKSPACE_EXAMPLE = `{
  "meta": {
    "customGameId": "MY_PROJECT",
    "accountId": "account-123",
    "createdAt": 0,
    "updatedAt": 0
  },
  "session": {
    "agentId": "agent-123",
    "agentName": "Example Agent",
    "world": "current world",
    "placeId": "12345",
    "jobId": "job-abc",
    "updatedAt": 0
  },
  "profile": {},
  "worldProgress": {
    "world name": {}
  },
  "inventory": {
    "fruits": {},
    "swords": {},
    "guns": {},
    "accessories": {},
    "materials": {}
  }
}`;

const PROTOCOL_EXAMPLE = `[
  {"Name":"Log","Payload":{"Content":"ready"}},
  {"Name":"SetPlaceId","Payload":{"Content":12345}},
  {"Name":"SetJobId","Payload":{"Content":"job-id"}},
  {"Name":"InventoryUpdate","Payload":{
    "customGameId":"MY_PROJECT",
    "accountId":"account-123",
    "world":"Example World",
    "profile":{"level":10},
    "worldProgress":{"Example World":{"visited":true}},
    "inventory":{"materials":{"Example Item":{"quantity":2}}}
  }},
  {"Name":"ping"},
  {"Name":"pong"}
]`;

export default function ApiDocsPage({ notify }: { notify: (message: string) => void }) {
  const { t } = useLanguage();
  const [activeSection, setActiveSection] = useState<DocsSection>("start");
  const [relatedTarget, setRelatedTarget] = useState<string | null>(null);
  const section = SECTIONS.find(item => item.id === activeSection) ?? SECTIONS[0];
  const SectionIcon = section.icon;

  useLayoutEffect(() => {
    if (!relatedTarget) return;
    const target = document.getElementById(getRelatedTargetId(relatedTarget));
    const page = document.querySelector<HTMLElement>(".page-docs");
    if (target && page) {
      const offset = target.getBoundingClientRect().top - page.getBoundingClientRect().top - 84;
      page.scrollTo({ top: page.scrollTop + offset, behavior: "auto" });
    }
    setRelatedTarget(null);
  }, [activeSection, relatedTarget]);

  const selectSection = (id: DocsSection) => {
    setActiveSection(id);
    setRelatedTarget(null);
    document.querySelector<HTMLElement>(".page-docs")?.scrollTo({ top: 0, behavior: "auto" });
  };

  const navigateRelated = (name: string) => {
    const targetSection = getRelatedSection(name);
    document.querySelector<HTMLElement>(".page-docs")?.scrollTo({ top: 0, behavior: "auto" });
    setRelatedTarget(name);
    setActiveSection(targetSection);
  };

  return (
    <div className="docs-layout">
      <aside className="docs-nav" aria-label={t("docs.navLabel")}>
        <div className="docs-nav-title"><BookOpen size={16} /><span>{t("docs.reference")}</span></div>
        <nav>
          {SECTIONS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`docs-nav-item ${activeSection === id ? "active" : ""}`}
              aria-current={activeSection === id ? "page" : undefined}
              onClick={() => selectSection(id)}
            >
              <Icon size={13} />
              <span>{t(`docs.sections.${id}`)}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="docs-content">
        <section key={activeSection} id={`section-${activeSection}`} className="docs-section">
          <h1><SectionIcon size={22} /> {t(`docs.sections.${section.id}`)}</h1>
          {activeSection === "start" && <GettingStarted notify={notify} />}
          {activeSection === "client" && <ClientApi notify={notify} onNavigate={navigateRelated} />}
          {activeSection === "scripts" && <ServerScriptsApi notify={notify} onNavigate={navigateRelated} />}
          {activeSection === "workspace" && <WorkspaceData notify={notify} />}
          {activeSection === "protocol" && <ProtocolReference notify={notify} />}
          {activeSection === "config" && <Configuration />}
          {activeSection === "errors" && <ErrorReference />}
          <footer className="docs-footer"><p>{t("docs.verified")}</p></footer>
        </section>
      </main>
    </div>
  );
}

function GettingStarted({ notify }: { notify: (message: string) => void }) {
  const { t } = useLanguage();
  const runExample = `local token = "${TOKEN}"
local ok, result = pcall(function()
  return AXION:Fetch("find_item", { query = "Example Item" }, token)
end)

if not ok then
  warn("Server Script request failed:", result)
  return
end

print("Matching items:", result.count)`;

  return (
    <>
      <p className="docs-lead">{t("docs.gettingStarted.lead")}</p>
      <div className="docs-callout">
        <b>{t("docs.gettingStarted.requirements")}</b>
        <p>{t("docs.gettingStarted.tauri")}</p>
        <p>{t("docs.gettingStarted.loadApi")}</p>
        <p>{t("docs.gettingStarted.serverScript")}</p>
      </div>
      <h2>{t("docs.gettingStarted.workflow")}</h2>
      <ol>
        <li>{t("docs.gettingStarted.stepSave")}</li>
        <li>{t("docs.gettingStarted.stepScope")}</li>
        <li>{t("docs.gettingStarted.stepToken")}</li>
        <li>{t("docs.gettingStarted.stepInventory")}</li>
        <li>{t("docs.gettingStarted.stepRun")}</li>
      </ol>
      <h3>{t("docs.gettingStarted.saveCode")}</h3>
      <CodeBlock code={FIND_ITEM_SERVER_SCRIPT} notify={notify} />
      <h3>{t("docs.gettingStarted.runCode")}</h3>
      <CodeBlock code={runExample} notify={notify} />
      <p>{t("docs.gettingStarted.httpNote")}</p>
    </>
  );
}

function ClientApi({
  notify,
  onNavigate,
}: {
  notify: (message: string) => void;
  onNavigate: (name: string) => void;
}) {
  return (
    <>
      <p className="docs-lead">Client APIs run in the Lua runtime that loads <code>lua/AXION api.lua</code>. The script exports <code>AXION</code> and the <code>performance</code> helper to <code>getgenv()</code>; it waits for the game to load before initializing.</p>
      {CLIENT_METHODS.map(method => (
        <article className="docs-api-entry" id={getRelatedTargetId(method.name)} key={method.name}>
          <h2>{method.name}</h2>
          <p><code>{method.signature}</code></p>
          <p>{method.description}</p>
          {method.setupExample && (
            <>
              <h3>Setup</h3>
              <CodeBlock code={method.setupExample} notify={notify} />
            </>
          )}
          <ParameterTable params={method.params} />
          <p><b>Returns:</b> {method.returns}</p>
          <h3>Example</h3>
          <CodeBlock code={method.example} notify={notify} />
          <p><b>Error behavior:</b> {method.errors}</p>
          <RelatedApis items={method.related} onNavigate={onNavigate} />
        </article>
      ))}
      <h2>Signals</h2>
      <p><code>AXION.Connected</code>, <code>AXION.Disconnected</code>, and <code>AXION.MessageReceived</code> are signals that support <code>:Connect(callback)</code> and <code>:Wait()</code>. <code>:Connect()</code> returns a Roblox connection that can be disconnected; calling <code>:Disconnect()</code> on the AXION signal itself destroys its BindableEvent.</p>
      <CodeBlock code={SIGNAL_EXAMPLE} notify={notify} />
      <h2>Runtime properties</h2>
      <table className="docs-params">
        <thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>AXION.gamescope</code></td><td>string</td><td>Copy of <code>CONFIG.gamescope</code>; used by Server Scripts calls and default workspace reports.</td></tr>
          <tr><td><code>AXION.IsConnected</code></td><td>boolean | nil</td><td>True while connected; false after disconnect; nil before the first connection attempt.</td></tr>
          <tr><td><code>AXION.Connecting</code></td><td>boolean | nil</td><td>True during the connection attempt and heartbeat loop.</td></tr>
          <tr><td><code>AXION.Terminated</code></td><td>boolean | nil</td><td>Set by <code>Stop()</code>; a terminated instance will not connect again.</td></tr>
          <tr><td><code>AXION.Socket</code></td><td>WebSocket | nil</td><td>Current WebSocket connection, when connected.</td></tr>
          <tr><td><code>AXION.Commands</code></td><td>table</td><td>Map of command names to handlers; includes the built-in commands listed below.</td></tr>
          <tr><td><code>AXION.Connections</code></td><td>table</td><td>Connection handles for the active WebSocket listeners; managed by the API.</td></tr>
          <tr><td><code>AXION.ShutdownTime</code></td><td>number</td><td>Delay in seconds before shutdown after a qualifying connection error; initialized from CONFIG.</td></tr>
          <tr><td><code>AXION.ShutdownOnTeleportError</code></td><td>boolean</td><td>Controls shutdown for certain teleport-related connection errors; initialized from CONFIG.</td></tr>
          <tr><td><code>performance</code></td><td>function</td><td>Global alias for the built-in performance command.</td></tr>
        </tbody>
      </table>
      <h2>Built-in commands</h2>
      <p>Incoming WebSocket messages that are not <code>pong</code> are fired through <code>MessageReceived</code>, then dispatched as plain-text commands. For messages containing a space, the command name is lowercased and the remainder is passed as one string; without a space, the full message is looked up verbatim. Handler errors are caught and sent to <code>AXION:Log</code>.</p>
      <table className="docs-params">
        <thead><tr><th>Command</th><th>Behavior</th></tr></thead>
        <tbody>
          <tr><td><code>execute &lt;lua&gt;</code></td><td>Compiles and runs the provided Lua source; print output and errors are reported through the AXION log.</td></tr>
          <tr><td><code>teleport &lt;placeId&gt; [jobId]</code></td><td>Teleports to a place, optionally targeting a specific job instance.</td></tr>
          <tr><td><code>rejoin</code></td><td>Teleports back to the current place and job instance.</td></tr>
          <tr><td><code>mute</code> / <code>unmute</code></td><td>Temporarily mutes master volume and restores the remembered volume.</td></tr>
          <tr><td><code>performance [fps]</code></td><td>Enables reduced rendering while unfocused; restores rendering and uses <code>CONFIG.NormalFPS</code> when focused. It runs only once per API instance.</td></tr>
        </tbody>
      </table>
      <p>Custom commands registered with <code>AXION:AddCommand</code> use the same plain-text dispatcher; AXION currently does not expose an app-side arbitrary command sender.</p>
    </>
  );
}

function ServerScriptsApi({
  notify,
  onNavigate,
}: {
  notify: (message: string) => void;
  onNavigate: (name: string) => void;
}) {
  return (
    <>
      <p className="docs-lead">Server Scripts expose saved Lua functions through the local HTTP API. Requests are scoped to the configured game ID and require the token shown on the Server Scripts page.</p>
      <div className="docs-callout">
        <b>Security</b>
        <p>The API token is a secret. Do not include it in shared source code or logs.</p>
      </div>
      {SERVER_METHODS.map(method => (
        <article className="docs-api-entry" id={getRelatedTargetId(method.name)} key={method.name}>
          <h2>{method.name}</h2>
          <p><code>{method.signature}</code></p>
          <p>{method.description}</p>
          <ParameterTable params={method.params} />
          <p><b>Returns:</b> {method.returns}</p>
          <h3>Server Script</h3>
          <CodeBlock code={method.serverExample} notify={notify} />
          <h3>Client call</h3>
          <CodeBlock code={method.clientExample} notify={notify} />
          <p><b>Error behavior:</b> {method.errors}</p>
          <RelatedApis items={method.related} onNavigate={onNavigate} />
        </article>
      ))}
      <p>The Server Scripts page generates a random 32-byte token (64 hexadecimal characters) and stores it in AXION localStorage. The backend keeps the token in memory after initialization. Send it in the HTTP <code>Authorization</code> header and treat it as a secret.</p>
    </>
  );
}

function WorkspaceData({ notify }: { notify: (message: string) => void }) {
  return (
    <>
      <p className="docs-lead">Workspace reports are persisted locally and grouped by game and account. Only report fields your integration can read reliably.</p>
      <h2>Workspace document</h2>
      <p>The document includes metadata, the latest session context, profile data, world progress, and category-based inventory.</p>
      <CodeBlock code={WORKSPACE_EXAMPLE} notify={notify} language="json" />
      <h2>Automatic inventory reporting</h2>
      <p>Set <code>getgenv().AXIONInventory</code> once in the client environment. The first heartbeat sends a full snapshot; later heartbeats send only changed field values and item additions/removals. Unchanged heartbeats contain no inventory data. The API saves it under the current game scope and local player account. The value can be a list of item records or an inventory object grouped by category; list items without a category go to <code>materials</code>. No separate report or HTTP fetch call is required.</p>
      <CodeBlock code={`getgenv().AXIONInventory = {
  { name = "Potion", quantity = 2, category = "materials" },
  { name = "Iron Ore", quantity = 15, category = "materials" }
}`} notify={notify} />
      <p>The latest value is checked with each heartbeat and only changes are sent. Heartbeats use JSON text for compatibility with the executor's WebSocket transport. Keep the message under 16 KiB; if the inventory is invalid or too large, AXION sends the heartbeat without inventory and logs the problem. <code>AXION:FetchOnlineInventory(token)</code> remains a separate HTTP call that only fetches online inventory.</p>
      <h2>Reporting data</h2>
      <p>Use <code>AXION:ReportWorkspace(data)</code> to send an inventory update. The report is validated before it is stored; account and game identifiers determine its scope.</p>
      <h3>Use custom inventory categories</h3>
      <p>Inventory keys are not limited to the built-in examples. Use any category name with 1-64 Unicode characters; emoji and non-ASCII scripts are supported, but spaces and control characters are not. ASCII characters are limited to letters, digits, underscores, and hyphens (for example, <code>pets🎒</code> or <code>raid_rewards</code>). AXION creates and stores a valid new category when it first appears in a report. A category included in a later report replaces its previous contents; categories omitted from that report remain unchanged.</p>
      <CodeBlock code={`AXION:ReportWorkspace({
  customGameId = AXION.gamescope,
  accountId = tostring(game:GetService("Players").LocalPlayer.UserId) .. "_DOCS_TEST",
  world = "Example World",
  profile = { note = "Documentation example" },
  inventory = {
    pets = {
      ["Example Pet"] = { quantity = 1, itemId = "pet-001" }
    },
    raid_rewards = {
      ["Reward Chest"] = { quantity = 2 }
    }
  }
})`} notify={notify} />
    </>
  );
}

function ProtocolReference({ notify }: { notify: (message: string) => void }) {
  return (
    <>
      <p className="docs-lead">The local WebSocket protocol uses JSON messages with a <code>Name</code> and an optional <code>Payload</code>. Messages are one-way; there is no request ID or correlated response.</p>
      <h2>Example message sequence</h2>
      <CodeBlock code={PROTOCOL_EXAMPLE} notify={notify} language="json" />
      <h2>Supported messages</h2>
      <table className="docs-params">
        <thead><tr><th>Message</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><code>ping</code> / <code>pong</code></td><td>Heartbeat and connection health. If a client includes inventory data, AXION also validates and persists that workspace report.</td></tr>
          <tr><td><code>Log</code></td><td>Send a text message to the AXION activity log.</td></tr>
          <tr><td><code>SetPlaceId</code> / <code>SetJobId</code></td><td>Update the active session identifiers.</td></tr>
          <tr><td><code>Echo</code></td><td>Emit a client event for UI integrations.</td></tr>
          <tr><td><code>InventoryUpdate</code></td><td>Validate and persist a workspace report.</td></tr>
        </tbody>
      </table>
      <p>Encoded messages are limited to 16 KiB. The client API raises an error if a message exceeds this limit or the connection is unavailable.</p>
    </>
  );
}

function Configuration() {
  return (
    <>
      <p className="docs-lead">The <code>CONFIG</code> table controls local connection behavior, Server Scripts requests, and performance settings.</p>
      <table className="docs-params">
        <thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>WebSocketHost</code></td><td>number</td><td>Local WebSocket port (5242). Must be an integer from 1 to 65535.</td></tr>
          <tr><td><code>HeartbeatInterval</code></td><td>number</td><td>Seconds between WebSocket heartbeats (10); configured inventory is checked at each heartbeat.</td></tr>
          <tr><td><code>AutoConnect</code></td><td>boolean</td><td>Attempt a connection on load (true) when the global <code>AXION_Version</code> is nil or false.</td></tr>
          <tr><td><code>Debug</code></td><td>boolean</td><td>Print connection errors and <code>AXION:Log</code> messages in the runtime console (true).</td></tr>
          <tr><td><code>gamescope</code></td><td>string</td><td>Scope used for Server Scripts and default workspace reports (<code>AXION_TEST</code>).</td></tr>
          <tr><td><code>ScriptApiPort</code></td><td>number</td><td>Local HTTP port used by <code>AXION:Fetch</code> (5243).</td></tr>
          <tr><td><code>ShutdownTime</code></td><td>number</td><td>Seconds to wait before <code>game:Shutdown()</code> after a qualifying connection error (45).</td></tr>
          <tr><td><code>ShutdownOnTeleportError</code></td><td>boolean</td><td>Enable shutdown on disconnect errors (true); when false, errors with codes greater than <code>PlaceLaunchOtherError</code> are ignored.</td></tr>
          <tr><td><code>AutoShutdownOnLoadFail</code></td><td>boolean</td><td>Enable startup load-timeout shutdown check (true).</td></tr>
          <tr><td><code>LoadTimeout</code></td><td>number</td><td>Seconds before the startup load check runs (60).</td></tr>
          <tr><td><code>DefaultFPS</code></td><td>number</td><td>Unfocused performance-mode FPS target when omitted/invalid (8).</td></tr>
          <tr><td><code>NormalFPS</code></td><td>number</td><td>FPS target restored when the window is focused (60).</td></tr>
        </tbody>
      </table>
      <p><code>WebSocketHost</code> is validated as an integer from 1 to 65535. <code>NoShutdown</code>, when set in the executor environment, suppresses the API's delayed shutdown handlers. The API waits for <code>game.Loaded</code> before initializing services and the AXION object.</p>
      <p>Configuration defaults are defined by the bundled Lua API. Check the installed API file before relying on values that may change between versions.</p>
    </>
  );
}

function ErrorReference() {
  return (
    <>
      <p>Synchronous API calls raise errors on failure. Wrap calls with <code>pcall</code>; use FetchAsync for HTTP requests that should not block a frame.</p>
      <h2>Diagnosing and handling errors</h2>
      <CodeBlock code={`local ok, result = pcall(function()
  return AXION:Fetch("find_item", { query = "Example Item" }, "YOUR_64_CHARACTER_API_TOKEN")
end)

if not ok then
  warn("AXION API error:", result)
  return
end

print("Result count:", result.count)`} notify={() => {}} />
      <table className="docs-params">
        <thead><tr><th>Observed error / status</th><th>Likely cause</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td><code>websocket not connected</code></td><td>Send/report called before connection or after disconnect.</td><td>Check AXION.IsConnected and AXION listener; connection attempts do not retry automatically.</td></tr>
          <tr><td><code>Unsupported AXION command</code></td><td>AXION:Send command is not on the allowlist.</td><td>Use one of ping, Log, SetPlaceId, SetJobId, Echo, InventoryUpdate.</td></tr>
          <tr><td>HTTP 401: invalid token</td><td>Token missing, stale, or copied incorrectly.</td><td>Copy token again from the same AXION installation's Server Scripts page.</td></tr>
          <tr><td>HTTP 404 / function not found</td><td>Function not saved/loaded or scope does not match CONFIG.gamescope.</td><td>Save the export and align scope in the editor and client config.</td></tr>
          <tr><td>HTTP 429: rate limited</td><td>Calls made less than 500 ms apart.</td><td>Wait at least 500 ms before retrying.</td></tr>
          <tr><td>HTTP 422 / no response in 5 seconds</td><td>Server Script did not complete within the request timeout.</td><td>Reduce work; each Lua function is also limited to 4 seconds.</td></tr>
          <tr><td>HTTP 413 / 16 KiB limit</td><td>Encoded request or returned JSON is too large.</td><td>Return fewer fields/items; do not exceed the documented message/body limit.</td></tr>
          <tr><td>Invalid workspace category / item count</td><td>Category name is empty, longer than 64 Unicode characters, contains spaces/control characters, or uses unsupported ASCII punctuation; inventory is malformed; or it has more than 500 entries.</td><td>Use a valid category name and object-shaped category values. New valid categories are created automatically.</td></tr>
        </tbody>
      </table>
      <h3>HTTP error response shape</h3>
      <CodeBlock code={`{"ok":false,"error":"Invalid Server Scripts API token"}`} notify={() => {}} language="json" compact />
      <p>AXION:Fetch converts non-success HTTP/API responses into a Lua error. AXION:FetchAsync instead calls its callback as <code>(nil, error)</code>; callback errors are printed by the API.</p>
    </>
  );
}

function ParameterTable({ params }: { params: Parameter[] }) {
  const { t } = useLanguage();
  return (
    <table className="docs-params">
      <thead><tr><th>{t("docs.table.parameter")}</th><th>{t("docs.table.type")}</th><th>{t("docs.table.required")}</th><th>{t("docs.table.description")}</th></tr></thead>
      <tbody>
        {params.length === 0
          ? <tr><td colSpan={4}>{t("docs.table.noParameters")}</td></tr>
          : params.map(param => (
            <tr key={param.name}>
              <td><code>{param.name}</code></td>
              <td><span className="docs-type">{param.type}</span></td>
              <td>{param.required ? t("docs.table.yes") : t("docs.table.no")}</td>
              <td>{param.description}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

function getRelatedTargetId(name: string): string {
  if (["AXION.Connected", "AXION.Disconnected", "AXION.MessageReceived"].includes(name)) return "docs-signals";
  if (name.startsWith("CONFIG.")) return "section-config";
  return `api-${name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function getRelatedSection(name: string): DocsSection {
  if (name.startsWith("Server.")) return "scripts";
  if (name.startsWith("CONFIG.")) return "config";
  return "client";
}

function RelatedApis({ items, onNavigate }: { items: string[]; onNavigate: (name: string) => void }) {
  const { t } = useLanguage();
  return (
    <div className="docs-related">
      <span><Link2 size={12} /> {t("docs.table.related")}</span>
      {items.map(item => (
        <button key={item} type="button" onClick={() => onNavigate(item)}>
          <code>{item}</code>
        </button>
      ))}
    </div>
  );
}

function CodeBlock({
  code,
  notify,
  compact = false,
  language = "lua",
}: {
  code: string;
  notify: (message: string) => void;
  compact?: boolean;
  language?: SyntaxLanguage;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useLanguage();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      notify(t("docs.gettingStarted.copied"));
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      notify(t("docs.gettingStarted.copyFailed", {
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  return (
    <div className={`docs-code ${compact ? "compact" : ""}`}>
      <button className="docs-copy" type="button" onClick={() => void copy()} title={t("docs.gettingStarted.copy")} aria-label={t("docs.gettingStarted.copy")}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <SyntaxCodeBlock code={code} language={language} />
    </div>
  );
}
