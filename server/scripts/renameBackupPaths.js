#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const sqlite3 = require('sqlite3')
const { Client } = require('pg')
const StreamZip = require('../libs/nodeStreamZip')
const archiver = require('../libs/archiver')

function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function normalizePrefix(prefix) {
  if (!prefix) return ''
  return String(prefix).trim().replace(/\/+$/, '')
}

function replacePathPrefix(str, fromClean, toClean) {
  if (typeof str !== 'string') return str
  if (str === fromClean) {
    return toClean
  }
  if (str.startsWith(fromClean + '/')) {
    return toClean + str.slice(fromClean.length)
  }
  return str
}

function replaceInObject(obj, fromClean, toClean) {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'string') {
    return replacePathPrefix(obj, fromClean, toClean)
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => replaceInObject(item, fromClean, toClean))
  }
  if (typeof obj === 'object') {
    const newObj = {}
    for (const [key, val] of Object.entries(obj)) {
      newObj[key] = replaceInObject(val, fromClean, toClean)
    }
    return newObj
  }
  return obj
}

function transformValue(value, fromClean, toClean) {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') {
    return replaceInObject(value, fromClean, toClean)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed)
        const updated = replaceInObject(parsed, fromClean, toClean)
        return JSON.stringify(updated)
      } catch {
        // Not valid JSON, fall back to plain string replacement
      }
    }
    return replacePathPrefix(value, fromClean, toClean)
  }
  return value
}

function openSqlite(filePath, readOnly = false) {
  const mode = readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, mode, (err) => {
      if (err) return reject(err)
      resolve(db)
    })
  })
}

function closeSqlite(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) return reject(err)
      resolve()
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

function sqliteRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err)
      resolve(this)
    })
  })
}

async function renamePathsInSqliteDb(db, { fromPrefix, toPrefix, dryRun = false }) {
  const fromClean = normalizePrefix(fromPrefix)
  const toClean = normalizePrefix(toPrefix)

  if (!fromClean) {
    throw new Error('source path prefix (--from) cannot be empty')
  }

  const tables = await sqliteAll(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )

  const stats = {
    tablesExamined: 0,
    rowsUpdated: 0,
    byTable: {}
  }

  for (const { name: tableName } of tables) {
    stats.tablesExamined++
    const columns = await sqliteAll(db, `PRAGMA table_info(${quoteIdent(tableName)})`)
    const textColumns = columns.filter((col) => {
      const type = (col.type || '').toUpperCase()
      return !type || type.includes('CHAR') || type.includes('TEXT') || type.includes('CLOB') || type.includes('JSON')
    })

    if (!textColumns.length) continue

    for (const column of textColumns) {
      const colName = column.name
      const quotedCol = quoteIdent(colName)
      const quotedTable = quoteIdent(tableName)

      let rows = []
      try {
        rows = await sqliteAll(
          db,
          `SELECT rowid, ${quotedCol} AS val FROM ${quotedTable} WHERE ${quotedCol} LIKE '%' || ? || '%'`,
          [fromClean]
        )
      } catch {
        continue
      }

      if (!rows.length) continue

      let colUpdatedCount = 0
      for (const row of rows) {
        const originalVal = row.val
        const updatedVal = transformValue(originalVal, fromClean, toClean)

        if (originalVal !== updatedVal) {
          colUpdatedCount++
          if (!dryRun) {
            await sqliteRun(
              db,
              `UPDATE ${quotedTable} SET ${quotedCol} = ? WHERE rowid = ?`,
              [updatedVal, row.rowid]
            )
          }
        }
      }

      if (colUpdatedCount > 0) {
        stats.rowsUpdated += colUpdatedCount
        if (!stats.byTable[tableName]) {
          stats.byTable[tableName] = {}
        }
        stats.byTable[tableName][colName] = colUpdatedCount
      }
    }
  }

  return stats
}

async function renamePathsInPostgresDb(pgClient, { fromPrefix, toPrefix, pgSchema = 'public', dryRun = false }) {
  const fromClean = normalizePrefix(fromPrefix)
  const toClean = normalizePrefix(toPrefix)

  if (!fromClean) {
    throw new Error('source path prefix (--from) cannot be empty')
  }

  const tablesResult = await pgClient.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [pgSchema]
  )

  const stats = {
    tablesExamined: 0,
    rowsUpdated: 0,
    byTable: {}
  }

  for (const { table_name: tableName } of tablesResult.rows) {
    stats.tablesExamined++
    const columnsResult = await pgClient.query(
      `SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [pgSchema, tableName]
    )

    const textColumns = columnsResult.rows.filter((col) => {
      const type = (col.data_type || '').toLowerCase()
      const udt = (col.udt_name || '').toLowerCase()
      return type.includes('char') || type.includes('text') || type.includes('json') || udt.includes('json')
    })

    if (!textColumns.length) continue

    const pkResult = await pgClient.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [pgSchema, tableName]
    )
    const pkColumn = pkResult.rows[0]?.column_name || 'id'

    for (const column of textColumns) {
      const colName = column.column_name
      const quotedCol = quoteIdent(colName)
      const quotedTable = `${quoteIdent(pgSchema)}.${quoteIdent(tableName)}`
      const quotedPk = quoteIdent(pkColumn)

      let selectResult
      try {
        selectResult = await pgClient.query(
          `SELECT ${quotedPk} AS pk, ${quotedCol}::text AS val FROM ${quotedTable} WHERE ${quotedCol}::text LIKE '%' || $1 || '%'`,
          [fromClean]
        )
      } catch {
        continue
      }

      if (!selectResult.rows.length) continue

      let colUpdatedCount = 0
      for (const row of selectResult.rows) {
        const originalVal = row.val
        const updatedVal = transformValue(originalVal, fromClean, toClean)

        if (originalVal !== updatedVal) {
          colUpdatedCount++
          if (!dryRun) {
            const isJson = column.data_type.includes('json') || column.udt_name.includes('json')
            await pgClient.query(
              `UPDATE ${quotedTable} SET ${quotedCol} = $1${isJson ? '::jsonb' : ''} WHERE ${quotedPk} = $2`,
              [updatedVal, row.pk]
            )
          }
        }
      }

      if (colUpdatedCount > 0) {
        stats.rowsUpdated += colUpdatedCount
        if (!stats.byTable[tableName]) {
          stats.byTable[tableName] = {}
        }
        stats.byTable[tableName][colName] = colUpdatedCount
      }
    }
  }

  return stats
}

function zipBackupDirectory(outputPath, sourceDir) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => resolve(true))
    output.on('error', reject)
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err)
    })
    archive.on('error', reject)
    archive.pipe(output)

    archive.file(path.join(sourceDir, 'absdatabase.sqlite'), { name: 'absdatabase.sqlite' })
    archive.file(path.join(sourceDir, 'details'), { name: 'details' })

    const itemsDir = path.join(sourceDir, 'metadata-items')
    if (fs.existsSync(itemsDir)) {
      archive.directory(itemsDir, 'metadata-items')
    }

    const authorsDir = path.join(sourceDir, 'metadata-authors')
    if (fs.existsSync(authorsDir)) {
      archive.directory(authorsDir, 'metadata-authors')
    }

    archive.finalize()
  })
}

async function renameBackupArchive({ backupPath, outputPath, fromPrefix, toPrefix, dryRun = false }) {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file does not exist: "${backupPath}"`)
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-backup-rename-'))
  const zip = new StreamZip.async({ file: backupPath })

  try {
    const entries = await zip.entries()
    if (!entries['details']) {
      throw new Error(`Invalid backup archive: missing 'details' in "${backupPath}"`)
    }

    if (!entries['absdatabase.sqlite']) {
      throw new Error(
        `Archive "${backupPath}" does not contain 'absdatabase.sqlite'. Direct Postgres dump renaming inside .pgdump archives is not supported. Use --database-url to rename paths directly in PostgreSQL, or rename the SQLite backup first.`
      )
    }

    await zip.extract(null, tempDir)
    await zip.close()

    const dbPath = path.join(tempDir, 'absdatabase.sqlite')
    const db = await openSqlite(dbPath)
    let stats
    try {
      stats = await renamePathsInSqliteDb(db, { fromPrefix, toPrefix, dryRun })
    } finally {
      await closeSqlite(db)
    }

    if (!dryRun) {
      const targetPath = outputPath || backupPath
      const tempOutputPath = path.join(tempDir, 'output.audiobookshelf')

      await zipBackupDirectory(tempOutputPath, tempDir)

      const targetDir = path.dirname(targetPath)
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true })
      }
      fs.copyFileSync(tempOutputPath, targetPath)
      stats.outputPath = targetPath
    }

    return stats
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

function parseArgs(argv) {
  const options = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--backup=')) {
      options.backupPath = arg.substring('--backup='.length)
    } else if (arg === '--backup' || arg === '-b') {
      options.backupPath = argv[++i]
    } else if (arg.startsWith('--sqlite=')) {
      options.sqlitePath = arg.substring('--sqlite='.length)
    } else if (arg === '--sqlite' || arg === '-s') {
      options.sqlitePath = argv[++i]
    } else if (arg.startsWith('--database-url=')) {
      options.databaseUrl = arg.substring('--database-url='.length)
    } else if (arg === '--database-url' || arg === '-d') {
      options.databaseUrl = argv[++i]
    } else if (arg.startsWith('--from=')) {
      options.fromPrefix = arg.substring('--from='.length)
    } else if (arg === '--from' || arg === '-f') {
      options.fromPrefix = argv[++i]
    } else if (arg.startsWith('--to=')) {
      options.toPrefix = arg.substring('--to='.length)
    } else if (arg === '--to' || arg === '-t') {
      options.toPrefix = argv[++i]
    } else if (arg.startsWith('--output=')) {
      options.outputPath = arg.substring('--output='.length)
    } else if (arg === '--output' || arg === '-o') {
      options.outputPath = argv[++i]
    } else if (arg === '--in-place' || arg === '-i') {
      options.inPlace = true
    } else if (arg.startsWith('--schema=')) {
      options.pgSchema = arg.substring('--schema='.length)
    } else if (arg === '--schema') {
      options.pgSchema = argv[++i]
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

function printUsage() {
  console.log(`
Audiobookshelf Path Renaming Utility

Renames library file paths (e.g. /audiobooks/* -> gcs://smcgraw-abs-lib/*) in
a .audiobookshelf backup archive, a raw SQLite database, or directly in PostgreSQL.

Usage:
  Rename inside a .audiobookshelf backup archive:
    node server/scripts/renameBackupPaths.js --backup <file.audiobookshelf> --from /audiobooks --to gcs://smcgraw-abs-lib [options]

  Rename directly in PostgreSQL database:
    node server/scripts/renameBackupPaths.js --database-url <postgres_url> --from /audiobooks --to gcs://smcgraw-abs-lib [options]

  Rename inside a raw SQLite database:
    node server/scripts/renameBackupPaths.js --sqlite <absdatabase.sqlite> --from /audiobooks --to gcs://smcgraw-abs-lib [options]

Options:
  -b, --backup <path>         Path to .audiobookshelf backup archive to rename
  -s, --sqlite <path>         Path to raw SQLite database file to rename
  -d, --database-url <url>    PostgreSQL connection URL to rename in-place (or DATABASE_URL env var)
  -f, --from <prefix>         Source path prefix to replace (e.g. /audiobooks) [REQUIRED]
  -t, --to <prefix>           Target path prefix to replace with (e.g. gcs://smcgraw-abs-lib) [REQUIRED]
  -o, --output <path>         Path for new output backup archive (default: <input>-renamed.audiobookshelf)
  -i, --in-place              Overwrite input backup archive in-place
      --schema <schema>       PostgreSQL schema (default: public)
      --dry-run               Preview changes without modifying files or database
  -h, --help                  Show this help message
`)
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printUsage()
    return
  }

  const fromPrefix = args.fromPrefix || process.env.RENAME_FROM
  const toPrefix = args.toPrefix || process.env.RENAME_TO

  if (!fromPrefix || !toPrefix) {
    printUsage()
    console.error('[rename] Error: Both --from and --to are required.')
    process.exit(1)
  }

  const dryRun = !!args.dryRun
  const backupPath = args.backupPath || process.env.BACKUP_PATH || null
  const sqlitePath = args.sqlitePath || process.env.SQLITE_PATH || null
  const databaseUrl = args.databaseUrl || process.env.DATABASE_URL || null
  const pgSchema = args.pgSchema || process.env.PG_SCHEMA || 'public'

  console.log(`[rename] source prefix: "${normalizePrefix(fromPrefix)}"`)
  console.log(`[rename] target prefix: "${normalizePrefix(toPrefix)}"`)
  console.log(`[rename] dry run: ${dryRun}`)

  if (backupPath) {
    let outputPath = args.outputPath
    if (!outputPath && !args.inPlace) {
      const dir = path.dirname(backupPath)
      const base = path.basename(backupPath, path.extname(backupPath))
      outputPath = path.join(dir, `${base}-renamed.audiobookshelf`)
    } else if (args.inPlace) {
      outputPath = backupPath
    }

    console.log(`[rename] processing backup archive: "${backupPath}"`)
    if (!dryRun) {
      console.log(`[rename] target output backup: "${outputPath}"`)
    }

    const stats = await renameBackupArchive({
      backupPath,
      outputPath,
      fromPrefix,
      toPrefix,
      dryRun
    })

    console.log(`[rename] Done! Total matching values updated: ${stats.rowsUpdated}`)
    for (const [table, cols] of Object.entries(stats.byTable)) {
      const colDetails = Object.entries(cols).map(([c, count]) => `${c}: ${count}`).join(', ')
      console.log(`[rename]   ${table} -> ${colDetails}`)
    }
    if (!dryRun) {
      console.log(`[rename] Successfully saved updated backup archive at: "${outputPath}"`)
    }
  } else if (sqlitePath) {
    console.log(`[rename] processing raw SQLite database: "${sqlitePath}"`)
    const db = await openSqlite(sqlitePath)
    try {
      const stats = await renamePathsInSqliteDb(db, { fromPrefix, toPrefix, dryRun })
      console.log(`[rename] Done! Total matching values updated: ${stats.rowsUpdated}`)
      for (const [table, cols] of Object.entries(stats.byTable)) {
        const colDetails = Object.entries(cols).map(([c, count]) => `${c}: ${count}`).join(', ')
        console.log(`[rename]   ${table} -> ${colDetails}`)
      }
    } finally {
      await closeSqlite(db)
    }
  } else if (databaseUrl) {
    console.log(`[rename] processing PostgreSQL database (${pgSchema})...`)
    const pg = new Client({ connectionString: databaseUrl })
    await pg.connect()
    try {
      const stats = await renamePathsInPostgresDb(pg, { fromPrefix, toPrefix, pgSchema, dryRun })
      console.log(`[rename] Done! Total matching values updated: ${stats.rowsUpdated}`)
      for (const [table, cols] of Object.entries(stats.byTable)) {
        const colDetails = Object.entries(cols).map(([c, count]) => `${c}: ${count}`).join(', ')
        console.log(`[rename]   ${table} -> ${colDetails}`)
      }
    } finally {
      await pg.end()
    }
  } else {
    printUsage()
    console.error('[rename] Error: Must specify one of --backup, --sqlite, or --database-url.')
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[rename] failed:', err)
    process.exit(1)
  })
}

module.exports = {
  normalizePrefix,
  replacePathPrefix,
  replaceInObject,
  transformValue,
  renamePathsInSqliteDb,
  renamePathsInPostgresDb,
  renameBackupArchive,
  parseArgs,
  main
}
