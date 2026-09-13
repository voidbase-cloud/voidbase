import Client from "@/Client";
import { RecordService } from "@/services/RecordService";
import { RecordModel } from "@/tools/dtos";

/**
 * A map of collection names to their record types.
 *
 * This is the shape of the `Collections` interface that `voidbase types`
 * writes (one record interface per collection, keyed by collection name).
 */
export type CollectionMap = Record<string, RecordModel>;

/**
 * The collection map of a client that knows nothing about its instance:
 * every name answers an untyped RecordModel.
 */
export type AnyCollections = CollectionMap;

/**
 * The constraint a collection map has to meet: every value is a RecordModel.
 *
 * It is written as a mapped type over C rather than as `CollectionMap`
 * itself because an interface (which is what `voidbase types` generates)
 * has no index signature and so never satisfies `Record<string, RecordModel>`,
 * while it does satisfy a constraint that only looks at its own keys.
 */
export type CollectionMapOf<C> = { [K in keyof C]: RecordModel };

/**
 * The PocketBase client with `collection()` narrowed to the collections of
 * one instance.
 *
 * Pair it with the file that `voidbase types` writes:
 *
 * ```ts
 * import { VoidBase } from "@voidbase-cloud/sdk";
 * import type { Collections } from "./voidbase";
 *
 * const pb = new VoidBase<Collections>("https://example.com");
 *
 * const post = await pb.collection("posts").getOne("RECORD_ID"); // PostsRecord
 * post.titel; // compile error: the field is `title`
 * ```
 *
 * A name the map does not know answers an untyped `RecordService<RecordModel>`,
 * the same as the plain client, so system collections such as `_superusers`
 * keep working. Without a type argument every name is untyped.
 */
export class VoidBase<C extends CollectionMapOf<C> = AnyCollections> extends Client {
    /**
     * Returns the RecordService of a collection the map knows, typed with
     * its record.
     */
    collection<K extends keyof C & string>(name: K): RecordService<C[K]>;

    /**
     * Returns the RecordService of any other collection, untyped
     * (or typed with the explicit generic, as the plain client allows).
     */
    collection<M = RecordModel>(name: string): RecordService<M>;

    collection(name: string): RecordService<any> {
        return super.collection(name);
    }
}
