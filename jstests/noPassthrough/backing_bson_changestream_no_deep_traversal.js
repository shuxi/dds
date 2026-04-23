// Verify that deeply nested BSON documents are propagated through Change Streams using backing BSON
// fast-path serialization (no deep traversal) all the way to the client.
//
// @tags: [requires_replication, requires_journaling]
(function() {
    "use strict";

    function makeDeepNestedDoc(depth) {
        let doc = {leaf: 1};
        for (let i = 0; i < depth; ++i) {
            doc = {a: doc};
        }
        return doc;
    }

    // This codebase configures mongod with an admin whitelist file by default in some environments.
    removeFile("/tmp/adminWhiteList");
    writeFile("/tmp/adminWhiteList", "\n");

    const rst = new ReplSetTest({nodes: 1});
    rst.startSet();
    rst.initiate();

    const primary = rst.getPrimary();
    const testDB = primary.getDB(jsTestName());
    const coll = testDB.getCollection("cs_backing_bson_deep_nested");
    coll.drop();

    assert.commandWorked(testDB.createCollection(coll.getName()));

    // Open the change stream before the insert to observe the event.
    const csCursor = coll.aggregate([{$changeStream: {}}]);

    // Keep depth below BSON max depth (typically 100) to avoid server-side depth rejection.
    const deepDoc = makeDeepNestedDoc(50);
    deepDoc._id = 1;
    deepDoc.top = "t";

    assert.commandWorked(coll.insert(deepDoc));

    assert(csCursor.hasNext(), "expected an insert event in change stream");
    const evt = csCursor.next();

    assert.eq("insert", evt.operationType, "unexpected change stream event: " + tojson(evt));
    assert.eq(deepDoc._id, evt.documentKey._id, "documentKey mismatch: " + tojson(evt));
    assert(evt.fullDocument, "expected fullDocument for insert event: " + tojson(evt));
    assert.eq("t", evt.fullDocument.top, "fullDocument top field mismatch: " + tojson(evt));

    csCursor.close();
    rst.stopSet();
})();

