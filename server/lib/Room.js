const EventEmitter = require('events').EventEmitter;
const protoo = require('protoo-server');
const throttle = require('@sitespeed.io/throttle');
const Logger = require('./Logger');
const config = require('../config');
const Bot = require('./Bot');

const logger = new Logger('Room');

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 */
	static async create({ mediasoupWorker, roomId })
	{
		logger.info('create() [roomId:%s]', roomId);

		// Create a protoo Room instance.
		const protooRoom = new protoo.Room();

		// Router media codecs.
		const { mediaCodecs } = config.mediasoup.routerOptions;

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		// Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
			});

		const bot = await Bot.create({ mediasoupRouter });

		return new Room(
			{
				roomId,
				protooRoom,
				mediasoupRouter,
				audioLevelObserver,
				bot
			});
	}

	constructor({ roomId, protooRoom, mediasoupRouter, audioLevelObserver, bot })
	{
		super();
		this.setMaxListeners(Infinity);

		// Room id.
		// @type {String}
		this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// protoo Room instance.
		// @type {protoo.Room}
		this._protooRoom = protooRoom;

		// mediasoup Router instance.
		// @type {mediasoup.Router}
		this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		// @type {mediasoup.AudioLevelObserver}
		this._audioLevelObserver = audioLevelObserver;

		//remote pipes
		this._RoomPipes = {};

		//remote 
		this._RemotePeers = {};

		// DataChannel bot.
		// @type {Bot}
		this._bot = bot;

		// Network throttled.
		// @type {Boolean}
		this._networkThrottled = false;

		// Handle audioLevelObserver.
		this._handleAudioLevelObserver();

		// For debugging.
		global.audioLevelObserver = this._audioLevelObserver;
		global.bot = this._bot;
	}

	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{
		logger.debug('close()');

		this._closed = true;

		// Close the protoo Room.
		this._protooRoom.close();

		// Close the mediasoup Router.
		this._mediasoupRouter.close();

		// Close the Bot.
		this._bot.close();

		// Emit 'close' event.
		this.emit('close');

		// Stop network throttling.
		if (this._networkThrottled)
		{
			throttle.stop({})
				.catch(() => {});
		}
	}

	logStatus()
	{
		logger.info(
			'logStatus() [roomId:%s, protoo Peers:%s, mediasoup Transports:%s]',
			this._roomId,
			this._protooRoom.peers.length,
			this._mediasoupRouter._transports.size); // NOTE: Private API.
	}

	/**
	 * Called from server.js upon a protoo WebSocket connection request from a
	 * browser.
	 *
	 * @param {String} peerId - The id of the protoo peer to be created.
	 * @param {Boolean} consume - Whether this peer wants to consume from others.
	 * @param {protoo.WebSocketTransport} protooWebSocketTransport - The associated
	 *   protoo WebSocket transport.
	 */
	handleProtooConnection({ peerId, consume, protooWebSocketTransport })
	{
		const existingPeer = this._protooRoom.getPeer(peerId);

		if (existingPeer)
		{
			logger.warn(
				'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
				peerId);

			existingPeer.close();
		}

		let peer;

		// Create a new protoo Peer with the given peerId.
		try
		{
			peer = this._protooRoom.createPeer(peerId, protooWebSocketTransport);
		}
		catch (error)
		{
			logger.error('protooRoom.createPeer() failed:%o', error);
		}

		// Use the peer.data object to store mediasoup related objects.

		// Not joined after a custom protoo 'join' request is later received.
		peer.data.consume = consume;
		peer.data.joined = false;
		peer.data.displayName = undefined;
		peer.data.device = undefined;
		peer.data.rtpCapabilities = undefined;
		peer.data.sctpCapabilities = undefined;

		// Have mediasoup related maps ready even before the Peer joins since we
		// allow creating Transports before joining.
		peer.data.transports = new Map();
		peer.data.producers = new Map();
		peer.data.consumers = new Map();
		peer.data.dataProducers = new Map();
		peer.data.dataConsumers = new Map();

		peer.on('request', (request, accept, reject) =>
		{
			logger.debug(
				'protoo Peer "request" event [method:%s, peerId:%s]',
				request.method, peer.id);

			this._handleProtooRequest(peer, request, accept, reject)
				.catch((error) =>
				{
					logger.error('request failed:%o', error);

					reject(error);
				});
		});

		peer.on('close', () =>
		{
			if (this._closed)
				return;

			logger.debug('protoo Peer "close" event [peerId:%s]', peer.id);

			// If the Peer was joined, notify all Peers.
			if (peer.data.joined)
			{
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify('peerClosed', { peerId: peer.id })
						.catch(() => {});
				}
			}

			// Iterate and close all mediasoup Transport associated to this Peer, so all
			// its Producers and Consumers will also be closed.
			for (const transport of peer.data.transports.values())
			{
				transport.close();
			}

			// If this is the latest Peer in the room, close the room.
			if (this._protooRoom.peers.length === 0)
			{
				logger.info(
					'last Peer in the room left, closing the room [roomId:%s]',
					this._roomId);

				this.close();
			}
		});
	}

	getRouterRtpCapabilities()
	{
		return this._mediasoupRouter.rtpCapabilities;
	}

	_handleAudioLevelObserver()
	{
		this._audioLevelObserver.on('volumes', (volumes) =>
		{
			const { producer, volume } = volumes[0];

			// logger.debug(
			// 	'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
			// 	producer.id, volume);

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.notify(
					'activeSpeaker',
					{
						peerId : producer.appData.peerId,
						volume : volume
					})
					.catch(() => {});
			}
		});

		this._audioLevelObserver.on('silence', () =>
		{
			// logger.debug('audioLevelObserver "silence" event');

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('activeSpeaker', { peerId: null })
					.catch(() => {});
			}
		});
	}

	/**
	 * Handle protoo requests from browsers.
	 *
	 * @async
	 */
	async _handleProtooRequest(peer, request, accept, reject)
	{
		switch (request.method)
		{
			case 'getRouterRtpCapabilities':
			{
				accept(this._mediasoupRouter.rtpCapabilities);

				break;
			}

			case 'join':
			{
				// Ensure the Peer is not already joined.
				if (peer.data.joined)
					throw new Error('Peer already joined');

				const {
					displayName,
					device,
					rtpCapabilities,
					sctpCapabilities
				} = request.data;

				// Store client data into the protoo Peer data object.
				peer.data.joined = true;
				peer.data.displayName = displayName;
				peer.data.device = device;
				peer.data.rtpCapabilities = rtpCapabilities;
				peer.data.sctpCapabilities = sctpCapabilities;

				// Tell the new Peer about already joined Peers.
				// And also create Consumers for existing Producers.

				const joinedPeers =
				[
					...this._getJoinedPeers()
				];

				// Reply now the request with the list of joined peers (all but the new one).
				const peerInfos = joinedPeers
					.filter((joinedPeer) => joinedPeer.id !== peer.id)
					.map((joinedPeer) => ({
						id          : joinedPeer.id,
						displayName : joinedPeer.data.displayName,
						device      : joinedPeer.data.device
					}));
				
				const remotePeers = [
					...Object.values(this._RemotePeers)
				];

				const remotePeerInfos = remotePeers
					.map((remotePeer) => ({
						id          : remotePeer.id,
						displayName : remotePeer.data.displayName,
						device      : remotePeer.data.device
					}));
				
				const totalPeers = [...peerInfos, ...remotePeerInfos];

				accept({ peers: totalPeers });

				// Mark the new Peer as joined.
				peer.data.joined = true;

				for (const joinedPeer of joinedPeers)
				{
					// Create Consumers for existing Producers.
					for (const producer of joinedPeer.data.producers.values())
					{
						this._createConsumer(
							{
								consumerPeer : peer,
								producerPeer : joinedPeer,
								producer
							});
					}

					// Create DataConsumers for existing DataProducers.
					for (const dataProducer of joinedPeer.data.dataProducers.values())
					{
						if (dataProducer.label === 'bot')
							continue;

						this._createDataConsumer(
							{
								dataConsumerPeer : peer,
								dataProducerPeer : joinedPeer,
								dataProducer
							});
					}
				}

				for(const remotePeer of remotePeers){
					for(const producer of remotePeer.producers){
						this._createConsumer({
							consumerPeer: peer,
							producerPeer: remotePeer,
							producer
						})
					}
				}

				// Create DataConsumers for bot DataProducer.
				this._createDataConsumer(
					{
						dataConsumerPeer : peer,
						dataProducerPeer : null,
						dataProducer     : this._bot.dataProducer
					});

				// Notify the new Peer to all other Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'newPeer',
						{
							id          : peer.id,
							displayName : peer.data.displayName,
							device      : peer.data.device
						})
						.catch(() => {});
				}

				break;
			}

			case 'createWebRtcTransport':
			{
				// NOTE: Don't require that the Peer is joined here, so the client can
				// initiate mediasoup Transports and be ready when he later joins.

				const {
					forceTcp,
					producing,
					consuming,
					sctpCapabilities
				} = request.data;

				const webRtcTransportOptions =
				{
					...config.mediasoup.webRtcTransportOptions,
					enableSctp     : Boolean(sctpCapabilities),
					numSctpStreams : (sctpCapabilities || {}).numStreams,
					appData        : { producing, consuming }
				};

				if (forceTcp)
				{
					webRtcTransportOptions.enableUdp = false;
					webRtcTransportOptions.enableTcp = true;
				}

				const transport = await this._mediasoupRouter.createWebRtcTransport(
					webRtcTransportOptions);

				transport.on('sctpstatechange', (sctpState) =>
				{
					logger.debug('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState);
				});

				transport.on('dtlsstatechange', (dtlsState) =>
				{
					if (dtlsState === 'failed' || dtlsState === 'closed')
						logger.warn('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState);
				});

				// NOTE: For testing.
				// await transport.enableTraceEvent([ 'probation', 'bwe' ]);
				await transport.enableTraceEvent([ 'bwe' ]);

				transport.on('trace', (trace) =>
				{
					logger.debug(
						'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
						transport.id, trace.type, trace);

					if (trace.type === 'bwe' && trace.direction === 'out')
					{
						peer.notify(
							'downlinkBwe',
							{
								desiredBitrate          : trace.info.desiredBitrate,
								effectiveDesiredBitrate : trace.info.effectiveDesiredBitrate,
								availableBitrate        : trace.info.availableBitrate
							})
							.catch(() => {});
					}
				});

				// Store the WebRtcTransport into the protoo Peer data Object.
				peer.data.transports.set(transport.id, transport);

				accept(
					{
						id             : transport.id,
						iceParameters  : transport.iceParameters,
						iceCandidates  : transport.iceCandidates,
						dtlsParameters : transport.dtlsParameters,
						sctpParameters : transport.sctpParameters
					});

				const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions;

				// If set, apply max incoming bitrate limit.
				if (maxIncomingBitrate)
				{
					try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); }
					catch (error) {}
				}

				break;
			}

			case 'connectWebRtcTransport':
			{
				const { transportId, dtlsParameters } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				await transport.connect({ dtlsParameters });

				accept();

				break;
			}

			case 'restartIce':
			{
				const { transportId } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const iceParameters = await transport.restartIce();

				accept(iceParameters);

				break;
			}

			case 'produce':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { transportId, kind, rtpParameters } = request.data;
				let { appData } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				// Add peerId into appData to later get the associated Peer during
				// the 'loudest' event of the audioLevelObserver.
				appData = { ...appData, peerId: peer.id };

				const producer = await transport.produce(
					{
						kind,
						rtpParameters,
						appData
						// keyFrameRequestDelay: 5000
					});
				
				// Store the Producer into the protoo Peer data Object.
				peer.data.producers.set(producer.id, producer);

				// Set Producer events.
				producer.on('score', (score) =>
				{
					// logger.debug(
					// 	'producer "score" event [producerId:%s, score:%o]',
					// 	producer.id, score);

					peer.notify('producerScore', { producerId: producer.id, score })
						.catch(() => {});
				});

				producer.on('videoorientationchange', (videoOrientation) =>
				{
					logger.debug(
						'producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
						producer.id, videoOrientation);
				});

				// NOTE: For testing.
				// await producer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
				// await producer.enableTraceEvent([ 'pli', 'fir' ]);
				// await producer.enableTraceEvent([ 'keyframe' ]);

				producer.on('trace', (trace) =>
				{
					logger.debug(
						'producer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
						producer.id, trace.type, trace);
				});

				accept({ id: producer.id });

				// Optimization: Create a server-side Consumer for each Peer.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					this._createConsumer(
						{
							consumerPeer : otherPeer,
							producerPeer : peer,
							producer
						});
				}

				// Add into the audioLevelObserver.
				if (producer.kind === 'audio')
				{
					this._audioLevelObserver.addProducer({ producerId: producer.id })
						.catch(() => {});
				}

				break;
			}

			case 'closeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				producer.close();

				// Remove from its map.
				peer.data.producers.delete(producer.id);

				accept();

				break;
			}

			case 'pauseProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.pause();

				accept();

				break;
			}

			case 'resumeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.resume();

				accept();

				break;
			}

			case 'pauseConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.pause();

				accept();

				break;
			}

			case 'resumeConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.resume();

				accept();

				break;
			}

			case 'setConsumerPreferredLayers':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, spatialLayer, temporalLayer } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPreferredLayers({ spatialLayer, temporalLayer });

				accept();

				break;
			}

			case 'setConsumerPriority':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, priority } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPriority(priority);

				accept();

				break;
			}

			case 'requestConsumerKeyFrame':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.requestKeyFrame();

				accept();

				break;
			}

			case 'produceData':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const {
					transportId,
					sctpStreamParameters,
					label,
					protocol,
					appData
				} = request.data;

				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const dataProducer = await transport.produceData(
					{
						sctpStreamParameters,
						label,
						protocol,
						appData
					});

				// Store the Producer into the protoo Peer data Object.
				peer.data.dataProducers.set(dataProducer.id, dataProducer);

				accept({ id: dataProducer.id });

				switch (dataProducer.label)
				{
					case 'chat':
					{
						// Create a server-side DataConsumer for each Peer.
						for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
						{
							this._createDataConsumer(
								{
									dataConsumerPeer : otherPeer,
									dataProducerPeer : peer,
									dataProducer
								});
						}

						break;
					}

					case 'bot':
					{
						// Pass it to the bot.
						this._bot.handlePeerDataProducer(
							{
								dataProducerId : dataProducer.id,
								peer
							});

						break;
					}
				}

				break;
			}

			case 'changeDisplayName':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { displayName } = request.data;
				const oldDisplayName = peer.data.displayName;

				// Store the display name into the custom data Object of the protoo
				// Peer.
				peer.data.displayName = displayName;

				// Notify other joined Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'peerDisplayNameChanged',
						{
							peerId : peer.id,
							displayName,
							oldDisplayName
						})
						.catch(() => {});
				}

				accept();

				break;
			}

			case 'getTransportStats':
			{
				const { transportId } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const stats = await transport.getStats();

				accept(stats);

				break;
			}

			case 'getProducerStats':
			{
				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				const stats = await producer.getStats();

				accept(stats);

				break;
			}

			case 'getConsumerStats':
			{
				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				const stats = await consumer.getStats();

				accept(stats);

				break;
			}

			case 'getDataProducerStats':
			{
				const { dataProducerId } = request.data;
				const dataProducer = peer.data.dataProducers.get(dataProducerId);

				if (!dataProducer)
					throw new Error(`dataProducer with id "${dataProducerId}" not found`);

				const stats = await dataProducer.getStats();

				accept(stats);

				break;
			}

			case 'getDataConsumerStats':
			{
				const { dataConsumerId } = request.data;
				const dataConsumer = peer.data.dataConsumers.get(dataConsumerId);

				if (!dataConsumer)
					throw new Error(`dataConsumer with id "${dataConsumerId}" not found`);

				const stats = await dataConsumer.getStats();

				accept(stats);

				break;
			}

			case 'applyNetworkThrottle':
			{
				const DefaultUplink = 1000000;
				const DefaultDownlink = 1000000;
				const DefaultRtt = 0;

				const { uplink, downlink, rtt, secret } = request.data;

				if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET)
				{
					reject(403, 'operation NOT allowed, modda fuckaa');

					return;
				}

				try
				{
					await throttle.start(
						{
							up   : uplink || DefaultUplink,
							down : downlink || DefaultDownlink,
							rtt  : rtt || DefaultRtt
						});

					logger.warn(
						'network throttle set [uplink:%s, downlink:%s, rtt:%s]',
						uplink || DefaultUplink,
						downlink || DefaultDownlink,
						rtt || DefaultRtt);

					accept();
				}
				catch (error)
				{
					logger.error('network throttle apply failed: %o', error);

					reject(500, error.toString());
				}

				break;
			}

			case 'resetNetworkThrottle':
			{
				const { secret } = request.data;

				if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET)
				{
					reject(403, 'operation NOT allowed, modda fuckaa');

					return;
				}

				try
				{
					await throttle.stop({});

					logger.warn('network throttle stopped');

					accept();
				}
				catch (error)
				{
					logger.error('network throttle stop failed: %o', error);

					reject(500, error.toString());
				}

				break;
			}

			default:
			{
				logger.error('unknown request.method "%s"', request.method);

				reject(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	/**
	 * Helper to get the list of joined protoo peers.
	 */
	_getJoinedPeers({ excludePeer = undefined } = {})
	{
		return this._protooRoom.peers
			.filter((peer) => peer.data.joined && peer !== excludePeer);
	}

	/**
	 * Creates a mediasoup Consumer for the given mediasoup Producer.
	 *
	 * @async
	 */
	async _createConsumer({ consumerPeer, producerPeer, producer })
	{
		// Optimization:
		// - Create the server-side Consumer in paused mode.
		// - Tell its Peer about it and wait for its response.
		// - Upon receipt of the response, resume the server-side Consumer.
		// - If video, this will mean a single key frame requested by the
		//   server-side Consumer (when resuming it).
		// - If audio (or video), it will avoid that RTP packets are received by the
		//   remote endpoint *before* the Consumer is locally created in the endpoint
		//   (and before the local SDP O/A procedure ends). If that happens (RTP
		//   packets are received before the SDP O/A is done) the PeerConnection may
		//   fail to associate the RTP stream.

		// NOTE: Don't create the Consumer if the remote Peer cannot consume it.
		if (
			!consumerPeer.data.rtpCapabilities ||
			!this._mediasoupRouter.canConsume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities
				})
		)
		{
			return;
		}

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(consumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createConsumer() | Transport for consuming not found');

			return;
		}

		// Create the Consumer in paused mode.
		let consumer;

		try
		{
			consumer = await transport.consume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities,
					paused          : true
				});
		}
		catch (error)
		{
			logger.warn('_createConsumer() | transport.consume():%o', error);

			return;
		}

		// Store the Consumer into the protoo consumerPeer data Object.
		consumerPeer.data.consumers.set(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			// Remove from its map.
			consumerPeer.data.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			// Remove from its map.
			consumerPeer.data.consumers.delete(consumer.id);

			consumerPeer.notify('consumerClosed', { consumerId: consumer.id })
				.catch(() => {});
		});

		consumer.on('producerpause', () =>
		{
			consumerPeer.notify('consumerPaused', { consumerId: consumer.id })
				.catch(() => {});
		});

		consumer.on('producerresume', () =>
		{
			consumerPeer.notify('consumerResumed', { consumerId: consumer.id })
				.catch(() => {});
		});

		consumer.on('score', (score) =>
		{
			// logger.debug(
			// 	'consumer "score" event [consumerId:%s, score:%o]',
			// 	consumer.id, score);

			consumerPeer.notify('consumerScore', { consumerId: consumer.id, score })
				.catch(() => {});
		});

		consumer.on('layerschange', (layers) =>
		{
			consumerPeer.notify(
				'consumerLayersChanged',
				{
					consumerId    : consumer.id,
					spatialLayer  : layers ? layers.spatialLayer : null,
					temporalLayer : layers ? layers.temporalLayer : null
				})
				.catch(() => {});
		});

		// NOTE: For testing.
		// await consumer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
		// await consumer.enableTraceEvent([ 'pli', 'fir' ]);
		// await consumer.enableTraceEvent([ 'keyframe' ]);

		consumer.on('trace', (trace) =>
		{
			logger.debug(
				'consumer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
				consumer.id, trace.type, trace);
		});

		// Send a protoo request to the remote Peer with Consumer parameters.
		try
		{
			await consumerPeer.request(
				'newConsumer',
				{
					peerId         : producerPeer.id,
					producerId     : producer.id,
					id             : consumer.id,
					kind           : consumer.kind,
					rtpParameters  : consumer.rtpParameters,
					type           : consumer.type,
					appData        : producer.appData,
					producerPaused : consumer.producerPaused
				});

			// Now that we got the positive response from the remote endpoint, resume
			// the Consumer so the remote endpoint will receive the a first RTP packet
			// of this new stream once its PeerConnection is already ready to process
			// and associate it.
			await consumer.resume();

			consumerPeer.notify(
				'consumerScore',
				{
					consumerId : consumer.id,
					score      : consumer.score
				})
				.catch(() => {});
		}
		catch (error)
		{
			logger.warn('_createConsumer() | failed:%o', error);
		}
	}

	/**
	 * Creates a mediasoup DataConsumer for the given mediasoup DataProducer.
	 *
	 * @async
	 */
	async _createDataConsumer(
		{
			dataConsumerPeer,
			dataProducerPeer = null, // This is null for the bot DataProducer.
			dataProducer
		})
	{
		// NOTE: Don't create the DataConsumer if the remote Peer cannot consume it.
		if (!dataConsumerPeer.data.sctpCapabilities)
			return;

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(dataConsumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createDataConsumer() | Transport for consuming not found');

			return;
		}

		// Create the DataConsumer.
		let dataConsumer;

		try
		{
			dataConsumer = await transport.consumeData(
				{
					dataProducerId : dataProducer.id
				});
		}
		catch (error)
		{
			logger.warn('_createDataConsumer() | transport.consumeData():%o', error);

			return;
		}

		// Store the DataConsumer into the protoo dataConsumerPeer data Object.
		dataConsumerPeer.data.dataConsumers.set(dataConsumer.id, dataConsumer);

		// Set DataConsumer events.
		dataConsumer.on('transportclose', () =>
		{
			// Remove from its map.
			dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id);
		});

		dataConsumer.on('dataproducerclose', () =>
		{
			// Remove from its map.
			dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id);

			dataConsumerPeer.notify(
				'dataConsumerClosed', { dataConsumerId: dataConsumer.id })
				.catch(() => {});
		});

		// Send a protoo request to the remote Peer with Consumer parameters.
		try
		{
			await dataConsumerPeer.request(
				'newDataConsumer',
				{
					// This is null for bot DataProducer.
					peerId               : dataProducerPeer ? dataProducerPeer.id : null,
					dataProducerId       : dataProducer.id,
					id                   : dataConsumer.id,
					sctpStreamParameters : dataConsumer.sctpStreamParameters,
					label                : dataConsumer.label,
					protocol             : dataConsumer.protocol,
					appData              : dataProducer.appData
				});
		}
		catch (error)
		{
			logger.warn('_createDataConsumer() | failed:%o', error);
		}
	}
	async pipeCreate(){
		logger.info("room %s start create pipe for remote link", this._roomId);
		let remoteListenParam = {
			...config.mediasoup.pipeTransportOptions,
			appData: {type: "consumeRemote", consumeProducerIds: [], produceConsumerIds: {}}
		};
		let remoteRoomListnPipe = await this._mediasoupRouter.createPipeTransport(remoteListenParam);
		remoteRoomListnPipe.on('trace', (trace) =>
		{
			logger.debug(
				'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
				transport.id, trace.type, trace);
		});
		this._RoomPipes[remoteRoomListnPipe.id] = remoteRoomListnPipe;
		let localListenParam = {
			...config.mediasoup.pipeTransportOptions,
			appData: {type: "consumeLocal", consumeProducerIds: [], produceConsumerIds: {}}
		};
		let localRoomListnPipe = await this._mediasoupRouter.createPipeTransport(localListenParam);
		localRoomListnPipe.on('trace', (trace) =>
		{
			logger.debug(
				'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
				transport.id, trace.type, trace);
		});
		this._RoomPipes[localRoomListnPipe.id] = localRoomListnPipe;
		let ret = {
			consumeRemote: {
				pipeId: remoteRoomListnPipe.id,
				port: remoteRoomListnPipe.tuple.localPort
			},
			consumeLocal: {
				pipeId: localRoomListnPipe.id,
				port: localRoomListnPipe.tuple.localPort
			}
		}
		return ret;
	}
	
	
	async pipeConnect(pipeOpts){
		logger.info("room %s start connect remote room %s", this._roomId, pipeOpts);
		for(const pipeOpt of pipeOpts){
			const roomPipe = this._RoomPipes[pipeOpt.local.pipeId];
			if(roomPipe){
				await roomPipe.connect({ip: pipeOpt.remote.ip, port: pipeOpt.remote.port});
				roomPipe.appData.remoteIp = pipeOpt.remote.ip;
				roomPipe.appData.remotePort = pipeOpt.remote.port;
			}
		}
		return {code: 0};
	}
	
	async pipeConsumeOnePeer(pipeId, peerId){
		logger.info("room %s pipe %s consume local peer %s", this._roomId, pipeId, peerId);
		let ret = {
			success: false,
			peerOpts: []
		};
		const pipeTransport = this._RoomPipes[pipeId];
		if(pipeTransport === undefined 
			|| pipeTransport.closed
			|| pipeTransport.appData.type != "consumeLocal"){
			logger.info("DEBG111 %s, %s", pipeTransport, this._RoomPipes);
			return ret;
		}
		logger.info("DEBG");
		const peer = this._protooRoom.getPeer(peerId);
		if(!peer){
			logger.info("DEBGwww");
			return ret;
		}
		let peerData = {
			id: peer.id,
			data: peer.data,
			consumeDatas: []
		};
		for(const producer of peer.data.producers.values()){
			if(!(producer.id in pipeTransport.appData.consumeProducerIds)){
				let consumer = await pipeTransport.consume({
					producerId: producer.id,
					paused: true
				});
				let consumeData = {
					rtpParameters: consumer.rtpParameters,
					kind: producer.kind
				};
				peerData.consumeDatas.push(consumeData);
				pipeTransport.appData.consumeProducerIds.push(producer.id);
			}
		}
		if(peerData.consumeDatas.length > 0){
			ret.peerOpts.push(peerData);
		}
		ret.success = true;
		return ret;
	}
	
	async pipeConsume(pipeId){
		logger.info("room %s pipe %s consume local", this._roomId, pipeId);
		let ret = {
			success: false,
			peerOpts : []
		};
		const pipeTransport = this._RoomPipes[pipeId];
		if(pipeTransport === undefined 
			|| pipeTransport.closed
			|| pipeTransport.appData.type != "consumeLocal"){
			return ret;
		}
		for(const joinedPeer of this._getJoinedPeers()){
			let joinedPeerData = {
				id: joinedPeer.id,
				data: joinedPeer.data,
				consumeDatas: []
			};
			for(const producer of joinedPeer.data.producers.values()){
				if(!(producer.id in pipeTransport.appData.consumeProducerIds)){
					let consumer = await pipeTransport.consume({
						producerId: producer.id,
						paused: true
					});
					let consumeData = {
						rtpParameters: consumer.rtpParameters,
						kind:producer.kind
					};
					joinedPeerData.consumeDatas.push(consumeData);
					pipeTransport.appData.consumeProducerIds.push(producer.id);
				}
			}
			if(joinedPeerData.consumeDatas.length > 0){
				ret.peerOpts.push(joinedPeerData);
			}
		}
		ret.success = true;
		return ret;
	}
	
	
	async pipeProduce(pipeId, linkOpt){
		logger.info("room %s execute pipe %s with opt %s", this._roomId, pipeId, linkOpt);
		const pipeTransport = this._RoomPipes[pipeId];
		let ret = {
			success: true
		};
	
		if(pipeTransport === undefined
			|| pipeTransport.closed
			|| linkOpt == {}
			|| pipeTransport.appData.type != "consumeRemote"){
				return ret;
		}
		const{peerOpts} = linkOpt;
		for(const peerOpt of peerOpts){
			if(!this._RemotePeers[peerOpt.id]){
				this._RemotePeers[peerOpt.id] = {producers: [], id: peerOpt.id, data: peerOpt.data};
			}
			let remotePeer = this._RemotePeers[peerOpt.id];
			for(const joinedPeer of this._getJoinedPeers()){
				await joinedPeer.notify(
					'newPeer',
					{
						id: peerOpt.id,
						displayName: peerOpt.data.displayName,
						device: peerOpt.data.device
					})
					.catch(() => {});
			}
			for(const consumeData of peerOpt.consumeDatas){
				if(remotePeer.producers.filter((p) => p.kind == consumeData.kind).length > 0){
					continue;
				}
				let peerProducer = await pipeTransport.produce({
					kind: consumeData.kind,
					rtpParameters:consumeData.rtpParameters,
					appData: {peerId: peerOpt.id}
				});
				remotePeer.producers.push(peerProducer);
				for(const joinedPeer of this._getJoinedPeers()){
					let transport = Array.from(joinedPeer.data.transports.values())
					.find((t) => t.appData.consuming);
					if(producer.id in joinedPeer.data.consumers){
						continue;
					}
					let consumer = await transport.consume({
						producerId: peerProducer.id,
						kind: consumeData.kind,
						rtpCapabilities: joinedPeer.data.rtpCapabilities
					});

					consumer.on('transportclose', () =>
					{
						// Remove from its map.
						joinedPeer.data.consumers.delete(consumer.id);
					});
			
					consumer.on('producerclose', () =>
					{
						// Remove from its map.
						joinedPeer.data.consumers.delete(consumer.id);
			
						joinedPeer.notify('consumerClosed', { consumerId: consumer.id })
							.catch(() => {});
					});
			
					consumer.on('producerpause', () =>
					{
						joinedPeer.notify('consumerPaused', { consumerId: consumer.id })
							.catch(() => {});
					});
			
					consumer.on('producerresume', () =>
					{
						joinedPeer.notify('consumerResumed', { consumerId: consumer.id })
							.catch(() => {});
					});
			
					consumer.on('score', (score) =>
					{
						// logger.debug(
						// 	'consumer "score" event [consumerId:%s, score:%o]',
						// 	consumer.id, score);
			
						joinedPeer.notify('consumerScore', { consumerId: consumer.id, score })
							.catch(() => {});
					});
			
					consumer.on('layerschange', (layers) =>
					{
						joinedPeer.notify(
							'consumerLayersChanged',
							{
								consumerId    : consumer.id,
								spatialLayer  : layers ? layers.spatialLayer : null,
								temporalLayer : layers ? layers.temporalLayer : null
							})
							.catch(() => {});
					});
			
					// NOTE: For testing.
					// await consumer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
					// await consumer.enableTraceEvent([ 'pli', 'fir' ]);
					// await consumer.enableTraceEvent([ 'keyframe' ]);
			
					consumer.on('trace', (trace) =>
					{
						logger.debug(
							'consumer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
							consumer.id, trace.type, trace);
					});

					await joinedPeer.request('newConsumer', {
						appData: {peerId: peerOpt.id},
						peerId: peerOpt.id,
						producerId: peerProducer.id,
						id: consumer.id,
						kind: peerProducer.kind,
						rtpParameters: consumer.rtpParameters,
						type: "simple",
						producerPaused: consumer.producerPaused
					});
					joinedPeer.data.consumers.set(consumer.id, consumer);
				}
			}
		}
		return ret;
	}

	/**
	 * 
	 * @returns 
	 */
	async pipeCloseProducer(peerId, kind){
		if(this._RemotePeers[peerId]){
			const remotePeer = this._RemotePeers[peerId];
			for(const producer of remotePeer.producers.filter((p) => p.kind == kind)){
				let producerIndex = producer.indexOf(remotePeer.producers);
				remotePeer.producers.splice(producerIndex, 1);
				producer.close();
			}
		}
	}

	async pipePeerClose(peerId){
		if(this._RemotePeers[peerId]){
			let remotePeer = this._RemotePeers[peerId];
			for(const producer of remotePeer.producers){
				producer.close();
			}
			delete this._RemotePeers[peerId];
		}
	}

	/**
	 * 
	 */
	async pipes(){
		return this._RoomPipes;
	}
}


module.exports = Room;
