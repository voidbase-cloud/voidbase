import { describe, assert, test } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import Client from "@/Client";
import { VoidBase } from "@/VoidBase";
import { RecordService } from "@/services/RecordService";
import { existsSync } from "node:fs";

describe("VoidBase", function () {
    describe("collection()", function () {
        test("Should return a RecordService bound to the collection name", function () {
            const pb = new VoidBase("test_base_url");

            const posts = pb.collection("posts");
            const users = pb.collection("users");

            assert.instanceOf(posts, RecordService);
            assert.instanceOf(users, RecordService);
            assert.equal(posts.collectionIdOrName, "posts");
            assert.equal(users.collectionIdOrName, "users");
            assert.equal(posts.baseCrudPath, "/api/collections/posts/records");
            assert.equal(posts.client, pb);

            // the same instance on repeated calls, as the plain client caches it
            assert.equal(pb.collection("posts"), posts);
            assert.notEqual(posts, users);
        });

        test("Should be a Client", function () {
            const pb = new VoidBase("test_base_url", null, "test_language");

            assert.instanceOf(pb, Client);
            assert.equal(pb.baseURL, "test_base_url");
            assert.equal(pb.lang, "test_language");
            assert.equal(pb.buildURL("/api/health"), "test_base_url/api/health");
        });
    });

    describe("types", function () {
        test("Should make a wrong field a compile error (tests/VoidBase.types.ts)", function () {
            // this package's own install, or the workspace root's when it is installed as part of the monorepo
            const tsc = [resolve(__dirname, "../node_modules/typescript/bin/tsc"), resolve(__dirname, "../../../node_modules/typescript/bin/tsc")].find((f) => existsSync(f)) ?? resolve(__dirname, "../node_modules/typescript/bin/tsc");
            const project = resolve(__dirname, "./tsconfig.types.json");

            // tsc exits non-zero on any error, including an unused
            // @ts-expect-error, which is how the fixture proves the wrong
            // field errors; the output is the assertion message on failure
            let output = "";
            try {
                output = execFileSync(process.execPath, [tsc, "-p", project], {
                    encoding: "utf8",
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch (err: any) {
                assert.fail(String(err.stdout || err.stderr || err));
            }

            assert.equal(output.trim(), "");
        }, 60000);
    });
});
