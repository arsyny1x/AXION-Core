import type { FeatureDefinition, GameDefinition } from "./contracts";

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string`);
}

export class GameRegistry {
  private readonly games = new Map<string, GameDefinition>();
  private readonly scripts = new Map<string, string>();

  register(game: GameDefinition): void {
    assertIdentifier(game.id, "game.id");
    assertIdentifier(game.name, "game.name");
    if (this.games.has(game.id)) throw new Error(`Game "${game.id}" is already registered`);
    const scriptIds = new Set<string>();
    for (const scriptId of game.scriptIds) {
      assertIdentifier(scriptId, "scriptId");
      if (scriptIds.has(scriptId) || this.scripts.has(scriptId)) {
        throw new Error(`Script ID "${scriptId}" is already registered`);
      }
      scriptIds.add(scriptId);
    }
    const registered = { ...game, scriptIds: [...scriptIds] };
    this.games.set(game.id, registered);
    for (const scriptId of scriptIds) this.scripts.set(scriptId, game.id);
  }

  get(gameId: string): GameDefinition | undefined {
    return this.games.get(gameId);
  }

  findByScriptId(scriptId: string): GameDefinition | undefined {
    const gameId = this.scripts.get(scriptId);
    return gameId === undefined ? undefined : this.games.get(gameId);
  }

  list(): readonly GameDefinition[] {
    return [...this.games.values()];
  }
}

export class FeatureRegistry {
  private readonly features = new Map<string, Map<string, FeatureDefinition>>();

  register(gameId: string, feature: FeatureDefinition): void {
    assertIdentifier(gameId, "gameId");
    assertIdentifier(feature.id, "feature.id");
    const gameFeatures = this.features.get(gameId) ?? new Map<string, FeatureDefinition>();
    if (gameFeatures.has(feature.id)) {
      throw new Error(`Feature "${feature.id}" is already registered for game "${gameId}"`);
    }
    gameFeatures.set(feature.id, feature);
    this.features.set(gameId, gameFeatures);
  }

  get(gameId: string, featureId: string): FeatureDefinition | undefined {
    return this.features.get(gameId)?.get(featureId);
  }

  list(gameId: string): readonly FeatureDefinition[] {
    return [...(this.features.get(gameId)?.values() ?? [])];
  }
}
