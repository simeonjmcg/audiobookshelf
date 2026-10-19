const { expect } = require('chai')
const sinon = require('sinon')
const GcsWatcher = require('../../../server/GcsWatcher')

describe('GcsWatcher', () => {
  let gcsWatcher
  let mockFolderWatcher

  beforeEach(() => {
    mockFolderWatcher = {
      libraryWatchers: [
        {
          id: 'lib_1',
          name: 'Audiobooks',
          libraryFolders: [
            { id: 'fol_1', path: 'gcs://smcgraw-abs-lib/audiobooks' }
          ]
        }
      ],
      onFileAdded: sinon.spy(),
      onFileRemoved: sinon.spy()
    }
    gcsWatcher = new GcsWatcher(mockFolderWatcher)
  })

  afterEach(() => {
    sinon.restore()
  })

  it('matches incoming GCS object paths to the correct library and folder', () => {
    const match = gcsWatcher.findMatchingLibraryAndFolder('gcs://smcgraw-abs-lib/audiobooks/Author/Title/track.mp3')
    expect(match).to.not.be.null
    expect(match.library.id).to.equal('lib_1')
    expect(match.folder.id).to.equal('fol_1')
  })

  it('returns null if the path does not match any library folder', () => {
    const match = gcsWatcher.findMatchingLibraryAndFolder('gcs://smcgraw-abs-lib/other-folder/file.mp3')
    expect(match).to.be.null
  })

  it('dispatches onFileAdded on OBJECT_FINALIZE events and acknowledges message', async () => {
    const ackSpy = sinon.spy()
    const message = {
      attributes: {
        eventType: 'OBJECT_FINALIZE',
        bucketId: 'smcgraw-abs-lib',
        objectId: 'audiobooks/Brandon Sanderson/Mistborn/01.mp3'
      },
      ack: ackSpy
    }

    await gcsWatcher.handleMessage(message)

    expect(ackSpy.calledOnce).to.be.true
    expect(mockFolderWatcher.onFileAdded.calledOnce).to.be.true
    expect(mockFolderWatcher.onFileAdded.firstCall.args[0]).to.equal('lib_1')
    expect(mockFolderWatcher.onFileAdded.firstCall.args[1]).to.equal('gcs://smcgraw-abs-lib/audiobooks/Brandon Sanderson/Mistborn/01.mp3')
  })

  it('dispatches onFileRemoved on OBJECT_DELETE events and acknowledges message', async () => {
    const ackSpy = sinon.spy()
    const message = {
      attributes: {
        eventType: 'OBJECT_DELETE',
        bucketId: 'smcgraw-abs-lib',
        objectId: 'audiobooks/Brandon Sanderson/Mistborn/01.mp3'
      },
      ack: ackSpy
    }

    await gcsWatcher.handleMessage(message)

    expect(ackSpy.calledOnce).to.be.true
    expect(mockFolderWatcher.onFileRemoved.calledOnce).to.be.true
    expect(mockFolderWatcher.onFileRemoved.firstCall.args[0]).to.equal('lib_1')
    expect(mockFolderWatcher.onFileRemoved.firstCall.args[1]).to.equal('gcs://smcgraw-abs-lib/audiobooks/Brandon Sanderson/Mistborn/01.mp3')
  })

  it('ignores directory marker objects ending with / and acknowledges', async () => {
    const ackSpy = sinon.spy()
    const message = {
      attributes: {
        eventType: 'OBJECT_FINALIZE',
        bucketId: 'smcgraw-abs-lib',
        objectId: 'audiobooks/Brandon Sanderson/Mistborn/'
      },
      ack: ackSpy
    }

    await gcsWatcher.handleMessage(message)

    expect(ackSpy.calledOnce).to.be.true
    expect(mockFolderWatcher.onFileAdded.called).to.be.false
  })
})
