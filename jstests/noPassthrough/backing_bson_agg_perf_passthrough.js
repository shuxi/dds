// Measure aggregation pass-through performance with backing BSON enabled/disabled.
//
// Goal: validate that backing BSON provides measurable wins in a workload that:
// - materializes BSON into Document internally (aggregation pipeline)
// - does not logically modify the document (so Document::toBson() can take the fast path)
// - must serialize large documents back to the client
//
// This is a perf-smoke test: it logs timings and validates correctness, but does not assert a
// strict ratio to avoid flakiness across environments.
//
// @tags: [requires_replication, requires_journaling]
(function() {
    "use strict";

    function makeWideDeepNestedDoc(depth, fieldsPerLevel, id) {
        let child = {leaf: 0};
        for (let level = 0; level < depth; ++level) {
            const obj = {a: child};
            for (let i = 0; i < fieldsPerLevel - 1; ++i) {
                obj["f" + level + "_" + i] = i;
            }
            child = obj;
        }
        // Put _id at the top-level so the server can validate results without deep access.
        child._id = id;
        child.top = "t";
        return child;
    }

    function setBackingBsonEnabled(db, enabled) {
        assert.commandWorked(db.adminCommand(
            {setParameter: 1, internalDocumentUseBackingBson: enabled}));
        const got = assert.commandWorked(db.adminCommand(
            {getParameter: 1, internalDocumentUseBackingBson: 1}));
        assert.eq(enabled, got.internalDocumentUseBackingBson,
                  "failed to set internalDocumentUseBackingBson");
    }

    function openAggCursor(coll, pipeline) {
        // Large batchSize reduces network/getMore overhead to keep measurements focused on
        // server-side materialization/serialization.
        return coll.aggregate(pipeline, {cursor: {batchSize: 1000}});
    }

    // This codebase configures mongod with an admin whitelist file by default in some environments.
    removeFile("/tmp/adminWhiteList");
    writeFile("/tmp/adminWhiteList", "\n");

    // Some environments (e.g. containers) may not allow writing to /data/db. Override MongoRunner
    // paths to a writable temp directory for this test.
    mkdir("/tmp/mongorunner");
    const localDataPath = "/tmp/mongorunner/" + jsTestName() + "/";
    resetDbpath(localDataPath);
    MongoRunner.dataDir = localDataPath.endsWith("/") ? localDataPath.slice(0, -1) : localDataPath;
    MongoRunner.dataPath = localDataPath;

    const rst = new ReplSetTest({nodes: 1});
    rst.startSet();
    rst.initiate();

    const primary = rst.getPrimary();
    const testDB = primary.getDB(jsTestName());
    const coll = testDB.getCollection("backing_bson_agg_perf_passthrough");
    coll.drop();
    assert.commandWorked(testDB.createCollection(coll.getName()));

    // Parameter grids (override via TestData.*).
    // Keep these moderate by default; increase locally if you want clearer signal.
    const depths = (typeof TestData !== "undefined" && TestData.backingBsonAggPerfDepths) || [20, 50, 70];
    const fieldsPerLevelList =
        (typeof TestData !== "undefined" && TestData.backingBsonAggPerfFieldsPerLevelList) || [40, 120];
    const Ns = (typeof TestData !== "undefined" && TestData.backingBsonAggPerfNs) || [500, 3000];

    const maxN = Ns.reduce((a, b) => Math.max(a, b), 0);

    // Use a pipeline that forces aggregation to run, but does not modify the document contents.
    // A $match stage is the lightest-weight pipeline stage that still routes through the agg
    // machinery and its Document/BSON conversion/serialization path.
    function makePipelineForN(n) {
        return [{$match: {_id: {$lt: n}}}];
    }

    function warmOnce(pipeline) {
        const warm = openAggCursor(coll, pipeline);
        assert(warm.hasNext());
        warm.next();
        warm.close();
    }

    function runOnce(enabled, n, pipeline) {
        setBackingBsonEnabled(testDB, enabled);

        warmOnce(pipeline);

        const cursor = openAggCursor(coll, pipeline);
        const start = Date.now();

        let seen = 0;
        while (cursor.hasNext()) {
            const doc = cursor.next();
            // Touch a shallow field to ensure the client actually materializes the JS object.
            assert.eq("t", doc.top);
            seen++;
        }

        const elapsedMs = Date.now() - start;
        cursor.close();
        assert.eq(n, seen, "unexpected doc count");
        return elapsedMs;
    }

    for (let di = 0; di < depths.length; ++di) {
        const depth = depths[di];
        for (let fi = 0; fi < fieldsPerLevelList.length; ++fi) {
            const fieldsPerLevel = fieldsPerLevelList[fi];

            coll.drop();
            assert.commandWorked(testDB.createCollection(coll.getName()));

            // Bulk insert max dataset once for this (depth, fieldsPerLevel).
            const bulk = coll.initializeUnorderedBulkOp();
            for (let i = 0; i < maxN; ++i) {
                bulk.insert(makeWideDeepNestedDoc(depth, fieldsPerLevel, i));
            }
            assert.commandWorked(bulk.execute());

            // Warm up both modes once on the smallest N to reduce first-run noise.
            const warmN = Ns[0];
            const warmPipeline = makePipelineForN(warmN);
            runOnce(false, warmN, warmPipeline);
            runOnce(true, warmN, warmPipeline);

            for (let ni = 0; ni < Ns.length; ++ni) {
                const n = Ns[ni];
                const pipeline = makePipelineForN(n);

                const disabledMs = runOnce(false, n, pipeline);
                const enabledMs = runOnce(true, n, pipeline);

                jsTestLog("[backing_bson_agg_perf_passthrough] depth=" + depth +
                          " fieldsPerLevel=" + fieldsPerLevel +
                          " N=" + n +
                          " enabledMs=" + enabledMs + " disabledMs=" + disabledMs +
                          " speedup=" + (disabledMs / Math.max(1, enabledMs)).toFixed(2) + "x");
            }
        }
    }

    rst.stopSet();
})();

