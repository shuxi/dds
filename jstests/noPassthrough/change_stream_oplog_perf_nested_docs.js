// Benchmark: Change Stream vs Oplog Direct Read performance with deeply nested documents.
//
// Measures read throughput and latency for Change Stream (aggregation pipeline) versus
// direct oplog tailing, across varying document nesting depths and shapes.
//
// Requires a replica set since Change Stream needs oplog-based replication.
// @tags: [requires_getmore, requires_replication, requires_journaling]
(function() {
    "use strict";

    // === Configuration ===
    const DEPTHS = [5, 10, 20, 50, 100];
    const DOCS_PER_DEPTH = 1000;
    const BATCH_SIZE = 100;
    const WARMUP_DOCS = 100;
    const FIELDS_PER_LEVEL = 100;
    const SHAPES = ["singleKey", "multiField", "wide100"];

    // === Document generators ===

    /**
     * Single-key chain: {a: {a: {a: ... {a: 1}}}}
     */
    function makeNestedDocSingleKey(depth) {
        if (depth <= 1) {
            return {a: 1};
        }
        return {a: makeNestedDocSingleKey(depth - 1)};
    }

    /**
     * Multi-field wide: {a: 1, b: "str", c: 99, d: true, nested: {...}}
     */
    function makeNestedDocMultiField(depth) {
        if (depth <= 1) {
            return {a: 1, b: "hello", c: 42, d: true};
        }
        return {a: 1, b: "hello", c: 42, d: true, nested: makeNestedDocMultiField(depth - 1)};
    }

    /**
     * Very-wide per level: each level has 100 scalar fields plus a nested sub-document.
     * This avoids exponential growth while stressing large object materialization at each depth.
     */
    function makeNestedDocWide(depth, fieldsPerLevel) {
        const doc = {};
        for (let i = 0; i < fieldsPerLevel; i++) {
            doc["f" + i] = i;
        }
        if (depth <= 1) {
            return doc;
        }
        doc.nested = makeNestedDocWide(depth - 1, fieldsPerLevel);
        return doc;
    }

    function makeDoc(shape, depth) {
        if (shape === "singleKey") {
            return makeNestedDocSingleKey(depth);
        }
        if (shape === "wide100") {
            return makeNestedDocWide(depth, FIELDS_PER_LEVEL);
        }
        return makeNestedDocMultiField(depth);
    }

    // === Helpers ===

    /**
     * Get the latest oplog timestamp.
     */
    function getLatestOplogTs(primaryConn) {
        const localDB = primaryConn.getDB("local");
        const latest = localDB.oplog.rs.find().sort({$natural: -1}).limit(1).next();
        return latest.ts;
    }

    /**
     * Insert documents in batches, returning the array of inserted docs.
     */
    function insertInBatches(coll, docs) {
        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
            const batch = docs.slice(i, i + BATCH_SIZE);
            assert.commandWorked(coll.insert(batch, {ordered: false}));
        }
    }

    /**
     * Generate an array of N documents for a given shape/depth.
     */
    function generateDocs(shape, depth, count) {
        const docs = [];
        for (let i = 0; i < count; i++) {
            const doc = makeDoc(shape, depth);
            doc._id = depth + "_" + shape + "_" + i;
            docs.push(doc);
        }
        return docs;
    }

    /**
     * Read all expected events from a change stream cursor.
     * Returns {count, elapsedMs}.
     */
    function readAllChangeStreamEvents(cursor, expectedCount) {
        const start = new Date().getTime();
        let readCount = 0;
        while (readCount < expectedCount) {
            assert(cursor.hasNext(), "Change stream cursor exhausted at " + readCount +
                                         " events, expected " + expectedCount);
            cursor.next();
            readCount++;
        }
        const elapsed = new Date().getTime() - start;
        return {count: readCount, elapsedMs: elapsed};
    }

    /**
     * Read all expected entries from an oplog cursor.
     * Returns {count, elapsedMs}.
     */
    function readAllOplogEntries(cursor, expectedCount) {
        const start = new Date().getTime();
        let readCount = 0;
        while (readCount < expectedCount) {
            assert(cursor.hasNext(), "Oplog cursor exhausted at " + readCount +
                                         " entries, expected " + expectedCount);
            cursor.next();
            readCount++;
        }
        const elapsed = new Date().getTime() - start;
        return {count: readCount, elapsedMs: elapsed};
    }

    // === Main benchmark runner ===

    function runBenchmark(primaryConn, testDB, collName, depth, shape) {
        const coll = testDB[collName];

        // Clean slate
        coll.drop();
        assert.commandWorked(testDB.createCollection(collName));
        const collFullName = coll.getFullName();

        // Generate documents
        const docs = generateDocs(shape, depth, DOCS_PER_DEPTH);
        const sampleDoc = docs[0];
        const docSizeBytes = Object.bsonsize(sampleDoc);

        // --- TEST A: Change Stream Read ---
        // Important: the change stream cursor must be opened BEFORE inserting the documents we
        // expect to observe; change streams don't return historical events by default.
        const csCursor = coll.aggregate([{$changeStream: {}}]);

        // Warmup: insert a few docs to prime the collection
        const warmupDocs = [];
        for (let i = 0; i < WARMUP_DOCS; i++) {
            const doc = makeDoc(shape, depth);
            doc._id = "warmup_" + i;
            warmupDocs.push(doc);
        }
        insertInBatches(coll, warmupDocs);

        // Consume warmup events from change stream
        let warmupRead = 0;
        while (warmupRead < WARMUP_DOCS) {
            assert(csCursor.hasNext());
            csCursor.next();
            warmupRead++;
        }

        // Now insert benchmark docs and time reading from change stream
        const csInsertStart = new Date().getTime();
        insertInBatches(coll, docs);
        const csResult = readAllChangeStreamEvents(csCursor, DOCS_PER_DEPTH);
        const csTotalMs = (new Date().getTime() - csInsertStart);

        csCursor.close();

        // --- TEST B: Direct Oplog Read ---
        // Recreate the collection so Test B measures a clean insert workload and avoids duplicate
        // _id collisions from Test A.
        coll.drop();
        assert.commandWorked(testDB.createCollection(collName));

        // Record oplog position before inserts.
        const oplogTsBefore = getLatestOplogTs(primaryConn);

        const oplogInsertStart = new Date().getTime();
        insertInBatches(coll, docs);
        const oplogCursor = primaryConn.getDB("local").oplog.rs.find({
            op: "i",
            ns: collFullName,
            ts: {$gte: oplogTsBefore}
        }).sort({$natural: 1}).batchSize(1000);

        const oplogResult = readAllOplogEntries(oplogCursor, DOCS_PER_DEPTH);
        const oplogTotalMs = (new Date().getTime() - oplogInsertStart);

        oplogCursor.close();

        // --- Compute metrics ---
        const csThroughput = DOCS_PER_DEPTH / (csTotalMs / 1000);
        const oplogThroughput = DOCS_PER_DEPTH / (oplogTotalMs / 1000);
        const overheadPct = oplogTotalMs > 0
            ? ((csTotalMs - oplogTotalMs) / oplogTotalMs * 100)
            : 0;

        const result = {
            depth: depth,
            shape: shape,
            docSizeBytes: docSizeBytes,
            totalDocs: DOCS_PER_DEPTH,
            changeStreamMs: csTotalMs,
            changeStreamThroughput: Math.round(csThroughput),
            oplogMs: oplogTotalMs,
            oplogThroughput: Math.round(oplogThroughput),
            overheadPct: Math.round(overheadPct * 10) / 10
        };

        jsTestLog("Result: " + tojson(result));
        return result;
    }

    // === Run all combinations ===

    jsTestLog("=== Starting Change Stream vs Oplog Performance Benchmark ===");
    jsTestLog("Depths: " + tojson(DEPTHS) + ", Docs/depth: " + DOCS_PER_DEPTH +
              ", Shapes: " + tojson(SHAPES));

    const results = [];

    // This codebase configures mongod with an admin whitelist file by default. Ensure the file
    // exists so ReplSetTest can start nodes successfully in environments where mongod requires
    // the path to be present.
    // The whitelist parser expects at least one line (fgets must succeed). An empty line means
    // "match none/all" is controlled elsewhere; here we just need a valid file.
    removeFile("/tmp/adminWhiteList");
    writeFile("/tmp/adminWhiteList", "\n");

    const rst = new ReplSetTest({nodes: 1});

    rst.startSet();
    rst.initiate();

    const primary = rst.getPrimary();
    const testDB = primary.getDB(jsTestName());

    try {
        for (let shapeIdx = 0; shapeIdx < SHAPES.length; shapeIdx++) {
            const shape = SHAPES[shapeIdx];
            for (let depthIdx = 0; depthIdx < DEPTHS.length; depthIdx++) {
                const depth = DEPTHS[depthIdx];
                jsTestLog("--- Running: shape=" + shape + " depth=" + depth + " ---");
                results.push(runBenchmark(primary, testDB, "perf_cs_oplog_test", depth, shape));
            }
        }
    } finally {
        rst.stopSet();
    }

    // === Print summary table ===

    function padRight(str, len) {
        str = "" + str;
        while (str.length < len) {
            str = str + " ";
        }
        return str;
    }

    function padLeft(str, len) {
        str = "" + str;
        while (str.length < len) {
            str = " " + str;
        }
        return str;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) {
            return bytes + "B";
        }
        return (bytes / 1024).toFixed(1) + "KB";
    }

    function formatThroughput(tp) {
        return tp + "/s";
    }

    print("\n");
    print("=== Change Stream vs Oplog Performance: Deeply Nested Documents ===");
    print("Documents per test: " + DOCS_PER_DEPTH + ", Insert batch size: " + BATCH_SIZE);
    print("");
    print(padLeft("Depth", 6) + " | " + padRight("Shape", 10) + " | " +
          padRight("DocSize", 8) + " | " + padLeft("CS(ms)", 8) + " | " +
          padLeft("CS Tput", 10) + " | " + padLeft("Oplog(ms)", 10) + " | " +
          padLeft("Oplog Tput", 10) + " | " + padLeft("Overhead", 8));
    print("-".repeat(6) + "-+-" + "-".repeat(10) + "-+-" + "-".repeat(8) + "-+-" +
          "-".repeat(8) + "-+-" + "-".repeat(10) + "-+-" + "-".repeat(10) + "-+-" +
          "-".repeat(10) + "-+-" + "-".repeat(8));

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        print(padLeft(r.depth, 6) + " | " + padRight(r.shape, 10) + " | " +
              padRight(formatBytes(r.docSizeBytes), 8) + " | " +
              padLeft(r.changeStreamMs, 8) + " | " +
              padLeft(formatThroughput(r.changeStreamThroughput), 10) + " | " +
              padLeft(r.oplogMs, 10) + " | " +
              padLeft(formatThroughput(r.oplogThroughput), 10) + " | " +
              padLeft(r.overheadPct + "%", 8));
    }

    print("");
    print("=== Benchmark Complete ===");

    // Sanity checks
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        assert.gt(r.changeStreamMs,
                  0,
                  "Change stream time should be > 0 for depth=" + r.depth +
                      " shape=" + r.shape);
        assert.gt(r.oplogMs,
                  0,
                  "Oplog time should be > 0 for depth=" + r.depth + " shape=" + r.shape);
        assert.gt(r.docSizeBytes,
                  0,
                  "Document size should be > 0 for depth=" + r.depth + " shape=" + r.shape);
    }

    jsTestLog("All benchmarks completed and validated successfully.");
})();
