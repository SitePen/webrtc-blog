import express from "express";
import { readFileSync } from "fs";
import https from "https";
import { hostname } from "os";
import { join } from "path";
import { createServer } from "./rtc.js";

const port = process.env.PORT || 3000;
const host = process.env.HOST || hostname();
const cert = process.env.CERT || "cert.pem";
const key = process.env.KEY || "key.pem";

const sslConfig = {
	key: readFileSync(key),
	cert: readFileSync(cert),
};

const app = express();

app.use(express.static(join(__dirname, "..", "public")));

const httpServer = https.createServer(sslConfig, app).listen(3000);

createServer(httpServer, "/rtc");

console.log(`Listening at https://${host}:${port}...`);
