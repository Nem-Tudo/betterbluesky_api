require("dotenv").config()

const { ComAtprotoSyncSubscribeRepos, SubscribeReposMessage, subscribeRepos } = require("atproto-firehose");
const mongoose = require("mongoose");

const config = require("./config.js")

mongoose.connect(process.env.MONGODB);

const express = require("express");

const app = express();
const cors = require("cors");

app.use(cors({
    origin: "*"
}))

const WordSchema = mongoose.model("Word", new mongoose.Schema({
    t: {
        type: String,
        required: true,
    },
    ca: {
        type: Date,
        immutable: true,
        default: () => new Date()
    }
}));

const client = subscribeRepos(`wss://bsky.network`, { decodeRepoOps: true });

client.on('message', message => {
    if (ComAtprotoSyncSubscribeRepos.isCommit(message)) {
        message.ops.forEach(async (op) => {
            if (!op?.payload) return
            if (op.payload["$type"] != "app.bsky.feed.post") return;

            const text = op.payload.text.trim();

            const posthashtags = getHashtags(text);

            for (const hashtag of posthashtags) {
                if (hashtag.length > 2) {
                    if (config.blacklist.trends.includes(hashtag)) return;
                    if (config.blacklist.words.find(word => hashtag.includes(word))) return;
                    await WordSchema.create({ t: hashtag })
                }

            }
        })
    }
})

// setInterval(async () => {

//     const result = await getTrendingHashtags(10);

//     console.log("=======================================")
//     console.log(result)
// }, 200)

const cache = {
    trending: {
        head: {
            time: 0,
            length: 0,
        },
        data: []
    }
}
updateCacheTrending()
async function updateCacheTrending() {
    cache.trending.data = await getTrendingHashtags(5)
    cache.trending.head.time = Date.now()
    cache.trending.head.length = cache.trending.data.length
    console.log(`=============================== Cache atualizado (${Date.now()}) ===============================`)
    console.log(cache.trending)
}

setInterval(async () => {
    await updateCacheTrending()
}, 30 * 1000)

async function getTrendingHashtags(limit) {
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000); // Data e hora de 2 horas atrás

    const result = await WordSchema.aggregate([
        {
            $match: {
                ca: { $gte: hoursAgo } // Filtra documentos criados nos últimos 2 horas
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

    return result.filter(obj => (!config.blacklist.trends.map(t => t.toLowerCase()).includes(obj._id.toLowerCase())) && (!config.blacklist.words.find(word => obj._id.toLowerCase().includes(word.toLowerCase())))).map(obj => { return { text: obj._id, count: obj.count } }).slice(0, limit);
}

setInterval(() => {
    deleteOlds(3)
}, 1000 * 60 * 60 * 1)

async function deleteOlds(hours) {
    const hoursAgo = new Date(Date.now() - hours * 60 * 60 * 1000); // Data e hora de x horas atrás

    await Word.deleteMany({
        ca: { $lt: hoursAgo } // Remove documentos criados há mais de 2 horas
    });

    console.log(`Removed before ${hours}h`);
}

function getHashtags(texto) {
    const regex = /#\w+/g;
    return texto.match(regex) || [];
}


app.get("/trends", (req, res) => {
    console.log(`[${Date.now()}] GET - /trends`)
    res.json(cache.trending)
})


app.listen(process.env.PORT, () => {
    console.log(`Aplicativo iniciado em ${process.env.PORT}`)
})