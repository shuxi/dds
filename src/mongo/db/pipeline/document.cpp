/**
 * Copyright (c) 2011 10gen Inc.
 *
 * This program is free software: you can redistribute it and/or  modify
 * it under the terms of the GNU Affero General Public License, version 3,
 * as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * As a special exception, the copyright holders give permission to link the
 * code of portions of this program with the OpenSSL library under certain
 * conditions as described in each individual source file and distribute
 * linked combinations including the program with the OpenSSL library. You
 * must comply with the GNU Affero General Public License in all respects for
 * all of the code used other than as permitted herein. If you modify file(s)
 * with this exception, you may extend this exception to your version of the
 * file(s), but you are not obligated to do so. If you do not wish to do so,
 * delete this exception statement from your version. If you delete this
 * exception statement from all source files in the program, then also delete
 * it in the license file.
 */

#include "mongo/platform/basic.h"

#include "mongo/db/pipeline/document.h"

#include <boost/functional/hash.hpp>

#include "mongo/bson/bson_depth.h"
#include "mongo/db/jsobj.h"
#include "mongo/db/pipeline/field_path.h"
#include "mongo/util/mongoutils/str.h"

namespace mongo {
using namespace mongoutils;
using boost::intrusive_ptr;
using std::string;
using std::vector;

namespace {
bool isMetadataField(StringData fieldName);
}  // namespace

const DocumentStorage DocumentStorage::kEmptyDoc;

const std::vector<StringData> Document::allMetadataFieldNames = {
    Document::metaFieldTextScore, Document::metaFieldRandVal, Document::metaFieldSortKey};

Position DocumentStorage::findField(StringData requested) const {
    Position pos = findFieldInCache(requested);
    if (pos.found()) {
        return pos;
    }

    if (materializeUntil(requested)) {
        return findFieldInCache(requested);
    }

    return Position();
}

Position DocumentStorage::findFieldInCache(StringData requested) const {
    int reqSize = requested.size();  // get size calculation out of the way if needed

    if (_numFields >= HASH_TAB_MIN) {  // hash lookup
        const unsigned bucket = bucketForKey(requested);

        Position pos = _hashTab[bucket];
        while (pos.found()) {
            const ValueElement& elem = getField(pos);
            if (elem.nameLen == reqSize && memcmp(requested.rawData(), elem._name, reqSize) == 0) {
                return pos;
            }

            // possible collision
            pos = elem.nextCollision;
        }
    } else {  // linear scan
        for (DocumentStorageIterator it = iteratorAll(); !it.atEnd(); it.advance()) {
            if (it->nameLen == reqSize && memcmp(requested.rawData(), it->_name, reqSize) == 0) {
                return it.position();
            }
        }
    }

    // if we got here, there's no such field
    return Position();
}

void DocumentStorage::setBackingBson(BSONObj bson) {
    initFromBson(bson);
}

size_t DocumentStorage::size() const {
    if (!hasBackingBson()) {
        // Cache-only: can't use _numFields because it includes removed fields.
        size_t count = 0;
        for (DocumentStorageIterator it = iterator(); !it.atEnd(); it.advance()) {
            count++;
        }
        return count;
    }

    // With backing BSON: start from backing field count, then apply overlay adjustments.
    size_t count = _numBsonFields;
    for (DocumentStorageIterator it = iteratorAll(); !it.atEnd(); it.advance()) {
        if (it->fromBson) {
            if (it->val.missing()) {
                count--;
            }
        } else {
            if (!it->val.missing()) {
                count++;
            }
        }
    }
    return count;
}

void DocumentStorage::makeOwned() const {
    if (_bson.isEmpty() || _bson.isOwned()) {
        return;
    }

    const char* oldObjData = _bson.objdata();
    const char* oldIt = _bsonIt;

    _bson = _bson.getOwned();

    if (oldIt) {
        _bsonIt = _bson.objdata() + (oldIt - oldObjData);
    } else {
        _bsonIt = _bson.isEmpty() ? nullptr : _bson.objdata() + 4;
    }
}

void DocumentStorage::initFromBson(const BSONObj& bson) {
    _bson = bson.getOwned();
    _bsonIt = _bson.isEmpty() ? nullptr : _bson.objdata() + 4;
    _modified = false;

    _bsonHasMetadata = false;
    _stripMetadata = false;
    _numBsonFields = _bson.isEmpty() ? 0U : static_cast<uint32_t>(_bson.nFields());
}

void DocumentStorage::initFromBsonWithMetadata(const BSONObj& bson) {
    _bson = bson.getOwned();
    _bsonIt = _bson.isEmpty() ? nullptr : _bson.objdata() + 4;
    _modified = false;

    _bsonHasMetadata = false;
    _stripMetadata = false;
    _numBsonFields = 0U;

    BSONObjIterator it(_bson);
    while (it.more()) {
        BSONElement elem(it.next());
        auto fieldName = elem.fieldNameStringData();

        if (!fieldName.empty() && fieldName[0] == '$') {
            if (fieldName == Document::metaFieldTextScore) {
                setTextScore(elem.Double());
                _bsonHasMetadata = true;
                continue;
            } else if (fieldName == Document::metaFieldRandVal) {
                setRandMetaField(elem.Double());
                _bsonHasMetadata = true;
                continue;
            } else if (fieldName == Document::metaFieldSortKey) {
                setSortKeyMetaField(elem.Obj());
                _bsonHasMetadata = true;
                continue;
            }
        }

        _numBsonFields++;
    }

    _stripMetadata = _bsonHasMetadata;
}

bool DocumentStorage::materializeUntil(StringData requested) const {
    // If already materialized (including logically removed), nothing to do.
    if (findFieldInCache(requested).found()) {
        return true;
    }

    if (_bson.isEmpty()) {
        return false;
    }

    // Scan the backing BSON and only materialize the requested field.
    //
    // This intentionally avoids caching intermediate fields encountered during the scan. It trades
    // off repeated scans for reduced cache growth when callers access only a small subset of fields.
    BSONObjIterator it(_bson);
    while (it.more()) {
        BSONElement elem = it.next();
        auto name = elem.fieldNameStringData();
        if (_stripMetadata && !name.empty() && name[0] == '$' && isMetadataField(name)) {
            continue;
        }
        if (name == requested) {
            materializeOne(elem);
            return true;
        }
    }

    return false;
}

void DocumentStorage::materializeAll() const {
    if (!hasUnmaterializedBson()) {
        return;
    }

    BSONObjIterator it(_bson);
    while (it.more()) {
        BSONElement elem = it.next();
        auto name = elem.fieldNameStringData();
        if (_stripMetadata && !name.empty() && name[0] == '$' && isMetadataField(name)) {
            continue;
        }

        // Avoid duplicating fields if they were previously materialized individually.
        if (findFieldInCache(name).found()) {
            continue;
        }

        materializeOne(elem);
    }

    // Mark backing BSON as fully materialized for APIs that consult hasUnmaterializedBson().
    _bsonIt = bsonEnd();
}

void DocumentStorage::materializeOne(const BSONElement& elem) const {
    Value& val =
        const_cast<DocumentStorage*>(this)->appendField(elem.fieldNameStringData(), /*fromBson*/ true);
    val = Value(elem);
}

Value& DocumentStorage::appendField(StringData name, bool fromBson) {
    if (!fromBson && hasUnmaterializedBson()) {
        // Preserve BSON field-order semantics: new fields must be appended after all backing fields.
        materializeAll();
    }

    if (!fromBson) {
        // Adding a new field is a logical modification relative to backing BSON.
        _modified = true;
    }

    Position pos = getNextPosition();
    const int nameSize = name.size();

    // these are the same for everyone
    const Position nextCollision;
    const Value value;

    // Make room for new field (and padding at end for alignment)
    const unsigned newUsed = ValueElement::align(_usedBytes + sizeof(ValueElement) + nameSize);
    if (!_buffer || _buffer + newUsed > _bufferEnd)
        alloc(newUsed);
    _usedBytes = newUsed;

    // Append structure of a ValueElement
    char* dest = _buffer + pos.index;  // must be after alloc since it changes _buffer
#define append(x)                  \
    memcpy(dest, &(x), sizeof(x)); \
    dest += sizeof(x)
    append(value);
    append(fromBson);
    append(nextCollision);
    append(nameSize);
    name.copyTo(dest, true);
// Padding for alignment handled above
#undef append

    // Make sure next field starts where we expect it
    fassert(16486, getField(pos).next()->ptr() == _buffer + _usedBytes);

    _numFields++;

    if (_numFields > HASH_TAB_MIN) {
        addFieldToHashTable(pos);
    } else if (_numFields == HASH_TAB_MIN) {
        // adds all fields to hash table (including the one we just added)
        rehash();
    }

    return getField(pos).val;
}

// Call after adding field to _fields and increasing _numFields
void DocumentStorage::addFieldToHashTable(Position pos) {
    ValueElement& elem = getField(pos);
    elem.nextCollision = Position();

    const unsigned bucket = bucketForKey(elem.nameSD());

    Position* posPtr = &_hashTab[bucket];
    while (posPtr->found()) {
        // collision: walk links and add new to end
        posPtr = &getField(*posPtr).nextCollision;
    }
    *posPtr = Position(pos.index);
}

void DocumentStorage::alloc(unsigned newSize) {
    const bool firstAlloc = !_buffer;
    const bool doingRehash = needRehash();
    const size_t oldCapacity = firstAlloc ? 0 : (_bufferEnd - _buffer);

    // make new bucket count big enough
    while (needRehash() || hashTabBuckets() < HASH_TAB_INIT_SIZE)
        _hashTabMask = hashTabBuckets() * 2 - 1;

    // only allocate power-of-two sized space > 128 bytes
    size_t capacity = 128;
    while (capacity < newSize + hashTabBytes())
        capacity *= 2;

    uassert(16490, "Tried to make oversized document", capacity <= size_t(BufferMaxSize));

    std::unique_ptr<char[]> oldBuf(_buffer);
    _buffer = new char[capacity];
    _bufferEnd = _buffer + capacity - hashTabBytes();

    if (!firstAlloc) {
        // This just copies the elements
        memcpy(_buffer, oldBuf.get(), _usedBytes);

        if (_numFields >= HASH_TAB_MIN) {
            // if we were hashing, deal with the hash table
            if (doingRehash) {
                rehash();
            } else {
                // no rehash needed so just slide table down to new position
                memcpy(_hashTab, oldBuf.get() + oldCapacity, hashTabBytes());
            }
        }
    }
}

void DocumentStorage::reserveFields(size_t expectedFields) {
    fassert(16487, !_buffer);

    unsigned buckets = HASH_TAB_INIT_SIZE;
    while (buckets < expectedFields)
        buckets *= 2;
    _hashTabMask = buckets - 1;

    // Using expectedFields+1 to allow space for long field names
    const size_t newSize = (expectedFields + 1) * ValueElement::align(sizeof(ValueElement));

    uassert(16491, "Tried to make oversized document", newSize <= size_t(BufferMaxSize));

    _buffer = new char[newSize + hashTabBytes()];
    _bufferEnd = _buffer + newSize;
}

intrusive_ptr<DocumentStorage> DocumentStorage::clone() const {
    intrusive_ptr<DocumentStorage> out(new DocumentStorage());

    // Make a copy of the buffer.
    // It is very important that the positions of each field are the same after cloning.
    const size_t bufferBytes = allocatedBytes();
    if (bufferBytes > 0) {
        out->_buffer = new char[bufferBytes];
        out->_bufferEnd = out->_buffer + (_bufferEnd - _buffer);
        memcpy(out->_buffer, _buffer, bufferBytes);
    } else {
        out->_buffer = nullptr;
        out->_bufferEnd = nullptr;
    }

    // Copy remaining fields
    out->_usedBytes = _usedBytes;
    out->_numFields = _numFields;
    out->_hashTabMask = _hashTabMask;
    out->_bson = _bson;
    out->_bsonIt = _bsonIt;
    out->_modified = _modified;
    out->_bsonHasMetadata = _bsonHasMetadata;
    out->_stripMetadata = _stripMetadata;
    out->_numBsonFields = _numBsonFields;
    out->_metaFields = _metaFields;
    out->_textScore = _textScore;
    out->_randVal = _randVal;
    out->_sortKey = _sortKey.getOwned();

    // Tell values that they have been memcpyed (updates ref counts)
    for (DocumentStorageIterator it = out->iteratorAll(); !it.atEnd(); it.advance()) {
        it->val.memcpyed();
    }

    return out;
}

DocumentStorage::~DocumentStorage() {
    std::unique_ptr<char[]> deleteBufferAtScopeEnd(_buffer);

    for (DocumentStorageIterator it = iteratorAll(); !it.atEnd(); it.advance()) {
        it->val.~Value();  // explicit destructor call
    }
}

Document::Document(const BSONObj& bson) {
    boost::intrusive_ptr<DocumentStorage> storage(new DocumentStorage());
    storage->setBackingBson(bson);
    _storage = std::move(storage);
}

Document::Document(std::initializer_list<std::pair<StringData, ImplicitValue>> initializerList) {
    MutableDocument mutableDoc(initializerList.size());

    for (auto&& pair : initializerList) {
        mutableDoc.addField(pair.first, pair.second);
    }

    *this = mutableDoc.freeze();
}

BSONObjBuilder& operator<<(BSONObjBuilderValueStream& builder, const Document& doc) {
    BSONObjBuilder subobj(builder.subobjStart());
    doc.toBson(&subobj);
    subobj.doneFast();
    return builder.builder();
}

namespace {
bool isMetadataField(StringData fieldName) {
    return fieldName == Document::metaFieldTextScore || fieldName == Document::metaFieldRandVal ||
        fieldName == Document::metaFieldSortKey;
}

void uassertValidBsonDepthForToBson(const BSONObj& obj, size_t recursionLevel) {
    std::vector<BSONObjIterator> frames;
    frames.reserve(16);
    frames.emplace_back(obj);

    while (!frames.empty()) {
        const auto elem = frames.back().next();
        if (elem.type() == BSONType::Object || elem.type() == BSONType::Array) {
            // 'recursionLevel' is 1 for the top-level Document::toBson() call. Each additional
            // nested object/array increments the effective recursion level by 1.
            if (MONGO_unlikely(recursionLevel + frames.size() > BSONDepth::getMaxAllowableDepth())) {
                uasserted(ErrorCodes::Overflow,
                          str::stream()
                              << "cannot convert document to BSON because it exceeds the limit of "
                              << BSONDepth::getMaxAllowableDepth() << " levels of nesting");
            }
            frames.emplace_back(elem.embeddedObject());
        }

        if (!frames.back().more()) {
            frames.pop_back();
        }
    }
}
}  // namespace

void Document::toBson(BSONObjBuilder* builder, size_t recursionLevel) const {
    uassert(ErrorCodes::Overflow,
            str::stream() << "cannot convert document to BSON because it exceeds the limit of "
                          << BSONDepth::getMaxAllowableDepth()
                          << " levels of nesting",
            recursionLevel <= BSONDepth::getMaxAllowableDepth());

    const auto& docStorage = storage();

    // Fast path: backing BSON with no logical modifications and no metadata stripping requested.
    // Note: Lazy materialization (reading fields into cache) does not count as a logical modification.
    if (docStorage.hasBackingBson() && !docStorage.isModified() && !docStorage.shouldStripMetadata()) {
        builder->bb().appendBuf(docStorage.backingBson().objdata() + 4,
                                docStorage.backingBson().objsize() - 5);
        return;
    }

    // Slow path: merge backing BSON (base image) with cache (overlay).
    if (docStorage.hasBackingBson()) {
        // We may append unmaterialized BSON elements directly, which would otherwise bypass the
        // recursion-level checks in Value::addToBsonObj().
        uassertValidBsonDepthForToBson(docStorage.backingBson(), recursionLevel);
        BSONObjIterator it(docStorage.backingBson());
        while (it.more()) {
            BSONElement elem = it.next();
            auto name = elem.fieldNameStringData();

            if (docStorage.shouldStripMetadata() && !name.empty() && name[0] == '$' &&
                isMetadataField(name)) {
                continue;
            }

            Position cachePos = docStorage.findFieldInCache(name);
            if (cachePos.found()) {
                const Value& cachedVal = docStorage.getField(cachePos).val;
                if (!cachedVal.missing()) {
                    cachedVal.addToBsonObj(builder, name, recursionLevel);
                }
            } else {
                // Not materialized or modified: append raw backing BSON element.
                builder->append(elem);
            }
        }
    }

    // Append cache-only fields (new fields) in insertion order.
    for (DocumentStorageIterator it = docStorage.iteratorAll(); !it.atEnd(); it.advance()) {
        if (it->fromBson) {
            continue;
        }
        if (it->val.missing()) {
            continue;
        }
        if (docStorage.shouldStripMetadata() && !it->nameSD().empty() && it->nameSD()[0] == '$' &&
            isMetadataField(it->nameSD())) {
            continue;
        }

        it->val.addToBsonObj(builder, it->nameSD(), recursionLevel);
    }
}

BSONObj Document::toBson() const {
    BSONObjBuilder bb;
    toBson(&bb);
    return bb.obj();
}

constexpr StringData Document::metaFieldTextScore;
constexpr StringData Document::metaFieldRandVal;
constexpr StringData Document::metaFieldSortKey;

BSONObj Document::toBsonWithMetaData() const {
    BSONObjBuilder bb;
    toBson(&bb);
    if (hasTextScore())
        bb.append(metaFieldTextScore, getTextScore());
    if (hasRandMetaField())
        bb.append(metaFieldRandVal, getRandMetaField());
    if (hasSortKeyMetaField())
        bb.append(metaFieldSortKey, getSortKeyMetaField());
    return bb.obj();
}

Document Document::fromBsonWithMetaData(const BSONObj& bson) {
    boost::intrusive_ptr<DocumentStorage> storage(new DocumentStorage());
    storage->initFromBsonWithMetadata(bson);
    return Document(storage.get());
}

BSONObj Document::stripMetadataFields(const BSONObj& bsonWithMetadata) {
    BSONObjBuilder bb;

    BSONObjIterator it(bsonWithMetadata);
    while (it.more()) {
        BSONElement elem = it.next();
        auto fieldName = elem.fieldNameStringData();
        if (!fieldName.empty() && fieldName[0] == '$' && isMetadataField(fieldName)) {
            continue;
        }
        bb.append(elem);
    }

    return bb.obj();
}

Document Document::getOwned() const {
    if (!_storage || !storage().hasBackingBson()) {
        return *this;
    }

    storage().makeOwned();
    return *this;
}

MutableDocument::MutableDocument(size_t expectedFields)
    : _storageHolder(NULL), _storage(_storageHolder) {
    if (expectedFields) {
        storage().reserveFields(expectedFields);
    }
}

MutableValue MutableDocument::getNestedFieldHelper(const FieldPath& dottedField, size_t level) {
    if (level == dottedField.getPathLength() - 1) {
        return getField(dottedField.getFieldName(level));
    } else {
        MutableDocument nested(getField(dottedField.getFieldName(level)));
        return nested.getNestedFieldHelper(dottedField, level + 1);
    }
}

MutableValue MutableDocument::getNestedField(const FieldPath& dottedField) {
    fassert(16601, dottedField.getPathLength());
    return getNestedFieldHelper(dottedField, 0);
}

MutableValue MutableDocument::getNestedFieldHelper(const vector<Position>& positions,
                                                   size_t level) {
    if (level == positions.size() - 1) {
        return getField(positions[level]);
    } else {
        MutableDocument nested(getField(positions[level]));
        return nested.getNestedFieldHelper(positions, level + 1);
    }
}

MutableValue MutableDocument::getNestedField(const vector<Position>& positions) {
    fassert(16488, !positions.empty());
    return getNestedFieldHelper(positions, 0);
}

static Value getNestedFieldHelper(const Document& doc,
                                  const FieldPath& fieldNames,
                                  vector<Position>* positions,
                                  size_t level) {
    const auto fieldName = fieldNames.getFieldName(level);
    const Position pos = doc.positionOf(fieldName);

    if (!pos.found())
        return Value();

    if (positions)
        positions->push_back(pos);

    if (level == fieldNames.getPathLength() - 1)
        return doc.getField(pos);

    Value val = doc.getField(pos);
    if (val.getType() != Object)
        return Value();

    return getNestedFieldHelper(val.getDocument(), fieldNames, positions, level + 1);
}

const Value Document::getNestedField(const FieldPath& path, vector<Position>* positions) const {
    fassert(16489, path.getPathLength());
    return getNestedFieldHelper(*this, path, positions, 0);
}

size_t Document::getApproximateSize() const {
    if (!_storage)
        return 0;  // we've allocated no memory

    size_t size = sizeof(DocumentStorage);
    size += storage().allocatedBytes();
    size += storage().backingBsonSize();

    for (FieldIterator it(*this); it.more();) {
        auto field = it.next();
        size += field.second.getApproximateSize();
        size -= sizeof(Value);  // already accounted for above
    }

    return size;
}

void Document::hash_combine(size_t& seed,
                            const StringData::ComparatorInterface* stringComparator) const {
    for (FieldIterator it(*this); it.more();) {
        auto field = it.next();
        StringData name = field.first;
        boost::hash_range(seed, name.rawData(), name.rawData() + name.size());
        field.second.hash_combine(seed, stringComparator);
    }
}

int Document::compare(const Document& rL,
                      const Document& rR,
                      const StringData::ComparatorInterface* stringComparator) {
    FieldIterator lIt(rL);
    FieldIterator rIt(rR);

    while (true) {
        if (!lIt.more()) {
            if (!rIt.more())
                return 0;  // documents are the same length

            return -1;  // left document is shorter
        }

        if (!rIt.more())
            return 1;  // right document is shorter

        const auto lField = lIt.next();
        const auto rField = rIt.next();
        const StringData lName = lField.first;
        const StringData rName = rField.first;
        const Value& lVal = lField.second;
        const Value& rVal = rField.second;

        // For compatibility with BSONObj::woCompare() consider the canonical type of values
        // before considerting their names.
        if (lVal.getType() != rVal.getType()) {
            const int rCType = canonicalizeBSONType(rVal.getType());
            const int lCType = canonicalizeBSONType(lVal.getType());
            if (lCType != rCType)
                return lCType < rCType ? -1 : 1;
        }

        const int nameCmp = lName.compare(rName);
        if (nameCmp)
            return nameCmp;  // field names are unequal

        const int valueCmp = Value::compare(lVal, rVal, stringComparator);
        if (valueCmp)
            return valueCmp;  // fields are unequal
    }
}

string Document::toString() const {
    if (empty())
        return "{}";

    StringBuilder out;
    const char* prefix = "{";

    for (FieldIterator it(*this); it.more();) {
        auto field = it.next();
        out << prefix << field.first << ": " << field.second.toString();
        prefix = ", ";
    }
    out << '}';

    return out.str();
}

void Document::serializeForSorter(BufBuilder& buf) const {
    const int numElems = size();
    buf.appendNum(numElems);

    for (FieldIterator it(*this); it.more();) {
        auto field = it.next();
        buf.appendStr(field.first, /*NUL byte*/ true);
        field.second.serializeForSorter(buf);
    }

    if (hasTextScore()) {
        buf.appendNum(char(DocumentStorage::MetaType::TEXT_SCORE + 1));
        buf.appendNum(getTextScore());
    }
    if (hasRandMetaField()) {
        buf.appendNum(char(DocumentStorage::MetaType::RAND_VAL + 1));
        buf.appendNum(getRandMetaField());
    }
    if (hasSortKeyMetaField()) {
        buf.appendNum(char(DocumentStorage::MetaType::SORT_KEY + 1));
        getSortKeyMetaField().appendSelfToBufBuilder(buf);
    }
    buf.appendNum(char(0));
}

Document Document::deserializeForSorter(BufReader& buf, const SorterDeserializeSettings&) {
    const int numElems = buf.read<LittleEndian<int>>();
    MutableDocument doc(numElems);
    for (int i = 0; i < numElems; i++) {
        StringData name = buf.readCStr();
        doc.addField(name, Value::deserializeForSorter(buf, Value::SorterDeserializeSettings()));
    }

    while (char marker = buf.read<char>()) {
        if (marker == char(DocumentStorage::MetaType::TEXT_SCORE) + 1) {
            doc.setTextScore(buf.read<LittleEndian<double>>());
        } else if (marker == char(DocumentStorage::MetaType::RAND_VAL) + 1) {
            doc.setRandMetaField(buf.read<LittleEndian<double>>());
        } else if (marker == char(DocumentStorage::MetaType::SORT_KEY) + 1) {
            doc.setSortKeyMetaField(
                BSONObj::deserializeForSorter(buf, BSONObj::SorterDeserializeSettings()));
        } else {
            uasserted(28744, "Unrecognized marker, unable to deserialize buffer");
        }
    }

    return doc.freeze();
}
}
