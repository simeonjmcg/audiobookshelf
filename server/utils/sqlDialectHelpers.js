function getDialect(sequelize) {
  if (!sequelize) return 'sqlite'
  if (typeof sequelize.getDialect === 'function') return sequelize.getDialect()
  return sequelize.dialect?.name || 'sqlite'
}

function isPostgres(sequelize) {
  return getDialect(sequelize) === 'postgres'
}

function booleanLiteral(value, sequelize) {
  if (isPostgres(sequelize)) return value ? 'TRUE' : 'FALSE'
  return value ? '1' : '0'
}

function noCaseSortExpression(columnExpression, sequelize) {
  if (isPostgres(sequelize)) return `LOWER(${columnExpression})`
  return `${columnExpression} COLLATE NOCASE`
}

function coalesceFunctionName(sequelize) {
  return isPostgres(sequelize) ? 'COALESCE' : 'IFNULL'
}

function jsonArrayContainsAny(columnExpression, bindName, sequelize) {
  if (isPostgres(sequelize)) {
    return `(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(${columnExpression}::jsonb, '[]'::jsonb)) AS json_each(value) WHERE json_each.value IN (:${bindName}))`
  }
  return `(SELECT count(*) FROM json_each(${columnExpression}) WHERE json_valid(${columnExpression}) AND json_each.value IN (:${bindName}))`
}

function jsonArrayContainsValue(columnExpression, bindName, sequelize) {
  if (isPostgres(sequelize)) {
    return `(SELECT count(*) FROM jsonb_array_elements_text(COALESCE(${columnExpression}::jsonb, '[]'::jsonb)) AS json_each(value) WHERE json_each.value = :${bindName})`
  }
  return `(SELECT count(*) FROM json_each(${columnExpression}) WHERE json_valid(${columnExpression}) AND json_each.value = :${bindName})`
}

function jsonArrayExpand(columnExpression, sequelize, options = {}) {
  const alias = options.alias || 'json_each'
  const textValues = options.textValues !== false
  if (isPostgres(sequelize)) {
    const fn = textValues ? 'jsonb_array_elements_text' : 'jsonb_array_elements'
    return `${fn}(COALESCE(${columnExpression}::jsonb, '[]'::jsonb)) AS ${alias}(value)`
  }
  return `json_each(${columnExpression})`
}

function jsonPathText(columnExpression, pathSegments, sequelize) {
  const path = Array.isArray(pathSegments) ? pathSegments : [pathSegments]
  if (isPostgres(sequelize)) {
    return `${columnExpression}::jsonb #>> '{${path.join(',')}}'`
  }
  return `json_extract(${columnExpression}, '$.${path.join('.')}')`
}

function jsonPathNumber(columnExpression, pathSegments, sequelize) {
  if (isPostgres(sequelize)) {
    return `NULLIF(${jsonPathText(columnExpression, pathSegments, sequelize)}, '')::double precision`
  }
  return `json_extract(${columnExpression}, '$.${[].concat(pathSegments).join('.')}')`
}

function safeTextToDoubleExpression(columnExpression, sequelize) {
  if (isPostgres(sequelize)) {
    return `CASE WHEN BTRIM(${columnExpression}) ~ '^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)$' THEN BTRIM(${columnExpression})::double precision ELSE NULL END`
  }
  return `CAST(${columnExpression} AS FLOAT)`
}

function safeTextToIntegerExpression(columnExpression, sequelize) {
  if (isPostgres(sequelize)) {
    return `CASE WHEN BTRIM(${columnExpression}) ~ '^[+-]?\\d+$' THEN BTRIM(${columnExpression})::integer ELSE NULL END`
  }
  return `CAST(${columnExpression} AS INTEGER)`
}

function hashStringToInt(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

async function tryAdvisoryLock(sequelize, lockKey) {
  if (!isPostgres(sequelize)) return true
  const lockId = typeof lockKey === 'number' ? lockKey : hashStringToInt(String(lockKey))
  const [results] = await sequelize.query(`SELECT pg_try_advisory_lock(${lockId}) AS acquired;`)
  return !!(results[0]?.acquired || results[0]?.pg_try_advisory_lock)
}

async function releaseAdvisoryLock(sequelize, lockKey) {
  if (!isPostgres(sequelize)) return true
  const lockId = typeof lockKey === 'number' ? lockKey : hashStringToInt(String(lockKey))
  try {
    await sequelize.query(`SELECT pg_advisory_unlock(${lockId});`)
    return true
  } catch (err) {
    return false
  }
}

module.exports = {
  getDialect,
  isPostgres,
  booleanLiteral,
  noCaseSortExpression,
  coalesceFunctionName,
  jsonArrayContainsAny,
  jsonArrayContainsValue,
  jsonArrayExpand,
  jsonPathText,
  jsonPathNumber,
  safeTextToDoubleExpression,
  safeTextToIntegerExpression,
  hashStringToInt,
  tryAdvisoryLock,
  releaseAdvisoryLock
}

