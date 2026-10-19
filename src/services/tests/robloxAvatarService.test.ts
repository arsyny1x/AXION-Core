import { afterEach, describe, expect, it, vi } from "vitest";
import { requestRobloxAvatars } from "../robloxAvatarService";

afterEach(() => vi.unstubAllGlobals());

describe("Roblox avatar service", () => {
  it("negative-caches usernames that do not resolve", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const player = { id: "avatar-missing-test", name: "avatar-missing-test" };
    requestRobloxAvatars([player]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));

    requestRobloxAvatars([player]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
