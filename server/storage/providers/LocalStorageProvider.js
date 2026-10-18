const Path = require('path')
const fs = require('../../libs/fsExtra')
const fileUtils = require('../../utils/fileUtils')
const Logger = require('../../Logger')

class LocalStorageProvider {
  constructor() {
    this.type = 'local'
  }

  isSupported(path) {
    if (!path) return false
    return !path.startsWith('gcs://') && !path.startsWith('gs://')
  }

  normalizePath(path) {
    return fileUtils.filePathToPOSIX(Path.normalize(path))
  }

  async pathExists(path) {
    try {
      return await fs.pathExists(path)
    } catch (err) {
      Logger.error(`[LocalStorageProvider] pathExists failed for "${path}": ${err.message}`)
      return false
    }
  }

  async stat(path) {
    try {
      const stats = await fs.stat(path, { bigint: true })
      return {
        size: Number(stats.size),
        mtimeMs: Number(stats.mtimeMs),
        ctimeMs: Number(stats.ctimeMs),
        birthtimeMs: Number(stats.birthtimeMs),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        ino: String(stats.ino)
      }
    } catch (err) {
      Logger.error(`[LocalStorageProvider] stat failed for "${path}": ${err.message}`)
      return null
    }
  }

  async getFileTimestampsWithIno(path) {
    return fileUtils.getFileTimestampsWithIno(path)
  }

  async getIno(path) {
    return fileUtils.getIno(path)
  }

  async ensureDir(path) {
    return fs.ensureDir(path)
  }

  async readdir(path) {
    return fs.readdir(path)
  }

  async recurseFiles(path, relPathToReplace = null) {
    return fileUtils.recurseFiles(path, relPathToReplace)
  }

  async getDirectoriesInPath(dirPath, level = 0) {
    return fileUtils.getDirectoriesInPath(dirPath, level)
  }

  async rename(oldPath, newPath) {
    return fs.move(oldPath, newPath, { overwrite: true })
  }

  async delete(path) {
    return fs.remove(path)
  }

  async readFile(path, encoding = null) {
    return fs.readFile(path, encoding)
  }

  async writeFile(path, data, options = null) {
    return fs.writeFile(path, data, options)
  }

  createReadStream(path, options) {
    return fs.createReadStream(path, options)
  }

  createWriteStream(path, options) {
    return fs.createWriteStream(path, options)
  }

  async getSignedUrl(path) {
    // Local storage does not use signed URLs
    return null
  }
}

module.exports = LocalStorageProvider
