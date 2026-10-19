export class StateStore {
  private readonly scopes = new Map<string, Map<string, unknown>>();

  set<T>(scope: string, key: string, value: T): void {
    assertKey(scope, "scope");
    assertKey(key, "key");
    const values = this.scopes.get(scope) ?? new Map<string, unknown>();
    values.set(key, value);
    this.scopes.set(scope, values);
  }

  get<T>(scope: string, key: string): T | undefined {
    return this.scopes.get(scope)?.get(key) as T | undefined;
  }

  delete(scope: string, key: string): boolean {
    const values = this.scopes.get(scope);
    if (!values) return false;
    const deleted = values.delete(key);
    if (values.size === 0) this.scopes.delete(scope);
    return deleted;
  }

  clearScope(scope: string): void {
    this.scopes.delete(scope);
  }

  listScope(scope: string): ReadonlyMap<string, unknown> {
    return new Map(this.scopes.get(scope) ?? []);
  }
}

function assertKey(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be a non-empty string`);
}
