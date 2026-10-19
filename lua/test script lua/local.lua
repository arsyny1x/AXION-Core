-- AXION workspace database test UI.
-- Run this after loading the AXION API. Set the API CONFIG gamescope to AXION_TEST.

local Players = game:GetService("Players")
local LocalPlayer = Players.LocalPlayer
local PlayerGui = LocalPlayer:WaitForChild("PlayerGui")

local TEST_GAME_ID = "AXION_TEST"
local TEST_ITEM_NAMES = {
    "AXION_TEST_ITEM1",
    "AXION_TEST_ITEM2",
    "AXION_TEST_ITEM3",
    "AXION_TEST_ITEM4",
    "AXION_TEST_ITEM5",
}
local DEFAULT_API_TOKEN = "PASTE_API_TOKEN_HERE"

if type(AXION) ~= "table" then
    error("AXION API is not loaded. Load the copied AXION API first, then run this test UI.")
end

local ExistingGui = PlayerGui:FindFirstChild("AXIONWorkspaceTest")
if ExistingGui then
    ExistingGui:Destroy()
end

local ScreenGui = Instance.new("ScreenGui")
ScreenGui.Name = "AXIONWorkspaceTest"
ScreenGui.ResetOnSpawn = false
ScreenGui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
ScreenGui.Parent = PlayerGui

local Panel = Instance.new("Frame")
Panel.Name = "Panel"
Panel.AnchorPoint = Vector2.new(0.5, 0.5)
Panel.Position = UDim2.fromScale(0.5, 0.5)
Panel.Size = UDim2.fromOffset(390, 320)
Panel.BackgroundColor3 = Color3.fromRGB(15, 19, 39)
Panel.BorderSizePixel = 0
Panel.Parent = ScreenGui

local PanelCorner = Instance.new("UICorner")
PanelCorner.CornerRadius = UDim.new(0, 12)
PanelCorner.Parent = Panel

local PanelStroke = Instance.new("UIStroke")
PanelStroke.Color = Color3.fromRGB(91, 94, 160)
PanelStroke.Transparency = 0.35
PanelStroke.Parent = Panel

local Padding = Instance.new("UIPadding")
Padding.PaddingTop = UDim.new(0, 14)
Padding.PaddingBottom = UDim.new(0, 12)
Padding.PaddingLeft = UDim.new(0, 14)
Padding.PaddingRight = UDim.new(0, 14)
Padding.Parent = Panel

local Layout = Instance.new("UIListLayout")
Layout.Padding = UDim.new(0, 9)
Layout.SortOrder = Enum.SortOrder.LayoutOrder
Layout.Parent = Panel

local function makeLabel(name, text, height, color, order)
    local Label = Instance.new("TextLabel")
    Label.Name = name
    Label.LayoutOrder = order
    Label.Size = UDim2.new(1, 0, 0, height)
    Label.BackgroundTransparency = 1
    Label.Font = Enum.Font.Gotham
    Label.Text = text
    Label.TextColor3 = color
    Label.TextSize = 13
    Label.TextWrapped = true
    Label.TextXAlignment = Enum.TextXAlignment.Left
    Label.Parent = Panel
    return Label
end

local function makeButton(name, text, order)
    local Button = Instance.new("TextButton")
    Button.Name = name
    Button.LayoutOrder = order
    Button.Size = UDim2.new(1, 0, 0, 38)
    Button.BackgroundColor3 = Color3.fromRGB(91, 77, 207)
    Button.BorderSizePixel = 0
    Button.AutoButtonColor = true
    Button.Font = Enum.Font.GothamSemibold
    Button.Text = text
    Button.TextColor3 = Color3.fromRGB(245, 245, 255)
    Button.TextSize = 13
    Button.Parent = Panel

    local Corner = Instance.new("UICorner")
    Corner.CornerRadius = UDim.new(0, 8)
    Corner.Parent = Button
    return Button
end

local Title = makeLabel(
    "Title",
    "AXION · Workspace database test",
    24,
    Color3.fromRGB(224, 226, 255),
    1
)
Title.Font = Enum.Font.GothamBold
Title.TextSize = 16

local Description = makeLabel(
    "Description",
    "Test scope: " .. TEST_GAME_ID .. " · Account: " .. tostring(LocalPlayer.UserId) .. "_TEST",
    30,
    Color3.fromRGB(164, 172, 204),
    2
)
Description.TextSize = 11

local TokenBox = Instance.new("TextBox")
TokenBox.Name = "ApiToken"
TokenBox.LayoutOrder = 3
TokenBox.Size = UDim2.new(1, 0, 0, 36)
TokenBox.BackgroundColor3 = Color3.fromRGB(8, 11, 25)
TokenBox.BorderSizePixel = 0
TokenBox.ClearTextOnFocus = false
TokenBox.Font = Enum.Font.Code
TokenBox.PlaceholderText = "Paste Server Scripts API token"
TokenBox.Text = DEFAULT_API_TOKEN
TokenBox.TextColor3 = Color3.fromRGB(220, 224, 246)
TokenBox.PlaceholderColor3 = Color3.fromRGB(120, 128, 158)
TokenBox.TextSize = 11
TokenBox.Parent = Panel

local TokenCorner = Instance.new("UICorner")
TokenCorner.CornerRadius = UDim.new(0, 7)
TokenCorner.Parent = TokenBox

local ReportButton = makeButton("SendTestData", "1. Send test data to AXION", 4)
local VerifyButton = makeButton("VerifySavedData", "2. Read it back from the database", 5)
local Status = makeLabel(
    "Status",
    "Ready. Start AXION and connect the AXION API first.",
    60,
    Color3.fromRGB(164, 172, 204),
    6
)
Status.TextSize = 11

local Busy = false

local function setStatus(Text, IsError)
    Status.Text = Text
    Status.TextColor3 = IsError
        and Color3.fromRGB(255, 143, 153)
        or Color3.fromRGB(164, 172, 204)
end

local function createTestData()
    local TestRun = tostring(math.floor(os.clock() * 1000))
    local TestMaterials = {}
    for Index, ItemName in ipairs(TEST_ITEM_NAMES) do
        TestMaterials[ItemName] = {
            quantity = Index * 7,
            itemId = string.lower(ItemName),
        }
    end

    return {
        customGameId = TEST_GAME_ID,
        accountId = tostring(LocalPlayer.UserId) .. "_TEST",
        world = "Test World",
        profile = {
            level = 999,
            beli = 123456,
            race = "AXION_TEST",
            testRun = TestRun,
        },
        worldProgress = {
            ["Test World"] = {
                axionWorkspaceTest = true,
                lastTestRun = TestRun,
            },
        },
        inventory = {
            fruits = {},
            swords = {},
            guns = {},
            accessories = {},
            materials = TestMaterials,
        },
    }
end

ReportButton.Activated:Connect(function()
    if Busy then return end
    Busy = true
    ReportButton.Active = false

    local Success, ErrorMessage = pcall(function()
        if not AXION.IsConnected then
            error("AXION WebSocket is not connected. Wait for AXION to connect, then try again.")
        end
        if AXION.gamescope ~= TEST_GAME_ID then
            error(
                "Scope mismatch: this test uses " .. TEST_GAME_ID
                    .. " but the loaded AXION API uses " .. tostring(AXION.gamescope)
                    .. ". Set CONFIG.gamescope to " .. TEST_GAME_ID .. " and reload AXION."
            )
        end
        AXION:ReportWorkspace(createTestData())
    end)

    if Success then
        setStatus(
            "Client sent report for " .. TEST_GAME_ID .. " / "
                .. tostring(LocalPlayer.UserId) .. "_TEST. Confirm “Saved workspace received” in AXION before assuming it was stored.",
            false
        )
    else
        setStatus("Send failed: " .. tostring(ErrorMessage), true)
    end

    task.delay(3.1, function()
        Busy = false
        ReportButton.Active = true
    end)
end)

VerifyButton.Activated:Connect(function()
    if Busy then return end
    Busy = true
    VerifyButton.Active = false

    task.spawn(function()
        local Success, Result = pcall(function()
            if not AXION.IsConnected then
                error("AXION WebSocket is not connected.")
            end
            if AXION.gamescope ~= TEST_GAME_ID then
                error(
                    "Scope mismatch: this test uses " .. TEST_GAME_ID
                        .. " but the loaded AXION API uses " .. tostring(AXION.gamescope)
                        .. ". Set CONFIG.gamescope to " .. TEST_GAME_ID .. " and reload AXION."
                )
            end
            local Token = TokenBox.Text
            if Token == "" or Token == "PASTE_API_TOKEN_HERE" then
                error("Paste the token from AXION > Server Scripts.")
            end
            return AXION:Fetch(
                "test_workspace",
                {
                    query = "AXION_TEST_ITEM",
                    accountId = tostring(LocalPlayer.UserId) .. "_TEST",
                },
                Token
            )
        end)

        if Success then
            if Result.ok then
                local FoundItemNames = {}
                for _, Match in ipairs(Result.matches or {}) do
                    table.insert(FoundItemNames, Match.itemName .. " × " .. tostring(Match.quantity))
                end
                setStatus(
                    "Database read OK · " .. tostring(Result.matchCount) .. "/"
                        .. tostring(#TEST_ITEM_NAMES) .. " test items: "
                        .. table.concat(FoundItemNames, ", "),
                    false
                )
            else
                setStatus("No test item found yet. Send the test data first.", true)
            end
        else
            setStatus("Database check failed: " .. tostring(Result), true)
        end

        Busy = false
        VerifyButton.Active = true
    end)
end)
