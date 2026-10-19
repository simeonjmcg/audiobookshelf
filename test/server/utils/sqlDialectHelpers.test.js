const { expect } = require('chai')

const {
  booleanLiteral,
  noCaseSortExpression,
  coalesceFunctionName,
  jsonArrayContainsAny,
  jsonArrayContainsValue,
  jsonArrayExpand,
  jsonPathText,
  jsonPathNumber,
  safeTextToDoubleExpression,
  safeTextToIntegerExpression
} = require('../../../server/utils/sqlDialectHelpers')

const sqlite = {
  getDialect: () => 'sqlite'
}

const postgres = {
  getDialect: () => 'postgres'
}

describe('sqlDialectHelpers', () => {
  it('should return sqlite and postgres boolean literals', () => {
    expect(booleanLiteral(true, sqlite)).to.equal('1')
    expect(booleanLiteral(false, sqlite)).to.equal('0')
    expect(booleanLiteral(true, postgres)).to.equal('TRUE')
    expect(booleanLiteral(false, postgres)).to.equal('FALSE')
  })

  it('should generate case-insensitive sort expressions', () => {
    expect(noCaseSortExpression('name', sqlite)).to.equal('name COLLATE NOCASE')
    expect(noCaseSortExpression('name', postgres)).to.equal('LOWER(name)')
  })

  it('should choose the correct null-coalescing function name', () => {
    expect(coalesceFunctionName(sqlite)).to.equal('IFNULL')
    expect(coalesceFunctionName(postgres)).to.equal('COALESCE')
  })

  it('should generate array membership count queries per dialect', () => {
    expect(jsonArrayContainsAny('tags', 'selectedTags', sqlite)).to.equal('(SELECT count(*) FROM json_each(tags) WHERE json_valid(tags) AND json_each.value IN (:selectedTags))')
    expect(jsonArrayContainsAny('tags', 'selectedTags', postgres)).to.equal("(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(tags::jsonb, '[]'::jsonb)) AS json_each(value) WHERE json_each.value IN (:selectedTags))")

    expect(jsonArrayContainsValue('tags', 'tag', sqlite)).to.equal('(SELECT count(*) FROM json_each(tags) WHERE json_valid(tags) AND json_each.value = :tag)')
    expect(jsonArrayContainsValue('tags', 'tag', postgres)).to.equal("(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(tags::jsonb, '[]'::jsonb)) AS json_each(value) WHERE json_each.value = :tag)")
  })

  it('should generate json array expansion and path extraction by dialect', () => {
    expect(jsonArrayExpand('books.tags', sqlite)).to.equal('json_each(books.tags)')
    expect(jsonArrayExpand('books.tags', postgres)).to.equal("jsonb_array_elements_text(COALESCE(books.tags::jsonb, '[]'::jsonb)) AS json_each(value)")

    expect(jsonPathText('payload', ['metadata', 'filename'], sqlite)).to.equal("json_extract(payload, '$.metadata.filename')")
    expect(jsonPathText('payload', ['metadata', 'filename'], postgres)).to.equal("payload::jsonb #>> '{metadata,filename}'")

    expect(jsonPathNumber('payload', ['duration'], sqlite)).to.equal("json_extract(payload, '$.duration')")
    expect(jsonPathNumber('payload', ['duration'], postgres)).to.equal("NULLIF(payload::jsonb #>> '{duration}', '')::double precision")
  })

  it('should generate safe numeric cast expressions for sequence-like text', () => {
    expect(safeTextToDoubleExpression('sequence', sqlite)).to.equal('CAST(sequence AS FLOAT)')
    expect(safeTextToDoubleExpression('"bookSeries"."sequence"', postgres)).to.equal("CASE WHEN BTRIM(\"bookSeries\".\"sequence\") ~ '^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)$' THEN BTRIM(\"bookSeries\".\"sequence\")::double precision ELSE NULL END")

    expect(safeTextToIntegerExpression('publishedYear', sqlite)).to.equal('CAST(publishedYear AS INTEGER)')
    expect(safeTextToIntegerExpression('book.publishedYear', postgres)).to.equal("CASE WHEN BTRIM(book.publishedYear) ~ '^[+-]?\\d+$' THEN BTRIM(book.publishedYear)::integer ELSE NULL END")
  })

  it('should hash strings consistently to positive integers', () => {
    const { hashStringToInt } = require('../../../server/utils/sqlDialectHelpers')
    const hash1 = hashStringToInt('scan_library_123')
    const hash2 = hashStringToInt('scan_library_123')
    const hash3 = hashStringToInt('scan_library_456')

    expect(hash1).to.equal(hash2)
    expect(hash1).to.not.equal(hash3)
    expect(hash1).to.be.a('number')
    expect(hash1).to.be.at.least(0)
  })

  it('should handle advisory locks on sqlite as no-op true', async () => {
    const { tryAdvisoryLock, releaseAdvisoryLock } = require('../../../server/utils/sqlDialectHelpers')
    const acquired = await tryAdvisoryLock(sqlite, 'test_lock')
    expect(acquired).to.be.true
    const released = await releaseAdvisoryLock(sqlite, 'test_lock')
    expect(released).to.be.true
  })

  it('should query pg_try_advisory_lock on postgres', async () => {
    const { tryAdvisoryLock, releaseAdvisoryLock } = require('../../../server/utils/sqlDialectHelpers')
    const mockPostgres = {
      getDialect: () => 'postgres',
      query: async (sql) => {
        if (sql.includes('pg_try_advisory_lock')) {
          return [[{ acquired: true }]]
        }
        return [[{ pg_advisory_unlock: true }]]
      }
    }
    const acquired = await tryAdvisoryLock(mockPostgres, 'test_lock')
    expect(acquired).to.be.true
    const released = await releaseAdvisoryLock(mockPostgres, 'test_lock')
    expect(released).to.be.true
  })
})

