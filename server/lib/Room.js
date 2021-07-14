const EventEmitter = require('events').EventEmitter;
const protoo = require('protoo-server');
const protooClient = require('protoo-client');
const Logger = require('./Logger');
const config = require('../config');

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

		// Router media codecs.
		const { mediaCodecs } = config.mediasoup.routerOptions;

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		return new Room(
			{
				roomId,
				mediasoupRouter
			});
	}

	constructor({ roomId, mediasoupRouter})
	{
		super();
		this.setMaxListeners(Infinity);

		// Room id.
		// @type {String}
		this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;


		this._peers = new Map();


		// mediasoup Router instance.
		// @type {mediasoup.Router}
		this._mediasoupRouter = mediasoupRouter;
	}

	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{
		logger.debug('close()');

		this._closed = true;

		// Close the mediasoup Router.
		this._mediasoupRouter.close();


		for(const [peerId, peer] of this._peers.values()){
			for(const transport of peer.origin.transports.values()){
				transport.close();
			}
			for(const transport of peer.bridge.transports.values()){
				transport.close();
			}
			this._peers.delete(peerId);
		}

		// Emit 'close' event.
		this.emit('close');
	}

	logStatus()
	{
		// logger.info(
		// 	'logStatus() [roomId:%s, protoo Peers:%s, mediasoup Transports:%s]',
		// 	this._roomId,
		// 	this._protooRoom.peers.length,
		// 	this._mediasoupRouter._transports.size); // NOTE: Private API.
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
	handleProtooConnection({ peerId, protooWebSocketTransport })
	{
		const existingPeer = this._peers.get(peerId);

		if (existingPeer)
		{
			logger.warn(
				'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
				peerId);

			existingPeer.close();
		}

		let originPeer;

		// Create a new protoo Peer with the given peerId.
		try
		{
			originPeer = new protoo.Peer(peerId, protooWebSocketTransport);
		}
		catch (error)
		{
			logger.error('createPeer() failed:%o', error);
		}

		// Use the peer.data object to store mediasoup related objects.

		// Not joined after a custom protoo 'join' request is later received.
		originPeer.data.joined = false;
		originPeer.data.displayName = undefined;
		originPeer.data.device = undefined;
		originPeer.data.rtpCapabilities = undefined;
		originPeer.data.sctpCapabilities = undefined;

		// Have mediasoup related maps ready even before the Peer joins since we
		// allow creating Transports before joining.
		originPeer.data.transports = new Map();
		originPeer.data.producers = new Map();
		originPeer.data.consumers = new Map();
		originPeer.data.produceRemoteConsumers = new Map();

		const bridgeUrl = config.bridgeAddress + '?roomId=' + this._roomId + "&peerId=" + peerId;
		logger.info("KKKKK %s", bridgeUrl);
		const bridgeTransport = new protooClient.WebSocketTransport(bridgeUrl);
		let bridgePeer = new protooClient.Peer(bridgeTransport);


		bridgePeer.data.joined = false;
		bridgePeer.data.displayName = undefined;
		bridgePeer.data.device = undefined;
		bridgePeer.data.rtpCapabilities = undefined;
		bridgePeer.data.sctpCapabilities = undefined;
		bridgePeer.data.consumeRemoteProducerIds = new Map();
		bridgePeer.data.produceLocalConsumerIds = new Map();


		bridgePeer.data.transports = new Map();
		bridgePeer.data.producers = new Map();
		bridgePeer.data.consumers = new Map();

		let peer = {};
		peer.id = peerId;
		peer.origin = originPeer;
		peer.bridge = bridgePeer;

		this._peers.set(peerId, peer);

		originPeer.on('request', (request, accept, reject) =>
		{
			logger.debug(
				'protoo Peer "request" event [method:%s, peerId:%s]',
				request.method, peer.id);

			this._handleOriginRequest(peer, request, accept, reject)
				.catch((error) =>
				{
					logger.error('origin request failed:%o', error);

					reject(error);
				});
		});

		originPeer.on('close', () =>
		{
			if (this._closed)
				return;

			logger.debug('origin "close" event [peerId:%s]', peer.id);

			this._closePeer(peerId);
		});

		bridgePeer.on('request', async (request, accept, reject) =>
		{
			logger.debug(
				'protoo Peer "request" event [method:%s, peerId:%s]',
				request.method, peer.id);

			this._handleBridgeRequest(peer, request, accept, reject)
				.catch((error) =>
				{
					logger.error('bridge request failed:%o', error);

					reject(error);
				});
		});

		bridgePeer.on('notification', (notification) =>
		{
			logger.debug(
				'bridge Peer "notification" event [method:%s, peerId:%s]',
				notification.method, peer.id);

			this._handleBridgeNotification(peer, notification)
				.catch((error) =>
				{
					logger.error('handle notification failed:%o', error);
				});
		});

		bridgePeer.on('close', () =>
		{
			if (this._closed)
				return;
			logger.debug('bridge "close" event [peerId:%s]', peer.id);

			this._closePeer(peerId);
		});

		bridgePeer.on('failed', () =>
		{
			if (this._closed)
				return;
			logger.debug('bridge "failed" event [peerId:%s]', peer.id);

			this._closePeer(peerId);
		});

		bridgePeer.on('disconnected', () =>
		{
			if (this._closed)
				return;
			logger.debug('bridge "disconnected" event [peerId:%s]', peer.id);

			this._closePeer(peerId);
		});

	}

	getRouterRtpCapabilities()
	{
		return this._mediasoupRouter.rtpCapabilities;
	}

	/**
	 * Handle protoo requests from browsers.
	 *
	 * @async
	 */
	async _handleOriginRequest(peer, request, accept, reject)
	{
		if(peer.bridge.data.transports.size <= 0){
			await this._bridgeConnect(peer.bridge);
		}
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
				if (peer.origin.data.joined)
					throw new Error('Peer already joined');

				const {
					displayName,
					device,
					rtpCapabilities,
					sctpCapabilities
				} = request.data;

				let nrequestData = {
					...request.data,
					isBridge: true
				};

				const {peers: peerInfos} = await peer.bridge.request('join', nrequestData);

				// Store client data into the protoo Peer data object.
				peer.origin.data.joined = true;
				peer.origin.data.displayName = displayName;
				peer.origin.data.device = device;
				peer.origin.data.rtpCapabilities = rtpCapabilities;
				peer.origin.data.sctpCapabilities = sctpCapabilities;
				peer.origin.data.consumerMidSeq = 0;

				accept({ peers: peerInfos });

				// Mark the new Peer as joined.
				peer.origin.data.joined = true;

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
						peer.origin.notify(
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
				peer.origin.data.transports.set(transport.id, transport);

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
				const transport = peer.origin.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				await transport.connect({ dtlsParameters });

				accept();

				break;
			}

			case 'restartIce':
			{
				const { transportId } = request.data;
				const transport = peer.origin.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const iceParameters = await transport.restartIce();

				accept(iceParameters);

				break;
			}

			case 'produce':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { transportId, kind, rtpParameters } = request.data;
				let { appData } = request.data;
				const transport = peer.origin.data.transports.get(transportId);

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
				peer.origin.data.producers.set(producer.id, producer);

				// Set Producer events.
				producer.on('score', (score) =>
				{
					// logger.debug(
					// 	'producer "score" event [producerId:%s, score:%o]',
					// 	producer.id, score);

					peer.origin.notify('producerScore', { producerId: producer.id, score })
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
			

				let consumeTransport = Array.from(peer.bridge.data.transports.values())
				.find((t) => t.appData.consuming);

				let consumer = await consumeTransport.consume({
					producerId: producer.id,
					kind: kind,
					rtpCapabilities: peer.origin.data.rtpCapabilities,
					paused: true
				});


				logger.info("GGGGGGD %s", consumer.rtpParameters);

				const {id: remoteProducerId} = await peer.bridge.request('produce', {
					transportId: consumeTransport.appData.remoteTransportId, 
					kind, 
					rtpParameters: consumer.rtpParameters
				});

				consumer.appData.remoteProducerId = remoteProducerId;
				peer.bridge.data.produceLocalConsumerIds.set(consumer.id, remoteProducerId);

				consumer.on('producerclose', async () => {
					logger.info("GGGGGGGGGGGGG");
					const remoteCloseProducerId = peer.bridge.data.produceLocalConsumerIds.get(consumer.id);
					if(remoteCloseProducerId){
						let requestData = {producerId: remoteCloseProducerId};
						await peer.bridge.request('closeProducer', requestData);
						peer.bridge.data.produceLocalConsumerIds.delete(consumer.id);
					}
					peer.bridge.consumers.delete(consumer.id);
				});
				



				break;
			}

			case 'closeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.origin.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				producer.close();

				// Remove from its map.
				peer.origin.data.producers.delete(producer.id);

				accept();

				break;
			}

			case 'pauseProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.origin.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.pause();

				accept();

				break;
			}

			case 'resumeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.origin.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.resume();

				accept();

				break;
			}

			case 'pauseConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.origin.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.pause();

				accept();

				break;
			}

			case 'resumeConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.origin.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.resume();

				accept();

				break;
			}

			case 'setConsumerPreferredLayers':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, spatialLayer, temporalLayer } = request.data;
				const consumer = peer.origin.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPreferredLayers({ spatialLayer, temporalLayer });

				accept();

				break;
			}

			case 'setConsumerPriority':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, priority } = request.data;
				const consumer = peer.origin.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPriority(priority);

				accept();

				break;
			}

			case 'requestConsumerKeyFrame':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.origin.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.requestKeyFrame();

				accept();

				break;
			}

			case 'changeDisplayName':
			{
				// Ensure the Peer is joined.
				if (!peer.origin.data.joined)
					throw new Error('Peer not yet joined');

				const { displayName } = request.data;

				// Store the display name into the custom data Object of the protoo
				// Peer.
				peer.origin.data.displayName = displayName;


				await peer.bridge.request('changeDisplayName', request.data);

				accept();

				break;
			}

			case 'getTransportStats':
			{
				const { transportId } = request.data;
				const transport = peer.origin.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const stats = await transport.getStats();

				accept(stats);

				break;
			}

			case 'getProducerStats':
			{
				const { producerId } = request.data;
				const producer = peer.origin.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				const stats = await producer.getStats();

				accept(stats);

				break;
			}

			case 'getConsumerStats':
			{
				const { consumerId } = request.data;
				const consumer = peer.origin.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				const stats = await consumer.getStats();

				accept(stats);

				break;
			}

			case 'sendMessage':
				{
					await peer.bridge.request('sendMessage', request.data);
					accept({});
	
					break;
				}

			default:
			{
				logger.error('unknown request.method "%s"', request.method);

				reject(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	async _handleBridgeNotification(peer, notifcation){
		logger.info("JJJJJJJ %s %s", notifcation.data, peer.origin);
		switch (notifcation.method){
			case 'newPeer':
			{
				await peer.origin.notify('newPeer', notifcation.data).catch(() => {});

				break;
			}

			case 'peerDisplayNameChanged':
			{
				await peer.origin.notify('peerDisplayNameChanged', notifcation.data).catch(() => {});
				
				break;
			}
			case 'peerClosed':
			{
				await peer.origin.notify('peerClosed', notifcation.data).catch(() => {});

				break;
			}
			case 'consumerClosed':
			{
				const { consumerId } = notifcation.data;
				const producer = peer.bridge.data.consumeRemoteProducerIds.get(consumerId);
				if(producer){
					producer.close();
					peer.bridge.consumeRemoteProducerIds.delete(consumerId);
				}
				break;
			}

			case 'messageReceived':
				{
					peer.origin.notify('messageReceived', notifcation.data).catch(() => {});
					break;
				}

			default:
			{
				logger.error(
					'unknown protoo notifcation.method "%s"', notifcation.method);
				break;
			}
		}

	}


	async _handleBridgeRequest(peer, request, accept, reject){
		switch (request.method)
		{
			case 'newConsumer':
			{
				const {
					peerId,
					producerId,
					id,
					kind,
					rtpParameters,
					type,
					appData,
					producerPaused
				} = request.data;

				try
				{
					const transport = Array.from(peer.bridge.data.transports.values())
					.find((t) => t.appData.producing);
					let producer = await transport.produce({
						kind,
						rtpParameters,
						appData: {...appData, remoteConsumerId: id, remoteProducerId: producerId}
					});
					logger.info("FFFJDD %s %s %s", rtpParameters.encodings[0].ssrc, transport.appData, producer.rtpParameters.encodings[0].ssrc);

					const consumeTransport = Array.from(peer.origin.data.transports.values())
					.find((t) => t.appData.consuming);

					let a = this._mediasoupRouter.canConsume(
						{
							producerId      : producer.id,
							rtpCapabilities : peer.origin.data.rtpCapabilities
						})
					if(!a){
						logger.warn("can not produce %s", producer.id);
					}


					let consumer = await consumeTransport.consume({
						producerId: producer.id,
						kind: kind,
						rtpCapabilities: peer.origin.data.rtpCapabilities
					});

					consumer.on('transportclose', () =>
					{
						// Remove from its map.
						peer.origin.data.consumers.delete(consumer.id);
					});
			
					consumer.on('producerclose', () =>
					{
						logger.info("DEBUG");
						// Remove from its map.
						peer.origin.data.consumers.delete(consumer.id);
			
						peer.origin.notify('consumerClosed', { consumerId: consumer.id })
							.catch(() => {});
					});
			
					consumer.on('producerpause', () =>
					{
						peer.origin.notify('consumerPaused', { consumerId: consumer.id })
							.catch(() => {});
					});
			
					consumer.on('producerresume', () =>
					{
						peer.origin.notify('consumerResumed', { consumerId: consumer.id })
							.catch(() => {});
					});
			
					consumer.on('score', (score) =>
					{
						// logger.debug(
						// 	'consumer "score" event [consumerId:%s, score:%o]',
						// 	consumer.id, score);
			
						peer.origin.notify('consumerScore', { consumerId: consumer.id, score })
							.catch(() => {});
					});
			
					consumer.on('layerschange', (layers) =>
					{
						peer.origin.notify(
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

					let newRequestData = {
						peerId,
						producerId: producer.id,
						id: consumer.id,
						kind,
						rtpParameters: consumer.rtpParameters,
						type,
						appData,
						producerPaused
					};

					await peer.origin.request('newConsumer', newRequestData).catch(() => {});

					await consumer.resume();

					peer.origin.notify(
						'consumerScore',
						{
							consumerId : consumer.id,
							score      : consumer.score
						})
						.catch(() => {});

					peer.bridge.data.producers.set(producer.id, producer);
					peer.origin.data.consumers.set(consumer.id, consumer);
					peer.bridge.data.consumeRemoteProducerIds.set(id, producer);
					
					

					accept();

				}
				catch (error)
				{
					logger.error('"newConsumer" request failed:%o', error);

					store.dispatch(requestActions.notify(
						{
							type : 'error',
							text : `Error creating a Consumer: ${error}`
						}));

					throw error;
				}

				break;
			}
			default:
			{
				logger.error(
					'unknown protoo reques.method "%s"', request.method);
				break;
			}
			
		}
	}

	_closePeer(peerId){
		const peer = this._peers.get(peerId);
		if(peer){
			if(!peer.origin.closed){
				peer.origin.close();
			}

			for (const transport of peer.origin.data.transports.values()){
				transport.close();
			}

			if(!peer.bridge.closed){
				peer.bridge.close();
			}

			for (const transport of peer.bridge.data.transports.values()){
				transport.close();
			}

			this._peers.delete(peerId);
		}

		if(this._peers.length === 0){
			logger.info(
				'last Peer in the room left, closing the room [roomId:%s]',
				this._roomId);
			this.close();
		}
	}

	async _bridgeConnect(bridgePeer){
		logger.info("CONNECTING.......");
		let producePipeTransportOption = {
			...config.mediasoup.pipeTransportOptions,
			appData:{consuming: false, producing: true, peerId: bridgePeer.id}
		}
		let producePipeTransport = await this._mediasoupRouter.createPipeTransport(producePipeTransportOption);
		

		let consumePipeTransportOption = {
			...config.mediasoup.pipeTransportOptions,
			appData:{consuming: true, producing: false, peerId: bridgePeer.id}
		}
		let consumePipeTransport = await this._mediasoupRouter.createPipeTransport(consumePipeTransportOption);
		
		let consumePipe = {
				id: consumePipeTransport.id,
				ip: config.mediasoup.pipeTransportOptions.listenIp,
				port: consumePipeTransport.tuple.localPort
			};
		let producePipe = {
				id: producePipeTransport.id,
				ip: config.mediasoup.pipeTransportOptions.listenIp,
				port: producePipeTransport.tuple.localPort
			};

		const {
			consumePipe: remoteConsumePipe, 
			producePipe: remoteProducePipe
		} = await bridgePeer.request('createPipeTransport', {consumePipe, producePipe});
		
		await producePipeTransport.connect({ip: remoteConsumePipe.ip, port: remoteConsumePipe.port});
		await consumePipeTransport.connect({ip: remoteProducePipe.ip, port: remoteProducePipe.port});

		producePipeTransport.appData.remoteTransportId = remoteConsumePipe.id;
		consumePipeTransport.appData.remoteTransportId = remoteProducePipe.id;

		bridgePeer.data.transports.set(producePipeTransport.id, producePipeTransport);
		bridgePeer.data.transports.set(consumePipeTransport.id, consumePipeTransport);
		return;
	}

}

module.exports = Room;
