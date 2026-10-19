/**
 * Core.status — publish and read the current client status.
 *
 * The status is cached locally and, when the transport is connected, pushed
 * to the Central Core via a `client.status` message.
 */

import { err } from "../errors";
import {
  CLIENT_STATES,
  type ClientState,
  type IStatusApi,
  type StatusSnapshot,
  type StatusUpdate,
} from "../types";
import { assertFiniteNumber, assertOneOf, assertRange, assertString } from "../validation/validators";
import type { ICoreTransport } from "../transport/ICoreTransport";
import { createEnvelope } from "../transport/ICoreTransport";

export interface StatusApiDeps {
  transport: ICoreTransport;
  now: () => number;
  uuid: () => string;
  clientId: () => string | null;
  /** Called whenever status changes; used to fan out `core.status` events. */
  onChanged?: (snapshot: StatusSnapshot) => void;
}

const PROGRESS_MIN = 0;
const PROGRESS_MAX = 100;

export function createStatusApi(deps: StatusApiDeps): IStatusApi {
  let snapshot: StatusSnapshot = {
    state: "initializing",
    message: "",
    progress: 0,
    updatedAt: deps.now(),
  };

  function publish(next: StatusSnapshot): void {
    const previous = snapshot;
    snapshot = next;
    deps.onChanged?.(snapshot);
    // Best-effort push to the Central Core. Errors are surfaced to the caller
    // via the onChanged handler; the API itself does not throw for status.
    if (deps.transport.getState() === "connected") {
      const envelope = createEnvelope(
        "client.status",
        {
          state: next.state,
          message: next.message,
          progress: next.progress,
        },
        { id: deps.uuid(), clientId: deps.clientId() ?? undefined },
      );
      void deps.transport.send(envelope).catch(() => {
        /* transport errors are reported through core.error by the client api */
      });
    }
    void previous;
  }

  function applyUpdate(update: StatusUpdate): void {
    const next: StatusSnapshot = { ...snapshot, updatedAt: deps.now() };
    if (update.state !== undefined) {
      next.state = assertOneOf(update.state, CLIENT_STATES, "state");
    }
    if (update.message !== undefined) {
      next.message = assertString(update.message, "message", { allowEmpty: true });
    }
    if (update.progress !== undefined) {
      const p = assertFiniteNumber(update.progress, "progress");
      assertRange(p, PROGRESS_MIN, PROGRESS_MAX, "progress");
      next.progress = p;
    }
    publish(next);
  }

  return {
    update(update) {
      if (update === null || typeof update !== "object" || Array.isArray(update)) {
        throw err.invalidArgument("status update must be an object");
      }
      applyUpdate(update as StatusUpdate);
    },
    get() {
      return { ...snapshot };
    },
    setState(state) {
      applyUpdate({ state: assertOneOf(state, CLIENT_STATES, "state") });
    },
    setProgress(progress) {
      const p = assertFiniteNumber(progress, "progress");
      assertRange(p, PROGRESS_MIN, PROGRESS_MAX, "progress");
      applyUpdate({ progress: p });
    },
    setMessage(message) {
      applyUpdate({ message: assertString(message, "message", { allowEmpty: true }) });
    },
  };
}

export type { ClientState };