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
}

module.exports = new StorageManager()
