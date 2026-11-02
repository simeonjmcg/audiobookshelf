/**
 * @typedef MigrationContext
 * @property {import('sequelize').QueryInterface} queryInterface - a Sequelize QueryInterface object.
 * @property {import('../Logger')} logger - a Logger object.
 *
 * @typedef MigrationOptions
 * @property {MigrationContext} context - an object containing the migration context.
 */

const migrationVersion = '2.37.0'
const migrationName = `${migrationVersion}-create-pubsub-tables`
const loggerPrefix = `[${migrationVersion} migration]`

/**
 * Creates unlogged PostgreSQL tables and indexes for cross-replica pub/sub events
 * and socket presences. Only applicable to postgres dialect.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function up({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} UPGRADE BEGIN: ${migrationName}`)

  if (queryInterface.sequelize.getDialect() !== 'postgres') {
    logger.info(`${loggerPrefix} Skipping ${migrationName} on non-postgres dialect`)
    logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
    return
  }

  logger.info(`${loggerPrefix} Creating pub/sub broadcast events and socket presences tables for postgres`)
  await queryInterface.sequelize.query(`
    CREATE UNLOGGED TABLE IF NOT EXISTS abs_broadcast_events (
      id BIGSERIAL PRIMARY KEY,
      origin VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_abs_broadcast_events_created ON abs_broadcast_events (created_at);

    CREATE UNLOGGED TABLE IF NOT EXISTS abs_socket_presences (
      socket_id VARCHAR(64) PRIMARY KEY,
      instance_id VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      user_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_abs_socket_presences_inst ON abs_socket_presences (instance_id);
    CREATE INDEX IF NOT EXISTS idx_abs_socket_presences_user ON abs_socket_presences (user_id);
  `)

  logger.info(`${loggerPrefix} UPGRADE END: ${migrationName}`)
}

/**
 * Drops the pub/sub broadcast events and socket presences tables on downgrade.
 *
 * @param {MigrationOptions} options - an object containing the migration context.
 * @returns {Promise<void>} - A promise that resolves when the migration is complete.
 */
async function down({ context: { queryInterface, logger } }) {
  logger.info(`${loggerPrefix} DOWNGRADE BEGIN: ${migrationName}`)

  if (queryInterface.sequelize.getDialect() !== 'postgres') {
    logger.info(`${loggerPrefix} Skipping ${migrationName} on non-postgres dialect`)
    logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
    return
  }

  logger.info(`${loggerPrefix} Dropping pub/sub broadcast events and socket presences tables`)
  await queryInterface.sequelize.query(`
    DROP TABLE IF EXISTS abs_socket_presences;
    DROP TABLE IF EXISTS abs_broadcast_events;
  `)

  logger.info(`${loggerPrefix} DOWNGRADE END: ${migrationName}`)
}

module.exports = { up, down }
