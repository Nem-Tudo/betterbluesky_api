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

// const StatsSchema = mongoose.model("Stats", new mongoose.Schema({
//     action: {
//         type: String,
//         required: true,
//     },
//     data: {
//         type: String,
//         required: true
//     },
//     createdAt: { //created at
//         type: Date,
//         immutable: true,
//         default: () => new Date()
//     }
// }));

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
    settings: {
        blacklist: {
            trends: [],
            words: [],
            users: []
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
            const postwords = text.trim().split(" ").filter(word => (word.length > 2) && (word.length < 64) && !word.startsWith("#"))

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
}

updateCacheTrending()
async function updateCacheTrending() {
    cache.trending.data = await getTrending(15)
    cache.trending.head.time = Date.now()
    cache.trending.head.length = cache.trending.data.length
    console.log(`=============================== Cache atualizado (${Date.now()}) ===============================`)
    console.log(cache.trending)
}

setInterval(async () => {
    await updateCacheTrending()
    await updateCacheSettings()
}, 30 * 1000)


async function getTrending(limit) {
    const words = await getTrendingType(limit, "w");
    const hashtags = await getTrendingType(limit, "h");

    const trends = mergeArray(hashtags, words)

    return removeDuplicatedTrends(trends).slice(0, limit)
}

async function getTrendingType(limit, type) {
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000); // Data e hora de 2 horas atrás

    const result = await WordSchema.aggregate([
        {
            $match: {
                ca: { $gte: hoursAgo }, // Filtra documentos criados nos últimos 2 horas
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

    return result.filter(obj => (!cache.settings.blacklist.trends.map(t => t.toLowerCase()).includes(obj._id.toLowerCase())) && (!cache.settings.blacklist.words.find(word => obj._id.toLowerCase().includes(word.toLowerCase())))).map(obj => { return { text: obj._id, count: obj.count } }).slice(0, limit);
}

function removeDuplicatedTrends(trends) {
    const wordMap = new Map();

    trends.forEach(({ text, count }) => {
        const lowerCaseText = text.toLowerCase();

        if (wordMap.has(lowerCaseText)) {
            wordMap.set(lowerCaseText, {
                text: wordMap.get(lowerCaseText).text,
                count: wordMap.get(lowerCaseText).count + count
            });
        } else {
            wordMap.set(lowerCaseText, { text, count });
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

setInterval(() => {
    deleteOlds(3)
}, 1000 * 60 * 60 * 1)

async function deleteOlds(hours) { //apaga as words antes de x horas
    const hoursAgo = new Date(Date.now() - hours * 60 * 60 * 1000); // Data e hora de x horas atrás

    const result = await WordSchema.deleteMany({ "ca": { $lt: hoursAgo } });

    console.log("-----------------------------------------------------------------------");
    console.log(`Removed before ${hours}h: ${result.deletedCount}`);
    console.log("-----------------------------------------------------------------------");
}

function getHashtags(texto) {
    const regex = /#\w+/g;
    return texto.match(regex) || [];
}


app.get("/api/trends", (req, res) => {
    console.log(`[${Date.now()}] GET - /trends (${req.query.updateCount})`)
    res.json(cache.trending)
})

// app.post("/api/stats", async (req, res) => {
//     const event = req.query.event;

//     if (!event) return res.status(400).json({ message: "event is required" })
//     if (typeof event != "string") return res.status(400).json({ message: "event must be an string" })

//     if (!["trends.click"].includes(event)) return res.status(400).json({ message: "invalid event" })


//     const data = req.query.data;

//     if (!data) return res.status(400).json({ message: "data is required" })
//     if (typeof data != "string") return res.status(400).json({ message: "data must be an string" })

//     StatsSchema.create({
//         event: event,
//         data: data
//     })

//     return res.json({ ok: true })
// })

app.listen(process.env.PORT, () => {
    console.log(`Aplicativo iniciado em ${process.env.PORT}`)
    updateCacheTrending()
    updateCacheSettings()
    deleteOlds(3)
})