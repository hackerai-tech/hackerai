/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as chats from "../chats.js";
import type * as feedback from "../feedback.js";
import type * as fileActions from "../fileActions.js";
import type * as fileStorage from "../fileStorage.js";
import type * as memories from "../memories.js";
import type * as messages from "../messages.js";
import type * as userCustomization from "../userCustomization.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  chats: typeof chats;
  feedback: typeof feedback;
  fileActions: typeof fileActions;
  fileStorage: typeof fileStorage;
  memories: typeof memories;
  messages: typeof messages;
  userCustomization: typeof userCustomization;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
