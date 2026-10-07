import {
  type ChangeRequestEventContext,
  type CodeHostCoordinates,
  parseChangeRequestEventContext,
} from "../types.js";
import type { CodeHostEvent, CodeHostEvents, LoadedChangeRequest } from "./types.js";

type ChangeRequestLookup = Parameters<CodeHostEvents["loadChangeRequest"]>[0];

/** Returns the change coordinates for `provider`, or throws `${label} adapter requires ${coordinatesLabel} coordinates`. */
export function requireCoordinates<Provider extends CodeHostCoordinates["provider"]>(
  change: Pick<ChangeRequestEventContext, "coordinates">,
  provider: Provider,
  label: string,
  coordinatesLabel = label,
): Extract<CodeHostCoordinates, { provider: Provider }> {
  const coordinates = change.coordinates;
  if (coordinates?.provider !== provider) {
    throw new Error(`${label} adapter requires ${coordinatesLabel} coordinates`);
  }
  return coordinates as Extract<CodeHostCoordinates, { provider: Provider }>;
}

/** Copies the event identity from a `loadChangeRequest` lookup onto a freshly loaded change. */
export function withEventRef(
  loaded: LoadedChangeRequest,
  ref: ChangeRequestLookup,
): LoadedChangeRequest {
  return {
    ...loaded,
    eventName: ref.eventName,
    action: ref.action,
    rawAction: ref.rawAction,
    workspace: ref.workspace,
  };
}

export function draftEvent(): CodeHostEvent {
  return { kind: "ignored", reason: "pull request is a draft" };
}

export function changeRequestEvent(
  loaded: LoadedChangeRequest,
  native: {
    eventName: string;
    action?: string;
    rawAction?: string;
    platform: ChangeRequestEventContext["platform"];
    workspace: string;
  },
): CodeHostEvent {
  return {
    kind: "change-request",
    change: parseChangeRequestEventContext({
      eventName: native.eventName,
      action: native.action,
      rawAction: native.rawAction,
      platform: native.platform,
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: native.workspace,
    }),
  };
}
