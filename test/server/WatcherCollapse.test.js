const { expect } = require('chai')
const WatcherInstance = require('../../server/Watcher')

describe('Watcher Event Collapsing', () => {
  let folderWatcher

  beforeEach(() => {
    // Instantiate a clean FolderWatcher
    const FolderWatcherClass = WatcherInstance.constructor
    folderWatcher = new FolderWatcherClass()
    folderWatcher.libraryWatchers = [
      {
        id: 'lib_1',
        name: 'Audiobooks',
        libraryFolders: [
          { id: 'fol_1', path: 'gcs://smcgraw-abs-lib/audiobooks' }
        ]
      }
    ]
  })

  it('collapses HNS folder rename and file deletes/adds under old and new paths', () => {
    const oldFolder = 'gcs://smcgraw-abs-lib/audiobooks/Author/OldBook'
    const newFolder = 'gcs://smcgraw-abs-lib/audiobooks/Author/NewBook'

    folderWatcher.pendingFolderRenames.push({
      libraryId: 'lib_1',
      oldPath: oldFolder,
      newPath: newFolder
    })

    folderWatcher.pendingFileUpdates = [
      {
        path: `${oldFolder}/01.mp3`,
        relPath: '/Author/OldBook/01.mp3',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'deleted'
      },
      {
        path: `${oldFolder}/desc.txt`,
        relPath: '/Author/OldBook/desc.txt',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'deleted'
      },
      {
        path: `${newFolder}/01.mp3`,
        relPath: '/Author/NewBook/01.mp3',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'added'
      },
      {
        path: `${newFolder}/desc.txt`,
        relPath: '/Author/NewBook/desc.txt',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'added'
      }
    ]

    folderWatcher.collapsePendingFileUpdates()

    // Old deletes should be removed
    expect(folderWatcher.pendingFileUpdates.some((u) => u.type === 'deleted')).to.be.false

    // New adds should be converted to renames with oldPath mapped
    expect(folderWatcher.pendingFileUpdates).to.have.length(2)
    const audioUpdate = folderWatcher.pendingFileUpdates.find((u) => u.path === `${newFolder}/01.mp3`)
    expect(audioUpdate).to.exist
    expect(audioUpdate.type).to.equal('renamed')
    expect(audioUpdate.oldPath).to.equal(`${oldFolder}/01.mp3`)

    const textUpdate = folderWatcher.pendingFileUpdates.find((u) => u.path === `${newFolder}/desc.txt`)
    expect(textUpdate).to.exist
    expect(textUpdate.type).to.equal('renamed')
    expect(textUpdate.oldPath).to.equal(`${oldFolder}/desc.txt`)
  })

  it('ensures folder rename update exists when atomic folder rename has no child events', () => {
    const oldFolder = 'gcs://smcgraw-abs-lib/audiobooks/Author/OldBook'
    const newFolder = 'gcs://smcgraw-abs-lib/audiobooks/Author/NewBook'

    folderWatcher.pendingFolderRenames.push({
      libraryId: 'lib_1',
      oldPath: oldFolder,
      newPath: newFolder
    })

    folderWatcher.pendingFileUpdates = []

    folderWatcher.collapsePendingFileUpdates()

    expect(folderWatcher.pendingFileUpdates).to.have.length(1)
    const update = folderWatcher.pendingFileUpdates[0]
    expect(update.path).to.equal(newFolder)
    expect(update.oldPath).to.equal(oldFolder)
    expect(update.type).to.equal('renamed')
    expect(update.isDir).to.be.true
  })

  it('collapses file-level 1-to-1 delete and add in the same directory into a rename', () => {
    const dir = 'gcs://smcgraw-abs-lib/audiobooks/Author/Book'
    folderWatcher.pendingFileUpdates = [
      {
        path: `${dir}/01 - Old Title.mp3`,
        relPath: '/Author/Book/01 - Old Title.mp3',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'deleted'
      },
      {
        path: `${dir}/01 - New Title.mp3`,
        relPath: '/Author/Book/01 - New Title.mp3',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'added'
      }
    ]

    folderWatcher.collapsePendingFileUpdates()

    expect(folderWatcher.pendingFileUpdates).to.have.length(1)
    const update = folderWatcher.pendingFileUpdates[0]
    expect(update.path).to.equal(`${dir}/01 - New Title.mp3`)
    expect(update.oldPath).to.equal(`${dir}/01 - Old Title.mp3`)
    expect(update.type).to.equal('renamed')
  })

  it('collapses file moved across directories with matching basename into a rename', () => {
    folderWatcher.pendingFileUpdates = [
      {
        path: 'gcs://smcgraw-abs-lib/audiobooks/Author/OldDir/track01.mp3',
        relPath: '/Author/OldDir/track01.mp3',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'deleted'
      },
      {
        path: 'gcs://smcgraw-abs-lib/audiobooks/Author/NewDir/track01.mp3',
        relPath: '/Author/NewDir/track01.mp3',
        folderId: 'fol_1',
        libraryId: 'lib_1',
        type: 'added'
      }
    ]

    folderWatcher.collapsePendingFileUpdates()

    expect(folderWatcher.pendingFileUpdates).to.have.length(2)
    const update = folderWatcher.pendingFileUpdates.find((u) => u.path === 'gcs://smcgraw-abs-lib/audiobooks/Author/NewDir/track01.mp3')
    expect(update).to.exist
    expect(update.oldPath).to.equal('gcs://smcgraw-abs-lib/audiobooks/Author/OldDir/track01.mp3')
    expect(update.type).to.equal('renamed')

    const sourceDirUpdate = folderWatcher.pendingFileUpdates.find((u) => u.path === 'gcs://smcgraw-abs-lib/audiobooks/Author/OldDir')
    expect(sourceDirUpdate).to.exist
    expect(sourceDirUpdate.type).to.equal('updated')
    expect(sourceDirUpdate.isDir).to.be.true
  })

  it('cancels file added and immediately deleted during debounce window', () => {
    const file = 'gcs://smcgraw-abs-lib/audiobooks/Author/Book/temp.mp3'
    folderWatcher.addFileUpdate('lib_1', file, 'added')
    expect(folderWatcher.pendingFileUpdates).to.have.length(1)

    folderWatcher.addFileUpdate('lib_1', file, 'deleted')
    expect(folderWatcher.pendingFileUpdates).to.have.length(0)
  })
})
