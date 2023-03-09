import { WebRTCClient } from "./rtc.js";
import type { Offer, Peer } from "../types";

type State = {
	id: string;
	name: string;
	audio: boolean;
	camera?: string;
};

const stateKey = "rtc-state";

let client: WebRTCClient;

/**
 * Set a data attribute on the main element
 */
function setMainData(name: string, value: string): void {
	getElement("main").setAttribute(`data-${name}`, value);
}

/**
 * Load app state from local storage
 */
function loadState(): State {
	let stateStr = localStorage.getItem(stateKey);
	if (!stateStr) {
		const state = {
			name: "Anonymous",
			audio: true,
		};
		stateStr = JSON.stringify(state);
		localStorage.setItem(stateKey, stateStr);
	}
	return JSON.parse(stateStr) as State;
}

/**
 * Update stored app state
 */
function updateState(newState: Partial<State>): void {
	const state = loadState();
	if (newState.name) {
		client.name = newState.name;
	}
	const updatedState = { ...state, ...newState };
	localStorage.setItem(stateKey, JSON.stringify(updatedState));

	if (state.camera !== newState.camera || state.audio !== newState.audio) {
		updateCameraStream();
	}
}

/**
 * Return an element, which must exist.
 */
function getElement<T extends HTMLElement>(selector: string): T {
	const elem = document.querySelector(selector) as T;
	if (!elem) {
		throw new Error(`Element not found: ${selector}`);
	}
	return elem;
}

/**
 * Update the local camera stream
 */
async function updateCameraStream(): Promise<void> {
	setMainData("camera", "attaching");
	const state = loadState();

	// Detach the video stream before creating a new stream so the video
	// element doesn't flash when the original stream stops
	const userVideo = getElement<HTMLVideoElement>("#user-video");
	userVideo.srcObject = null;

	if (state.camera) {
		userVideo.srcObject = await client.openStream({
			cameraId: state.camera,
			audioDisabled: !state.audio,
		});
		setMainData("camera", "attached");
		getElement<HTMLSelectElement>("#peer").disabled = false;
	} else {
		client.closeStream();
		setMainData("camera", "");
		getElement<HTMLSelectElement>("#peer").disabled = true;
	}
}

/**
 * Setup a listener for the name input
 */
function initNameInput(): void {
	const state = loadState();
	const nameInput = getElement<HTMLInputElement>("#name");
	nameInput.value = state.name;
	nameInput.addEventListener("change", async () => {
		updateState({ name: nameInput.value });
	});
}

/**
 * Setup a listener for the camera selector
 */
async function initCameraSelect(): Promise<void> {
	const state = loadState();
	const cameras = await client.getCameras();
	const cameraSelect = getElement<HTMLSelectElement>("#camera");
	cameraSelect.innerHTML = '<option value="">Disabled</option>';

	for (const camera of cameras) {
		const opt = document.createElement("option");
		opt.value = camera.deviceId;
		opt.textContent = camera.label;
		if (camera.deviceId === state.camera) {
			opt.selected = true;
		}
		cameraSelect.append(opt);
	}

	cameraSelect.addEventListener("change", async () => {
		updateState({ camera: cameraSelect.value });
	});
}

/**
 * Setup a listener for the audio checkbox
 */
function initAudioCheckbox(): void {
	const state = loadState();
	const audioCheckbox = getElement<HTMLInputElement>("#audio");
	audioCheckbox.checked = state.audio;
	audioCheckbox.addEventListener("change", async () => {
		updateState({ audio: audioCheckbox.checked });
	});
}

/**
 * Setup a listener for the peer selector
 */
function initPeerSelect(): void {
	const peerSelect = getElement<HTMLSelectElement>("#peer");
	peerSelect.addEventListener("change", async () => {
		const peer = peerSelect.value;
		if (!peer) {
			return;
		}

		setMainData("peer", "connecting");
		client?.invite(peer);
	});
}

/**
 * Setup a listener for the disconnect button
 */
function initDisconnectButton(): void {
	const disconnect = getElement<HTMLButtonElement>("#disconnect");
	disconnect.addEventListener("click", () => {
		client.disconnect();
	});
}

/**
 * Add listener for chat input
 */
function initChatInput() {
	const input = getElement<HTMLInputElement>("#chat-input");
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			const message = input.value;
			client.sendChat(message);
			addChatMessage(message, undefined);
			input.value = "";
		}
	});
}

/**
 * The client has connected to the RTC server
 */
function handleConnected(): void {
	console.log("Connected to signal server");
}

/**
 * The client has disconnected from the RTC server
 */
function handleDisconnected(): void {
	console.log("Disconnected from signal server");
}

/**
 * Update the peer selector when a peer is added
 */
function handlePeerAdded(peer: Peer): void {
	const peerSelect = getElement<HTMLSelectElement>("#peer");
	const option = document.createElement("option");
	option.value = peer.id;
	option.textContent = peer.name;
	peerSelect.append(option);
}

/**
 * Update the peer selector when a peer is removed
 */
function handlePeerRemoved(peer: Peer): void {
	const peerSelect = getElement<HTMLSelectElement>("#peer");
	for (const option of peerSelect.options) {
		if (option.value === peer.id) {
			option.remove();
			break;
		}
	}
}

/**
 * Update the peer selector when a peer's name changes
 */
function handlePeerUpdated(peer: Peer): void {
	const peerSelect = getElement<HTMLSelectElement>("#peer");
	for (const option of peerSelect.options) {
		if (option.value === peer.id) {
			option.textContent = peer.name;
			break;
		}
	}
}

/**
 * Attach the peer video stream and enable chat when a peer connects
 */
function handlePeerConnected(event: { stream: MediaStream; peer: Peer }): void {
	setMainData("peer", "connected");

	const peerVideo = getElement<HTMLVideoElement>("#peer-video");
	peerVideo.srcObject = event.stream;

	getElement<HTMLInputElement>("#chat-input").disabled = false;
}

/**
 * Reset the peer video element and disable chat when a peer disconnects
 */
function handlePeerDisconnected(): void {
	const peerVideo = getElement<HTMLVideoElement>("#peer-video");
	peerVideo.srcObject = null;

	setMainData("peer", "");

	const peer = getElement<HTMLSelectElement>("#peer");
	peer.value = "";

	getElement<HTMLInputElement>("#chat-input").disabled = true;
}

/**
 * Confirm an offer from a peer
 */
function handleOffer(offer: Offer): void {
	const peer = client.getPeer(offer.source);
	if (confirm(`Accept offer from ${peer?.name ?? offer.source}?`)) {
		client.accept(offer);
	} else {
		client.reject(offer);
	}
}

/**
 * Add incoming chat messages to the message list
 */
function handleChat(data: { peer: Peer; message: string }): void {
	addChatMessage(data.message, data.peer);
}

/**
 * Add a chat message to the displayed message list
 */
function addChatMessage(message: string, peer: Peer | undefined) {
	const li = document.createElement("li");
	const from = document.createElement("span");
	from.textContent = peer ? peer.name : "Me";
	li.append(from);
	li.append(message);
	const chatList = getElement<HTMLUListElement>("#chat ul");
	chatList.append(li);
}

async function main() {
	const state = loadState();
	client = new WebRTCClient(state.name);

	client.on("connected", handleConnected);
	client.on("disconnected", handleDisconnected);
	client.on("peeradded", handlePeerAdded);
	client.on("peerremoved", handlePeerRemoved);
	client.on("peerupdated", handlePeerUpdated);
	client.on("peerconnected", handlePeerConnected);
	client.on("peerdisconnected", handlePeerDisconnected);
	client.on("offer", handleOffer);
	client.on("chat", handleChat);

	initChatInput();
	initNameInput();
	initAudioCheckbox();
	initPeerSelect();
	initDisconnectButton();
	await initCameraSelect();

	await updateCameraStream();

	setMainData("state", "ready");
	console.log('App is ready');
}

main().catch((err) => {
	console.error(err);
	alert(`Error starting app: ${err}`);
});
