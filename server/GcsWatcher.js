const { PubSub } = require('@google-cloud/pubsub')
const Logger = require('./Logger')
const StorageManager = require('./storage/StorageManager')
const fileUtils = require('./utils/fileUtils')

class GcsWatcher {
  constructor(folderWatcher) {
    /** @type {import('./Watcher')} */
    this.folderWatcher = folderWatcher
    /** @type {PubSub|null} */
    this.pubsub = null
    /** @type {any|null} */
    this.subscription = null
    this.subscriptionName = process.env.GCS_PUBSUB_SUBSCRIPTION || null
    this.topicName = process.env.GCS_PUBSUB_TOPIC || null
    this.enabled = false
  }

  /**
   * Initialize GCS Pub/Sub subscriber if subscription name is configured
   */
  init() {
    this.subscriptionName = process.env.GCS_PUBSUB_SUBSCRIPTION || null
    if (!this.subscriptionName) {
      Logger.debug('[GcsWatcher] GCS Pub/Sub watcher disabled (GCS_PUBSUB_SUBSCRIPTION not set)')
      return
    }

    try {
      const options = {}
      const keyFile = process.env.GCS_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS
      if (keyFile) {
        options.keyFilename = keyFile
      } else if (process.env.GCS_CREDENTIALS_JSON) {
        try {
          options.credentials = JSON.parse(process.env.GCS_CREDENTIALS_JSON)
        } catch (err) {
          Logger.error(`[GcsWatcher] Failed to parse GCS_CREDENTIALS_JSON: ${err.message}`)
        }
      }

      const projectId = process.env.GCS_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT
      if (projectId) {
        options.projectId = projectId
      }

      this.pubsub = new PubSub(options)
      this.subscription = this.pubsub.subscription(this.subscriptionName)

      this.subscription.on('message', (message) => this.handleMessage(message))
      this.subscription.on('error', (error) => {
        Logger.error(`[GcsWatcher] Pub/Sub subscription error: ${error.message || error}`)
      })

      this.enabled = true
      Logger.info(`[GcsWatcher] Initialized and listening on subscription "${this.subscriptionName}"`)
    } catch (err) {
      Logger.error(`[GcsWatcher] Failed to initialize Pub/Sub client: ${err.message}`)
    }
  }

  /**
   * Handle incoming Pub/Sub message from GCS bucket notification
   * GCS events include: OBJECT_FINALIZE, OBJECT_DELETE, OBJECT_METADATA_UPDATE, OBJECT_ARCHIVE
   * @param {any} message
   */
  async handleMessage(message) {
    try {
      let data = {}
      if (message.data) {
        try {
          data = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))
        } catch (parseErr) {
          Logger.warn(`[GcsWatcher] Could not parse message payload as JSON: ${parseErr.message}`)
        }
      }

      // Case 1: Cloud Audit Log event for atomic folder rename (HNS buckets)
      if (data.protoPayload?.methodName === 'storage.folders.rename') {
        await this.handleFolderRenameAuditLog(data)
        message.ack()
        return
      }

      const eventType = message.attributes?.eventType || data.kind || ''
      const bucketName = message.attributes?.bucketId || data.bucket
      const objectId = message.attributes?.objectId || data.name

      Logger.debug(`[GcsWatcher] Received event "${eventType}" for bucket "${bucketName}", object "${objectId}"`)

      if (!objectId || !bucketName) {
        message.ack()
        return
      }

      // Ignore folder placeholder objects ending in trailing slash
      if (objectId.endsWith('/')) {
        message.ack()
        return
      }

      // Construct POSIX gcs path
      const gcsPath = `gcs://${bucketName}/${objectId}`

      // Clear any cached stat in GcsStorageProvider
      if (StorageManager.clearStatCache) {
        StorageManager.clearStatCache(gcsPath)
      } else {
        const provider = StorageManager.getProvider(gcsPath)
        if (provider && provider.clearStatCache) {
          provider.clearStatCache(gcsPath)
        }
      }

      // Find matching library and folder
      const match = this.findMatchingLibraryAndFolder(gcsPath)
      if (!match) {
        Logger.debug(`[GcsWatcher] No matching library folder for path "${gcsPath}"`)
        message.ack()
        return
      }

      const { library, folder } = match

      if (eventType === 'OBJECT_FINALIZE') {
        Logger.info(`[GcsWatcher] File added in library "${library.name}": "${gcsPath}"`)
        this.folderWatcher.onFileAdded(library.id, gcsPath)
      } else if (eventType === 'OBJECT_DELETE') {
        Logger.info(`[GcsWatcher] File deleted in library "${library.name}": "${gcsPath}"`)
        this.folderWatcher.onFileRemoved(library.id, gcsPath)
      } else {
        Logger.debug(`[GcsWatcher] Ignoring eventType "${eventType}" for "${gcsPath}"`)
      }

      message.ack()
    } catch (err) {
      Logger.error(`[GcsWatcher] Error handling Pub/Sub message: ${err.message}`)
      // Nack so message can be retried or sent to dead-letter queue if transient error
      try {
        message.nack()
      } catch (_) {}
    }
  }

  /**
   * Find matching library and folder for a given GCS path
   * @param {string} gcsPath
   * @returns {{ library: any, folder: any }|null}
   */
  findMatchingLibraryAndFolder(gcsPath) {
    if (!this.folderWatcher?.libraryWatchers?.length) return null

    const normalizedPath = fileUtils.filePathToPOSIX(gcsPath)

    for (const libWatcher of this.folderWatcher.libraryWatchers) {
      if (!libWatcher.libraryFolders?.length) continue

      for (const folder of libWatcher.libraryFolders) {
        const folderPath = fileUtils.filePathToPOSIX(folder.path)
        if (fileUtils.isSameOrSubPath(folderPath, normalizedPath)) {
          return { library: libWatcher, folder }
        }
      }
    }

    return null
  }

  /**
   * Parse Cloud Audit Log for storage.folders.rename event
   * Resources are in format: projects/_/buckets/{bucketName}/folders/{folderPath}/
   * @param {any} data
   */
  async handleFolderRenameAuditLog(data) {
    try {
      const authInfo = data.protoPayload?.authorizationInfo || []
      let srcResource = ''
      let destResource = ''

      for (const info of authInfo) {
        if (info.permission === 'storage.folders.rename') {
          srcResource = info.resource || ''
        } else if (info.permission === 'storage.folders.create') {
          destResource = info.resource || ''
        }
      }

      if (!srcResource && data.protoPayload?.resourceName) {
        srcResource = data.protoPayload.resourceName
      }

      Logger.info(`[GcsWatcher] Detected HNS folder rename: "${srcResource}" -> "${destResource}"`)

      // Parse bucket and relative folder paths from resource names
      // Format: projects/_/buckets/<bucket>/folders/<path>/
      const parseResource = (res) => {
        if (!res) return null
        const match = res.match(/buckets\/([^\/]+)\/folders\/(.+)$/)
        if (!match) return null
        let folderPath = match[2]
        if (folderPath.endsWith('/')) folderPath = folderPath.slice(0, -1)
        return { bucket: match[1], path: `gcs://${match[1]}/${folderPath}` }
      }

      const src = parseResource(srcResource)
      const dest = parseResource(destResource)

      // Invalidate stat cache
      if (src && StorageManager.clearStatCache) StorageManager.clearStatCache(src.path)
      if (dest && StorageManager.clearStatCache) StorageManager.clearStatCache(dest.path)

      // Find library matching either source or destination
      const srcMatch = src ? this.findMatchingLibraryAndFolder(src.path) : null
      const destMatch = dest ? this.findMatchingLibraryAndFolder(dest.path) : null

      const match = destMatch || srcMatch
      if (!match) {
        Logger.debug(`[GcsWatcher] Folder rename paths do not match any library: src="${src?.path}", dest="${dest?.path}"`)
        return
      }

      const { library, folder } = match

      // Queue file updates on the renamed folder so Scanner rescans the changed directory
      if (src && srcMatch) {
        this.folderWatcher.onFileRemoved(library.id, src.path)
      }
      if (dest && destMatch) {
        this.folderWatcher.onFileAdded(library.id, dest.path)
      }
    } catch (err) {
      Logger.error(`[GcsWatcher] Failed to handle folder rename audit log: ${err.message}`)
    }
  }

  /**
   * Close subscription on server shutdown
   */
  async close() {
    if (this.subscription) {
      try {
        await this.subscription.close()
        Logger.info('[GcsWatcher] Closed Pub/Sub subscription')
      } catch (err) {
        Logger.warn(`[GcsWatcher] Error closing subscription: ${err.message}`)
      }
      this.subscription = null
    }
    this.enabled = false
  }
}

module.exports = GcsWatcher
