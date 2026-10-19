const stream = require('stream')
const { ERRORS, TUS_RESUMABLE, Upload, DataStore } = require('@tus/server')
const Logger = require('../Logger')

/**
 * Custom GCS DataStore for @tus/server.
 * Extends DataStore and stores chunks and metadata in Google Cloud Storage
 * with automatic path prefixing (defaulting to metadata/tmp/tus/).
 */
class GcsTusDataStore extends DataStore {
  constructor(options = {}) {
    super()
    if (!options.bucket) {
      throw new Error('GcsTusDataStore must have a bucket')
    }
    this.bucket = options.bucket
    this.prefix = options.prefix || 'metadata/tmp/tus/'
    this.extensions = ['creation', 'creation-with-upload', 'creation-defer-length']
  }

  getFilePath(id) {
    if (!id) return ''
    return id.startsWith(this.prefix) ? id : `${this.prefix}${id}`
  }

  create(file) {
    return new Promise((resolve, reject) => {
      if (!file.id) {
        reject(ERRORS.FILE_NOT_FOUND)
        return
      }
      const gcsPath = this.getFilePath(file.id)
      const gcsFile = this.bucket.file(gcsPath)
      file.storage = { type: 'gcs', path: gcsPath, bucket: this.bucket.name }

      const options = {
        metadata: {
          metadata: {
            tus_version: TUS_RESUMABLE,
            ...this._stringifyUploadKeys(file)
          }
        }
      }
      if (file.metadata?.contentType) {
        options.contentType = file.metadata.contentType
      }

      const passThrough = new stream.PassThrough()
      passThrough.end()
      passThrough
        .pipe(gcsFile.createWriteStream(options))
        .on('error', reject)
        .on('finish', () => {
          resolve(file)
        })
    })
  }

  read(fileId) {
    return this.bucket.file(this.getFilePath(fileId)).createReadStream()
  }

  write(readable, id, offset) {
    return this.getUpload(id).then((upload) => {
      return new Promise((resolve, reject) => {
        const filePath = this.getFilePath(id)
        const file = this.bucket.file(filePath)
        const destination = upload.offset === 0 ? file : this.bucket.file(`${filePath}_patch`)
        upload.offset = offset

        const options = {
          metadata: {
            metadata: {
              tus_version: TUS_RESUMABLE,
              ...this._stringifyUploadKeys(upload)
            }
          }
        }

        const writeStream = destination.createWriteStream(options)
        if (!writeStream || readable.destroyed) {
          reject(ERRORS.FILE_WRITE_ERROR)
          return
        }

        let bytesReceived = upload.offset
        readable.on('data', (buffer) => {
          bytesReceived += buffer.length
        })

        stream.pipeline(readable, writeStream, async (err) => {
          if (err) {
            Logger.error('[GcsTusDataStore] Error writing chunk to GCS', err)
            try {
              await destination.delete({ ignoreNotFound: true })
            } finally {
              reject(ERRORS.FILE_WRITE_ERROR)
            }
          } else {
            try {
              if (file !== destination) {
                await this.bucket.combine([file, destination], file)
                await Promise.all([
                  file.setMetadata(options.metadata),
                  destination.delete({ ignoreNotFound: true })
                ])
              }
              resolve(bytesReceived)
            } catch (error) {
              Logger.error('[GcsTusDataStore] Error combining chunks in GCS', error)
              reject(ERRORS.FILE_WRITE_ERROR)
            }
          }
        })
      })
    })
  }

  getUpload(id) {
    return new Promise((resolve, reject) => {
      if (!id) {
        reject(ERRORS.FILE_NOT_FOUND)
        return
      }
      const gcsPath = this.getFilePath(id)
      this.bucket.file(gcsPath).getMetadata((error, metadata) => {
        if (error && error.code === 404) {
          return reject(ERRORS.FILE_NOT_FOUND)
        }
        if (error) {
          Logger.error('[GcsTusDataStore] getMetadata error', error)
          return reject(error)
        }
        const customMeta = metadata?.metadata || {}
        const size = customMeta.size
        const meta = customMeta.metadata

        return resolve(new Upload({
          id,
          size: size ? Number.parseInt(size, 10) : undefined,
          offset: Number.parseInt(metadata.size, 10),
          metadata: meta ? JSON.parse(meta) : undefined,
          storage: { type: 'gcs', path: gcsPath, bucket: this.bucket.name }
        }))
      })
    })
  }

  async declareUploadLength(id, uploadLength) {
    const upload = await this.getUpload(id)
    upload.size = uploadLength
    const gcsPath = this.getFilePath(id)
    await this.bucket.file(gcsPath).setMetadata({
      metadata: this._stringifyUploadKeys(upload)
    })
  }

  _stringifyUploadKeys(upload) {
    return {
      size: upload.size ?? null,
      sizeIsDeferred: `${upload.sizeIsDeferred}`,
      offset: upload.offset,
      metadata: JSON.stringify(upload.metadata),
      storage: JSON.stringify(upload.storage)
    }
  }
}

module.exports = GcsTusDataStore
