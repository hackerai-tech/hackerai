/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chats from "../chats.js";
import type * as crons from "../crons.js";
import type * as feedback from "../feedback.js";
import type * as fileActions from "../fileActions.js";
import type * as fileStorage from "../fileStorage.js";
import type * as memories from "../memories.js";
import type * as messages from "../messages.js";
import type * as tempStreams from "../tempStreams.js";
import type * as userCustomization from "../userCustomization.js";
import type * as userDeletion from "../userDeletion.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chats: typeof chats;
  crons: typeof crons;
  feedback: typeof feedback;
  fileActions: typeof fileActions;
  fileStorage: typeof fileStorage;
  memories: typeof memories;
  messages: typeof messages;
  tempStreams: typeof tempStreams;
  userCustomization: typeof userCustomization;
  userDeletion: typeof userDeletion;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
