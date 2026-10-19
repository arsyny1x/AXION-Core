-- Paste this Lua code into a Server Script in AXION Core, then save it.
-- This function can be tested from the Server Scripts UI without a game client.

return {
    find_item = function(args)
        local matches = Server.Items.search(
            args.query or "",
            args.includeOffline == true
        )
        return {
            customGameId = Server.Game.customGameId,
            count = #matches,
            items = matches
        }
    end,
    get_online_inventory = function(args)
        args = args or {}
        local items = Server.Items.getOnline(args.agentId)
        return {
            customGameId = Server.Game.customGameId,
            count = #items,
            items = items
        }
    end
}
