// Compare Change Stream performance for deeply nested documents with backing BSON enabled/disabled.
//
// This is a perf-smoke test: it reports timings and ensures both modes work. It intentionally does
// not assert a strict performance ratio to avoid flakiness across environments.
//
// @tags: [requires_replication, requires_journaling]
(function() {
    "use strict";

    function deepLeafPath(depth) {
        // For depth=0, leaf is at top-level.
        let path = "";
        for (let i = 0; i < depth; ++i) {
            path += "a.";
        }
        return path + "leaf";
    }

    function makeWideDeepNestedDoc(depth, fieldsPerLevel, id) {
        // Each level has `fieldsPerLevel` fields: one child pointer field 'a' + (fieldsPerLevel-1)
        // scalar fields. This stresses serialization without requiring deep client-side traversal.
        let child = {leaf: 0};
        for (let level = 0; level < depth; ++level) {
            const obj = {a: child};
            for (let i = 0; i < fieldsPerLevel - 1; ++i) {
                obj["f" + i] = i;
            }
            child = obj;
        }

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

    // Keep depths below BSON max depth (typically 100) to avoid server-side depth rejection.
    // Default parameters are intentionally sized to make change stream event materialization and
    // server->client serialization cost dominate over fixed overheads (awaitData, getMore, replset).
    // They can be overridden via TestData.* when running in different environments.
    const depths =
        (typeof TestData !== "undefined" && TestData.backingBsonPerfDepths) || [30, 50, 70];
    const fieldsPerLevel =
        (typeof TestData !== "undefined" && TestData.backingBsonPerfFieldsPerLevel) || 100;
    const numDocs = (typeof TestData !== "undefined" && TestData.backingBsonPerfN) || 1000;
    const numUpdates =
        (typeof TestData !== "undefined" && TestData.backingBsonPerfUpdateN) || numDocs;

    function openChangeStream(coll, pipeline) {
        // Use a large batchSize to reduce getMore/network round-trips, which can drown out any
        // server-side serialization differences.
        return coll.aggregate(pipeline, {cursor: {batchSize: 1000}});
    }

    function runInsertOnce(enabled, depth) {
        setBackingBsonEnabled(testDB, enabled);

        const coll = testDB.getCollection("cs_backing_bson_perf_deep_nested_insert");
        coll.drop();
        assert.commandWorked(testDB.createCollection(coll.getName()));

        // Open the change stream before doing writes.
        const csCursor = openChangeStream(coll, [{$changeStream: {}}]);

        // Insert N documents with deep+wide structure.
        const bulk = coll.initializeUnorderedBulkOp();
        for (let i = 0; i < numDocs; ++i) {
            bulk.insert(makeWideDeepNestedDoc(depth, fieldsPerLevel, i));
        }
        assert.commandWorked(bulk.execute());

        // Only measure consumption time (server->client serialization + cursor iteration). The
        // write phase has substantial noise (journaling/replication/storage) that can hide the
        // expected backing BSON benefits.
        const start = Date.now();

        // Consume the N insert events. The cursor is tailable/awaitData, so use assert.soon()
        // rather than assuming immediate availability.
        for (let i = 0; i < numDocs; ++i) {
            assert.soon(() => csCursor.hasNext(),
                        "missing change stream event i=" + i,
                        60 * 1000);
            const evt = csCursor.next();
            assert.eq("insert", evt.operationType, "unexpected event: " + tojson(evt));
            assert.eq(i, evt.documentKey._id, "unexpected documentKey: " + tojson(evt));
            assert(evt.fullDocument, "expected fullDocument: " + tojson(evt));
        }

        const elapsedMs = Date.now() - start;
        csCursor.close();
        return elapsedMs;
    }

    function runUpdateLookupOnce(enabled, depth) {
        setBackingBsonEnabled(testDB, enabled);

        const coll = testDB.getCollection("cs_backing_bson_perf_deep_nested_updateLookup");
        coll.drop();
        assert.commandWorked(testDB.createCollection(coll.getName()));

        const leafPath = deepLeafPath(depth);

        const pipeline = [
            {$changeStream: {fullDocument: "updateLookup"}},
            // Keep this workload focused on producing + transmitting fullDocument, without forcing
            // a deep path traversal that can dominate runtime and mask serialization differences.
            {$project: {operationType: 1, documentKey: 1, fullDocument: 1}}
        ];
        const csCursor = openChangeStream(coll, pipeline);

        // Seed one document (we will ignore the insert event). Insert after opening the cursor so
        // we can reliably drain it.
        assert.commandWorked(coll.insert(makeWideDeepNestedDoc(depth, fieldsPerLevel, 0)));

        // Drain the seed insert event so the measured section only includes update events.
        assert.soon(() => csCursor.hasNext(), "missing seed insert event", 60 * 1000);
        csCursor.next();

        const start = Date.now();

        // For updateLookup, the server performs the document lookup when the client requests the
        // event. If we generate all updates first and consume later, each lookup can observe a
        // newer version of the document. To measure and validate accurately, interleave write and
        // read so each event's lookup occurs near its corresponding update.
        for (let i = 1; i <= numUpdates; ++i) {
            assert.commandWorked(coll.update({_id: 0}, {$set: {[leafPath]: i}}));

            assert.soon(() => csCursor.hasNext(),
                        "missing change stream update event i=" + i,
                        60 * 1000);
            const evt = csCursor.next();
            assert.eq("update", evt.operationType, "unexpected event: " + tojson(evt));
            assert.eq(0, evt.documentKey._id, "unexpected documentKey: " + tojson(evt));
            assert(evt.fullDocument, "expected fullDocument: " + tojson(evt));
        }

        const elapsedMs = Date.now() - start;
        csCursor.close();
        return elapsedMs;
    }

    function runUpdateLookupDeepProjectionOnce(enabled, depth) {
        setBackingBsonEnabled(testDB, enabled);

        const coll = testDB.getCollection("cs_backing_bson_perf_deep_nested_updateLookupDeepProj");
        coll.drop();
        assert.commandWorked(testDB.createCollection(coll.getName()));

        const leafPath = deepLeafPath(depth);
        const projectionPath = "$fullDocument." + leafPath;

        const pipeline = [
            {$changeStream: {fullDocument: "updateLookup"}},
            // Force a deep path lookup in the change stream output. This is expected to reduce or
            // eliminate backing BSON wins because it requires deep traversal/materialization.
            {$project: {operationType: 1, documentKey: 1, fullDocument: 1, deepLeaf: projectionPath}}
        ];
        const csCursor = openChangeStream(coll, pipeline);

        assert.commandWorked(coll.insert(makeWideDeepNestedDoc(depth, fieldsPerLevel, 0)));

        assert.soon(() => csCursor.hasNext(), "missing seed insert event", 60 * 1000);
        csCursor.next();

        const start = Date.now();

        for (let i = 1; i <= numUpdates; ++i) {
            assert.commandWorked(coll.update({_id: 0}, {$set: {[leafPath]: i}}));

            assert.soon(() => csCursor.hasNext(),
                        "missing change stream update event i=" + i,
                        60 * 1000);
            const evt = csCursor.next();
            assert.eq("update", evt.operationType, "unexpected event: " + tojson(evt));
            assert.eq(0, evt.documentKey._id, "unexpected documentKey: " + tojson(evt));
            assert(evt.fullDocument, "expected fullDocument: " + tojson(evt));
            assert(evt.deepLeaf !== undefined, "missing deepLeaf projection: " + tojson(evt));
            assert.eq(i, evt.deepLeaf, "unexpected deepLeaf projection: " + tojson(evt));
        }

        const elapsedMs = Date.now() - start;
        csCursor.close();
        return elapsedMs;
    }

    // Warm up to reduce first-run noise (both workloads).
    runInsertOnce(true, depths[0]);
    runInsertOnce(false, depths[0]);
    runUpdateLookupOnce(true, depths[0]);
    runUpdateLookupOnce(false, depths[0]);
    runUpdateLookupDeepProjectionOnce(true, depths[0]);
    runUpdateLookupDeepProjectionOnce(false, depths[0]);

    for (let idx = 0; idx < depths.length; ++idx) {
        const d = depths[idx];
        const enabledInsertMs = runInsertOnce(true, d);
        const disabledInsertMs = runInsertOnce(false, d);

        jsTestLog("[backing_bson_perf_insert] depth=" + d + " fieldsPerLevel=" + fieldsPerLevel +
                  " N=" + numDocs +
                  " enabledMs=" + enabledInsertMs + " disabledMs=" + disabledInsertMs +
                  " speedup=" +
                      (disabledInsertMs / Math.max(1, enabledInsertMs)).toFixed(2) + "x");

        const enabledUpdateMs = runUpdateLookupOnce(true, d);
        const disabledUpdateMs = runUpdateLookupOnce(false, d);

        jsTestLog("[backing_bson_perf_updateLookup] depth=" + d + " fieldsPerLevel=" + fieldsPerLevel +
                  " N=" + numUpdates +
                  " enabledMs=" + enabledUpdateMs + " disabledMs=" + disabledUpdateMs +
                  " speedup=" +
                      (disabledUpdateMs / Math.max(1, enabledUpdateMs)).toFixed(2) + "x");

        const enabledDeepUpdateMs = runUpdateLookupDeepProjectionOnce(true, d);
        const disabledDeepUpdateMs = runUpdateLookupDeepProjectionOnce(false, d);

        jsTestLog("[backing_bson_perf_updateLookupDeepProj] depth=" + d +
                  " fieldsPerLevel=" + fieldsPerLevel +
                  " N=" + numUpdates +
                  " enabledMs=" + enabledDeepUpdateMs + " disabledMs=" + disabledDeepUpdateMs +
                  " speedup=" +
                      (disabledDeepUpdateMs / Math.max(1, enabledDeepUpdateMs)).toFixed(2) + "x");
    }

    rst.stopSet();
})();

