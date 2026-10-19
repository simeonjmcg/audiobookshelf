const { expect } = require('chai')
const sinon = require('sinon')
const StorageManager = require('../../../server/storage/StorageManager')
const MiscController = require('../../../server/controllers/MiscController')

describe('MiscController Tus Resumable Uploads Multi-Replica Support', () => {
  let originalMetadataPath

  before(() => {
    originalMetadataPath = global.MetadataPath
    global.MetadataPath = '/tmp'
  })

  after(() => {
    global.MetadataPath = originalMetadataPath
  })

  afterEach(() => {
    sinon.restore()
    MiscController.tusServer = null
  })

  it('should initialize with TusFileStore when GCS is not enabled', () => {
    sinon.stub(StorageManager, 'gcsProvider').value(null)

    MiscController.initTusServer()
    expect(MiscController.tusServer).to.exist
    expect(MiscController.tusServer.options.path).to.equal('/api/upload/tus')
    expect(MiscController.tusServer.datastore).to.exist
  })

  it('should initialize with GCSStore when GCS provider has default bucket', () => {
    const mockFile = sinon.stub().callsFake((name) => ({ name }))
    const mockBucket = {
      name: 'test-bucket',
      file: mockFile
    }

    sinon.stub(StorageManager, 'gcsProvider').value({
      defaultBucketName: 'test-bucket',
      storage: {},
      getBucket: sinon.stub().returns(mockBucket)
    })

    MiscController.initTusServer()
    expect(MiscController.tusServer).to.exist
    expect(MiscController.tusServer.options.path).to.equal('/api/upload/tus')
    expect(MiscController.tusServer.datastore).to.exist
    expect(MiscController.tusServer.datastore.bucket).to.exist
    expect(MiscController.tusServer.datastore.bucket.name).to.equal('test-bucket')

    // Test bucket proxy prepending metadata/tmp/tus/
    MiscController.tusServer.datastore.bucket.file('upload-uuid-123')
    expect(mockFile.calledWith('metadata/tmp/tus/upload-uuid-123')).to.be.true
  })
})
