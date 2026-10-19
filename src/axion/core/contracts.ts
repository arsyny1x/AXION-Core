export type JsonPrimitive = string | number | boolean | null;

export interface GameDefinition {
  id: string;
  name: string;
  scriptIds: readonly string[];
}

export interface FeatureContext {
  readonly gameId: string;
  readonly featureId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly dependencies: ReadonlyMap<string, IGameFeature>;
  readonly events: EventPublisher;
}

export interface EventPublisher {
  emit(eventName: string, payload?: unknown): void;
  on(eventName: string, callback: (payload: unknown) => void): () => void;
}

export interface IGameFeature {
  initialize(context: FeatureContext): Promise<void> | void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface FeatureDefinition {
  id: string;
  dependencies?: readonly string[];
  defaultConfig?: Readonly<Record<string, unknown>>;
  create(): IGameFeature;
}

export type FeatureLifecycleState =
  | "created"
  | "initialized"
  | "running"
  | "stopped"
  | "disposed";
