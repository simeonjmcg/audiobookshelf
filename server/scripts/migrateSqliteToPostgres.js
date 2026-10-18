#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const childProcess = require('child_process')
const sqlite3 = require('sqlite3')
const { Client } = require('pg')
const StreamZip = require('../libs/nodeStreamZip')
const archiver = require('../libs/archiver')

const integerBounds = {
  smallint: { min: -32768n, max: 32767n },
  integer: { min: -2147483648n, max: 2147483647n },
  bigint: { min: -9223372036854775808n, max: 9223372036854775807n }
}

const preferredOrder = [
  'migrationsMeta',
  'SequelizeMeta',
  'settings',
  'users',
  'apiKeys',
  'sessions',
  'libraries',
  'libraryFolders',
  'authors',
  'series',
  'books',
  'podcasts',
  'podcastEpisodes',
  'libraryItems',
  'bookAuthors',
  'bookSeries',
  'collections',
  'collectionBooks',
  'playlists',
  'playlistMediaItems',
  'mediaProgresses',
  'devices',
  'playbackSessions',
  'feeds',
  'feedEpisodes',
  'mediaItemShares',
  'customMetadataProviders'
]

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function openSqlite(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err)
      resolve(db)
    })
  })
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err)
      resolve(rows)
    })
  })
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err)
      resolve(row)
    })
  })
}

async function findOverlongVarcharValues(sqliteDb, tablesToMigrate, pgColumnsByTable) {
  const issues = []

  for (const { sqliteTable, postgresTable } of tablesToMigrate) {
    const pgColumns = pgColumnsByTable.get(postgresTable)
    if (!pgColumns) continue

    for (const column of pgColumns.values()) {
      if (column.data_type !== 'character varying' || !column.character_maximum_length) continue

      const sqliteColumn = column.column_name
      const maxLength = Number(column.character_maximum_length)
      const quotedTable = quoteIdent(sqliteTable)
      const quotedColumn = quoteIdent(sqliteColumn)

      try {
        const maxLengthRow = await sqliteGet(
          sqliteDb,
          `SELECT MAX(LENGTH(${quotedColumn})) AS maxLength FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`
        )
        const actualMaxLength = Number(maxLengthRow?.maxLength || 0)

        if (actualMaxLength > maxLength) {
          const countRow = await sqliteGet(
            sqliteDb,
            `SELECT COUNT(*) AS count FROM ${quotedTable} WHERE LENGTH(${quotedColumn}) > ?`,
            [maxLength]
          )
          issues.push({
            sqliteTable,
            sqliteColumn,
            postgresTable,
            postgresColumn: column.column_name,
            maxLength,
            actualMaxLength,
            overCount: Number(countRow?.count || 0)
          })
        }
      } catch (error) {
        // SQLite column might not exist or may be named differently; skip preflight check if query fails
      }
    }
  }

  return issues
}

function isIntegerCompatible(value, pgType = 'integer') {
  if (value === null || value === undefined) return true

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return false
    const bounds = integerBounds[pgType]
    if (!bounds) return true
    const bigVal = BigInt(value)
    return bigVal >= bounds.min && bigVal <= bounds.max
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return false
    if (!/^-?\d+$/.test(trimmed)) return false

    try {
      const bigVal = BigInt(trimmed)
      const bounds = integerBounds[pgType]
      if (!bounds) return true
      return bigVal >= bounds.min && bigVal <= bounds.max
    } catch {
      return false
    }
  }

  return false
}

async function findIntegerTypeIssues(sqliteDb, tablesToMigrate, pgColumnsByTable) {
  const issues = []
  const integerTypes = new Set(['smallint', 'integer', 'bigint'])

  for (const { sqliteTable, postgresTable } of tablesToMigrate) {
    const pgColumns = pgColumnsByTable.get(postgresTable)
    if (!pgColumns) continue

    for (const column of pgColumns.values()) {
      if (!integerTypes.has(column.data_type)) continue

      const sqliteColumn = column.column_name
      const quotedTable = quoteIdent(sqliteTable)
      const quotedColumn = quoteIdent(sqliteColumn)

      let rows
      try {
        rows = await sqliteAll(
          sqliteDb,
          `SELECT ${quotedColumn} AS val FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`
        )
      } catch {
        continue
      }

      let badCount = 0
      let sampleValue = null

      for (const row of rows) {
        if (!isIntegerCompatible(row.val, column.data_type)) {
          badCount++
          if (sampleValue === null) sampleValue = row.val
        }
      }

      if (badCount > 0) {
        issues.push({
          sqliteTable,
          sqliteColumn,
          postgresTable,
          postgresColumn: column.column_name,
          postgresType: column.data_type,
          badCount,
          sampleValue
        })
      }
    }
  }

  return issues
}

function normalizeJson(value) {
  if (value === null || value === undefined) return null

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      return JSON.stringify(trimmed)
    }
  }

  return JSON.stringify(value)
}

function convertValue(value, pgColumn) {
  if (value === null || value === undefined) return null

  const type = pgColumn?.data_type
  const udtName = pgColumn?.udt_name

  if (type === 'json' || type === 'jsonb' || udtName === 'json' || udtName === 'jsonb') {
    return normalizeJson(value)
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value === 1
    if (typeof value === 'string') {
      const lower = value.trim().toLowerCase()
      if (lower === '1' || lower === 'true' || lower === 't') return true
      if (lower === '0' || lower === 'false' || lower === 'f') return false
    }
    return Boolean(value)
  }

  if (type === 'integer' || type === 'smallint') {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (/^-?\d+$/.test(trimmed)) {
        const parsed = Number(trimmed)
        if (Number.isSafeInteger(parsed)) return parsed
      }
    }
  }

  if (type === 'bigint') {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed
      }
    }
  }

  return value
}

function getOverlongColumns(row, insertColumns) {
  const overlong = []

  for (const column of insertColumns) {
    const maxLength = column.metadata.character_maximum_length
    if (!maxLength) continue

    const value = row[column.sqliteColumn]
    if (value === null || value === undefined) continue

    const length = String(value).length
    if (length > maxLength) {
      overlong.push({
        sqliteColumn: column.sqliteColumn,
        postgresColumn: column.postgresColumn,
        maxLength,
        actualLength: length
      })
    }
  }

  return overlong
}

function parseArgs(argv) {
  const options = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--backup=')) {
      options.backupPath = arg.substring('--backup='.length)
    } else if (arg === '--backup' || arg === '-b') {
      options.backupPath = argv[++i]
    } else if (arg.startsWith('--output=')) {
      options.outputPath = arg.substring('--output='.length)
    } else if (arg === '--output' || arg === '-o') {
      options.outputPath = argv[++i]
    } else if (arg.startsWith('--sqlite=')) {
      options.sqlitePath = arg.substring('--sqlite='.length)
    } else if (arg === '--sqlite') {
      options.sqlitePath = argv[++i]
    } else if (arg.startsWith('--database-url=')) {
      options.databaseUrl = arg.substring('--database-url='.length)
    } else if (arg === '--database-url') {
      options.databaseUrl = argv[++i]
    } else if (arg.startsWith('--schema=')) {
      options.pgSchema = arg.substring('--schema='.length)
    } else if (arg === '--schema') {
      options.pgSchema = argv[++i]
    } else if (arg.startsWith('--batch-size=')) {
      options.batchSize = Number(arg.substring('--batch-size='.length))
    } else if (arg === '--batch-size') {
      options.batchSize = Number(argv[++i])
    } else if (arg === '--allow-destructive-target') {
      options.allowDestructiveTarget = true
    } else if (arg === '--auto-widen-columns') {
      options.autoWidenColumns = true
    } else if (arg === '--no-auto-widen-columns') {
      options.autoWidenColumns = false
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

function getDefaultOutputPath(backupPath) {
  const dir = path.dirname(backupPath)
  let base = path.basename(backupPath)
  if (base.endsWith('.audiobookshelf')) {
    base = base.slice(0, -'.audiobookshelf'.length)
  } else {
    const ext = path.extname(base)
    if (ext) base = path.basename(base, ext)
  }
  return path.join(dir, `${base}-postgres.audiobookshelf`)
}

function getPostgresConnection(databaseUrl) {
  let dbUrl
  try {
    dbUrl = new URL(databaseUrl)
  } catch (error) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URI')
  }

  const args = ['--host', dbUrl.hostname, '--dbname', decodeURIComponent(dbUrl.pathname.replace(/^\//, ''))]
  if (dbUrl.port) args.push('--port', dbUrl.port)
  if (dbUrl.username) args.push('--username', decodeURIComponent(dbUrl.username))

  const decodedPassword = dbUrl.password ? decodeURIComponent(dbUrl.password) : null
  const secrets = dbUrl.password ? [dbUrl.password, decodedPassword] : []
  const env = decodedPassword ? { ...process.env, PGPASSWORD: decodedPassword } : process.env

  return { args, env, secrets }
}

function runPostgresDump({ databaseUrl, dumpFilePath, pgSchema }) {
  return new Promise((resolve, reject) => {
    let connection
    try {
      connection = getPostgresConnection(databaseUrl)
    } catch (error) {
      return reject(error)
    }

    const redact = (text) => {
      if (typeof text !== 'string') return text
      return connection.secrets.reduce((redacted, secret) => redacted.split(secret).join('***'), text)
    }

    const args = [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--file',
      dumpFilePath
    ]
    if (pgSchema && pgSchema !== 'public') {
      args.push('--schema', pgSchema)
    }

    const options = {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
      env: connection.env
    }

    childProcess.execFile('pg_dump', [...args, ...connection.args], options, (error, stdout, stderr) => {
      if (error) {
        error.message = redact(error.message)
        if (error.cmd) error.cmd = redact(error.cmd)
        error.stderr = redact(stderr)
        return reject(error)
      }
      resolve({ stdout, stderr })
    })
  })
}

async function extractBackupArchive(backupPath, targetDir) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file does not exist: "${backupPath}"`)
  }

  const zip = new StreamZip.async({ file: backupPath })
  try {
    const entries = await zip.entries()

    if (!entries['details']) {
      throw new Error(`Invalid backup archive: missing 'details' metadata in "${backupPath}"`)
    }

    const detailsData = await zip.entryData('details')
    const detailsLines = detailsData.toString('utf8').split('\n')

    const dialectKey = detailsLines[1]
    if (dialectKey === 'postgres') {
      console.warn(`[migrate] Warning: Backup archive "${backupPath}" is already marked as postgres dialect.`)
    }

    if (!entries['absdatabase.sqlite']) {
      if (entries['absdatabase.postgres.dump']) {
        throw new Error(`Archive "${backupPath}" already contains absdatabase.postgres.dump - it is already a PostgreSQL backup.`)
      }
      throw new Error(`Invalid backup archive: missing 'absdatabase.sqlite' database file in "${backupPath}".`)
    }

    await fs.promises.mkdir(targetDir, { recursive: true })
    await zip.extract(null, targetDir)

    return {
      details: detailsLines,
      id: detailsLines[0],
      key: detailsLines[1],
      createdAt: detailsLines[2],
      serverVersion: detailsLines[3]
    }
  } finally {
    await zip.close().catch(() => {})
  }
}

function createPostgresBackupArchive({ outputBackupPath, tempDir, dumpFilePath, details }) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(outputBackupPath)
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const output = fs.createWriteStream(outputBackupPath)
    const archive = archiver('zip', {
      zlib: { level: 9 }
    })

    output.on('close', () => {
      resolve(true)
    })
    output.on('error', (err) => {
      reject(err)
    })

    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') {
        reject(err)
      }
    })
    archive.on('error', (err) => {
      reject(err)
    })

    archive.pipe(output)

    // 1. Add Postgres database dump
    archive.file(dumpFilePath, { name: 'absdatabase.postgres.dump' })

    // 2. Add metadata folders if they exist
    const itemsDir = path.join(tempDir, 'metadata-items')
    if (fs.existsSync(itemsDir)) {
      archive.directory(itemsDir, 'metadata-items')
    }

    const authorsDir = path.join(tempDir, 'metadata-authors')
    if (fs.existsSync(authorsDir)) {
      archive.directory(authorsDir, 'metadata-authors')
    }

    // 3. Update details: ensure dialect (key at index 1) is 'postgres'
    const updatedDetails = [...details]
    updatedDetails[1] = 'postgres'
    const detailsContent = updatedDetails.join('\n')
    archive.append(detailsContent, { name: 'details' })

    archive.finalize()
  })
}

async function migrateDatabase({ sqliteDb, pg, pgSchema, batchSize, dryRun, allowDestructiveTarget, autoWidenColumns = true }) {
  const sqliteTablesRows = await sqliteAll(
    sqliteDb,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  const sqliteTables = sqliteTablesRows.map((row) => row.name)

  const pgTablesRows = await pg.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type='BASE TABLE' ORDER BY table_name`,
    [pgSchema]
  )

  const pgTablesByLowerName = new Map(pgTablesRows.rows.map((row) => [row.table_name.toLowerCase(), row.table_name]))

  const tablesToMigrate = sqliteTables
    .map((sqliteTable) => {
      const postgresTable = pgTablesByLowerName.get(sqliteTable.toLowerCase())
      if (!postgresTable) return null
      return {
        sqliteTable,
        postgresTable
      }
    })
    .filter(Boolean)

  tablesToMigrate.sort((a, b) => {
    const ai = preferredOrder.findIndex((tableName) => tableName.toLowerCase() === a.sqliteTable.toLowerCase())
    const bi = preferredOrder.findIndex((tableName) => tableName.toLowerCase() === b.sqliteTable.toLowerCase())
    if (ai === -1 && bi === -1) return a.sqliteTable.localeCompare(b.sqliteTable)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  if (!tablesToMigrate.length) {
    throw new Error('No overlapping tables found between SQLite and PostgreSQL')
  }

  console.log(`[migrate] tables to migrate: ${tablesToMigrate.map((table) => table.sqliteTable).join(', ')}`)

  const pgColumnsByTable = new Map()
  for (const { postgresTable } of tablesToMigrate) {
    const columnsResult = await pg.query(
      `SELECT column_name, data_type, udt_name, character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [pgSchema, postgresTable]
    )
    const columnMap = new Map(columnsResult.rows.map((column) => [column.column_name.toLowerCase(), column]))
    pgColumnsByTable.set(postgresTable, columnMap)
  }

  const overlongVarcharIssues = await findOverlongVarcharValues(sqliteDb, tablesToMigrate, pgColumnsByTable)
  const integerTypeIssues = await findIntegerTypeIssues(sqliteDb, tablesToMigrate, pgColumnsByTable)

  if (overlongVarcharIssues.length) {
    if (autoWidenColumns) {
      console.log('[migrate] overlong source values detected for varchar columns; automatically widening target columns to TEXT:')
      for (const issue of overlongVarcharIssues) {
        console.log(
          `[migrate]   widening ${issue.postgresTable}.${issue.postgresColumn} to TEXT ` +
            `(max was ${issue.maxLength}, source actualMax=${issue.actualMaxLength}, overRows=${issue.overCount})`
        )
        if (!dryRun) {
          await pg.query(
            `ALTER TABLE ${quoteIdent(pgSchema)}.${quoteIdent(issue.postgresTable)} ALTER COLUMN ${quoteIdent(issue.postgresColumn)} TYPE TEXT`
          )
        }
        const pgColumns = pgColumnsByTable.get(issue.postgresTable)
        if (pgColumns) {
          const col = pgColumns.get(issue.postgresColumn.toLowerCase())
          if (col) {
            col.data_type = 'text'
            col.character_maximum_length = null
          }
        }
      }
    } else {
      console.error('[migrate] overlong source values detected for varchar columns:')
      overlongVarcharIssues.forEach((issue) => {
        console.error(
          `[migrate]   ${issue.sqliteTable}.${issue.sqliteColumn} -> ${issue.postgresTable}.${issue.postgresColumn} ` +
            `(max=${issue.maxLength}, actualMax=${issue.actualMaxLength}, overRows=${issue.overCount})`
        )
      })
      throw new Error('Migration aborted to prevent truncation/data loss. Specify --auto-widen-columns or widen target column types first.')
    }
  }

  if (integerTypeIssues.length) {
    console.error('[migrate] non-integer source values detected for integer columns:')
    integerTypeIssues.forEach((issue) => {
      console.error(
        `[migrate]   ${issue.sqliteTable}.${issue.sqliteColumn} -> ${issue.postgresTable}.${issue.postgresColumn} ` +
          `(type=${issue.postgresType}, badRows=${issue.badCount}, sample=${JSON.stringify(issue.sampleValue)})`
      )
    })
    throw new Error('Migration aborted to prevent numeric precision loss. Widen target numeric column types first.')
  }

  if (!dryRun) {
    if (!allowDestructiveTarget) {
      throw new Error('Migration writes are destructive. Specify --allow-destructive-target (or ALLOW_DESTRUCTIVE_TARGET=true) after confirming the target database can be truncated.')
    }

    await pg.query('BEGIN')
    await pg.query('SET session_replication_role = replica')

    const truncateList = tablesToMigrate.map(({ postgresTable }) => `${quoteIdent(pgSchema)}.${quoteIdent(postgresTable)}`).join(', ')
    await pg.query(`TRUNCATE TABLE ${truncateList} RESTART IDENTITY CASCADE`)
    console.log('[migrate] truncated target tables')
  }

  try {
    for (const { sqliteTable, postgresTable } of tablesToMigrate) {
      const rows = await sqliteAll(sqliteDb, `SELECT * FROM ${quoteIdent(sqliteTable)}`)
      const pgColumns = pgColumnsByTable.get(postgresTable)
      const insertColumns = rows.length
        ? Object.keys(rows[0])
            .map((sqliteColumn) => {
              const pgColumn = pgColumns.get(sqliteColumn.toLowerCase())
              if (!pgColumn) return null
              return {
                sqliteColumn,
                postgresColumn: pgColumn.column_name,
                metadata: pgColumn
              }
            })
            .filter(Boolean)
        : []

      if (!rows.length || !insertColumns.length) {
        console.log(`[migrate] ${sqliteTable}: skipped (rows=${rows.length}, insertableColumns=${insertColumns.length})`)
        continue
      }

      if (!dryRun) {
        for (let offset = 0; offset < rows.length; offset += batchSize) {
          const batchRows = rows.slice(offset, offset + batchSize)
          const valuesSql = []
          const params = []
          let paramIndex = 1

          for (const row of batchRows) {
            const placeholders = []
            for (const column of insertColumns) {
              params.push(convertValue(row[column.sqliteColumn], column.metadata))
              placeholders.push(`$${paramIndex++}`)
            }
            valuesSql.push(`(${placeholders.join(', ')})`)
          }

          const insertSql = `INSERT INTO ${quoteIdent(pgSchema)}.${quoteIdent(postgresTable)} (${insertColumns.map((column) => quoteIdent(column.postgresColumn)).join(', ')}) VALUES ${valuesSql.join(', ')}`

          try {
            await pg.query('SAVEPOINT migrate_batch')
            await pg.query(insertSql, params)
            await pg.query('RELEASE SAVEPOINT migrate_batch')
          } catch (error) {
            await pg.query('ROLLBACK TO SAVEPOINT migrate_batch')
            console.error(`[migrate] batch insert failed for ${sqliteTable} (offset=${offset}, size=${batchRows.length}): ${error.message}`)

            for (let rowIndex = 0; rowIndex < batchRows.length; rowIndex++) {
              const row = batchRows[rowIndex]
              const singleRowParams = insertColumns.map((column) => convertValue(row[column.sqliteColumn], column.metadata))
              const singleRowInsertSql = `INSERT INTO ${quoteIdent(pgSchema)}.${quoteIdent(postgresTable)} (${insertColumns.map((column) => quoteIdent(column.postgresColumn)).join(', ')}) VALUES (${singleRowParams.map((_, index) => `$${index + 1}`).join(', ')})`

              try {
                await pg.query('SAVEPOINT migrate_row')
                await pg.query(singleRowInsertSql, singleRowParams)
                await pg.query('RELEASE SAVEPOINT migrate_row')
              } catch (rowError) {
                await pg.query('ROLLBACK TO SAVEPOINT migrate_row')
                const overlongColumns = getOverlongColumns(row, insertColumns)
                if (overlongColumns.length) {
                  overlongColumns.forEach((column) => {
                    console.error(
                      `[migrate] overlong value in ${sqliteTable}.${column.sqliteColumn} -> ${postgresTable}.${column.postgresColumn} ` +
                        `(length=${column.actualLength}, max=${column.maxLength})`
                    )
                  })
                }

                throw rowError
              }
            }
          }
        }
      }

      console.log(`[migrate] ${sqliteTable}: ${rows.length} rows`)
    }

    if (!dryRun) {
      await pg.query('SET session_replication_role = DEFAULT')
      await pg.query('COMMIT')
      console.log('[migrate] migration transaction committed')

      try {
        const seqResult = await pg.query(
          `SELECT
            c.relname AS sequence_name,
            t.relname AS table_name,
            a.attname AS column_name
          FROM pg_class c
          JOIN pg_depend d ON d.objid = c.oid
          JOIN pg_class t ON t.oid = d.refobjid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE c.relkind = 'S' AND n.nspname = $1`,
          [pgSchema]
        )

        for (const seq of seqResult.rows) {
          await pg.query(
            `SELECT setval(
              quote_ident($1) || '.' || quote_ident($2),
              COALESCE((SELECT MAX(${quoteIdent(seq.column_name)}) FROM ${quoteIdent(pgSchema)}.${quoteIdent(seq.table_name)}), 1)
            )`,
            [pgSchema, seq.sequence_name]
          )
        }
      } catch (seqError) {
        console.warn(`[migrate] warning: could not update sequences: ${seqError.message}`)
      }
    }
  } catch (error) {
    if (!dryRun) {
      await pg.query('ROLLBACK').catch(() => {})
    }
    throw error
  }

  const parity = []
  for (const { sqliteTable, postgresTable } of tablesToMigrate) {
    const sqliteCountRow = await sqliteGet(sqliteDb, `SELECT COUNT(*) AS count FROM ${quoteIdent(sqliteTable)}`)
    const pgCountResult = await pg.query(`SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(pgSchema)}.${quoteIdent(postgresTable)}`)
    parity.push({
      table: sqliteTable,
      sqliteCount: Number(sqliteCountRow.count || 0),
      postgresCount: Number(pgCountResult.rows[0].count || 0)
    })
  }

  const mismatches = parity.filter((row) => row.sqliteCount !== row.postgresCount)
  if (mismatches.length) {
    console.error('[migrate] row-count mismatches detected:')
    mismatches.forEach((row) => {
      console.error(`[migrate]   ${row.table}: sqlite=${row.sqliteCount} postgres=${row.postgresCount}`)
    })
    process.exitCode = 2
  } else {
    console.log('[migrate] parity check passed for all migrated tables')
  }
}

function printUsage() {
  console.log(`
Audiobookshelf SQLite to PostgreSQL Migration Tool

Usage:
  Direct SQLite Database Migration:
    node server/scripts/migrateSqliteToPostgres.js [options]

  Convert .audiobookshelf Backup Archive to Postgres Backup:
    node server/scripts/migrateSqliteToPostgres.js --backup <input.audiobookshelf> [options]

Options:
  -b, --backup <path>           Path to SQLite .audiobookshelf backup archive to convert
  -o, --output <path>           Path for output PostgreSQL .audiobookshelf backup archive
                                (default: <input>-postgres.audiobookshelf)
      --sqlite <path>           Path to source SQLite database file (default: SQLITE_PATH or /config/absdatabase.sqlite)
      --database-url <url>      Target PostgreSQL connection URL (or DATABASE_URL env var)
      --schema <schema>         Target PostgreSQL schema (default: PG_SCHEMA or public)
      --batch-size <num>        Number of rows per batch insert (default: 500)
      --allow-destructive-target Set to allow truncating target tables (or ALLOW_DESTRUCTIVE_TARGET=true)
      --auto-widen-columns      Automatically widen overlong VARCHAR columns to TEXT (default: true)
      --no-auto-widen-columns   Disable auto-widening and abort if overlong VARCHAR columns are found
      --dry-run                 Validate schema compatibility and data types without writing (or DRY_RUN=true)
  -h, --help                    Show this help message
`)
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printUsage()
    return
  }

  const backupPath = args.backupPath || process.env.BACKUP_PATH || null
  const outputPath = args.outputPath || process.env.OUTPUT_BACKUP_PATH || (backupPath ? getDefaultOutputPath(backupPath) : null)
  let sqlitePath = args.sqlitePath || process.env.SQLITE_PATH || '/config/absdatabase.sqlite'
  const databaseUrl = args.databaseUrl || process.env.DATABASE_URL
  const pgSchema = args.pgSchema || process.env.PG_SCHEMA || 'public'
  const batchSize = Number(args.batchSize || process.env.MIGRATION_BATCH_SIZE || 500)
  const dryRun = args.dryRun !== undefined ? args.dryRun : String(process.env.DRY_RUN || 'false').toLowerCase() === 'true'
  const allowDestructiveTarget = args.allowDestructiveTarget !== undefined ? args.allowDestructiveTarget : String(process.env.ALLOW_DESTRUCTIVE_TARGET || 'false').toLowerCase() === 'true'
  const autoWidenColumns = args.autoWidenColumns !== undefined ? args.autoWidenColumns : String(process.env.AUTO_WIDEN_COLUMNS || 'true').toLowerCase() !== 'false'

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (pass via --database-url or DATABASE_URL env var)')
  }

  let tempDir = null
  let backupMeta = null

  try {
    if (backupPath) {
      console.log(`[migrate] backup source: ${backupPath}`)
      console.log(`[migrate] target backup destination: ${outputPath}`)
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-backup-migration-'))
      console.log(`[migrate] extracting backup to temporary folder: ${tempDir}`)
      backupMeta = await extractBackupArchive(backupPath, tempDir)
      sqlitePath = path.join(tempDir, 'absdatabase.sqlite')
      console.log(`[migrate] extracted details: ID=${backupMeta.id}, dialect=${backupMeta.key || 'sqlite'}, serverVersion=${backupMeta.serverVersion}`)
    } else {
      console.log(`[migrate] sqlite source: ${sqlitePath}`)
    }

    console.log(`[migrate] postgres target schema: ${pgSchema}`)
    console.log(`[migrate] dry run: ${dryRun}`)
    console.log(`[migrate] auto widen columns: ${autoWidenColumns}`)

    const sqliteDb = await openSqlite(sqlitePath)
    try {
      const pg = new Client({ connectionString: databaseUrl })
      await pg.connect()
      try {
        await migrateDatabase({
          sqliteDb,
          pg,
          pgSchema,
          batchSize,
          dryRun,
          allowDestructiveTarget,
          autoWidenColumns
        })
      } finally {
        await pg.end()
      }
    } finally {
      sqliteDb.close()
    }

    if (backupPath && !dryRun) {
      console.log('[migrate] creating PostgreSQL dump...')
      const dumpFilePath = path.join(tempDir, 'absdatabase.postgres.dump')
      await runPostgresDump({ databaseUrl, dumpFilePath, pgSchema })
      console.log('[migrate] PostgreSQL dump created successfully')

      console.log(`[migrate] packaging into PostgreSQL backup archive at: ${outputPath}`)
      await createPostgresBackupArchive({
        outputBackupPath: outputPath,
        tempDir,
        dumpFilePath,
        details: backupMeta.details
      })

      const outputStats = fs.statSync(outputPath)
      console.log(`[migrate] Successfully created PostgreSQL-compatible backup: ${outputPath} (${(outputStats.size / (1024 * 1024)).toFixed(2)} MB)`)
      console.log(`[migrate] You can now restore this backup via Audiobookshelf Web UI (Settings > Backups > Upload Backup).`)
    }
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[migrate] warning: failed to clean up temp directory ${tempDir}:`, err.message)
      }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[migrate] failed:', error)
    process.exit(1)
  })
}

module.exports = {
  normalizeJson,
  isIntegerCompatible,
  convertValue,
  findOverlongVarcharValues,
  findIntegerTypeIssues,
  quoteIdent,
  parseArgs,
  getDefaultOutputPath,
  getPostgresConnection,
  runPostgresDump,
  extractBackupArchive,
  createPostgresBackupArchive,
  migrateDatabase,
  main
}
