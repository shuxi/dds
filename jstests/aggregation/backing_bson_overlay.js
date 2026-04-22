/**
 * Backing BSON regression tests.
 *
 * This test focuses on externally observable semantics that can regress when backing BSON is
 * introduced: field order stability, overlay behavior (overwrite/delete/add), nested updates, and
 * metadata ($textScore) not leaking unless explicitly projected.
 */
(function() {
    "use strict";

    const testDB = db.getSiblingDB("test");
    const coll = testDB.getCollection("backing_bson_overlay");
    coll.drop();

    assert.commandWorked(coll.createIndex({a: 1}));

    assert.writeOK(coll.insert({
        _id: 1,
        a: 1,
        b: 2,
        obj: {x: 1, y: 2},
        arr: [1, 2],
        z: "tail"
    }));

    function keys(doc) {
        return Object.keys(doc);
    }

    function assertKeyOrder(doc, expectedKeys) {
        assert.eq(expectedKeys, keys(doc), "unexpected field order: " + tojson(doc));
    }

    function assertKeysEndWith(doc, expectedSuffixKeys) {
        const actualKeys = keys(doc);
        const suffix = actualKeys.slice(actualKeys.length - expectedSuffixKeys.length);
        assert.eq(expectedSuffixKeys, suffix, "unexpected suffix field order: " + tojson(doc));
    }

    // 1) Unmodified pass-through should preserve field order and values.
    {
        const doc = coll.aggregate([{$match: {_id: 1}}]).toArray()[0];
        assert(doc, "expected one result");
        assertKeyOrder(doc, ["_id", "a", "b", "obj", "arr", "z"]);
        assert.eq(1, doc.a);
        assert.eq(2, doc.b);
        assert.eq({x: 1, y: 2}, doc.obj);
        assert.eq([1, 2], doc.arr);
        assert.eq("tail", doc.z);
    }

    // 2) Overlay behavior: overwrite existing field, delete existing field, add new fields.
    // Also include nested update to ensure merge serialization remains correct.
    {
        const out = coll.aggregate([
                           {$match: {_id: 1}},
                           // MongoDB 4.0 does not support $set/$unset stages; use $addFields/$project.
                           {$addFields: {a: 999, "obj.x": 42}},
                           {$project: {b: 0}},
                           {$addFields: {newField: "new", newObj: {k: 1}}},
                       ])
                       .toArray()[0];

        assert(out, "expected one result");
        assert.eq(999, out.a);
        assert(!out.hasOwnProperty("b"), "expected 'b' to be removed: " + tojson(out));
        assert.eq({x: 42, y: 2}, out.obj);
        assert.eq("new", out.newField);
        assert.eq({k: 1}, out.newObj);

        // New fields should appear at the tail (MongoDB 4.0 semantics for $addFields).
        // $project may change field order depending on projection implementation, so only enforce
        // the suffix order here.
        assertKeysEndWith(out, ["newField", "newObj"]);
    }

    // 3) Metadata ($textScore) should not leak unless explicitly projected.
    coll.drop();
    assert.writeOK(coll.insert({_id: 1, text: "cakes and cookies", keep: 1}));
    assert.writeOK(coll.insert({_id: 2, text: "cakes only", keep: 1}));
    assert.commandWorked(coll.createIndex({text: "text"}));

    // Without explicit $meta projection, no $textScore field should be present.
    {
        const docs = coll.aggregate([{$match: {$text: {$search: "cakes"}}}]).toArray();
        assert.gte(docs.length, 1, "expected at least one $text match");
        docs.forEach(d => {
            assert(!d.hasOwnProperty("$textScore"),
                   "should not expose $textScore to user: " + tojson(d));
        });
    }

    // With explicit projection, 'score' should exist and be numeric.
    {
        const docs = coll.aggregate([
                           {$match: {$text: {$search: "cakes"}}},
                           {$project: {_id: 1, keep: 1, score: {$meta: "textScore"}}},
                       ])
                       .toArray();

        assert.gte(docs.length, 1, "expected at least one $text match");
        docs.forEach(d => {
            assert(d.hasOwnProperty("score"), "expected 'score' field: " + tojson(d));
            assert.eq("number", typeof d.score, "expected numeric score: " + tojson(d));
            assert.eq(1, d.keep, "expected projected keep field: " + tojson(d));
            assert(!d.hasOwnProperty("$textScore"),
                   "internal $textScore should never leak: " + tojson(d));
        });
    }

    // 4) Dependency pruning / narrow projection: only a small subset of fields should be
    // materialized/returned, and missing fields should behave as missing (not present).
    {
        coll.drop();
        const bigDoc = {_id: 1, a: 1, z: "tail"};
        for (let i = 0; i < 50; ++i) {
            bigDoc["f" + i] = i;
        }
        assert.writeOK(coll.insert(bigDoc));

        const out = coll.aggregate([
                           {$match: {_id: 1}},
                           {$project: {_id: 1, a: 1}},
                       ])
                       .toArray()[0];
        assert(out, "expected one result");
        assert.eq(1, out._id);
        assert.eq(1, out.a);
        assert.eq(["_id", "a"], keys(out), "expected projection to return only _id and a");
        assert(!out.hasOwnProperty("z"), "projected-out field should be absent: " + tojson(out));
        assert(!out.hasOwnProperty("f0"), "projected-out field should be absent: " + tojson(out));
    }

    // 5) Broader BSON type coverage: ensure pass-through serialization does not corrupt types.
    {
        coll.drop();
        const oid = ObjectId("0123456789abcdef01234567");
        const dt = ISODate("2020-01-01T00:00:00Z");
        const bin = BinData(0, "AQID");  // 0x01 0x02 0x03
        const ts = Timestamp(1, 2);
        assert.writeOK(coll.insert({
            _id: 1,
            oid: oid,
            dt: dt,
            bin: bin,
            ts: ts,
            min: MinKey,
            max: MaxKey,
            nested: {n: 1},
            arr: [1, {x: 1}]
        }));

        const out = coll.aggregate([{$match: {_id: 1}}]).toArray()[0];
        assert(out, "expected one result");

        // Compare via tojson for types with tricky JS equality semantics.
        assert.eq(tojson(oid), tojson(out.oid), "OID mismatch: " + tojson(out));
        assert.eq(tojson(dt), tojson(out.dt), "Date mismatch: " + tojson(out));
        assert.eq(tojson(bin), tojson(out.bin), "BinData mismatch: " + tojson(out));
        assert.eq(tojson(ts), tojson(out.ts), "Timestamp mismatch: " + tojson(out));
        assert.eq(tojson(MinKey), tojson(out.min), "MinKey mismatch: " + tojson(out));
        assert.eq(tojson(MaxKey), tojson(out.max), "MaxKey mismatch: " + tojson(out));
        assert.eq({n: 1}, out.nested);
        assert.eq([1, {x: 1}], out.arr);
    }
})();

