import type { FeatureContext, FeatureDefinition, GameDefinition, IGameFeature } from "../core/contracts";
import { FeatureRegistry, GameRegistry } from "../core/registries";

export const exampleGame: GameDefinition = {
  id: "example-adventure",
  name: "Example Adventure",
  scriptIds: ["example-adventure-v1"],
};

class ExampleFeature implements IGameFeature {
  private context: FeatureContext | null = null;

  constructor(private readonly featureId: string) {}

  initialize(context: FeatureContext): void {
    this.context = context;
    context.events.emit("feature.initialized", { gameId: context.gameId, featureId: this.featureId });
  }

  start(): void {
    this.context?.events.emit("feature.started", { featureId: this.featureId });
  }

  stop(): void {
    this.context?.events.emit("feature.stopped", { featureId: this.featureId });
  }

  dispose(): void {
    this.context = null;
  }
}

export const exampleFeatures: readonly FeatureDefinition[] = [
  { id: "auto-farm", defaultConfig: { intervalMs: 1_000 }, create: () => new ExampleFeature("auto-farm") },
  { id: "race-v4-coordinator", dependencies: ["item-tracker"], create: () => new ExampleFeature("race-v4-coordinator") },
  { id: "item-tracker", create: () => new ExampleFeature("item-tracker") },
  { id: "quest-manager", dependencies: ["item-tracker"], create: () => new ExampleFeature("quest-manager") },
];

export function registerExampleGame(games: GameRegistry, features: FeatureRegistry): void {
  games.register(exampleGame);
  for (const feature of exampleFeatures) features.register(exampleGame.id, feature);
}
