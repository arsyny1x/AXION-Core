--[[
    AXION · Test Suite Server Script (revised)
    Scope: ต้องตรงกับ CONFIG.gamescope ของ AXION API
]]

return {
    --==============================================================
    -- 1) find_item — Server.Items.search
    --==============================================================
    find_item = function(args)
        args = args or {}
        if type(args.query) ~= "string" then
            error("query must be a string")
        end
        local includeOffline = args.includeOffline == true
        local matches = Server.Items.search(args.query, includeOffline)
        return {
            customGameId = Server.Game.customGameId,
            count = #matches,
            items = matches,
        }
    end,

    --==============================================================
    -- get_online_inventory — online cached inventory for this scope
    --==============================================================
    get_online_inventory = function(args)
        args = args or {}
        local items = Server.Items.getOnline(args.agentId)
        return {
            customGameId = Server.Game.customGameId,
            count = #items,
            items = items,
        }
    end,

    --==============================================================
    -- 2) check_online — Server.Players.isOnline
    --==============================================================
    check_online = function(args)
        args = args or {}
        if type(args.playerId) ~= "string" then
            error("playerId must be a string")
        end
        return {
            playerId = args.playerId,
            online = Server.Players.isOnline(args.playerId),
        }
    end,

    --==============================================================
    -- 3) get_scope
    --==============================================================
    get_scope = function(_args)
        return { customGameId = Server.Game.customGameId }
    end,

    --==============================================================
    -- 4) ping
    --==============================================================
    ping = function(_args)
        return {
            ok = true,
            scope = Server.Game.customGameId,
            serverTime = os.time(),
        }
    end,

    --==============================================================
    -- 5) echo — JSON round-trip
    --==============================================================
    echo = function(args)
        return {
            received = args,
            receivedType = type(args),
        }
    end,

    --==============================================================
    -- 6) empty_result
    --==============================================================
    empty_result = function(_args)
        return {}
    end,

    --==============================================================
    -- 7) null_result — คืน JSON null อย่างชัดเจน
    --==============================================================
    null_result = function(_args)
        -- Runtime แปลง nil → JSON null; ห่อใน table เพื่อให้ serialize มั่นคง
        return { value = nil, note = "nil becomes JSON null" }
    end,

    --==============================================================
    -- 8) raise_error — intentional error path
    --==============================================================
    raise_error = function(_args)
        error("intentional server-side error for testing")
    end,

    --==============================================================
    -- 9) sleep_brief — ~0.5s busy wait (ต่ำกว่า 4s execution timeout)
    --==============================================================
    sleep_brief = function(_args)
        local t0 = os.clock()
        local guard = 0
        while os.clock() - t0 < 0.5 do
            guard = guard + 1
            if guard > 5e8 then break end  -- safety guard
        end
        return { target = 0.5, elapsed = os.clock() - t0 }
    end,

    --==============================================================
    -- 10) sleep_long — ตั้งใจให้ชน execution timeout 4s
    --     (ไม่ใช่ HTTP 5s; runtime ตัดก่อน)
    --==============================================================
    sleep_long = function(_args)
        local t0 = os.clock()
        local guard = 0
        while os.clock() - t0 < 5 do
            guard = guard + 1
            if guard > 5e9 then break end
        end
        return { target = 5, elapsed = os.clock() - t0, note = "should never reach client" }
    end,

    --==============================================================
    -- 11) type_echo
    --==============================================================
    type_echo = function(args)
        args = args or {}
        local out, n = {}, 0
        for k, v in pairs(args) do
            out[tostring(k)] = type(v)
            n = n + 1
        end
        return { types = out, count = n }
    end,

    --==============================================================
    -- 12) big_payload — ตั้งใจให้เกิน 16 KiB → ควร 413
    --==============================================================
    big_payload = function(_args)
        local out = {}
        for i = 1, 2000 do
            out[i] = {
                index = i,
                label = "item_" .. tostring(i),
                description = string.rep("x", 32),
            }
        end
        return { items = out, count = #out }
    end,

    --==============================================================
    -- 13) big_payload_ok — ใกล้ 16 KiB แต่ไม่เกิน
    --     ~400 rows × ~30 bytes ≈ 12 KiB
    --==============================================================
    big_payload_ok = function(_args)
        local out = {}
        for i = 1, 400 do
            out[i] = { index = i, label = "row_" .. tostring(i) }
        end
        return { items = out, count = #out }
    end,

    --==============================================================
    -- 14) scope_items_summary — ต้องส่ง query มาถึงจะนับได้
    --==============================================================
    scope_items_summary = function(args)
        args = args or {}
        local q = args.query
        if type(q) ~= "string" or q == "" then
            return {
                customGameId = Server.Game.customGameId,
                note = "provide a non-empty query; empty query returns [] by contract",
                count = 0,
                categories = {},
            }
        end
        local items = Server.Items.search(q, args.includeOffline == true)
        local cats = {}
        for _, it in ipairs(items) do
            cats[it.category] = (cats[it.category] or 0) + 1
        end
        return {
            customGameId = Server.Game.customGameId,
            query = q,
            count = #items,
            categories = cats,
        }
    end,

    --==============================================================
    -- 15) count_all — ต้องมี query (ตั้งชื่อให้ตรงพฤติกรรม)
    --==============================================================
    count_all = function(args)
        args = args or {}
        local q = args.query
        if type(q) ~= "string" or q == "" then
            return { count = 0, note = "empty query → [] by contract" }
        end
        local items = Server.Items.search(q, args.includeOffline == true)
        return { query = q, count = #items }
    end,

    --==============================================================
    -- 16) find_by_category
    --==============================================================
    find_by_category = function(args)
        args = args or {}
        if type(args.query) ~= "string" then error("query must be a string") end
        if type(args.category) ~= "string" then error("category must be a string") end

        local ok, items = pcall(Server.Items.search, args.query, args.includeOffline == true)
        if not ok then error("search failed: " .. tostring(items)) end

        local filtered = {}
        for _, it in ipairs(items) do
            if it.category == args.category then
                table.insert(filtered, it)
            end
        end
        return {
            query = args.query,
            category = args.category,
            count = #filtered,
            items = filtered,
        }
    end,

    --==============================================================
    -- 17) find_online_only
    --==============================================================
    find_online_only = function(args)
        args = args or {}
        if type(args.query) ~= "string" then error("query must be a string") end

        local items = Server.Items.search(args.query, true)
        local online = {}
        for _, it in ipairs(items) do
            if it.online == true then
                table.insert(online, it)
            end
        end
        return { query = args.query, count = #online, items = online }
    end,
}