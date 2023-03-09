import {
	Answer,
	ClientMessage,
	Handler,
	IceCandidate,
	NonDataRtcEventName,
	Offer,
	Peer,
	PeerMessage,
	ReadyMessage,
	RtcEvent,
	RtcEventName,
	RtcMessage,
} from "../types";

type PeerConnection = {
	peer: Peer;
	connection: RTCPeerConnection;
	channel: RTCDataChannel;
	iceCandidates: RTCIceCandidateInit[];
};

/**
 * A class for managing a WebRTC client
 */
export class WebRTCClient {
	#closed = false;

	/**
	 * A notional version used by the client to see if the server has been
	 * updated
	 */
	#version = "";

	/** This client's unique ID; it will be set by the server */
	#id = '';

	#listeners = new Map<RtcEventName, Set<Handler<any>>>();

	/** This client's display name */
	#name: string;

	/** The active peer connection */
	#peerConnection: PeerConnection | undefined;

	/** Peers that this client knows about */
	#peers = new Map<string, Peer>();

	#reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	#socket: WebSocket | undefined;

	/** A camera stream from this device */
	#stream: MediaStream | undefined;

	constructor(name?: string) {
		this.#name = name ?? "Anonymous";
	}

	/**
	 * The client's unique ID.
	 */
	get id(): string {
		return this.#id;
	}

	/**
	 * The client's display name.
	 */
	get name(): string {
		return this.#name;
	}

	/**
	 * Set the client's display name.
	 *
	 * The signal server will be notified of the new name.
	 */
	set name(value: string) {
		const oldName = this.#name;
		this.#name = value;

		if (value !== oldName && this.#socket) {
			this.#sendToSignalServer({
				type: "identify",
				data: {
					name: value,
					id: this.#id,
				},
			});
		}
	}

	/**
	 * The set of peers known to this client
	 */
	get peers(): Peer[] {
		return Array.from(this.#peers.values());
	}

	/**
	 * Listen for events from the signal server
	 */
	on<T extends RtcEventName>(
		eventName: T,
		handler: Handler<RtcEvent[T]>
	): () => void {
		const handlers =
			/** @type {Set<H>} */ this.#listeners.get(eventName) ?? new Set();
		this.#listeners.set(eventName, handlers);
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
		};
	}

	/**
	 * Get the available cameras
	 */
	async getCameras(): Promise<MediaDeviceInfo[]> {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((device) => device.kind === "videoinput");
	}

	/**
	 * Open a camera stream on this device
	 */
	async openStream(options?: {
		cameraId?: string;
		audioDisabled?: boolean;
	}): Promise<MediaStream> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: options?.audioDisabled ? undefined : { echoCancellation: true },
			video: { deviceId: options?.cameraId },
		});

		// if there is an active peer connection, replace its stream tracks
		// with tracks from the new local stream
		this.#peerConnection?.connection.getSenders().map((sender) => {
			sender.replaceTrack(
				stream.getTracks().find((track) => track.kind === sender.track?.kind) ??
					null
			);
		});

		this.closeStream();
		this.#stream = stream;

		if (!this.#socket) {
			this.#connectToSignalServer();
		}

		return stream;
	}

	/**
	 * Close the currently open camera stream
	 */
	closeStream(): void {
		this.#disconnectFromSignalServer();
		this.#stream?.getTracks().forEach((track) => track.stop());
		this.#stream = undefined;
	}

	/**
	 * Close this client
	 */
	close(): void {
		clearTimeout(this.#reconnectTimer);
		this.#closed = true;
		this.#socket?.close();
		this.#listeners.clear();
		this.#peers.clear();
		this.closeStream();
	}

	/**
	 * Get a peer by ID
	 */
	getPeer(peerId: string): Peer | undefined {
		return this.#peers.get(peerId);
	}

	/**
	 * Get the name of the connected peer
	 */
	getConnectedPeer(): Peer {
		return this.#getPeerConnection().peer;
	}

	/**
	 * Invite a peer to connect
	 */
	async invite(peerId: string): Promise<void> {
		const peerConnection = this.#createPeerConnection(peerId);

		const offer = await peerConnection.createOffer({
			offerToReceiveAudio: true,
			offerToReceiveVideo: true,
		});

		if (!offer.sdp) {
			throw new Error("Unable to generate offer");
		}

		await peerConnection.setLocalDescription(offer);

		this.#sendToSignalServer({
			type: "offer",
			data: {
				type: offer.type,
				sdp: offer.sdp,
				source: this.#id,
				target: peerId,
			},
		});
	}

	/**
	 * Accept a peer invite
	 */
	async accept(offer: Offer): Promise<void> {
		const peerId = offer.source;
		const peerConnection = this.#createPeerConnection(peerId);

		await this.#setRemoteDescription(offer);

		const answer = await peerConnection.createAnswer({
			offerToReceiveAudio: true,
			offerToReceiveVideo: true,
		});

		if (!answer.sdp) {
			throw new Error("Unable to generate answer");
		}

		await peerConnection.setLocalDescription(answer);

		this.#sendToSignalServer({
			type: "accept",
			data: {
				type: answer.type,
				sdp: answer.sdp,
				source: this.#id,
				target: offer.source,
			},
		});

		// Start sending ICE candidates to the peer
		peerConnection.onicecandidate = (event) => {
			const candidate = event.candidate;
			if (candidate) {
				this.#sendToSignalServer({
					type: "icecandidate",
					data: {
						id: this.#id,
						target: peerId,
						candidate,
					},
				});
			}
		};
	}

	/**
	 * Reject a peer invite
	 */
	async reject(offer: Offer): Promise<void> {
		this.#sendToSignalServer({
			type: "reject",
			data: {
				source: this.#id,
				target: offer.source,
			},
		});
	}

	/**
	 * Disconnect from a peer
	 */
	disconnect(): void {
		this.#sendToPeer({
			type: "disconnect",
		});
		this.#closeConnection();
	}

	/**
	 * Shutdown a peer connection
	 */
	#closeConnection(): void {
		if (!this.#peerConnection) {
			return;
		}

		const {
			peer: { id: peerId },
		} = this.#peerConnection;

		this.#peerConnection.channel.close();
		this.#peerConnection.connection.close();
		this.#peerConnection = undefined;
		this.#emit("peerdisconnected", peerId);
	}

	/**
	 * Send a chat message to the connected peer
	 */
	sendChat(message: string): void {
		this.#sendToPeer({
			type: "chat",
			data: message,
		});
	}

	/**
	 * Get the active peer connection
	 */
	#getPeerConnection(): PeerConnection {
		if (!this.#peerConnection) {
			throw new Error("No peer connection");
		}
		return this.#peerConnection;
	}

	/**
	 * Add a received ICE candidate to the candidates list
	 *
	 * A peer will start sending ICE candidates as soon as it makes an offer.
	 * The receiving peer will need to queue them up until the offer is
	 * accepted or rejected.
	 */
	async #addIceCandidate(candidate: IceCandidate): Promise<void> {
		console.debug("Received candidate:", candidate);
		const { peer, iceCandidates, connection } = this.#getPeerConnection();
		if (candidate.id !== peer.id) {
			console.warn(
				`Ignoring ICE candidate for unconnected peer ${candidate.id}`
			);
			return;
		}

		if (connection.remoteDescription) {
			try {
				await connection.addIceCandidate(candidate.candidate);
			} catch (error) {
				console.warn(`Error adding ICE candidate ${candidate}: ${error}`);
			}
		} else {
			// If the remote end of the connection hasn't been configured yet,
			// cache the candidate to be added later
			iceCandidates.push(candidate.candidate);
		}
	}

	/**
	 * Connect to the signal server
	 */
	#connectToSignalServer(): void {
		console.log(`Connecting as ${this.#id}...`);
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const loc = `${protocol}//${window.location.host}/rtc`;

		const socket = new WebSocket(loc, ["userid", this.#id]);
		this.#socket = socket;

		socket.onopen = () => {
			this.#emit("connected");
		};

		socket.onmessage = (event) => {
			const msg = /** @type {RtcMessage} */ JSON.parse(event.data);
			this.#handleServerMessage(msg);
		};

		socket.onerror = (event) => {
			this.#emit("error", new Error(`${event}`));
			console.warn("Socket error:", event);
		};

		socket.onclose = () => {
			this.#socket = undefined;
			this.#emit("disconnected");
			console.debug("Socket closed");

			if (!this.#closed && this.#stream) {
				this.#reconnectToSignalServer();
			}
		};
	}

	/**
	 * Disconnect from the signal server
	 */
	#disconnectFromSignalServer(): void {
		this.#socket?.close();
		this.#socket = undefined;
	}

	/**
	 * Connect to a peer that has accepted an offer.
	 */
	async #connectToPeer(answer: Answer): Promise<void> {
		await this.#setRemoteDescription(answer);

		// Start sending ICE candidates to the peer
		const {
			connection,
			peer: { id: peerId },
		} = this.#getPeerConnection();
		connection.onicecandidate = (event) => {
			const candidate = event.candidate;
			if (candidate) {
				this.#sendToSignalServer({
					type: "icecandidate",
					data: {
						id: this.#id,
						target: peerId,
						candidate,
					},
				});
			}
		};
	}

	/**
	 * Initialize a new peer connection
	 */
	#createPeerConnection(peerId: string): RTCPeerConnection {
		if (!this.#stream) {
			throw new Error("Stream must be open to create a peer connection");
		}

		if (this.#peerConnection) {
			throw new Error("Client already has an active peer connection");
		}

		const peer = this.#peers.get(peerId);
		if (!peer) {
			throw new Error(`Unknown peer ${peerId}`);
		}

		const peerConnection = new RTCPeerConnection({
			iceServers: [],
			iceTransportPolicy: "all",
			iceCandidatePoolSize: 0,
		});

		// Open a data channel for chatting with the peer. Both this client and
		// the peer will open a channel in negoatiated mode. The channel won't
		// actually be active until the remote accepts the offer and the ICE
		// process has started.
		const channel = peerConnection.createDataChannel("chat", {
			negotiated: true,
			id: 0,
		});
		channel.onopen = () => {
			console.debug(`Opened data channel to ${peerId}`);
		};
		channel.onclose = () => {
			console.debug(`Closed data channel to ${peerId}`);
		};
		channel.onmessage = (event) => {
			const { data } = event;
			const message = JSON.parse(data) as ClientMessage;
			this.#handlePeerMessage(peer, message);
		};

		this.#peerConnection = {
			peer,
			connection: peerConnection,
			channel,
			iceCandidates: [],
		};
		console.debug(`Created peer connection for ${peerId}`);

		// Add a listener to handle an incoming video stream from the remote
		// peer. This won't fire until the remote accepts the connection and
		// the ICE process has started
		peerConnection.ontrack = (event) => {
			console.debug("Received remote stream");
			this.#emit("peerconnected", {
				stream: event.streams[0],
				peer,
			});
		};

		for (const track of this.#stream.getTracks()) {
			peerConnection.addTrack(track, this.#stream);
			console.debug("Added local stream track to peer connection");
		}

		peerConnection.onconnectionstatechange = () => {
			switch (peerConnection.connectionState) {
				case "disconnected":
				case "failed":
					this.#closeConnection();
					break;
			}
		};

		return peerConnection;
	}

	/**
	 * Set the remote description for an RTCPeerConnection in the process of
	 * being opened.
	 */
	async #setRemoteDescription(answerOrOffer: Answer | Offer): Promise<void> {
		const {
			peer: { id: peerId },
			connection,
			iceCandidates,
		} = this.#getPeerConnection();
		if (peerId !== answerOrOffer.source) {
			throw new Error("Answer or offer doesn't match pending peer connection");
		}

		await connection.setRemoteDescription(answerOrOffer);

		// If we have any ICE candidates queued up, now is the time to add them
		// to the peer connection
		while (iceCandidates && iceCandidates.length > 0) {
			const candidate = iceCandidates.shift();
			try {
				await connection.addIceCandidate(candidate);
			} catch (error) {
				console.warn(`Error adding ICE candidate ${candidate}: ${error}`);
			}
		}
	}

	/**
	 * Emit an RTC event
	 */
	#emit<T extends RtcEventName>(
		eventName: T,
		data?: T extends NonDataRtcEventName ? never : RtcEvent[T]
	): void {
		this.#listeners.get(eventName)?.forEach((listener) => listener(data));
	}

	/**
	 * Handle an incoming message from the signal server
	 */
	async #handleServerMessage(
		message: RtcMessage | PeerMessage | ReadyMessage
	): Promise<void> {
		console.debug(`Received [${message.type}]`, message);

		try {
			switch (message.type) {
				// A potential peer has become available or unavailable, or a name
				// has changed
				case "peer":
					if (message.data.remove) {
						this.#peers.delete(message.data.id);
						this.#emit("peerremoved", message.data);
					} else {
						const event = this.#peers.has(message.data.id)
							? "peerupdated"
							: "peeradded";
						this.#peers.set(message.data.id, message.data);
						this.#emit(event, message.data);
					}
					break;

				// A peer has offered to connect to this client
				case "offer":
					this.#emit("offer", message.data);
					break;

				// A peer has accepted a connection offer made by this client
				case "accept":
					this.#connectToPeer(message.data);
					break;

				// A peer has rejected a connection offer made by this client
				case "reject":
					this.#closeConnection();
					break;

				// A peer has sent an ICE candidate
				case "icecandidate":
					await this.#addIceCandidate(message.data);
					break;

				// This client has connected to the signal server
				case "ready":
					if (this.#version && this.#version !== message.version) {
						// reload the page if the server version is different from
						// what this client was initialized with
						location.reload();
						return;
					} else if (!this.#version) {
						this.#version = message.version;
					}

					this.#id = message.id;

					// Let the signal sever know what ID and display name this
					// client is using. IDs must be globally unique. They're locally
					// generated for simplicity.
					this.#sendToSignalServer({
						type: "identify",
						data: {
							id: this.#id,
							name: this.#name,
						},
					});
					break;
			}
		} catch (error) {
			console.warn(error);
		}
	}

	/**
	 * Handle an incoming message from a connected peer
	 */
	#handlePeerMessage(peer: Peer, message: ClientMessage): void {
		switch (message.type) {
			case "chat":
				this.#emit("chat", {
					peer,
					message: message.data,
				});
				break;
			case "disconnect":
				this.#closeConnection();
				break;
		}
	}

	/**
	 * Attempt to reconnect to the signal server
	 */
	#reconnectToSignalServer(): void {
		clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = setTimeout(() => {
			if (this.#socket) {
				return;
			}

			console.debug("Attempting reconnect...");
			this.#connectToSignalServer();
		}, 1000);
	}

	/**
	 * Send a message to the signal server
	 */
	#sendToSignalServer(message: RtcMessage): void {
		if (!this.#socket) {
			throw new Error("Client is not connected");
		}
		this.#socket.send(JSON.stringify(message));
		console.debug(`Sent [${message.type}]`, message);
	}

	/**
	 * Send a message to a connected peer over a data channel
	 */
	#sendToPeer(message: ClientMessage): void {
		const {
			channel,
			peer: { id: peerId },
		} = this.#getPeerConnection();

		if (channel.readyState === "open") {
			channel.send(JSON.stringify(message));
			console.debug(`Sent [${message.type}] to ${peerId}`, message);
		} else {
			console.warn(
				`Not sending message to ${peerId} because channel isn't ready`
			);
		}
	}
}
