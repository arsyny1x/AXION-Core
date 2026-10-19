import type {
  FeatureContext,
  FeatureDefinition,
  FeatureLifecycleState,
  IGameFeature,
} from "./contracts";
import { AXIONAggregateError } from "./errors";
import { EventBus } from "./EventBus";
import { FeatureRegistry, GameRegistry } from "./registries";

export type FeatureConfig = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export class ModuleLoader {
  private gameId: string | null = null;
  private readonly instances = new Map<string, IGameFeature>();
  private readonly states = new Map<string, FeatureLifecycleState>();
  private order: string[] = [];

  constructor(
    private readonly games: GameRegistry,
    private readonly features: FeatureRegistry,
    private readonly events = new EventBus(),
  ) {}

  getEventBus(): EventBus {
    return this.events;
  }

  getState(featureId: string): FeatureLifecycleState | undefined {
    return this.states.get(featureId);
  }

  async loadGame(gameId: string, config: FeatureConfig = {}): Promise<void> {
    if (this.gameId !== null) throw new Error(`Game "${this.gameId}" is already loaded`);
    if (!this.games.get(gameId)) throw new Error(`Game "${gameId}" is not registered`);

    const definitions = this.features.list(gameId);
    const sorted = resolveFeatureOrder(definitions);
    this.gameId = gameId;
    this.order = sorted.map((definition) => definition.id);

    try {
      for (const definition of sorted) {
        const instance = definition.create();
        this.instances.set(definition.id, instance);
        this.states.set(definition.id, "created");
      }
      for (const definition of sorted) {
        const instance = this.requireInstance(definition.id);
        const context = this.createContext(gameId, definition, config);
        await instance.initialize(context);
        this.states.set(definition.id, "initialized");
      }
    } catch (error) {
      try {
        await this.disposeAll();
      } catch (cleanupError) {
        this.gameId = null;
        this.order = [];
        throw new AXIONAggregateError([error, cleanupError], "Game loading and cleanup both failed");
      }
      this.gameId = null;
      this.order = [];
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.gameId === null) throw new Error("No game is loaded");
    await this.startInOrder(this.order);
  }

  async startFeature(featureId: string): Promise<void> {
    if (this.gameId === null) throw new Error("No game is loaded");
    if (!this.instances.has(featureId)) throw new Error(`Feature "${featureId}" is not loaded`);
    const required = new Set<string>([featureId]);
    const pending = [featureId];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const dependencies = this.features.get(this.gameId, current)?.dependencies ?? [];
      for (const dependency of dependencies) {
        if (required.has(dependency)) continue;
        required.add(dependency);
        pending.push(dependency);
      }
    }
    await this.startInOrder(this.order.filter((id) => required.has(id)));
  }

  private async startInOrder(featureIds: readonly string[]): Promise<void> {
    const started: string[] = [];
    try {
      for (const featureId of featureIds) {
        if (this.isRunning(featureId)) continue;
        started.push(featureId);
        await this.requireInstance(featureId).start();
        this.states.set(featureId, "running");
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const featureId of started.reverse()) {
        try {
          await this.requireInstance(featureId).stop();
          this.states.set(featureId, "stopped");
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AXIONAggregateError([error, ...rollbackErrors], "Feature start and rollback both failed");
      }
      throw error;
    }
  }

  async stopFeature(featureId: string): Promise<void> {
    if (!this.instances.has(featureId)) throw new Error(`Feature "${featureId}" is not loaded`);
    const dependents = this.order
      .filter((candidate) => this.isRunning(candidate) && this.dependsTransitivelyOn(candidate, featureId))
      .reverse();
    for (const dependent of dependents) await this.stopOne(dependent);
    await this.stopOne(featureId);
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    for (const featureId of [...this.order].reverse()) {
      try {
        await this.stopOne(featureId);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AXIONAggregateError(errors, "One or more features failed to stop");
  }

  async dispose(): Promise<void> {
    if (this.gameId === null) return;
    const errors: unknown[] = [];
    try {
      await this.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.disposeAll();
    } catch (error) {
      errors.push(error);
    }
    this.gameId = null;
    this.order = [];
    if (errors.length > 0) throw new AXIONAggregateError(errors, "Game disposal failed");
  }

  private async stopOne(featureId: string): Promise<void> {
    if (!this.isRunning(featureId)) return;
    await this.requireInstance(featureId).stop();
    this.states.set(featureId, "stopped");
  }

  private async disposeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const featureId of [...this.order].reverse()) {
      const instance = this.instances.get(featureId);
      if (!instance) continue;
      try {
        if (this.states.get(featureId) === "running") await instance.stop();
        await instance.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        this.states.set(featureId, "disposed");
      }
    }
    this.instances.clear();
    this.states.clear();
    if (errors.length > 0) throw new AXIONAggregateError(errors, "One or more features failed to dispose");
  }

  private createContext(
    gameId: string,
    definition: FeatureDefinition,
    config: FeatureConfig,
  ): FeatureContext {
    const dependencies = new Map<string, IGameFeature>();
    for (const dependency of definition.dependencies ?? []) {
      dependencies.set(dependency, this.requireInstance(dependency));
    }
    return {
      gameId,
      featureId: definition.id,
      config: Object.freeze({
        ...(definition.defaultConfig ?? {}),
        ...(config[definition.id] ?? {}),
      }),
      dependencies,
      events: this.events,
    };
  }

  private requireInstance(featureId: string): IGameFeature {
    const instance = this.instances.get(featureId);
    if (!instance) throw new Error(`Feature "${featureId}" is not loaded`);
    return instance;
  }

  private isRunning(featureId: string): boolean {
    return this.states.get(featureId) === "running";
  }

  private dependsTransitivelyOn(featureId: string, dependencyId: string): boolean {
    const pending = [...(this.features.get(this.gameId!, featureId)?.dependencies ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === dependencyId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(this.features.get(this.gameId!, current)?.dependencies ?? []));
    }
    return false;
  }
}

function resolveFeatureOrder(definitions: readonly FeatureDefinition[]): FeatureDefinition[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: FeatureDefinition[] = [];

  const visit = (featureId: string): void => {
    const definition = byId.get(featureId);
    if (!definition) throw new Error(`Feature dependency "${featureId}" is not registered`);
    if (visiting.has(featureId)) throw new Error(`Feature dependency cycle at "${featureId}"`);
    if (visited.has(featureId)) return;
    visiting.add(featureId);
    for (const dependency of definition.dependencies ?? []) visit(dependency);
    visiting.delete(featureId);
    visited.add(featureId);
    result.push(definition);
  };

  for (const definition of definitions) visit(definition.id);
  return result;
}
