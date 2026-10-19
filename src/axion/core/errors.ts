export class AXIONAggregateError extends Error {
  constructor(readonly errors: readonly unknown[], message: string) {
    super(message);
    this.name = "AXIONAggregateError";
  }
}
