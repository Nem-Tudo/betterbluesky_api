require("dotenv").config()

const { ComAtprotoSyncSubscribeRepos, SubscribeReposMessage, subscribeRepos } = require("atproto-firehose");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGODB);

const express = require("express");

const app = express();
const cors = require("cors");

app.use(cors({
    origin: "*"
}))

const WordSchema = mongoose.model("Word", new mongoose.Schema({
    t: { //texto
        type: String,
        required: true,
    },
    ty: { //tipo (w = word, h = hashtag)
        type: String,
        required: true
    },
    l: { //languages
        type: String,
        required: true
    },
    ca: { //created at
        type: Date,
        immutable: true,
        default: () => new Date()
    }
}));

const TokenSchema = mongoose.model("Token", new mongoose.Schema({ //usado para acessar funções de admin
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
        default: () => new Date()
    }
}));

const UserSchema = mongoose.model("User", new mongoose.Schema({
    h: { //handle
        type: String,
        required: true,
    },
    d: { //did
        type: String,
        required: true,
    },
    s: { //BetterBluesky SessionID created
        type: String,
        required: true
    },
    ll: { //last login
        type: Date,
        default: () => new Date()
    },
    ca: { //created at
        type: Date,
        immutable: true,
        default: () => new Date()
    }
}));

const StatsSchema = mongoose.model("Stats", new mongoose.Schema({
    event: {
        type: String,
        required: true,
    },
    data: {
        type: String,
        required: true
    },
    sessionID: {
        type: String,
        required: true
    },
    createdAt: { //created at
        type: Date,
        immutable: true,
        default: () => new Date()
    }
}));

const SettingsSchema = mongoose.model("Setting", new mongoose.Schema({
    blacklist: {
        trends: {
            type: Array,
            default: []
        },
        words: {
            type: Array,
            default: []
        },
        users: {
            type: Array,
            default: []
        }
    },
    pinWord: {
        enabled: {
            type: Boolean,
            default: false
        },
        word: {
            type: String,
        },
        count: {
            type: Number
        },
        message: {
            type: String,
        },
        position: {
            type: Number
        },
    },
    trendsMessages: [{ //se a palavra está nos trends, adiciona uma mensagem nela
        word: {
            type: String,
        },
        message: {
            type: String,
        }
    }],
    config: {
        acceptableStats: {
            type: Array,
            default: []
        }
    }
}))

const cache = {
    trending: {
        head: {
            time: 0,
            length: 0,
        },
        data: []
    },
    stats: {
        last30sSessions: new Map()
    },
    settings: {
        blacklist: {
            trends: [],
            words: [],
            users: []
        },
        pinWord: {
            enabled: false,
            word: "",
            count: 0,
            position: 0,
        },
        trendsMessages: [],
        config: {
            acceptableStats: []
        }
    }
}


const client = subscribeRepos(`wss://bsky.network`, { decodeRepoOps: true });

client.on('message', message => {
    if (ComAtprotoSyncSubscribeRepos.isCommit(message)) {
        message.ops.forEach(async (op) => {
            if (!op?.payload) return
            if (op.payload["$type"] != "app.bsky.feed.post") return;
            if (!op.payload.langs?.includes("pt")) return; //apenas em portugues

            const text = op.payload.text.trim();

            const posthashtags = getHashtags(text);
            const postwords = [...new Set(text.trim().split(" ").filter(word => (word.length > 2) && (word.length < 64) && !word.startsWith("#")))]

            for (const hashtag of posthashtags) {
                if (hashtag.length > 2) {
                    if (cache.settings.blacklist.trends.map(t => t.toLowerCase()).includes(hashtag.toLowerCase())) return;
                    if (cache.settings.blacklist.words.find(w => hashtag.toLowerCase().includes(w.toLowerCase()))) return;
                    await WordSchema.create({ t: hashtag, ty: "h", l: op.payload.langs.join(" ") })
                }

            }

            for (const word of postwords) {
                if (cache.settings.blacklist.trends.map(t => t.toLowerCase()).includes(word.toLowerCase())) return;
                if (cache.settings.blacklist.words.find(w => word.toLowerCase().includes(w.toLowerCase()))) return;
                await WordSchema.create({ t: word.toLowerCase(), ty: "w", l: op.payload.langs.join(" ") })

            }
        })
    }
})

updateCacheSettings()
async function updateCacheSettings() {
    const settings = (await SettingsSchema.findOne({})) || await SettingsSchema.create({})
    cache.settings.blacklist = settings.blacklist;
    cache.settings.pinWord = settings.pinWord;
    cache.settings.config = settings.config;
    cache.settings.trendsMessages = settings.trendsMessages
}

updateCacheTrending()
async function updateCacheTrending() {
    cache.trending.data = await getTrending(15, 6)
    cache.trending.head.time = Date.now()
    cache.trending.head.length = cache.trending.data.length
    console.log(`=============================== Cache atualizado (${Date.now()}) ===============================`)
    console.log(cache.trending)
}

setInterval(async () => {
    await updateCacheTrending()
    await updateCacheSettings()
}, 29 * 1000)


async function getTrending(hourlimit, recentlimit) {
    const hourwords = await getTrendingType(hourlimit, "w", 1.5 * 60 * 60 * 1000);
    const hourhashtags = await getTrendingType(hourlimit, "h", 1.5 * 60 * 60 * 1000);

    const recentwords = await getTrendingType(10, "w", 10 * 60 * 1000);
    const recenthashtags = await getTrendingType(10, "h", 10 * 60 * 1000);

    const _hourtrends = mergeArray(hourhashtags, hourwords)
    const _recenttrends = mergeArray(recenthashtags, recentwords)

    const hourtrends = removeDuplicatedTrends(_hourtrends).slice(0, hourlimit)
    const recenttrends = removeDuplicatedTrends(_recenttrends).filter(rt => !hourtrends.find(t => t.text.toLowerCase() === rt.text.toLowerCase())).slice(0, recentlimit)

    const trends = removeDuplicatedTrends([...hourtrends, ...recenttrends]);

    trends.forEach(trend => {
        if (cache.settings.trendsMessages.find(t => t.word === trend.text)) {
            trend.message = cache.settings.trendsMessages.find(t => t.word === trend.text).message;
        }
    });


    if (cache.settings.pinWord.enabled) {
        trends.splice(cache.settings.pinWord.position, 0, { text: cache.settings.pinWord.word, count: cache.settings.pinWord.count, timefilter: 0, message: cache.settings.pinWord.message });
        console.log(`PINNED WORD: [${cache.settings.pinWord.position}] ${cache.settings.pinWord.word} (${cache.settings.pinWord.count})`)
    }

    return trends;
}

async function getTrendingType(limit, type, time) {
    const hoursAgo = new Date(Date.now() - time); // Data e hora de x horas atrás

    const result = await WordSchema.aggregate([
        {
            $match: {
                ca: { $gte: hoursAgo }, // Filtra documentos criados nos últimos x horas
                ty: type,
            }
        },
        {
            $group: {
                _id: "$t", // Agrupar por palavra
                count: { $sum: 1 } // Contar o número de ocorrências
            }
        },
        {
            $sort: { count: -1 } // Ordenar por contagem em ordem decrescente
        },
        {
            $limit: (limit + 9) // Limitar o resultado para as palavra mais frequente
        }
    ]);

    return result.filter(obj => (!cache.settings.blacklist.trends.map(t => t.toLowerCase()).includes(obj._id.toLowerCase())) && (!cache.settings.blacklist.words.find(word => obj._id.toLowerCase().includes(word.toLowerCase())))).map(obj => { return { text: obj._id, count: obj.count, timefilter: time } }).slice(0, limit);
}

function removeDuplicatedTrends(trends) {
    const wordMap = new Map();

    trends.forEach(({ text, count, timefilter }) => {
        const lowerCaseText = text.toLowerCase();

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

setTimeout(() => {
    deleteOlds(3, 1000 * 60 * 60 * 1)
}, 1000 * 60 * 60 * 1)


//log stats
setInterval(() => {
    console.log(`Sessões últimos 30s: ${cache.stats.last30sSessions.size}`);
    cache.stats.last30sSessions = new Map()
}, 1000 * 30)

async function deleteOlds(hours, loopTimer) { //apaga as words antes de x horas
    console.log(`Apagando documentos de antes de horas: ${hours}`)
    const hoursAgo = new Date(Date.now() - hours * 60 * 60 * 1000); // Data e hora de x horas atrás

    const result = await WordSchema.deleteMany({ "ca": { $lt: hoursAgo } });

    console.log("-----------------------------------------------------------------------");
    console.log(`Removed before ${hours}h: ${result.deletedCount}`);
    console.log("-----------------------------------------------------------------------");
    setTimeout(() => {
        deleteOlds(3, 1000 * 60 * 60 * 1)
    }, loopTimer)
}

function getHashtags(texto) {
    const regex = /#\w+/g;
    return texto.match(regex) || [];
}

let hasSendSomeTrending = false;

app.get("/api/trends", (req, res) => {
    res.json(cache.trending)
    if (req.query.sessionID) cache.stats.last30sSessions.set(req.query.sessionID, req.query.updateCount)

    //Gambiarra gigante para reinciar o app quando houver o erro misterioso de começar a retornar array vazia nos trends (Me ajude e achar!)
    if (cache.trending.data.length > 0) hasSendSomeTrending = true;
    if (hasSendSomeTrending && (cache.trending.data.length === 0)) process.exit(1)
})

app.post("/api/stats", async (req, res) => {
    const sessionID = req.query.sessionID;

    if (!sessionID) return res.status(400).json({ message: "sessionID is required" })
    if (typeof sessionID != "string") return res.status(400).json({ message: "sessionID must be an string" })


    const event = req.query.action; //action because "event" cause an error

    if (!event) return res.status(400).json({ message: "event is required" })
    if (typeof event != "string") return res.status(400).json({ message: "event must be an string" })

    if (!cache.settings.config.acceptableStats.includes(event)) return res.status(400).json({ message: "invalid event" })

    const data = req.query.data;

    if (!data) return res.status(400).json({ message: "data is required" })
    if (typeof data != "string") return res.status(400).json({ message: "data must be an string" })

    StatsSchema.create({
        event: event,
        data: data,
        sessionID: sessionID
    })

    return res.json({ ok: true });
})

app.post("/api/stats/users", async (req, res) => {

    try {
        const sessionID = req.query.sessionID;

        if (!sessionID) return res.status(400).json({ message: "sessionID is required" })
        if (typeof sessionID != "string") return res.status(400).json({ message: "sessionID must be an string" })

        const handle = req.query.handle;

        if (!handle) return res.status(400).json({ message: "handle is required" })
        if (typeof handle != "string") return res.status(400).json({ message: "handle must be an string" })

        const did = req.query.did;

        if (!did) return res.status(400).json({ message: "did is required" })
        if (typeof did != "string") return res.status(400).json({ message: "did must be an string" })

        const existUser = await UserSchema.findOne({ h: handle, d: did });

        if (existUser) {
            existUser.ll = Date.now();
            await existUser.save()
            return res.json({ message: "updated" })
        }

        await UserSchema.create({ //salva os usuários que utilizam a extensão para futuras atualizações
            h: handle,
            d: did,
            s: sessionID
        })

        return res.json({ message: "created" })
    } catch (e) {
        console.log(e)
        res.status(500).json({ message: "Internal Server Error" })
    }
})

app.get("/api/trendsmessages", async (req, res) => {
    console.log(`${Date.now()} /api/trendsmessages`)
    const settings = await SettingsSchema.findOne({});

    return res.json(settings.trendsMessages)
})

app.put("/api/admin/trendsmessages", async (req, res) => {
    const tokenstring = req.headers.authorization;
    if (!tokenstring) return res.status(401).json({ message: "Token is required" })

    const token = await TokenSchema.findOne({ token: tokenstring });
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    if(!token.permissions.includes("*")){
        if (!token.permissions.includes("trendsmessages.manage")) return res.status(403).json({ message: "Missing permissions" });
    }
    const settings = await SettingsSchema.findOne({});

    try {
        const trendsmessages = JSON.parse(req.query.trendsmessages);
        settings.trendsMessages = trendsmessages;
        await settings.save();
        return res.json(settings.trendsMessages)

    } catch (e) {
        console.log(e)
        res.status(500).json({ message: "Internal Server Error" })
    }
})

app.get('*', function (req, res) {
    res.status(404).send({ message: "Route not found" });
});

app.post('*', function (req, res) {
    res.status(404).send({ message: "Route not found" });
});

app.listen(process.env.PORT, () => {
    console.log(`Aplicativo iniciado em ${process.env.PORT}`)
    updateCacheTrending()
    updateCacheSettings()
    // deleteOlds(3)
})