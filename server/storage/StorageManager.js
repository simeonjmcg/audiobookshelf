const Path = require('path')
const LocalStorageProvider = require('./providers/LocalStorageProvider')
const GcsStorageProvider = require('./providers/GcsStorageProvider')
const Logger = require('../Logger')

class StorageManager {
  constructor() {
    this.localProvider = new LocalStorageProvider()
    this.gcsProvider = null

    // Lazy or eager initialize GCS provider
    try {
      this.gcsProvider = new GcsStorageProvider()
    } catch (err) {
      Logger.warn(`[StorageManager] GCS provider initialization deferred: ${err.message}`)
    }
  }

  /**
   * Determine the storage provider for a given path
   * @param {string} path
   * @returns {LocalStorageProvider|GcsStorageProvider}
   */
  getProvider(path) {
    if (!path) return this.localProvider

    const strPath = String(path)
    if (strPath.startsWith('gcs:') || strPath.startsWith('gs:')) {
      if (!this.gcsProvider) {
        this.gcsProvider = new GcsStorageProvider()
      }
      return this.gcsProvider
    }

    if (process.env.STORAGE_PROVIDER === 'gcs') {
      // Internal config, metadata, and streams paths stay local
      if (global.ConfigPath && strPath.startsWith(global.ConfigPath)) return this.localProvider
      if (global.MetadataPath && strPath.startsWith(global.MetadataPath)) return this.localProvider
      if (!this.gcsProvider) {
        this.gcsProvider = new GcsStorageProvider()
      }
      return this.gcsProvider
    }

    return this.localProvider
  }

  isGcsPath(path) {
    return this.getProvider(path).type === 'gcs'
  }

  async pathExists(path) {
    return this.getProvider(path).pathExists(path)
  }

  async stat(path) {
    return this.getProvider(path).stat(path)
  }

  async getFileTimestampsWithIno(path) {
    return this.getProvider(path).getFileTimestampsWithIno(path)
  }

  async getIno(path) {
    return this.getProvider(path).getIno(path)
  }

  join(base, ...parts) {
    if (this.isGcsPath(base)) {
      const { bucketName, key } = this.getProvider(base).parsePath(base)
      const combinedKey = Path.posix.join(key || '', ...parts)
      return `gcs://${bucketName}/${combinedKey.replace(/^\/+/, '')}`
    }
    return Path.posix.join(base, ...parts)
  }

  async ensureDir(path) {
    return this.getProvider(path).ensureDir(path)
  }

  async readdir(path) {
    return this.getProvider(path).readdir(path)
  }

  async recurseFiles(path, relPathToReplace = null) {
    return this.getProvider(path).recurseFiles(path, relPathToReplace)
  }

  async getDirectoriesInPath(dirPath, level = 0) {
    return this.getProvider(dirPath).getDirectoriesInPath(dirPath, level)
  }

  async getBuckets() {
    if (!this.gcsProvider) {
      try {
        this.gcsProvider = new GcsStorageProvider()
      } catch (err) {
        return []
      }
    }
    return this.gcsProvider.getBuckets()
  }

  async rename(oldPath, newPath) {
    const srcProvider = this.getProvider(oldPath)
    const destProvider = this.getProvider(newPath)
    if (srcProvider !== destProvider) {
      throw new Error(`[StorageManager] Cross-provider rename not supported (${srcProvider.type} -> ${destProvider.type})`)
    }
    return srcProvider.rename(oldPath, newPath)
  }

  async delete(path) {
    return this.getProvider(path).delete(path)
  }

  async readFile(path, encoding = null) {
    return this.getProvider(path).readFile(path, encoding)
  }

  async writeFile(path, data, options = null) {
    return this.getProvider(path).writeFile(path, data, options)
  }

  createReadStream(path, options = {}) {
    return this.getProvider(path).createReadStream(path, options)
  }

  createWriteStream(path, options = {}) {
    return this.getProvider(path).createWriteStream(path, options)
  }

  async getSignedUrl(path, options = {}) {
    return this.getProvider(path).getSignedUrl(path, options)
  }

  get isGcsEnabled() {
    return !!(this.gcsProvider && (this.gcsProvider.defaultBucketName || process.env.GCS_BUCKET_NAME))
  }

  get defaultBucketName() {
    return this.gcsProvider?.defaultBucketName || process.env.GCS_BUCKET_NAME || null
  }

  /**
   * Translates a metadata path (e.g. /metadata/authors/abc.jpg or gcs://.../metadata/authors/abc.jpg)
   * to its corresponding GCS URI, local cache path, and storage key.
   * @param {string} filePath 
   * @returns {{ gcsUri: string, localPath: string, key: string }|null}
   */
  resolveMetadataPaths(filePath) {
    if (!filePath || !this.isGcsEnabled) return null
    const str = String(filePath).trim()
    const metadataPath = global.MetadataPath || '/metadata'

    let subpath = null
    if (str.startsWith('gcs:') || str.startsWith('gs:')) {
      const { key } = this.gcsProvider.parsePath(str)
      if (key.startsWith('metadata/')) {
        subpath = key.substring('metadata/'.length)
      } else {
        return null
      }
    } else if (str.startsWith(metadataPath)) {
      subpath = str.substring(metadataPath.length).replace(/^\/+/, '')
    } else if (str.startsWith('/metadata/')) {
      subpath = str.substring('/metadata/'.length)
    }

    if (!subpath) return null
    const key = `metadata/${subpath}`
    const gcsUri = `gcs://${this.defaultBucketName}/${key}`
    const localPath = Path.join(metadataPath, subpath)
    return { gcsUri, localPath, key }
  }

  /**
   * Ensures that a metadata file (author image, cover, metadata.json) exists in the local
   * ephemeral cache. If not found locally, downloads it on-demand from GCS.
   * @param {string} filePath 
   * @returns {Promise<string|null>} returns the local path if available/downloaded, or null
   */
  async ensureLocalMetadata(filePath) {
    if (!filePath) return null
    const fs = require('../libs/fsExtra')

    // If file already exists locally and is non-empty, return it immediately
    try {
      if ((await fs.pathExists(filePath)) && (await fs.stat(filePath).then((s) => s.size > 0).catch(() => false))) {
        return filePath
      }
    } catch (err) {}

    const resolved = this.resolveMetadataPaths(filePath)
    if (!resolved) {
      return (await fs.pathExists(filePath)) ? filePath : null
    }

    try {
      if ((await fs.pathExists(resolved.localPath)) && (await fs.stat(resolved.localPath).then((s) => s.size > 0).catch(() => false))) {
        return resolved.localPath
      }
    } catch (err) {}

    // Attempt to download from GCS
    try {
      if (!this.gcsProvider) return null
      const file = this.gcsProvider.getBucket().file(resolved.key)
      const [exists] = await file.exists()
      if (!exists) {
        return null
      }

      await fs.ensureDir(Path.dirname(resolved.localPath))
      await file.download({ destination: resolved.localPath })
      Logger.debug(`[StorageManager] Downloaded metadata file from GCS: "${resolved.key}" -> "${resolved.localPath}"`)
      return resolved.localPath
    } catch (err) {
      Logger.error(`[StorageManager] Failed to download metadata file from GCS "${resolved.key}": ${err.message}`)
      return null
    }
  }

  /**
   * Upload a newly saved or updated local metadata file to GCS
   * @param {string} localPath 
   */
  async saveMetadataFile(localPath) {
    const resolved = this.resolveMetadataPaths(localPath)
    if (!resolved || !this.gcsProvider) return
    const fs = require('../libs/fsExtra')

    try {
      if (!(await fs.pathExists(resolved.localPath))) return
      const file = this.gcsProvider.getBucket().file(resolved.key)
      await file.save(await fs.readFile(resolved.localPath), {
        resumable: false
      })
      Logger.debug(`[StorageManager] Uploaded metadata file to GCS: "${resolved.localPath}" -> "${resolved.gcsUri}"`)
    } catch (err) {
      Logger.error(`[StorageManager] Failed to upload metadata file to GCS: ${err.message}`)
    }
  }

  /**
   * Remove a metadata file locally and from GCS
   * @param {string} filePath 
   */
  async removeMetadataFile(filePath) {
    const resolved = this.resolveMetadataPaths(filePath)
    const fs = require('../libs/fsExtra')
    if (resolved && this.gcsProvider) {
      try {
        const file = this.gcsProvider.getBucket().file(resolved.key)
        await file.delete({ ignoreNotFound: true })
        Logger.debug(`[StorageManager] Deleted metadata file from GCS: "${resolved.key}"`)
      } catch (err) {
        Logger.error(`[StorageManager] Failed to delete metadata file from GCS: ${err.message}`)
      }
      if (await fs.pathExists(resolved.localPath)) {
        await fs.unlink(resolved.localPath).catch(() => {})
      }
    } else if (await fs.pathExists(filePath)) {
      await fs.unlink(filePath).catch(() => {})
    }
  }
}

module.exports = new StorageManager()
