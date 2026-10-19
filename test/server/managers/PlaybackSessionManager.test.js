const { expect } = require('chai')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const SocketAuthority = require('../../../server/SocketAuthority')
const PlaybackSession = require('../../../server/objects/PlaybackSession')
const { PlayMethod } = require('../../../server/utils/constants')

describe('PlaybackSessionManager Multi-Replica State Centralization', () => {
  let PlaybackSessionManagerClass
  let playbackSessionManager
  let SessionController
  let originalMetadataPath

  before(() => {
    originalMetadataPath = global.MetadataPath
    global.MetadataPath = '/tmp'
    PlaybackSessionManagerClass = require('../../../server/managers/PlaybackSessionManager')
    SessionController = require('../../../server/controllers/SessionController')
  })

  after(() => {
    global.MetadataPath = originalMetadataPath
  })

  beforeEach(() => {
    playbackSessionManager = new PlaybackSessionManagerClass()
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('getOrLoadSession', () => {
    it('should return session from local memory if already open', async () => {
      const mockSession = new PlaybackSession({ id: 'session-local-1', userId: 'user-1' })
      playbackSessionManager.sessions.push(mockSession)

      const session = await playbackSessionManager.getOrLoadSession('session-local-1')
      expect(session).to.equal(mockSession)
    })

    it('should load session from database if not present in local memory', async () => {
      const dbSession = new PlaybackSession({
        id: 'session-remote-1',
        userId: 'user-remote',
        libraryItemId: 'li-1',
        playMethod: PlayMethod.DIRECTPLAY,
        currentTime: 120
      })

      sinon.stub(Database, 'getPlaybackSession').withArgs('session-remote-1').resolves(dbSession)
      sinon.stub(Database, 'libraryItemModel').value({
        getExpandedById: sinon.stub().resolves({
          id: 'li-1',
          getTrackList: () => [{ index: 1, title: 'Track 1' }]
        })
      })

      const session = await playbackSessionManager.getOrLoadSession('session-remote-1')
      expect(session).to.exist
      expect(session.id).to.equal('session-remote-1')
      expect(session.userId).to.equal('user-remote')
      expect(session.audioTracks).to.have.lengthOf(1)
      expect(playbackSessionManager.sessions.some((s) => s.id === 'session-remote-1')).to.be.true
    })

    it('should return null if session is not in memory and not in database', async () => {
      sinon.stub(Database, 'getPlaybackSession').resolves(null)

      const session = await playbackSessionManager.getOrLoadSession('non-existent-session')
      expect(session).to.be.null
    })
  })

  describe('removeSession', () => {
    it('should remove session locally and publish session_closed broadcast', async () => {
      const mockSession = new PlaybackSession({ id: 'session-to-remove', userId: 'user-1' })
      playbackSessionManager.sessions.push(mockSession)

      const publishStub = sinon.stub(SocketAuthority, 'publishBroadcast')

      await playbackSessionManager.removeSession('session-to-remove')
      expect(playbackSessionManager.sessions.some((s) => s.id === 'session-to-remove')).to.be.false
      expect(publishStub.calledWith({ type: 'session_closed', sessionId: 'session-to-remove' })).to.be.true
    })

    it('removeSessionLocally should remove session from in-memory array without publishing', () => {
      const mockSession = new PlaybackSession({ id: 'session-remote-remove', userId: 'user-2' })
      playbackSessionManager.sessions.push(mockSession)

      playbackSessionManager.removeSessionLocally('session-remote-remove')
      expect(playbackSessionManager.sessions.some((s) => s.id === 'session-remote-remove')).to.be.false
    })
  })

  describe('SessionController.openSessionMiddleware', () => {
    it('should find session via getOrLoadSession and assign req.playbackSession', async () => {
      const dbSession = new PlaybackSession({
        id: 'session-cross-pod',
        userId: 'user-alice'
      })

      sinon.stub(playbackSessionManager, 'getOrLoadSession').resolves(dbSession)

      const req = {
        params: { id: 'session-cross-pod' },
        user: { id: 'user-alice', isAdminOrUp: false }
      }
      const res = {
        sendStatus: sinon.spy()
      }
      const next = sinon.spy()

      const context = { playbackSessionManager }
      await SessionController.openSessionMiddleware.call(context, req, res, next)

      expect(next.calledOnce).to.be.true
      expect(req.playbackSession).to.equal(dbSession)
      expect(res.sendStatus.called).to.be.false
    })

    it('should return 404 when session cannot be loaded', async () => {
      sinon.stub(playbackSessionManager, 'getOrLoadSession').resolves(null)

      const req = {
        params: { id: 'missing-session' },
        user: { id: 'user-alice', isAdminOrUp: false }
      }
      const res = {
        sendStatus: sinon.spy()
      }
      const next = sinon.spy()

      const context = { playbackSessionManager }
      await SessionController.openSessionMiddleware.call(context, req, res, next)

      expect(res.sendStatus.calledWith(404)).to.be.true
      expect(next.called).to.be.false
    })

    it('should return 403 when session belongs to another user and user is not admin', async () => {
      const dbSession = new PlaybackSession({
        id: 'session-other-user',
        userId: 'user-bob'
      })

      sinon.stub(playbackSessionManager, 'getOrLoadSession').resolves(dbSession)

      const req = {
        params: { id: 'session-other-user' },
        user: { id: 'user-alice', username: 'alice', isAdminOrUp: false }
      }
      const res = {
        sendStatus: sinon.spy()
      }
      const next = sinon.spy()

      const context = { playbackSessionManager }
      await SessionController.openSessionMiddleware.call(context, req, res, next)

      expect(res.sendStatus.calledWith(403)).to.be.true
      expect(next.called).to.be.false
    })
  })

  describe('Cluster Active Sessions (getAllOpenSessions, recordActiveSession, deleteActiveSession)', () => {
    it('should return local sessions when not using Postgres dialect', async () => {
      sinon.stub(Database, 'isPostgresDialect').returns(false)
      const localSession = new PlaybackSession({ id: 'local-1', userId: 'user-1' })
      playbackSessionManager.sessions.push(localSession)

      const sessions = await playbackSessionManager.getAllOpenSessions()
      expect(sessions).to.deep.equal([localSession])
    })

    it('should query abs_active_sessions and merge with local sessions on Postgres', async () => {
      sinon.stub(Database, 'isPostgresDialect').returns(true)
      const mockQuery = sinon.stub().resolves([
        [
          {
            session_id: 'cluster-sess-1',
            session_json: JSON.stringify({ id: 'cluster-sess-1', userId: 'user-cluster', displayTitle: 'Cluster Book' })
          },
          {
            session_id: 'shared-sess-2',
            session_json: JSON.stringify({ id: 'shared-sess-2', userId: 'user-2', displayTitle: 'Old Title' })
          }
        ]
      ])
      sinon.stub(Database, 'sequelize').value({ query: mockQuery })

      const localSession = new PlaybackSession({ id: 'shared-sess-2', userId: 'user-2', displayTitle: 'Fresh Local Title' })
      playbackSessionManager.sessions.push(localSession)

      const sessions = await playbackSessionManager.getAllOpenSessions()
      expect(sessions).to.have.lengthOf(2)
      const shared = sessions.find((s) => s.id === 'shared-sess-2')
      expect(shared.displayTitle).to.equal('Fresh Local Title')
      const clusterOnly = sessions.find((s) => s.id === 'cluster-sess-1')
      expect(clusterOnly.userId).to.equal('user-cluster')
    })

    it('should record active session into abs_active_sessions on Postgres', async () => {
      sinon.stub(Database, 'isPostgresDialect').returns(true)
      const mockQuery = sinon.stub().resolves()
      sinon.stub(Database, 'sequelize').value({ query: mockQuery })

      const session = new PlaybackSession({ id: 'sess-rec-1', userId: 'user-1' })
      await playbackSessionManager.recordActiveSession(session)

      expect(mockQuery.calledOnce).to.be.true
      const [sql, options] = mockQuery.firstCall.args
      expect(sql).to.include('INSERT INTO abs_active_sessions')
      expect(options.replacements.sessionId).to.equal('sess-rec-1')
      expect(options.replacements.userId).to.equal('user-1')
    })

    it('should delete active session from abs_active_sessions on Postgres', async () => {
      sinon.stub(Database, 'isPostgresDialect').returns(true)
      const mockQuery = sinon.stub().resolves()
      sinon.stub(Database, 'sequelize').value({ query: mockQuery })

      await playbackSessionManager.deleteActiveSession('sess-del-1')

      expect(mockQuery.calledOnce).to.be.true
      const [sql, options] = mockQuery.firstCall.args
      expect(sql).to.include('DELETE FROM abs_active_sessions WHERE session_id = :sessionId')
      expect(options.replacements.sessionId).to.equal('sess-del-1')
    })
  })

  describe('SessionController cluster session queries', () => {
    it('getOpenSessions should return cluster-wide active sessions with user details', async () => {
      const mockSession = new PlaybackSession({ id: 'sess-all-1', userId: 'u-1', displayTitle: 'My Book' })
      sinon.stub(playbackSessionManager, 'getAllOpenSessions').resolves([mockSession])
      sinon.stub(Database, 'userModel').value({
        getMinifiedUserObjects: sinon.stub().resolves([{ id: 'u-1', username: 'alice' }])
      })

      const req = {
        user: { isAdminOrUp: true, username: 'admin' }
      }
      const res = {
        json: sinon.spy(),
        sendStatus: sinon.spy()
      }

      const context = { playbackSessionManager }
      await SessionController.getOpenSessions.call(context, req, res)

      expect(res.json.calledOnce).to.be.true
      const responseData = res.json.firstCall.args[0]
      expect(responseData.sessions).to.have.lengthOf(1)
      expect(responseData.sessions[0].id).to.equal('sess-all-1')
      expect(responseData.sessions[0].user).to.deep.equal({ id: 'u-1', username: 'alice' })
    })

    it('getTrack should load session via getOrLoadSession if not in local memory', async () => {
      const dbSession = new PlaybackSession({
        id: 'sess-track-1',
        userId: 'u-1',
        audioTracks: [{ index: 1, metadata: { path: '/path/to/track.mp3' } }]
      })
      sinon.stub(playbackSessionManager, 'getOrLoadSession').withArgs('sess-track-1').resolves(dbSession)
      sinon.stub(Database, 'userModel').value({
        getUserById: sinon.stub().resolves({ id: 'u-1', username: 'alice' })
      })

      const req = {
        params: { id: 'sess-track-1', index: '1' }
      }
      const res = {
        sendStatus: sinon.spy()
      }

      // Mock audio track streaming or check that session was resolved
      const context = {
        playbackSessionManager,
        streamAudioFile: sinon.stub().resolves()
      }
      await SessionController.getTrack.call(context, req, res)

      expect(playbackSessionManager.getOrLoadSession.calledWith('sess-track-1')).to.be.true
    })
  })
})
