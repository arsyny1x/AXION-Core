import { describe, expect, it, vi } from "vitest";
import {
  EventBus,
  FeatureRegistry,
  GameRegistry,
  ModuleLoader,
  type FeatureContext,
  type FeatureDefinition,
  type GameDefinition,
  type IGameFeature,
} from "..";

describe("AXION registries", () => {
  it("resolves a game by script id and rejects duplicate registration", () => {
    const games = new GameRegistry();
    const game: GameDefinition = { id: "game", name: "Game", scriptIds: ["script-a"] };
    games.register(game);
    expect(games.findByScriptId("script-a")?.id).toBe("game");
    expect(() => games.register({ ...game, id: "another" })).toThrow(/already registered/);
  });

  it("rejects duplicate features within a game but permits the same id in another game", () => {
    const features = new FeatureRegistry();
    const feature: FeatureDefinition = { id: "tracker", create: () => createFeature() };
    features.register("one", feature);
    features.register("two", feature);
    expect(features.list("one")).toHaveLength(1);
    expect(() => features.register("one", feature)).toThrow(/already registered/);
  });
});

describe("AXION module lifecycle", () => {
  it("initializes and starts in dependency order and stops dependents first", async () => {
    const games = new GameRegistry();
    const features = new FeatureRegistry();
    const log: string[] = [];
    games.register({ id: "game", name: "Game", scriptIds: ["script"] });

    features.register("game", makeFeature("coordinator", log, ["tracker"]));
    features.register("game", makeFeature("consumer", log, ["coordinator"]));
    features.register("game", makeFeature("tracker", log));
    expect(features.list("game").map(({ id }) => id)).toEqual(["coordinator", "consumer", "tracker"]);
    const loader = new ModuleLoader(games, features);

    await loader.loadGame("game");
    await loader.start();
    expect(log).toEqual([
      "tracker.initialize", "coordinator.initialize", "consumer.initialize",
      "tracker.start", "coordinator.start", "consumer.start",
    ]);

    await loader.stopFeature("tracker");
    expect(log.slice(-3)).toEqual(["consumer.stop", "coordinator.stop", "tracker.stop"]);
    expect(loader.getState("consumer")).toBe("stopped");
    await loader.dispose();
    expect(loader.getState("tracker")).toBeUndefined();
  });

  it("merges feature config and injects declared dependencies and shared events", async () => {
    const games = new GameRegistry();
    const features = new FeatureRegistry();
    games.register({ id: "example-adventure", name: "Example", scriptIds: ["example"] });
    const tracker = createFeature();
    features.register("example-adventure", { id: "item-tracker", create: () => tracker });
    expect(features.list("example-adventure").map(({ id }) => id)).toEqual(["item-tracker"]);
    let context: FeatureContext | undefined;
    features.register("example-adventure", {
      id: "race",
      dependencies: ["item-tracker"],
      defaultConfig: { enabled: true, threshold: 1 },
      create: () => ({
        ...createFeature(),
        initialize: (value: FeatureContext) => { context = value; },
      }),
    });
    const loader = new ModuleLoader(games, features, new EventBus());

    await loader.loadGame("example-adventure", { race: { threshold: 4 } });
    expect(context?.config).toEqual({ enabled: true, threshold: 4 });
    expect(context?.dependencies.get("item-tracker")).toBe(tracker);
  });

  it("starts only the requested feature and its dependencies", async () => {
    const games = new GameRegistry();
    const features = new FeatureRegistry();
    const log: string[] = [];
    games.register({ id: "game", name: "Game", scriptIds: [] });
    features.register("game", makeFeature("tracker", log));
    features.register("game", makeFeature("quest", log, ["tracker"]));
    features.register("game", makeFeature("farm", log));
    const loader = new ModuleLoader(games, features);
    await loader.loadGame("game");
    await loader.startFeature("quest");

    expect(log.filter((entry) => entry.endsWith(".start"))).toEqual(["tracker.start", "quest.start"]);
    expect(loader.getState("farm")).toBe("initialized");
    await loader.dispose();
  });

  it("reports missing dependencies and cleans up features after initialize failure", async () => {
    const games = new GameRegistry();
    const features = new FeatureRegistry();
    games.register({ id: "game", name: "Game", scriptIds: [] });
    features.register("game", { id: "broken", dependencies: ["missing"], create: () => createFeature() });
    const loader = new ModuleLoader(games, features);
    await expect(loader.loadGame("game")).rejects.toThrow(/dependency "missing"/);

    const cleanup = vi.fn();
    const badFeatures = new FeatureRegistry();
    badFeatures.register("game", {
      id: "bad",
      create: () => ({
        ...createFeature(),
        initialize: () => { throw new Error("initialization failed"); },
        dispose: cleanup,
      }),
    });
    const failedLoader = new ModuleLoader(games, badFeatures);
    await expect(failedLoader.loadGame("game")).rejects.toThrow("initialization failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

function makeFeature(
  id: string,
  log: string[],
  dependencies: readonly string[] = [],
): FeatureDefinition {
  return {
    id,
    dependencies,
    create: () => ({
      initialize: () => { log.push(`${id}.initialize`); },
      start: () => { log.push(`${id}.start`); },
      stop: () => { log.push(`${id}.stop`); },
      dispose: () => { log.push(`${id}.dispose`); },
    }),
  };
}

function createFeature(): IGameFeature {
  return {
    initialize: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
  };
}
