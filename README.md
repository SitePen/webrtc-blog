# WebRTC Demo

## Getting started

1. Clone this repo
2. Install dependencies with `npm install`
3. Build the app with `npm run build`
4. Create an SSL key and cert and save them as `cert.pem` and `key.pem` in the
   repo. [mkcert](https://github.com/FiloSottile/mkcert) is great for this.
5. Start the RTC server with `npm start`

The server will display a URL that other devices on the local network can
connect to.

The server can be customized with several environment variables:

- `HOST`
- `PORT`
- `KEY`
- `CERT`

For example:

```
> PORT=3030 KEY=../ssl/key.pem CERT=../ssl/cert.pem npm start
```

## Architecture

```
repo/
  public/
  src/
    client/
    server/
```

This application is a single page app with server and client components. The
client has 2 major parts: the UI and the RTC interface. Similarly, the server
has 2 major parts: the base HTTP server and a WebSocket server to manage
RTC-related communications.

## Operation

### Initialization

The server component serves static files at `/` from `<repo>/public`, and serves
websocket connections at `/rtc`. When a client connects, they're served
`public/index.html`, which loads the `public/main.js` client script. The client
script loads its state from local storage and initializes various elements on
the app page. If the camera is enabled, the client will open a websocket
connection to the server.

When a client connects to the server over a websocket, the server sends it a
"ready" message that identifies the current server version (used for live
reloading). If the server version differs from what the client thinks it should
be, the client will reload, otherwise the client will identify itself with an ID
and display name.

Each time a client connects, the server will announce the new client to any
other connected clients ("peers"). Similarly, if a client updates its name, the
updated client data is announced to other connected clients.

### Connecting to a peer

When the user selects a peer, the client negoations a connection with the peer
using the following process:

1. The client opens an RTC connection to the peer and generates an RTC
   connection "offer". The offer is sent to the peer via the websocket server.
2. The peer receives the offer and asks its user whether the offer should be
   accepted.
3. If the peer user accepts the offer, the peer opens an RTC connection back to
   the client and generates an RTC connection "answer". The answer is sent to
   the client via the websocket server.
4. The client uses the answer to complete the RTC connection to the peer.

At this point, the client and peer are sending RTC streams to each other.
