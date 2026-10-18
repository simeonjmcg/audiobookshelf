const { expect } = require('chai')
const sqlite3 = require('sqlite3')
const fs = require('fs')
const path = require('path')
const os = require('os')
const archiver = require('../../../server/libs/archiver')
const StreamZip = require('../../../server/libs/nodeStreamZip')

const {
  normalizeJson,
  isIntegerCompatible,
  convertValue,
  findOverlongVarcharValues,
  findIntegerTypeIssues,
  parseArgs,
  getDefaultOutputPath,
  getPostgresConnection,
  extractBackupArchive,
  createPostgresBackupArchive
} = require('../../../server/scripts/migrateSqliteToPostgres')

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) => {
      if (error) return reject(error)
      resolve(db)
    })
  })
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

describe('migrateSqliteToPostgres script helpers', () => {
  it('should keep malformed JSON payloads insertable by returning valid JSON text', () => {
    const malformed = '"{"x",1}"'
    const normalized = normalizeJson(malformed)

    expect(() => JSON.parse(normalized)).to.not.throw()
    expect(JSON.parse(normalized)).to.equal('"{"x",1}"')
  })

  it('should detect overlong varchar values before migration', async () => {
    const db = await openMemoryDb()

    try {
      await run(db, 'CREATE TABLE books (subtitle TEXT)')
      await run(db, 'INSERT INTO books (subtitle) VALUES (?)', ['x'.repeat(300)])
      await run(db, 'INSERT INTO books (subtitle) VALUES (?)', ['ok'])

      const tablesToMigrate = [{ sqliteTable: 'books', postgresTable: 'books' }]
      const pgColumnsByTable = new Map([
        [
          'books',
          new Map([
            [
              'subtitle',
              {
                column_name: 'subtitle',
                data_type: 'character varying',
                character_maximum_length: 255
              }
            ]
          ])
        ]
      ])

      const issues = await findOverlongVarcharValues(db, tablesToMigrate, pgColumnsByTable)

      expect(issues).to.have.length(1)
      expect(issues[0]).to.include({
        sqliteTable: 'books',
        sqliteColumn: 'subtitle',
        postgresTable: 'books',
        postgresColumn: 'subtitle',
        maxLength: 255,
        actualMaxLength: 300,
        overCount: 1
      })
    } finally {
      await close(db)
    }
  })

  it('should detect non-integer values for integer target columns', async () => {
    const db = await openMemoryDb()

    try {
      await run(db, 'CREATE TABLE playbackSessions (timeListening REAL)')
      await run(db, 'INSERT INTO playbackSessions (timeListening) VALUES (?)', [25.802536999999997])
      await run(db, 'INSERT INTO playbackSessions (timeListening) VALUES (?)', [42])

      const tablesToMigrate = [{ sqliteTable: 'playbackSessions', postgresTable: 'playbackSessions' }]
      const pgColumnsByTable = new Map([
        [
          'playbackSessions',
          new Map([
            [
              'timelistening',
              {
                column_name: 'timeListening',
                data_type: 'integer'
              }
            ]
          ])
        ]
      ])

      const issues = await findIntegerTypeIssues(db, tablesToMigrate, pgColumnsByTable)

      expect(issues).to.have.length(1)
      expect(issues[0].sqliteTable).to.equal('playbackSessions')
      expect(issues[0].sqliteColumn).to.equal('timeListening')
      expect(issues[0].postgresType).to.equal('integer')
      expect(issues[0].badCount).to.equal(1)
    } finally {
      await close(db)
    }
  })

  it('should only accept integer-compatible values for integer columns', () => {
    expect(isIntegerCompatible(10)).to.equal(true)
    expect(isIntegerCompatible('10')).to.equal(true)
    expect(isIntegerCompatible(10.5)).to.equal(false)
    expect(isIntegerCompatible('10.5')).to.equal(false)
    expect(isIntegerCompatible('32768', 'smallint')).to.equal(false)
    expect(isIntegerCompatible('9007199254740993', 'bigint')).to.equal(true)
  })

  it('should coerce integer-like strings for postgres integer columns', () => {
    expect(convertValue('42', { data_type: 'integer' })).to.equal(42)
    expect(convertValue('-7', { data_type: 'bigint' })).to.equal('-7')
    expect(convertValue('9007199254740993', { data_type: 'bigint' })).to.equal('9007199254740993')
    expect(convertValue('4.2', { data_type: 'integer' })).to.equal('4.2')
  })

  it('should always return valid json text for postgres json columns', () => {
    const convertedObject = convertValue({ a: 1 }, { data_type: 'jsonb', udt_name: 'jsonb' })
    const convertedMalformed = convertValue('"{"x",1}"', { data_type: 'jsonb', udt_name: 'jsonb' })

    expect(JSON.parse(convertedObject)).to.deep.equal({ a: 1 })
    expect(JSON.parse(convertedMalformed)).to.equal('"{"x",1}"')
  })

  describe('CLI arguments and paths', () => {
    it('should parse command line arguments accurately', () => {
      const parsed = parseArgs([
        'node',
        'migrateSqliteToPostgres.js',
        '--backup=/backups/backup.audiobookshelf',
        '-o',
        '/backups/out.audiobookshelf',
        '--schema=public',
        '--batch-size=250',
        '--allow-destructive-target',
        '--auto-widen-columns',
        '--dry-run'
      ])

      expect(parsed.backupPath).to.equal('/backups/backup.audiobookshelf')
      expect(parsed.outputPath).to.equal('/backups/out.audiobookshelf')
      expect(parsed.pgSchema).to.equal('public')
      expect(parsed.batchSize).to.equal(250)
      expect(parsed.allowDestructiveTarget).to.equal(true)
      expect(parsed.autoWidenColumns).to.equal(true)
      expect(parsed.dryRun).to.equal(true)

      const parsedNoWiden = parseArgs(['node', 'script.js', '--no-auto-widen-columns'])
      expect(parsedNoWiden.autoWidenColumns).to.equal(false)
    })

    it('should compute default postgres output backup path', () => {
      expect(getDefaultOutputPath('/backups/2026-10-18.audiobookshelf')).to.equal('/backups/2026-10-18-postgres.audiobookshelf')
      expect(getDefaultOutputPath('/backups/custom_backup.zip')).to.equal('/backups/custom_backup-postgres.audiobookshelf')
    })
  })

  describe('PostgreSQL connection parser', () => {
    it('should extract connection arguments and redact password', () => {
      const conn = getPostgresConnection('postgres://abs_user:secret_pass%21@db.host.internal:5433/abs_database')
      expect(conn.args).to.deep.equal([
        '--host', 'db.host.internal',
        '--dbname', 'abs_database',
        '--port', '5433',
        '--username', 'abs_user'
      ])
      expect(conn.env.PGPASSWORD).to.equal('secret_pass!')
      expect(conn.secrets).to.include('secret_pass!')
    })
  })

  describe('Backup archive extraction and conversion', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-backup-test-'))
    })

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    function createMockSqliteBackup(filePath) {
      return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(filePath)
        const archive = archiver('zip', { zlib: { level: 1 } })
        output.on('close', resolve)
        output.on('error', reject)
        archive.on('error', reject)
        archive.pipe(output)

        archive.append('mock sqlite db content', { name: 'absdatabase.sqlite' })
        archive.append('id-123\nsqlite\n1672531199000\n2.19.5', { name: 'details' })
        archive.append('cover image bytes', { name: 'metadata-items/item-1/cover.jpg' })
        archive.finalize()
      })
    }

    it('should extract sqlite backup and repackage into postgres-compatible backup', async () => {
      const sourceBackupPath = path.join(tempDir, 'source.audiobookshelf')
      const targetBackupPath = path.join(tempDir, 'target-postgres.audiobookshelf')
      const extractedDir = path.join(tempDir, 'extracted')

      await createMockSqliteBackup(sourceBackupPath)

      // 1. Extract
      const meta = await extractBackupArchive(sourceBackupPath, extractedDir)
      expect(meta.id).to.equal('id-123')
      expect(meta.key).to.equal('sqlite')
      expect(meta.serverVersion).to.equal('2.19.5')
      expect(fs.existsSync(path.join(extractedDir, 'absdatabase.sqlite'))).to.be.true
      expect(fs.existsSync(path.join(extractedDir, 'metadata-items/item-1/cover.jpg'))).to.be.true

      // 2. Mock creation of absdatabase.postgres.dump
      const mockDumpPath = path.join(extractedDir, 'absdatabase.postgres.dump')
      fs.writeFileSync(mockDumpPath, 'mock postgres custom dump binary')

      // 3. Create converted archive
      await createPostgresBackupArchive({
        outputBackupPath: targetBackupPath,
        tempDir: extractedDir,
        dumpFilePath: mockDumpPath,
        details: meta.details
      })

      expect(fs.existsSync(targetBackupPath)).to.be.true

      // 4. Verify converted archive contents using StreamZip
      const zip = new StreamZip.async({ file: targetBackupPath })
      try {
        const entries = await zip.entries()
        expect(entries['absdatabase.postgres.dump']).to.exist
        expect(entries['absdatabase.sqlite']).to.be.undefined
        expect(entries['details']).to.exist
        expect(entries['metadata-items/item-1/cover.jpg']).to.exist

        const detailsData = await zip.entryData('details')
        const detailsLines = detailsData.toString('utf8').split('\n')
        expect(detailsLines[0]).to.equal('id-123')
        expect(detailsLines[1]).to.equal('postgres')
        expect(detailsLines[2]).to.equal('1672531199000')
        expect(detailsLines[3]).to.equal('2.19.5')
      } finally {
        await zip.close()
      }
    })
  })
})

