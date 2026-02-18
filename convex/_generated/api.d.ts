/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as aggregateVersions from "../aggregateVersions.js";
import type * as chatStreams from "../chatStreams.js";
import type * as chats from "../chats.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as extraUsage from "../extraUsage.js";
import type * as extraUsageActions from "../extraUsageActions.js";
import type * as feedback from "../feedback.js";
import type * as fileActions from "../fileActions.js";
import type * as fileAggregate from "../fileAggregate.js";
import type * as fileStorage from "../fileStorage.js";
import type * as lib_logger from "../lib/logger.js";
import type * as lib_utils from "../lib/utils.js";
import type * as localSandbox from "../localSandbox.js";
import type * as memories from "../memories.js";
import type * as messages from "../messages.js";
import type * as notes from "../notes.js";
import type * as rateLimitStatus from "../rateLimitStatus.js";
import type * as redisPubsub from "../redisPubsub.js";
import type * as s3Actions from "../s3Actions.js";
import type * as s3Cleanup from "../s3Cleanup.js";
import type * as s3Utils from "../s3Utils.js";
import type * as sharedChats from "../sharedChats.js";
import type * as tempStreams from "../tempStreams.js";
import type * as userCustomization from "../userCustomization.js";
import type * as userDeletion from "../userDeletion.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  aggregateVersions: typeof aggregateVersions;
  chatStreams: typeof chatStreams;
  chats: typeof chats;
  constants: typeof constants;
  crons: typeof crons;
  extraUsage: typeof extraUsage;
  extraUsageActions: typeof extraUsageActions;
  feedback: typeof feedback;
  fileActions: typeof fileActions;
  fileAggregate: typeof fileAggregate;
  fileStorage: typeof fileStorage;
  "lib/logger": typeof lib_logger;
  "lib/utils": typeof lib_utils;
  localSandbox: typeof localSandbox;
  memories: typeof memories;
  messages: typeof messages;
  notes: typeof notes;
  rateLimitStatus: typeof rateLimitStatus;
  redisPubsub: typeof redisPubsub;
  s3Actions: typeof s3Actions;
  s3Cleanup: typeof s3Cleanup;
  s3Utils: typeof s3Utils;
  sharedChats: typeof sharedChats;
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

export declare const components: {
  fileCountByUser: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
};
