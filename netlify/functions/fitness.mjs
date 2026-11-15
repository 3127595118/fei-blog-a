import { MongoClient } from "mongodb";

const DB_NAME = "fei_blog";
const COLLECTION = "fitness";
const DOC_ID = "fei";
const ALLOWED_ORIGINS = [
	"https://feimy.xyz",
	"https://www.feimy.xyz",
	"http://localhost:4321",
];

let clientPromise;

function getCollection() {
	if (!clientPromise) {
		const uri = process.env.MONGODB_URI;
		if (!uri) throw new Error("MONGODB_URI is not configured");
		clientPromise = new MongoClient(uri, {
			serverSelectionTimeoutMS: 8000,
		}).connect();
	}
	return clientPromise.then((client) =>
		client.db(DB_NAME).collection(COLLECTION),
	);
}

function corsHeaders(origin) {
	return {
		"Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
			? origin
			: ALLOWED_ORIGINS[0],
		"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, x-fitness-key",
		"Access-Control-Max-Age": "86400",
		Vary: "Origin",
	};
}

function json(statusCode, body, extraHeaders = {}) {
	return {
		statusCode,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...extraHeaders,
		},
		body: JSON.stringify(body),
	};
}

function readKey(event) {
	const headers = event.headers || {};
	return (
		headers["x-fitness-key"] ||
		headers["X-Fitness-Key"] ||
		event.queryStringParameters?.key ||
		""
	);
}

function emptyState() {
	return { checks: {}, items: {}, logs: [], weights: [] };
}

export const handler = async (event) => {
	const origin = event.headers?.origin || event.headers?.Origin || "";
	const cors = corsHeaders(origin);

	if (event.httpMethod === "OPTIONS") {
		return { statusCode: 204, headers: cors, body: "" };
	}

	const expected = process.env.FITNESS_KEY;
	if (!expected) {
		return json(500, { ok: false, error: "FITNESS_KEY not configured" }, cors);
	}
	if (readKey(event) !== expected) {
		return json(401, { ok: false, error: "unauthorized" }, cors);
	}

	try {
		const collection = await getCollection();

		if (event.httpMethod === "GET") {
			const doc = await collection.findOne({ _id: DOC_ID });
			return json(
				200,
				{
					ok: true,
					state: doc?.state || emptyState(),
					updatedAt: doc?.updatedAt || 0,
				},
				cors,
			);
		}

		if (event.httpMethod === "POST") {
			const raw = event.body || "{}";
			if (raw.length > 500_000) {
				return json(413, { ok: false, error: "payload too large" }, cors);
			}
			const parsed = JSON.parse(raw);
			const state = parsed?.state;
			if (!state || typeof state !== "object") {
				return json(400, { ok: false, error: "state is required" }, cors);
			}
			const updatedAt = Date.now();
			const clean = {
				checks: state.checks || {},
				items: state.items || {},
				logs: Array.isArray(state.logs) ? state.logs : [],
				weights: Array.isArray(state.weights) ? state.weights : [],
			};
			await collection.updateOne(
				{ _id: DOC_ID },
				{ $set: { state: clean, updatedAt } },
				{ upsert: true },
			);
			return json(200, { ok: true, updatedAt }, cors);
		}

		return json(405, { ok: false, error: "method not allowed" }, cors);
	} catch (error) {
		return json(
			500,
			{ ok: false, error: error?.message || "internal error" },
			cors,
		);
	}
};

export default handler;
