const { expect } = require('chai')
const sinon = require('sinon')
const StorageManager = require('../../../server/storage/StorageManager')
const GcsStorageProvider = require('../../../server/storage/providers/GcsStorageProvider')
const LocalStorageProvider = require('../../../server/storage/providers/LocalStorageProvider')

describe('StorageManager & Providers', () => {
  let gcsProvider

  beforeEach(() => {
    gcsProvider = new GcsStorageProvider({ bucketName: 'smcgraw-abs-lib' })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('StorageManager routing', () => {
    it('should route standard filesystem paths to LocalStorageProvider by default', () => {
      const provider = StorageManager.getProvider('/audiobooks/Brandon Sanderson/Mistborn')
      expect(provider).to.be.an.instanceOf(LocalStorageProvider)
      expect(StorageManager.isGcsPath('/audiobooks/Brandon Sanderson/Mistborn')).to.be.false
    })

    it('should route gcs:// paths to GcsStorageProvider', () => {
      const provider = StorageManager.getProvider('gcs://smcgraw-abs-lib/audiobooks/Brandon Sanderson')
      expect(provider).to.be.an.instanceOf(GcsStorageProvider)
      expect(StorageManager.isGcsPath('gcs://smcgraw-abs-lib/audiobooks/Brandon Sanderson')).to.be.true
    })

    it('should route gs:// paths to GcsStorageProvider', () => {
      const provider = StorageManager.getProvider('gs://smcgraw-abs-lib/audiobooks/Brandon Sanderson')
      expect(provider).to.be.an.instanceOf(GcsStorageProvider)
      expect(StorageManager.isGcsPath('gs://smcgraw-abs-lib/audiobooks/Brandon Sanderson')).to.be.true
    })
  })

  describe('GcsStorageProvider path parsing', () => {
    it('should parse gcs:// URI format correctly', () => {
      const result = gcsProvider.parsePath('gcs://smcgraw-abs-lib/audiobooks/Sci-Fi/Dune/part1.mp3')
      expect(result.bucketName).to.equal('smcgraw-abs-lib')
      expect(result.key).to.equal('audiobooks/Sci-Fi/Dune/part1.mp3')
      expect(result.uri).to.equal('gcs://smcgraw-abs-lib/audiobooks/Sci-Fi/Dune/part1.mp3')
    })

    it('should parse gs:// URI format correctly', () => {
      const result = gcsProvider.parsePath('gs://custom-bucket/audiobooks/Book.m4b')
      expect(result.bucketName).to.equal('custom-bucket')
      expect(result.key).to.equal('audiobooks/Book.m4b')
      expect(result.uri).to.equal('gcs://custom-bucket/audiobooks/Book.m4b')
    })

    it('should parse relative paths using default bucket name', () => {
      const result = gcsProvider.parsePath('/audiobooks/Dune/part1.mp3')
      expect(result.bucketName).to.equal('smcgraw-abs-lib')
      expect(result.key).to.equal('audiobooks/Dune/part1.mp3')
      expect(result.uri).to.equal('gcs://smcgraw-abs-lib/audiobooks/Dune/part1.mp3')
    })
  })

  describe('GcsStorageProvider signed URLs', () => {
    it('should generate signed URL with v4 and read action', async () => {
      const mockFile = {
        getSignedUrl: sinon.stub().resolves(['https://storage.googleapis.com/smcgraw-abs-lib/audiobooks/test.mp3?X-Goog-Signature=123'])
      }
      sinon.stub(gcsProvider, 'getFile').returns(mockFile)

      const url = await gcsProvider.getSignedUrl('gcs://smcgraw-abs-lib/audiobooks/test.mp3', { expiryHours: 2 })

      expect(url).to.include('https://storage.googleapis.com/smcgraw-abs-lib/audiobooks/test.mp3')
      expect(mockFile.getSignedUrl.calledOnce).to.be.true
      const callArgs = mockFile.getSignedUrl.firstCall.args[0]
      expect(callArgs.version).to.equal('v4')
      expect(callArgs.action).to.equal('read')
    })
  })

  describe('StorageManager.join helper', () => {
    it('should correctly join local POSIX paths', () => {
      const joined = StorageManager.join('/audiobooks', 'Author', 'Book')
      expect(joined).to.equal('/audiobooks/Author/Book')
    })

    it('should preserve gcs:// scheme and bucket when joining GCS paths', () => {
      const joined = StorageManager.join('gcs://smcgraw-abs-lib/audiobooks', 'Brandon Sanderson', 'Mistborn')
      expect(joined).to.equal('gcs://smcgraw-abs-lib/audiobooks/Brandon Sanderson/Mistborn')
    })

    it('should handle collapsed gcs:/ scheme properly', () => {
      const result = gcsProvider.parsePath('gcs:/smcgraw-abs-lib/audiobooks/Book.mp3')
      expect(result.uri).to.equal('gcs://smcgraw-abs-lib/audiobooks/Book.mp3')
      expect(result.bucketName).to.equal('smcgraw-abs-lib')
      expect(result.key).to.equal('audiobooks/Book.mp3')
    })
  })

  describe('GcsStorageProvider.getBuckets', () => {
    it('should query and return available buckets', async () => {
      sinon.stub(gcsProvider.storage, 'getBuckets').resolves([
        [{ name: 'smcgraw-abs-lib' }, { name: 'backup-bucket' }]
      ])

      const buckets = await gcsProvider.getBuckets()
      expect(buckets).to.deep.equal([
        { name: 'smcgraw-abs-lib', uri: 'gcs://smcgraw-abs-lib' },
        { name: 'backup-bucket', uri: 'gcs://backup-bucket' }
      ])
    })
  })

  describe('fileUtils GCS delegation', () => {
    const fileUtils = require('../../../server/utils/fileUtils')

    it('should identify GCS paths correctly', () => {
      expect(fileUtils.isGcsPath('gcs://bucket/file.m4b')).to.be.true
      expect(fileUtils.isGcsPath('gs://bucket/file.m4b')).to.be.true
      expect(fileUtils.isGcsPath('/local/file.m4b')).to.be.false
    })

    it('should route recurseFiles to GcsStorageProvider', async () => {
      const gcsMock = sinon.stub(StorageManager.gcsProvider, 'recurseFiles').resolves([
        { name: 'book.m4b', fullpath: 'gcs://smcgraw-abs-lib/book.m4b' }
      ])
      const res = await fileUtils.recurseFiles('gcs://smcgraw-abs-lib/book')
      expect(gcsMock.calledOnce).to.be.true
      expect(res).to.deep.equal([{ name: 'book.m4b', fullpath: 'gcs://smcgraw-abs-lib/book.m4b' }])
    })

    it('should route getFileTimestampsWithIno to GcsStorageProvider', async () => {
      const gcsMock = sinon.stub(StorageManager.gcsProvider, 'getFileTimestampsWithIno').resolves({
        size: 1000,
        mtimeMs: 123456789,
        ctimeMs: 123456789,
        birthtimeMs: 123456789,
        ino: '987654321'
      })
      const res = await fileUtils.getFileTimestampsWithIno('gcs://smcgraw-abs-lib/book')
      expect(gcsMock.calledOnce).to.be.true
      expect(res.ino).to.equal('987654321')
    })
  })
})

