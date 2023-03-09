import { WebSocket, WebSocketServer } from "ws";
import { Peer, PeerMessage, ReadyMessage, RtcMessage } from "../types";
import type { Server as HttpServer } from "http";

// This is the signal server used to manage connections between peers.

function send(
	socket: WebSocket | undefined,
	message: RtcMessage | PeerMessage | ReadyMessage
): void {
	socket?.send(JSON.stringify(message));
}

export function createServer(
	httpServer: HttpServer,
	path: string
): WebSocketServer {
	const server = new WebSocketServer({ noServer: true });

	/**
	 * A notional "version" that lets a client know whether the server has been
	 * updated
	 */
	const version = `${Date.now()}`;

	/**
	 * A map of sockets to peer info.
	 */
	const connections = new Map<WebSocket, Peer>();

	/**
	 * Get the connection for a given client ID.
	 */
	function getConnection(clientId: string): WebSocket | undefined {
		for (const [socket, client] of connections.entries()) {
			if (client.id === clientId) {
				return socket;
			}
		}
		return;
	}

	/**
	 * Notify a client of a peer update.
	 */
	async function notifyClient(
		socket: WebSocket,
		client: Peer,
		other: Peer,
		remove?: boolean
	): Promise<void> {
		console.debug(
			`Notifying ${client.id} (${client.name}) that ${other.id} (${
				other.name
			}) ${remove ? "disconnected" : "became available"}`
		);

		send(socket, {
			type: "peer",
			data: {
				...other,
				remove,
			},
		});
	}

	/**
	 * Handle an incoming message.
	 */
	async function handleMessage(
		msg: RtcMessage,
		socket: WebSocket
	): Promise<void> {
		switch (msg.type) {
			// A peer is identifying itself or updating its name
			case "identify": {
				const client = msg.data;
				const notifications = [];

				// This is a new client -- tell it about any existing peers
				if (!connections.has(socket)) {
					console.log("New client: ", client);
					for (const peer of connections.values()) {
						notifications.push(notifyClient(socket, client, peer));
					}
				}

				// Announce the new/updated peer to everyone else
				for (const [psock, peer] of connections.entries()) {
					if (peer.id !== client.id) {
						notifications.push(notifyClient(psock, peer, client));
					}
				}

				await Promise.all(notifications);

				// Store / update the connection's peer data
				connections.set(socket, client);
				break;
			}

			// All other messages are relayed to the message target
			default:
				send(getConnection(msg.data.target), msg);
				break;
		}
	}

	// A client is attempting to connect to the WebSocket server
	httpServer.on("upgrade", async function (request, socket, head) {
		const { url } = request;
		if (url !== path) {
			console.warn(`Ignoring upgrade request for ${url}`);
			return;
		}

		server.handleUpgrade(request, socket, head, function (ws) {
			server.emit("connection", ws, request);
		});
	});

	server.on("connection", async (socket) => {
		// Handle an incoming message from the client
		socket.on("message", async (message) => {
			try {
				await handleMessage(JSON.parse(`${message}`), socket);
			} catch (error) {
				console.warn(`Error parsing message: ${error}`);
			}
		});

		// When the client connection closes, remove the client's peer info
		socket.on("close", async () => {
			const client = connections.get(socket);

			if (client) {
				console.debug(`${client.id} (${client.name}) disconnected`);
				connections.delete(socket);

				// Notify all connected clients that a client has disconnected
				for (const [sock, peer] of connections.entries()) {
					await notifyClient(sock, peer, client, true);
				}
			}
		});

		const id = crypto.randomUUID();

		send(socket, { type: "ready", version, id });
	});

	return server;
}
