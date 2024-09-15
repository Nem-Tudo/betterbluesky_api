require("dotenv").config();

const {
	ComAtprotoSyncSubscribeRepos,
	subscribeRepos,
} = require("atproto-firehose");
const mongoose = require("mongoose");

// The database is divided into two: The one that stores the words of all posts and the one that stores information from BetterBluesky. If everyone goes to the same bank, it causes slowdowns.
const database_words = mongoose.createConnection(process.env.MONGODB_WORDS);
const database = mongoose.createConnection(process.env.MONGODB);

const express = require("express");

const app = express();
const cors = require("cors");

const jwt = require("jsonwebtoken")

app.use(
	cors({
		origin: "*",
	}),
);

const WordSchema = database_words.model(
	"Word",
	new mongoose.Schema({
		t: {
			//texto
			type: String,
			required: true,
		},
		ty: {
			//tipo (w = word, h = hashtag)
			type: String,
			required: true,
		},
		l: {
			//languages
			type: String,
			required: true,
		},
		ca: {
			//created at
			type: Date,
			immutable: true,
			default: () => new Date(),
		},
	}),
);

const PollSchema = database.model(
	"Poll",
	new mongoose.Schema({
		id: {
			type: String,
			unique: true,
			required: true,
		},
		authorDid: {
			type: String,
			required: true,
		},
		title: {
			type: String,
			required: true,
			minLength: 1,
			maxLength: 32,
		},
		options: [
			{
				text: {
					type: String,
					minLength: 1,
					maxLength: 32,
				},
				voteCount: {
					type: Number,
					default: 0,
				},
			},
		],
		createdAt: {
			//created at
			type: Date,
			immutable: true,
			default: () => new Date(),
		},
	}).set("toObject", {
		transform: (doc, ret, options) => {
			delete ret._id;
			delete ret.__v;
			return ret;
		},
	}),
);

const PollVoteSchema = database.model(
	"PollVote",
	new mongoose.Schema({
		pollId: {
			type: String,
			required: true,
		},
		userdid: {
			type: String,
			required: true,
		},
		option: {
			//position in options array
			type: Number,
			required: true,
		},
		createdAt: {
			//created at
			type: Date,
			immutable: true,
			default: () => new Date(),
		},
	}).set("toObject", {
		transform: (doc, ret, options) => {
			delete ret._id;
			delete ret.__v;
			return ret;
		},
	}),
);

const BookmarkSchema = database.model(
	"Bookmark",
	new mongoose.Schema({
		postaturi: {
			type: String,
			required: true,
		},
		userdid: {
			type: String,
			required: true,
		},
		postuserdid: {
			type: String,
			required: true
		},
		postid: {
			type: String,
			required: true
		},
		enabled: {
			type: Boolean,
			default: true
		},
		createdAt: {
			//created at
			type: Date,
			immutable: true,
			default: () => new Date(),
		},
	}).set("toObject", {
		transform: (doc, ret, options) => {
			delete ret._id;
			delete ret.__v;
			return ret;
		},
	}),
);

const TokenSchema = database.model(
	"Token",
	new mongoose.Schema({
		//usado para acessar funções de admin
		token: {
			type: String,
			required: true,
		},
		name: {
			type: String, //nome do token
		},
		permissions: {
			type: String,
			required: true,
		},
		createdAt: {
			type: Date,
			immutable: true,
			default: () => new Date(),
		},
	}),
);

const UserSchema = database.model(
	"User",
	new mongoose.Schema({
		h: {
			//handle
			type: String,
			required: true,
		},
		d: {
			//did
			type: String,
			required: true,
		},
		s: {
			//BetterBluesky last SessionID
			type: String,
			required: true,
		},
		ss: [
			{
				//BetterBluesky all SessionID's
				type: String,
			},
		],
		ll: {
			//last login
			type: Date,
			default: () => new Date(),
		},
		ca: {
			//created at
			type: Date,
			immutable: true,
			default: () => new Date(),
		},
	}),
);

const SettingsSchema = database.model(
	"Setting",
	new mongoose.Schema({
		blacklist: {
			trends: {
				type: Array,
				default: [],
			},
			words: {
				type: Array,
				default: [],
			},
			users: {
				type: Array,
				default: [],
			},
		},
		pinWord: {
			enabled: {
				type: Boolean,
				default: false,
			},
			word: {
				type: String,
			},
			count: {
				type: Number,
			},
			message: {
				type: String,
			},
			position: {
				type: Number,
			},
		},
		trendsMessages: [
			{
				//se a palavra está nos trends, adiciona uma mensagem nela
				word: {
					type: String,
				},
				message: {
					type: String,
				},
			},
		],
		config: {},
	}),
);

const cache = {
	trending: {
		head: {
			time: 0,
			length: 0,
		},
		data: [],
	},
	stats: {
		last30sSessions: new Map(),
		last30sSessionsCountStore: 0,
	},
	settings: {
		blacklist: {
			trends: [],
			words: [],
			users: [],
		},
		pinWord: {
			enabled: false,
			word: "",
			count: 0,
			position: 0,
		},
		trendsMessages: [],
		config: {},
	},
};

const client = subscribeRepos("wss://bsky.network", { decodeRepoOps: true });

client.on("message", (message) => {
	if (ComAtprotoSyncSubscribeRepos.isCommit(message)) {
		message.ops.forEach(async (op) => {
			if (!op?.payload) return;
			if (op.payload["$type"] !== "app.bsky.feed.post") return;
			if (!op.payload.langs?.includes("pt")) return; //apenas em portugues

			const text = op.payload.text.trim();

			const posthashtags = getHashtags(text);
			const postwords = [
				...new Set(
					text
						.trim()
						.split(" ")
						.filter(
							(word) =>
								word.length > 2 && word.length < 64 && !word.startsWith("#"),
						),
				),
			];

			for (const hashtag of posthashtags) {
				if (hashtag.length > 2) {
					if (
						cache.settings.blacklist.trends
							.map((t) => t.toLowerCase())
							.includes(hashtag.toLowerCase())
					)
						return;
					if (
						cache.settings.blacklist.words.find((w) =>
							hashtag.toLowerCase().includes(w.toLowerCase()),
						)
					)
						return;
					await WordSchema.create({
						t: hashtag,
						ty: "h",
						l: op.payload.langs.join(" "),
					});
				}
			}

			for (const word of postwords) {
				if (
					cache.settings.blacklist.trends
						.map((t) => t.toLowerCase())
						.includes(word.toLowerCase())
				)
					return;
				if (
					cache.settings.blacklist.words.find((w) =>
						word.toLowerCase().includes(w.toLowerCase()),
					)
				)
					return;
				await WordSchema.create({
					t: word.toLowerCase(),
					ty: "w",
					l: op.payload.langs.join(" "),
				});
			}
		});
	}
});

updateCacheSettings();
async function updateCacheSettings() {
	const settings =
		(await SettingsSchema.findOne({})) || (await SettingsSchema.create({}));
	cache.settings.blacklist = settings.blacklist;
	cache.settings.pinWord = settings.pinWord;
	cache.settings.config = settings.config;
	cache.settings.trendsMessages = settings.trendsMessages;
}

async function updateCacheTrending() {
	cache.trending.data = await getTrending(15, 6);
	cache.trending.head.time = Date.now();
	cache.trending.head.length = cache.trending.data.length;
	console.log(
		`=============================== Cache atualizado (${Date.now()}) ===============================`,
	);
	console.log(cache.trending);
}

setInterval(async () => {
	await updateCacheSettings();
	updateCacheTrending();
}, 29 * 1000);

setTimeout(
	() => {
		deleteOlds(3, 1000 * 60 * 60 * 1);
	},
	1000 * 60 * 60 * 1,
);

//log stats
setInterval(() => {
	console.log(`Sessões últimos 30s: ${cache.stats.last30sSessions.size}`);
	cache.stats.last30sSessionsCountStore = cache.stats.last30sSessions.size;
	cache.stats.last30sSessions = new Map();
}, 1000 * 30);

async function deleteOlds(hours, loopTimer) {
	//apaga as words antes de x horas
	console.log(`Apagando documentos de antes de horas: ${hours}`);
	const hoursAgo = new Date(Date.now() - hours * 60 * 60 * 1000); // Data e hora de x horas atrás

	const result = await WordSchema.deleteMany({ ca: { $lt: hoursAgo } });

	console.log(
		"-----------------------------------------------------------------------",
	);
	console.log(`Removed before ${hours}h: ${result.deletedCount}`);
	console.log(
		"-----------------------------------------------------------------------",
	);
	setTimeout(() => {
		deleteOlds(3, 1000 * 60 * 60 * 1);
	}, loopTimer);
}

function getHashtags(texto) {
	const regex = /#([\wÀ-ÖØ-öø-ÿ]+)/g;
	return texto.match(regex) || [];
}

let hasSendSomeTrending = false;

app.post("/api/polls", async (req, res) => {
	const sessionID = req.query.sessionID;

	if (!sessionID)
		return res.status(400).json({ message: "sessionID is required" });
	if (typeof sessionID !== "string")
		return res.status(400).json({ message: "sessionID must be an string" });

	const polldatastring = req.query.polldata;

	if (!polldatastring)
		return res.status(400).json({ message: "polldata is required" });
	if (typeof polldatastring !== "string")
		return res.status(400).json({ message: "polldata must be an string" });

	let polldata = null;

	try {
		polldata = JSON.parse(decodeURIComponent(polldatastring));
	} catch (e) {
		return res.status(400).json({ message: "polldata must be an json string" });
	}

	if (!polldata) return;

	if (!polldata.title || typeof polldata.title !== "string")
		return res
			.status(400)
			.json({ message: "polldata.title must be an string" });
	if (polldata.title.length < 1 || polldata.title.length > 32)
		return res
			.status(400)
			.json({ message: "polldata.title must be between 1 and 32 characters" });

	if (!polldata.options || !Array.isArray(polldata.options))
		return res
			.status(400)
			.json({ message: "polldata.options must be an array" });

	if (polldata.options.length < 1 || polldata.options.length > 5)
		return res
			.status(400)
			.json({ message: "polldata.options must be between 1 and 5 itens" });

	if (polldata.options.some((option) => typeof option !== "string"))
		return res
			.status(400)
			.json({ message: "polldata.options.* must be an string" });
	if (
		polldata.options.some((option) => option.length < 1 || option.length > 32)
	)
		return res.status(400).json({
			message: "polldata.options.* must be between 1 and 32 characters",
		});

	try {
		const user = await UserSchema.findOne({ ss: sessionID });
		if (!user) return res.status(403).json({ message: "Invalid SessionID" });

		const pollid = `${Date.now()}${randomString(3, false)}`;

		const poll = await PollSchema.create({
			id: pollid,
			authorDid: user.d,
			title: polldata.title,
			options: polldata.options.map((string) => {
				return { text: string };
			}),
		});

		return res.json(poll.toObject());
	} catch (e) {
		console.log("poll create", e);
		res.status(500).json({ message: "Internal Server Error" });
	}
});

app.get("/api/polls/:pollId", async (req, res) => {
	const sessionID = req.query.sessionID;

	if (!sessionID)
		return res.status(400).json({ message: "sessionID is required" });
	if (typeof sessionID !== "string")
		return res.status(400).json({ message: "sessionID must be an string" });

	const pollID = req.params.pollId;

	if (!pollID) return res.status(400).json({ message: "id is required" });
	if (typeof pollID !== "string")
		return res.status(400).json({ message: "id must be an string" });

	const poll = await PollSchema.findOne({ id: pollID });

	if (!poll) return res.status(404).json({ message: "poll not found" });

	const pollObject = poll.toObject();

	const user = await UserSchema.findOne({ ss: sessionID });

	const userPollVote = user
		? await PollVoteSchema.findOne({ pollId: poll.id, userdid: user.d })
		: null;

	pollObject.voted = !!userPollVote;

	pollObject.options.forEach((option, index) => {
		option.selected = userPollVote ? userPollVote.option === index : false;
	});

	return res.json(pollObject);
});

app.post("/api/polls/:pollId/votes", async (req, res) => {
	const sessionID = req.query.sessionID;

	if (!sessionID)
		return res.status(400).json({ message: "sessionID is required" });
	if (typeof sessionID !== "string")
		return res.status(400).json({ message: "sessionID must be an string" });

	const pollid = req.params.pollId;

	if (!pollid) return res.status(400).json({ message: "pollid is required" });
	if (typeof pollid !== "string")
		return res.status(400).json({ message: "pollid must be an string" });

	const option = Number(req.query.option);

	if (Number.isNaN(option))
		return res.status(400).json({ message: "option must be an number" });

	const user = await UserSchema.findOne({ ss: sessionID });
	if (!user) return res.status(403).json({ message: "Invalid SessionID" });

	const poll = await PollSchema.findOne({ id: pollid });
	if (!poll) return res.status(404).json({ message: "Poll not found" });

	if (option > poll.options.length)
		return res.status(400).json({ message: "Invalid option" });

	const existPollVote = await PollVoteSchema.findOne({
		pollId: pollid,
		userdid: user.d,
	});

	if (existPollVote) return res.json(existPollVote.toObject());

	const pollVote = await PollVoteSchema.create({
		pollId: pollid,
		userdid: user.d,
		option: option,
	});

	poll.options[option].voteCount++;
	poll.save();

	res.json(pollVote.toObject());
});

app.post("/api/bookmarks", async (req, res) => {
	try {
		const sessionID = req.query.sessionID;

		if (!sessionID)
			return res.status(400).json({ message: "sessionID is required" });
		if (typeof sessionID !== "string")
			return res.status(400).json({ message: "sessionID must be an string" });

		const postid = decodeURIComponent(req.query.postid);

		if (!postid) return res.status(400).json({ message: "postid is required" });
		if (typeof postid !== "string") return res.status(400).json({ message: "postid must be an string" });

		const postuserhandle = decodeURIComponent(req.query.postuserhandle);

		if (!postuserhandle) return res.status(400).json({ message: "postuserhandle is required" });
		if (typeof postuserhandle !== "string") return res.status(400).json({ message: "postuserhandle must be an string" });

		const { did: postuserdid } = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${postuserhandle}`).then(r => r.json())
		const user = await UserSchema.findOne({ ss: sessionID });
		if (!user) return res.status(403).json({ message: "Invalid SessionID" });

		const existBookmark = await BookmarkSchema.findOne({ postid: postid, postuserdid: postuserdid, userdid: user.d });
		if (existBookmark) {
			existBookmark.enabled = true;
			await existBookmark.save()
			return res.json(existBookmark.toObject());
		}

		const bookmark = await BookmarkSchema.create({ postaturi: `at://${postuserdid}/app.bsky.feed.post/${postid}`, postid: postid, postuserdid: postuserdid, userdid: user.d });
		return res.json(bookmark);
	} catch (e) {
		console.log(e);
		res.status(500).json({ message: "Internal Server Error" })
	}
});

app.delete("/api/bookmarks", async (req, res) => {
	try {
		const sessionID = req.query.sessionID;

		if (!sessionID)
			return res.status(400).json({ message: "sessionID is required" });
		if (typeof sessionID !== "string")
			return res.status(400).json({ message: "sessionID must be an string" });

		const postid = decodeURIComponent(req.query.postid);

		if (!postid) return res.status(400).json({ message: "postid is required" });
		if (typeof postid !== "string") return res.status(400).json({ message: "postid must be an string" });

		const user = await UserSchema.findOne({ ss: sessionID });
		if (!user) return res.status(403).json({ message: "Invalid SessionID" });

		await BookmarkSchema.findOneAndUpdate({ postid: postid, userdid: user.d }, { enabled: false });
		return res.json({ success: true });
	} catch (e) {
		console.log(e);
		res.status(500).json({ message: "Internal Server Error" })
	}
});

app.get("/api/bookmarks", async (req, res) => {
	const sessionID = req.query.sessionID;

	if (!sessionID)
		return res.status(400).json({ message: "sessionID is required" });
	if (typeof sessionID !== "string")
		return res.status(400).json({ message: "sessionID must be an string" });

	const postid = decodeURIComponent(req.query.postid);

	if (!postid) return res.status(400).json({ message: "postid is required" });
	if (typeof postid !== "string") return res.status(400).json({ message: "postid must be an string" });

	const user = await UserSchema.findOne({ ss: sessionID });
	if (!user) return res.status(403).json({ message: "Invalid SessionID" });

	const bookmark = await BookmarkSchema.exists({ postid: postid, userdid: user.d, enabled: true });
	res.json({ exists: bookmark });
});

app.get("/api/users/:userdid/bookmarks", async (req, res) => {
	const tokenstring = req.headers.authorization;
	if (!tokenstring)
		return res.status(401).json({ message: "Token is required" });

	const token = await TokenSchema.findOne({ token: tokenstring });
	if (!token) return res.status(401).json({ message: "Unauthorized" });

	if (!token.permissions.includes("*")) {
		if (!token.permissions.includes("bookmarks.view")) //used in feed integration
			return res.status(403).json({ message: "Missing permissions" });
	}

	const user = await UserSchema.findOne({ d: req.params.userdid });
	if (!user) return res.status(404).json({ message: "User not found" });

	const bookmarks = await BookmarkSchema.find({ userdid: user.d, enabled: true });
	res.json(bookmarks.map(bk => { return { post: bk.postaturi } }));
})


app.get("/api/trends", (req, res) => {
	res.json(cache.trending);
	if (req.query.sessionID)
		cache.stats.last30sSessions.set(req.query.sessionID, req.query.updateCount);

	//Gambiarra gigante para reinciar o app quando houver o erro misterioso de começar a retornar array vazia nos trends (Me ajude e achar!)
	if (cache.trending.data.length > 0) hasSendSomeTrending = true;
	if (hasSendSomeTrending && cache.trending.data.length === 0) process.exit(1);
});

app.get("/api/blacklist", async (req, res) => {
	const tokenstring = req.headers.authorization;
	if (!tokenstring)
		return res.status(401).json({ message: "Token is required" });

	const token = await TokenSchema.findOne({ token: tokenstring });
	if (!token) return res.status(401).json({ message: "Unauthorized" });

	if (!token.permissions.includes("*")) {
		if (!token.permissions.includes("blacklist.manage"))
			return res.status(403).json({ message: "Missing permissions" });
	}

	console.log(`${Date.now()} /api/blacklist`);
	const settings = await SettingsSchema.findOne({});

	return res.json(settings.blacklist);
});

// redundância enquanto a extensão não atualiza para todos

app.post("/api/users", async (req, res) => {
	try {
		const sessionID = req.query.sessionID;

		if (!sessionID)
			return res.status(400).json({ message: "sessionID is required" });
		if (typeof sessionID !== "string")
			return res.status(400).json({ message: "sessionID must be an string" });

		const handle = req.query.handle;

		if (!handle) return res.status(400).json({ message: "handle is required" });
		if (typeof handle !== "string")
			return res.status(400).json({ message: "handle must be an string" });

		const did = req.query.did;

		if (!did) return res.status(400).json({ message: "did is required" });
		if (typeof did !== "string")
			return res.status(400).json({ message: "did must be an string" });

		const existUser = await UserSchema.findOne({ h: handle, d: did });

		if (existUser) {
			existUser.ll = Date.now();
			existUser.s = sessionID;
			existUser.ss.push(sessionID);
			await existUser.save();
			return res.json({ message: "updated" });
		}

		await UserSchema.create({
			//salva os usuários que utilizam a extensão para futuras atualizações
			h: handle,
			d: did,
			s: sessionID,
			ss: [sessionID],
		});

		return res.json({ message: "created" });
	} catch (e) {
		console.log(e);
		res.status(500).json({ message: "Internal Server Error" });
	}
});

app.get("/api/trendsmessages", async (req, res) => {
	console.log(`${Date.now()} /api/trendsmessages`);
	const settings = await SettingsSchema.findOne({});

	return res.json(settings.trendsMessages);
});

app.get("/api/stats", async (req, res) => {
	const userscount = await UserSchema.countDocuments({});
	return res.json({
		last30sonline: cache.stats.last30sSessionsCountStore,
		userscount,
	});
});

app.put("/api/admin/trendsmessages", async (req, res) => {
	const tokenstring = req.headers.authorization;
	if (!tokenstring)
		return res.status(401).json({ message: "Token is required" });

	const token = await TokenSchema.findOne({ token: tokenstring });
	if (!token) return res.status(401).json({ message: "Unauthorized" });

	if (!token.permissions.includes("*")) {
		if (!token.permissions.includes("trendsmessages.manage"))
			return res.status(403).json({ message: "Missing permissions" });
	}
	const settings = await SettingsSchema.findOne({});

	try {
		const trendsmessages = JSON.parse(
			decodeURIComponent(req.query.trendsmessages),
		);
		settings.trendsMessages = trendsmessages;
		await settings.save();
		return res.json(settings.trendsMessages);
	} catch (e) {
		console.log(e);
		res.status(500).json({ message: "Internal Server Error" });
	}
});

app.put("/api/admin/blacklist", async (req, res) => {
	const tokenstring = req.headers.authorization;
	if (!tokenstring)
		return res.status(401).json({ message: "Token is required" });

	const token = await TokenSchema.findOne({ token: tokenstring });
	if (!token) return res.status(401).json({ message: "Unauthorized" });

	if (!token.permissions.includes("*")) {
		if (!token.permissions.includes("blacklist.manage"))
			return res.status(403).json({ message: "Missing permissions" });
	}
	const settings = await SettingsSchema.findOne({});

	try {
		const blacklist = JSON.parse(decodeURIComponent(req.query.blacklist));
		settings.blacklist = blacklist;
		await settings.save();
		return res.json(settings.blacklist);
	} catch (e) {
		console.log(e);
		res.status(500).json({ message: "Internal Server Error" });
	}
});

// xrpc
app.get("/xrpc/app.bsky.feed.getFeedSkeleton", async (req, res) => {

	try {
		if (req.query.feed == "at://did:plc:xy3lxva6bqrph3avrvhzck7q/app.bsky.feed.generator/bookmarks") {
			if (!req.headers.authorization) return res.status(401).json({ message: "Unauthorized" })

			// const authorization = verifyJWT(req.headers.authorization.replace('Bearer ', '').trim(), process.env.FEED_KEY);

			//TEMP
			const authorization = { error: false, data: JSON.parse(atob(req.headers.authorization.split(".")[1])) }
			//---------------------

			if (authorization.error) return res.status(401).json({ message: "Unauthorized" })

			const user = await UserSchema.findOne({ d: String(authorization.data.iss) });
			if (!user) return res.status(404).json({ message: "User not found" });

			const bookmarks = await BookmarkSchema.find({ userdid: user.d, enabled: true });

			if (bookmarks.length === 0) {
				return res.json(
					{
						cursor: `${Date.now()}_${randomString(5, false)}`,
						feed: [{ post: "at://did:plc:xy3lxva6bqrph3avrvhzck7q/app.bsky.feed.post/3l45rnoev4q2d" }]
					}
				)
			}


			return res.json(
				{
					cursor: `${Date.now()}_${randomString(5, false)}`,
					feed: bookmarks.map(bookmark => { return { post: bookmark.postaturi } })
				}
			)
		}

		return res.status(404).json({ message: "Feed not found" });
	} catch (e) {
		res.status(500).json({ message: "Internal Server Error" })
	}

})

app.get("/xrpc/app.bsky.feed.describeFeedGenerator", (req, res) => {
	res.json({
		"did": "did:web:betterbluesky.nemtudo.me",
		"feeds": [
			{
				"uri": "at://did:plc:xy3lxva6bqrph3avrvhzck7q/app.bsky.feed/bookmarks",
				"title": "Itens Salvos",
				"description": "Itens salvos da extensão BetterBluesky. Instale: https://nemtudo.me/betterbluesky",
				"author": "nemtudo.me"
			}
		]
	})
})

app.get("/.well-known/did.json", (req, res) => {
	return res.json({
		"@context": [
			"https://www.w3.org/ns/did/v1"
		],
		"id": "did:web:betterbluesky.nemtudo.me",
		"service": [
			{
				"id": "#bsky_fg",
				"type": "BskyFeedGenerator",
				"serviceEndpoint": "https://betterbluesky.nemtudo.me"
			}
		]
	})
})

app.get("*", (req, res) => {
	res.status(404).send({ message: "Route not found" });
});

app.post("*", (req, res) => {
	res.status(404).send({ message: "Route not found" });
});

app.listen(process.env.PORT, () => {
	console.log(`Aplicativo iniciado em ${process.env.PORT}`);
	updateCacheSettings();
	// deleteOlds(3)
});

function verifyJWT(token, key) {
	try {
		const decoded = jwt.verify(token, key, { algorithms: ["ES256K"] });
		return {
			error: false,
			data: decoded
		}
	} catch (err) {
		return {
			error: true,
			err: err
		}
	}

}

async function getTrending(hourlimit, recentlimit) {
	const hourwords = await getTrendingType(hourlimit, "w", 1.5 * 60 * 60 * 1000);
	const hourhashtags = await getTrendingType(
		hourlimit,
		"h",
		1.5 * 60 * 60 * 1000,
	);

	const recentwords = await getTrendingType(10, "w", 10 * 60 * 1000);
	const recenthashtags = await getTrendingType(10, "h", 10 * 60 * 1000);

	const _hourtrends = mergeArray(hourhashtags, hourwords);
	const _recenttrends = mergeArray(recenthashtags, recentwords);

	const hourtrends = removeDuplicatedTrends(_hourtrends).slice(0, hourlimit);
	const recenttrends = removeDuplicatedTrends(_recenttrends)
		.filter(
			(rt) =>
				!hourtrends.find((t) => t.text.toLowerCase() === rt.text.toLowerCase()),
		)
		.slice(0, recentlimit);

	const trends = removeDuplicatedTrends([...hourtrends, ...recenttrends]);

	trends.forEach((trend) => {
		if (
			cache.settings.trendsMessages.find(
				(t) => t.word.toLowerCase() === trend.text.toLowerCase(),
			)
		) {
			trend.message = cache.settings.trendsMessages.find(
				(t) => t.word.toLowerCase() === trend.text.toLowerCase(),
			).message;
		}
	});

	if (cache.settings.pinWord.enabled) {
		trends.splice(cache.settings.pinWord.position, 0, {
			text: cache.settings.pinWord.word,
			count: cache.settings.pinWord.count,
			timefilter: 0,
			message: cache.settings.pinWord.message,
		});
		console.log(
			`PINNED WORD: [${cache.settings.pinWord.position}] ${cache.settings.pinWord.word} (${cache.settings.pinWord.count})`,
		);
	}

	return trends;
}

async function getTrendingType(limit, type, time) {
	try {
		const hoursAgo = new Date(Date.now() - time); // Data e hora de x horas atrás

		const result = await WordSchema.aggregate([
			{
				$match: {
					ca: { $gte: hoursAgo }, // Filtra documentos criados nos últimos x horas
					ty: type,
				},
			},
			{
				$group: {
					_id: "$t", // Agrupar por palavra
					count: { $sum: 1 }, // Contar o número de ocorrências
				},
			},
			{
				$sort: { count: -1 }, // Ordenar por contagem em ordem decrescente
			},
			{
				$limit: limit + 9, // Limitar o resultado para as palavra mais frequente
			},
		]);

		return result
			.filter(
				(obj) =>
					!cache.settings.blacklist.trends
						.map((t) => t.toLowerCase())
						.includes(obj._id.toLowerCase()) &&
					!cache.settings.blacklist.words.find((word) =>
						obj._id.toLowerCase().includes(word.toLowerCase()),
					),
			)
			.map((obj) => {
				return { text: obj._id, count: obj.count, timefilter: time };
			})
			.slice(0, limit);
	} catch (e) {
		console.log("getTrending", e);
	}
}

function removeDuplicatedTrends(trends) {
	const wordMap = new Map();

	trends.forEach(({ text, count, timefilter }) => {
		const lowerCaseText = text
			.toLowerCase()
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "");

		if (wordMap.has(lowerCaseText)) {
			wordMap.set(lowerCaseText, {
				text: wordMap.get(lowerCaseText).text,
				count: wordMap.get(lowerCaseText).count + count,
				timefilter: wordMap.get(lowerCaseText).timefilter,
			});
		} else {
			wordMap.set(lowerCaseText, { text, count, timefilter });
		}
	});

	return Array.from(wordMap.values());
}

function mergeArray(arrayA, arrayB) {
	const result = [];
	const maxLength = Math.max(arrayA.length, arrayB.length);

	for (let i = 0; i < maxLength; i++) {
		if (i < arrayA.length) {
			result.push(arrayA[i]);
		}
		if (i < arrayB.length) {
			result.push(arrayB[i]);
		}
	}

	return result;
}

function randomString(length, uppercases = true) {
	let result = "";
	const characters = uppercases
		? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
		: "abcdefghijklmnopqrstuvwxyz0123456789";
	const charactersLength = characters.length;
	let counter = 0;
	while (counter < length) {
		result += characters.charAt(Math.floor(Math.random() * charactersLength));
		counter += 1;
	}
	return result;
}
