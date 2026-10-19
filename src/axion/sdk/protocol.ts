export interface AXIONTaskRequestPayload {
  task: string;
  taskId: string;
  payload: Record<string, unknown>;
}

export type AXIONTaskResponseStatus =
  | "accepted"
  | "assigned"
  | "matched"
  | "no_match"
  | "completed";

export interface AXIONTaskResponse {
  taskId: string;
  status: AXIONTaskResponseStatus;
  data?: unknown;
}

export interface AXIONTaskFailure {
  taskId: string;
  error: {
    code: string;
    message: string;
  };
}
