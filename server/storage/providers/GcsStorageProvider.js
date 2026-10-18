const Path = require('path')
const { Storage } = require('@google-cloud/storage')
const { LRUCache } = require('lru-cache')
const Logger = require('../../Logger')
const fileUtils = require('../../utils/fileUtils')

/**
 * Generate a deterministic numeric inode string from a string key or generation ID
 * Uses 64-bit FNV-1a hash to produce stable, unique numbers for ABS inode matching
 * @param {string|number} input
 * @returns {string}
 */
function hashToIno(input) {
  if (!input) return '0'
  const str = String(input)
  let h1 = 0xdeadbeef
  let h2 = 0x41c64e6d
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return String(Math.abs(4294967296 * (2097151 & h2) + (h1 >>> 0)))
}

class GcsStorageProvider {
  constructor(config = {}) {
    this.type = 'gcs'
    this.defaultBucketName = config.bucketName || process.env.GCS_BUCKET_NAME || process.env.GCS_DEFAULT_BUCKET || null
    this.signedUrlExpiryHours = Number(process.env.GCS_SIGNED_URL_EXPIRY_HOURS) || 6
    this._statCache = new LRUCache({ max: 50000, ttl: 1000 * 60 * 15 })

    const storageOptions = {}
    const keyFile = config.keyFilename || process.env.GCS_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (keyFile) {
      storageOptions.keyFilename = keyFile
    } else if (config.credentials || process.env.GCS_CREDENTIALS_JSON) {
      try {
        storageOptions.credentials = config.credentials || JSON.parse(process.env.GCS_CREDENTIALS_JSON)
      } catch (err) {
        Logger.error(`[GcsStorageProvider] Failed to parse GCS_CREDENTIALS_JSON: ${err.message}`)
      }
    }
    const projectId = config.projectId || process.env.GCS_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
    if (projectId) {
      storageOptions.projectId = projectId
    }

    this.storage = new Storage(storageOptions)
    if (this.defaultBucketName) {
      Logger.info(`[GcsStorageProvider] Initialized for default bucket "${this.defaultBucketName}"`)
    } else {
      Logger.info(`[GcsStorageProvider] Initialized without default bucket (dynamic URI mode)`)
    }
  }

  clearStatCache(path = null) {
    if (path) {
      const { uri } = this.parsePath(path)
      this._statCache.delete(uri)
      const prefix = uri.endsWith('/') ? uri : `${uri}/`
      for (const key of this._statCache.keys()) {
        if (key.startsWith(prefix)) {
          this._statCache.delete(key)
        }
      }
    } else {
      this._statCache.clear()
    }
  }

  isSupported(path) {
    if (!path) return false
    return path.startsWith('gcs://') || path.startsWith('gs://') || process.env.STORAGE_PROVIDER === 'gcs'
  }

  /**
   * Parse a storage path into bucket and key
   * Supports:
   *   - gcs://smcgraw-abs-lib/audiobooks/Author/Book.mp3
   *   - gs://smcgraw-abs-lib/audiobooks/Author/Book.mp3
   *   - /audiobooks/Author/Book.mp3 (when default bucket is active)
   * @param {string} rawPath
   * @returns {{ bucketName: string, key: string, uri: string }}
   */
  parsePath(rawPath) {
    if (!rawPath) return { bucketName: this.defaultBucketName, key: '', uri: `gcs://${this.defaultBucketName}/` }
    let cleaned = fileUtils.filePathToPOSIX(rawPath)
    let bucketName = this.defaultBucketName
    let key = cleaned

    if (cleaned.startsWith('gcs:') || cleaned.startsWith('gs:')) {
      const withoutScheme = cleaned.replace(/^(gcs|gs):\/+/, '')
      const slashIndex = withoutScheme.indexOf('/')
      if (slashIndex === -1) {
        bucketName = withoutScheme
        key = ''
      } else {
        bucketName = withoutScheme.substring(0, slashIndex)
        key = withoutScheme.substring(slashIndex + 1)
      }
    } else if (key.startsWith('/')) {
      key = key.substring(1)
    }

    // Clean multiple slashes
    key = key.replace(/\/+/g, '/')
    if (key.startsWith('/')) key = key.substring(1)

    const uri = `gcs://${bucketName}/${key}`
    return { bucketName, key, uri }
  }

  getBucket(bucketName = null) {
    return this.storage.bucket(bucketName || this.defaultBucketName)
  }

  async getBuckets() {
    try {
      const options = {}
      const projectId = this.storage.projectId || process.env.GCS_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
      if (projectId) {
        options.project = projectId
      }
      const [buckets] = await this.storage.getBuckets(options)
      return buckets.map((bucket) => ({
        name: bucket.name,
        uri: `gcs://${bucket.name}`
      }))
    } catch (err) {
      Logger.warn(`[GcsStorageProvider] Unable to list buckets: ${err.message}`)
      if (this.defaultBucketName) {
        return [{ name: this.defaultBucketName, uri: `gcs://${this.defaultBucketName}` }]
      }
      return []
    }
  }

  getFile(path) {
    const { bucketName, key } = this.parsePath(path)
    return this.getBucket(bucketName).file(key)
  }

  normalizePath(path) {
    const { uri } = this.parsePath(path)
    return uri
  }

  async pathExists(path) {
    try {
      const { bucketName, key, uri } = this.parsePath(path)
      if (this._statCache.has(uri)) return true

      if (!key) {
        try {
          const [exists] = await this.getBucket(bucketName).exists()
          return exists
        } catch (bucketErr) {
          // If storage.buckets.get is denied (e.g. objectAdmin role), test object access
          try {
            await this.getBucket(bucketName).getFiles({ maxResults: 1 })
            return true
          } catch (listErr) {
            Logger.error(`[GcsStorageProvider] Bucket "${bucketName}" not accessible: ${listErr.message}`)
            return false
          }
        }
      }

      const file = this.getFile(path)
      const [exists] = await file.exists()
      if (exists) return true

      // Check if it's an HNS folder or prefix containing files
      const prefix = key.endsWith('/') ? key : `${key}/`
      const [files] = await this.getBucket(bucketName).getFiles({
        prefix,
        maxResults: 1
      })
      return files.length > 0
    } catch (err) {
      Logger.error(`[GcsStorageProvider] pathExists failed for "${path}": ${err.message}`)
      return false
    }
  }

  async stat(path) {
    try {
      const { bucketName, key, uri } = this.parsePath(path)
      const cached = this._statCache.get(uri)
      if (cached) return cached

      const bucket = this.getBucket(bucketName)

      if (!key) {
        const rootStat = {
          size: 0,
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
          isDirectory: true,
          isFile: false,
          ino: hashToIno(bucketName)
        }
        this._statCache.set(uri, rootStat)
        return rootStat
      }

      const file = bucket.file(key)
      const [metadata] = await file.getMetadata().catch(() => [null])

      if (metadata) {
        const isFolder = key.endsWith('/') || metadata.contentType === 'application/x-directory'
        const mtimeMs = metadata.updated ? new Date(metadata.updated).getTime() : Date.now()
        const ctimeMs = metadata.timeCreated ? new Date(metadata.timeCreated).getTime() : mtimeMs

        const statObj = {
          size: Number(metadata.size || 0),
          mtimeMs,
          ctimeMs,
          birthtimeMs: ctimeMs,
          isDirectory: isFolder,
          isFile: !isFolder,
          ino: hashToIno(metadata.generation || metadata.id || uri)
        }
        this._statCache.set(uri, statObj)
        return statObj
      }

      // Check if it represents an HNS folder
      const prefix = key.endsWith('/') ? key : `${key}/`
      const [childFiles] = await bucket.getFiles({ prefix, maxResults: 1 })
      if (childFiles.length > 0) {
        const dirStat = {
          size: 0,
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
          isDirectory: true,
          isFile: false,
          ino: hashToIno(uri)
        }
        this._statCache.set(uri, dirStat)
        return dirStat
      }

      return null
    } catch (err) {
      Logger.error(`[GcsStorageProvider] stat failed for "${path}": ${err.message}`)
      return null
    }
  }

  async getFileTimestampsWithIno(path) {
    const statData = await this.stat(path)
    if (!statData) return { size: 0, mtimeMs: null, ctimeMs: null, birthtimeMs: null, ino: null }
    return {
      size: Number(statData.size || 0),
      mtimeMs: statData.mtimeMs,
      ctimeMs: statData.ctimeMs,
      birthtimeMs: statData.birthtimeMs,
      ino: statData.ino
    }
  }

  async getIno(path) {
    const statData = await this.stat(path)
    return statData ? statData.ino : null
  }

  async ensureDir(path) {
    // In GCS HNS, folders can be explicitly created or are implicitly maintained
    const { bucketName, key } = this.parsePath(path)
    if (!key) return
    const folderKey = key.endsWith('/') ? key : `${key}/`
    const file = this.getBucket(bucketName).file(folderKey)
    const [exists] = await file.exists()
    if (!exists) {
      await file.save('', {
        metadata: {
          contentType: 'application/x-directory'
        }
      }).catch((err) => {
        Logger.warn(`[GcsStorageProvider] ensureDir warning for "${path}": ${err.message}`)
      })
    }
  }

  /**
   * List files recursively under folderPath, matching fileUtils.recurseFiles format
   * @param {string} folderPath
   * @param {string} [relPathToReplace]
   * @returns {Promise<Array<object>>}
   */
  async recurseFiles(folderPath, relPathToReplace = null) {
    try {
      const { bucketName, key: folderKey } = this.parsePath(folderPath)
      const bucket = this.getBucket(bucketName)
      const prefix = folderKey ? (folderKey.endsWith('/') ? folderKey : `${folderKey}/`) : ''

      Logger.info(`[GcsStorageProvider] Recursing files in gs://${bucketName}/${prefix}`)
      const [files] = await bucket.getFiles({ prefix })

      const items = []
      const directoriesToIgnore = []

      // Check for .ignore files first
      for (const file of files) {
        const basename = Path.posix.basename(file.name)
        if (basename === '.ignore') {
          const dir = Path.posix.dirname(file.name)
          directoriesToIgnore.push(`gcs://${bucketName}/${dir}`)
        }
      }

      for (const file of files) {
        // Skip directory markers
        if (file.name.endsWith('/')) continue

        const fullname = `gcs://${bucketName}/${file.name}`
        const dirname = `gcs://${bucketName}/${Path.posix.dirname(file.name)}`

        // Check if file is in an ignored directory
        if (directoriesToIgnore.some((ignoredDir) => dirname.startsWith(ignoredDir))) {
          continue
        }

        const ext = Path.posix.extname(file.name).toLowerCase()
        const basename = Path.posix.basename(file.name)
        const mtimeMs = file.metadata.updated ? new Date(file.metadata.updated).getTime() : Date.now()
        const ctimeMs = file.metadata.timeCreated ? new Date(file.metadata.timeCreated).getTime() : mtimeMs

        const relPath = prefix ? file.name.substring(prefix.length) : file.name
        let relDir = Path.posix.dirname(relPath)
        if (relDir === '.') relDir = ''
        const deep = relDir ? relDir.split('/').length : 0

        const fileStat = {
          size: Number(file.metadata.size || 0),
          mtimeMs,
          ctimeMs,
          birthtimeMs: ctimeMs,
          isDirectory: false,
          isFile: true,
          ino: hashToIno(file.metadata.generation || file.id || fullname)
        }
        this._statCache.set(fullname, fileStat)

        // Pre-cache ancestor directories so stat/getFileTimestampsWithIno returns immediately
        let curDir = Path.posix.dirname(file.name)
        while (curDir && curDir !== '.' && curDir !== '/') {
          const dirUri = `gcs://${bucketName}/${curDir}`
          if (!this._statCache.has(dirUri)) {
            this._statCache.set(dirUri, {
              size: 0,
              mtimeMs,
              ctimeMs,
              birthtimeMs: ctimeMs,
              isDirectory: true,
              isFile: false,
              ino: hashToIno(dirUri)
            })
          }
          const parentDir = Path.posix.dirname(curDir)
          if (parentDir === curDir) break
          curDir = parentDir
        }

        items.push({
          name: basename,
          path: relPath,
          reldirpath: relDir,
          fullpath: fullname,
          fullname,
          extension: ext,
          deep,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ctimeMs: fileStat.ctimeMs,
          birthtimeMs: fileStat.birthtimeMs,
          ino: fileStat.ino
        })
      }

      items.sort((a, b) => a.deep - b.deep)

      Logger.info(`[GcsStorageProvider] Found ${items.length} files in gs://${bucketName}/${prefix}`)
      return items
    } catch (err) {
      Logger.error(`[GcsStorageProvider] recurseFiles failed for "${folderPath}": ${err.message}`)
      return []
    }
  }

  /**
   * Returns immediate subdirectories for directory selection UI
   * @param {string} dirPath
   * @param {number} level
   */
  async getDirectoriesInPath(dirPath, level = 0) {
    try {
      const { bucketName, key: rawKey } = this.parsePath(dirPath)
      const bucket = this.getBucket(bucketName)
      const prefix = rawKey ? (rawKey.endsWith('/') ? rawKey : `${rawKey}/`) : ''

      const [, , apiResponse] = await bucket.getFiles({
        prefix,
        delimiter: '/',
        autoPaginate: false
      })

      const directories = []
      const prefixes = apiResponse?.prefixes || []

      for (const subPrefix of prefixes) {
        const cleanSubPrefix = subPrefix.replace(/\/$/, '')
        const dirname = Path.posix.basename(cleanSubPrefix)
        directories.push({
          path: `gcs://${bucketName}/${cleanSubPrefix}`,
          dirname,
          level
        })
      }

      return directories
    } catch (err) {
      Logger.error(`[GcsStorageProvider] getDirectoriesInPath failed for "${dirPath}": ${err.message}`)
      return []
    }
  }

  /**
   * Atomic rename for GCS HNS folders and files
   * @param {string} oldPath
   * @param {string} newPath
   */
  async rename(oldPath, newPath) {
    this.clearStatCache()
    const { bucketName: srcBucket, key: srcKey } = this.parsePath(oldPath)
    const { bucketName: destBucket, key: destKey } = this.parsePath(newPath)
    const bucket = this.getBucket(srcBucket)

    if (srcBucket !== destBucket) {
      throw new Error(`[GcsStorageProvider] Cross-bucket rename is not supported (${srcBucket} -> ${destBucket})`)
    }

    const srcFile = bucket.file(srcKey)
    const [exists] = await srcFile.exists()

    if (exists) {
      // Single file rename
      Logger.info(`[GcsStorageProvider] Renaming file "${srcKey}" to "${destKey}"`)
      await srcFile.rename(destKey)
      return
    }

    // GCS HNS Atomic Folder Rename
    // In HNS enabled buckets, folder rename is an atomic metadata operation
    const srcFolderKey = srcKey.endsWith('/') ? srcKey : `${srcKey}/`
    const destFolderKey = destKey.endsWith('/') ? destKey : `${destKey}/`

    Logger.info(`[GcsStorageProvider] Renaming HNS directory "${srcFolderKey}" to "${destFolderKey}"`)
    const srcFolderFile = bucket.file(srcFolderKey)
    const [folderExists] = await srcFolderFile.exists()

    if (folderExists) {
      await srcFolderFile.rename(destFolderKey)
    } else {
      // Fallback for folders: rename all objects matching prefix
      const [files] = await bucket.getFiles({ prefix: srcFolderKey })
      for (const f of files) {
        const relative = f.name.substring(srcFolderKey.length)
        const targetName = `${destFolderKey}${relative}`
        await f.rename(targetName)
      }
    }
  }

  async delete(path) {
    this.clearStatCache(path)
    const { bucketName, key } = this.parsePath(path)
    const bucket = this.getBucket(bucketName)

    if (!key) {
      throw new Error(`[GcsStorageProvider] Refusing to delete root bucket "${bucketName}"`)
    }

    const cleanKey = key.replace(/\/+$/, '')
    const prefix = `${cleanKey}/`

    // Check if there are objects under this prefix (i.e. it is a directory)
    const [filesUnderPrefix] = await bucket.getFiles({ prefix, maxResults: 1 })
    if (filesUnderPrefix.length > 0) {
      Logger.info(`[GcsStorageProvider] Deleting folder and contents with prefix "${prefix}"`)
      await bucket.deleteFiles({ prefix, force: true })
      // Delete directory marker if exists
      const exactMarker = bucket.file(cleanKey)
      const [markerExists] = await exactMarker.exists()
      if (markerExists) {
        await exactMarker.delete().catch(() => {})
      }
      return
    }

    // Single file or directory marker
    const file = bucket.file(key)
    const [exists] = await file.exists()
    if (exists) {
      await file.delete()
      return
    }

    const cleanFile = bucket.file(cleanKey)
    const [cleanExists] = await cleanFile.exists()
    if (cleanExists) {
      await cleanFile.delete()
      return
    }

    // Fallback: deleteFiles with prefix
    await bucket.deleteFiles({ prefix, force: true }).catch(() => {})
  }

  async readFile(path, encoding = null) {
    const file = this.getFile(path)
    const [buffer] = await file.download()
    if (encoding) {
      return buffer.toString(encoding)
    }
    return buffer
  }

  async writeFile(path, data, options = {}) {
    this.clearStatCache(path)
    const file = this.getFile(path)
    const metadata = {}
    if (options?.contentType) {
      metadata.contentType = options.contentType
    }
    await file.save(data, { metadata })
  }

  createReadStream(path, options = {}) {
    const file = this.getFile(path)
    return file.createReadStream(options)
  }

  createWriteStream(path, options = {}) {
    const file = this.getFile(path)
    return file.createWriteStream(options)
  }

  /**
   * Generate a V4 Signed URL for direct client streaming
   * @param {string} path
   * @param {object} [options]
   * @returns {Promise<string>}
   */
  async getSignedUrl(path, options = {}) {
    const file = this.getFile(path)
    const expiryMinutes = (options.expiryHours || this.signedUrlExpiryHours) * 60
    const expires = options.expires || Date.now() + expiryMinutes * 60 * 1000

    const config = {
      version: 'v4',
      action: options.action || 'read',
      expires: expires
    }

    if (options.action === 'write' && options.contentType) {
      config.contentType = options.contentType
    } else if (options.responseType || options.contentType) {
      config.responseType = options.responseType || options.contentType
    }
    if (options.responseDisposition) {
      config.responseDisposition = options.responseDisposition
    }

    const [signedUrl] = await file.getSignedUrl(config)
    return signedUrl
  }
}

module.exports = GcsStorageProvider
