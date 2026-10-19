-- AXION Server Scripts API smoke test
--
-- Before running this file:
-- 1. Open the app's Server Scripts tab and save the code from
--    "lua/Server Script Demo.lua" (or use the prefilled Server Script Demo).
--
--    It exports find_item for the game client to call.
--
-- 2. Copy the API token from that tab and replace YOUR_API_TOKEN below.
-- 3. Run "lua/AXION api.lua" first and wait until the AXION client is connected.
-- 4. AXION:Fetch needs executor HTTP support for localhost on this same computer.
--
-- This inventory is test data. Replace it with inventory read from your game.

local API_TOKEN = "YOUR_API_TOKEN"

local ok, err = pcall(function()
    AXION:ReportInventory({
        { name = "Potion", quantity = 2, itemId = "test-potion" },
        { name = "Iron Ore", quantity = 15, itemId = "test-ore" }
    })

    local result = AXION:Fetch("find_item", { query = "Potion" }, API_TOKEN)
    assert(type(result) == "table", "Expected the server function to return a table")
    assert(type(result.count) == "number", "Expected result.count to be a number")
    assert(type(result.items) == "table", "Expected result.items to be a table")
    local foundTestItem = false
    for _, item in ipairs(result.items) do
        if item.itemId == "test-potion" and item.playerId == tostring(game:GetService("Players").LocalPlayer.UserId) then
            foundTestItem = true
            break
        end
    end
    assert(foundTestItem, "The test inventory was not returned; confirm this player is connected and the script is saved")

    print(("Server Scripts API OK: %d matching item(s)"):format(result.count))
    for _, item in ipairs(result.items) do
        print(("%s owns %s x%d (online=%s)"):format(
            item.playerName,
            item.itemName,
            item.quantity,
            tostring(item.online)
        ))
    end
end)

if not ok then
    warn("Server Scripts API test failed: " .. tostring(err))
end