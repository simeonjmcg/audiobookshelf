const { expect } = require('chai')
const sqlite3 = require('sqlite3')
const fs = require('fs')
const path = require('path')
const os = require('os')
const archiver = require('../../../server/libs/archiver')
const StreamZip = require('../../../server/libs/nodeStreamZip')

const {
  normalizePrefix,
  replacePathPrefix,
  replaceInObject,
  transformValue,
  renamePathsInSqliteDb,
  renameBackupArchive,
  parseArgs
} = require('../../../server/scripts/renameBackupPaths')

describe('renameBackupPaths script helpers', () => {
  it('should normalize path prefixes', () => {
    expect(normalizePrefix('/audiobooks/')).to.equal('/audiobooks')
    expect(normalizePrefix('gcs://smcgraw-abs-lib///')).to.equal('gcs://smcgraw-abs-lib')
    expect(normalizePrefix('')).to.equal('')
  })

  it('should replace path prefixes correctly and avoid partial substring collisions', () => {
    const from = '/audiobooks'
    const to = 'gcs://smcgraw-abs-lib'

    expect(replacePathPrefix('/audiobooks', from, to)).to.equal('gcs://smcgraw-abs-lib')
    expect(replacePathPrefix('/audiobooks/Mira Grant/Parasite', from, to)).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite')
    expect(replacePathPrefix('/audiobooks/Mira Grant/Parasite/Parasite.m4b', from, to)).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/Parasite.m4b')

    // Should NOT match /audiobookshelf or /audiobooks_extra
    expect(replacePathPrefix('/audiobookshelf/config', from, to)).to.equal('/audiobookshelf/config')
    expect(replacePathPrefix('/audiobooks_extra/book', from, to)).to.equal('/audiobooks_extra/book')

    // Should NOT match metadata or other folders
    expect(replacePathPrefix('/metadata/items/123/cover.jpg', from, to)).to.equal('/metadata/items/123/cover.jpg')
    expect(replacePathPrefix('A string mentioning /audiobooks in the middle', from, to)).to.equal('A string mentioning /audiobooks in the middle')
  })

  it('should recursively replace path prefixes inside complex JSON structures', () => {
    const from = '/audiobooks'
    const to = 'gcs://smcgraw-abs-lib'

    const libraryFiles = [
      {
        ino: '101',
        metadata: {
          path: '/audiobooks/Mira Grant/Parasite/Parasite.m4b',
          relPath: 'Parasite.m4b',
          size: 1048576
        }
      },
      {
        ino: '102',
        metadata: {
          path: '/audiobooks/Mira Grant/Parasite/cover.jpg',
          relPath: 'cover.jpg',
          size: 20480
        }
      }
    ]

    const updated = replaceInObject(libraryFiles, from, to)

    expect(updated[0].metadata.path).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/Parasite.m4b')
    expect(updated[0].metadata.relPath).to.equal('Parasite.m4b')
    expect(updated[1].metadata.path).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/cover.jpg')
  })

  it('should transform serialized JSON strings in database columns', () => {
    const from = '/audiobooks'
    const to = 'gcs://smcgraw-abs-lib'

    const jsonStr = JSON.stringify([
      {
        metadata: {
          path: '/audiobooks/Author/Title/file.m4b'
        }
      }
    ])

    const transformed = transformValue(jsonStr, from, to)
    const parsed = JSON.parse(transformed)

    expect(parsed[0].metadata.path).to.equal('gcs://smcgraw-abs-lib/Author/Title/file.m4b')
  })

  it('should parse command-line arguments accurately', () => {
    const parsed = parseArgs([
      'node',
      'renameBackupPaths.js',
      '--backup=/backups/backup.audiobookshelf',
      '--from=/audiobooks',
      '--to=gcs://smcgraw-abs-lib',
      '--output=/backups/out.audiobookshelf',
      '--dry-run'
    ])

    expect(parsed.backupPath).to.equal('/backups/backup.audiobookshelf')
    expect(parsed.fromPrefix).to.equal('/audiobooks')
    expect(parsed.toPrefix).to.equal('gcs://smcgraw-abs-lib')
    expect(parsed.outputPath).to.equal('/backups/out.audiobookshelf')
    expect(parsed.dryRun).to.equal(true)
  })

  describe('SQLite database and backup archive renaming', () => {
    let tempDir

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-rename-test-'))
    })

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    function openDb(filePath) {
      return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filePath, (err) => {
          if (err) return reject(err)
          resolve(db)
        })
      })
    }

    function run(db, sql, params = []) {
      return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }

    function all(db, sql, params = []) {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) return reject(err)
          resolve(rows)
        })
      })
    }

    function closeDb(db) {
      return new Promise((resolve, reject) => {
        db.close((err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }

    it('should rename paths across tables and JSON columns in a SQLite database', async () => {
      const dbPath = path.join(tempDir, 'test.sqlite')
      const db = await openDb(dbPath)

      try {
        await run(db, 'CREATE TABLE libraryFolders (id TEXT PRIMARY KEY, path TEXT)')
        await run(db, 'CREATE TABLE libraryItems (id TEXT PRIMARY KEY, path TEXT, libraryFiles TEXT)')
        await run(db, 'CREATE TABLE books (id TEXT PRIMARY KEY, coverPath TEXT, audioFiles TEXT)')
        await run(db, 'CREATE TABLE playbackSessions (id TEXT PRIMARY KEY, coverPath TEXT)')

        await run(db, 'INSERT INTO libraryFolders VALUES (?, ?)', ['f1', '/audiobooks'])
        await run(db, 'INSERT INTO libraryItems VALUES (?, ?, ?)', [
          'item1',
          '/audiobooks/Mira Grant/Parasite',
          JSON.stringify([{ metadata: { path: '/audiobooks/Mira Grant/Parasite/Parasite.m4b' } }])
        ])
        await run(db, 'INSERT INTO books VALUES (?, ?, ?)', [
          'b1',
          '/audiobooks/Mira Grant/Parasite/cover.jpg',
          JSON.stringify([{ metadata: { path: '/audiobooks/Mira Grant/Parasite/Parasite.m4b' } }])
        ])
        await run(db, 'INSERT INTO playbackSessions VALUES (?, ?)', ['s1', '/audiobooks/Mira Grant/Parasite/cover.jpg'])

        const stats = await renamePathsInSqliteDb(db, {
          fromPrefix: '/audiobooks',
          toPrefix: 'gcs://smcgraw-abs-lib'
        })

        expect(stats.rowsUpdated).to.be.greaterThan(0)

        const folders = await all(db, 'SELECT * FROM libraryFolders')
        expect(folders[0].path).to.equal('gcs://smcgraw-abs-lib')

        const items = await all(db, 'SELECT * FROM libraryItems')
        expect(items[0].path).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite')
        const itemFiles = JSON.parse(items[0].libraryFiles)
        expect(itemFiles[0].metadata.path).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/Parasite.m4b')

        const books = await all(db, 'SELECT * FROM books')
        expect(books[0].coverPath).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/cover.jpg')
        const bookAudio = JSON.parse(books[0].audioFiles)
        expect(bookAudio[0].metadata.path).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/Parasite.m4b')

        const sessions = await all(db, 'SELECT * FROM playbackSessions')
        expect(sessions[0].coverPath).to.equal('gcs://smcgraw-abs-lib/Mira Grant/Parasite/cover.jpg')
      } finally {
        await closeDb(db)
      }
    })

    it('should rename paths inside a .audiobookshelf backup archive', async () => {
      const sqlitePath = path.join(tempDir, 'absdatabase.sqlite')
      const backupPath = path.join(tempDir, 'backup.audiobookshelf')
      const outBackupPath = path.join(tempDir, 'backup-renamed.audiobookshelf')

      // 1. Create a SQLite database with a folder and item
      const db = await openDb(sqlitePath)
      await run(db, 'CREATE TABLE libraryFolders (id TEXT PRIMARY KEY, path TEXT)')
      await run(db, 'INSERT INTO libraryFolders VALUES (?, ?)', ['f1', '/audiobooks'])
      await closeDb(db)

      // 2. Package it into a .audiobookshelf zip archive
      await new Promise((resolve, reject) => {
        const outStream = fs.createWriteStream(backupPath)
        const archive = archiver('zip', { zlib: { level: 1 } })
        outStream.on('close', resolve)
        outStream.on('error', reject)
        archive.on('error', reject)
        archive.pipe(outStream)

        archive.file(sqlitePath, { name: 'absdatabase.sqlite' })
        archive.append('id-test\nsqlite\n1672531199000\n2.37.1', { name: 'details' })
        archive.finalize()
      })

      // 3. Run renameBackupArchive
      const stats = await renameBackupArchive({
        backupPath,
        outputPath: outBackupPath,
        fromPrefix: '/audiobooks',
        toPrefix: 'gcs://smcgraw-abs-lib'
      })

      expect(stats.rowsUpdated).to.equal(1)
      expect(fs.existsSync(outBackupPath)).to.be.true

      // 4. Verify inside the new archive that the SQLite database has the new path
      const verifyZip = new StreamZip.async({ file: outBackupPath })
      const verifyExtractDir = path.join(tempDir, 'verify-extracted')
      await fs.promises.mkdir(verifyExtractDir, { recursive: true })
      await verifyZip.extract('absdatabase.sqlite', path.join(verifyExtractDir, 'absdatabase.sqlite'))
      await verifyZip.close()

      const verifyDb = await openDb(path.join(verifyExtractDir, 'absdatabase.sqlite'))
      const folders = await all(verifyDb, 'SELECT * FROM libraryFolders')
      await closeDb(verifyDb)

      expect(folders[0].path).to.equal('gcs://smcgraw-abs-lib')
    })
  })
})
