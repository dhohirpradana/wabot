import { Boom } from "@hapi/boom";
import makeWASocket, {
  AnyMessageContent,
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  MessageRetryMap,
  useMultiFileAuthState,
} from "../src";
import MAIN_LOGGER from "../src/Utils/logger";
const fs = require("fs");
const axios = require("axios");

let msgRes;
fs.readFile("Example/msgRes.json", (err, data) => {
  if (err) throw err;
  msgRes = JSON.parse(data);
  console.log("msgRes", msgRes);
});

console.log("This is after the read call");

const logger = MAIN_LOGGER.child({});
logger.level = "trace";

const useStore = !process.argv.includes("--no-store");
const doReplies = !process.argv.includes("--no-reply");

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterMap: MessageRetryMap = {};

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined;
store?.readFromFile("./baileys_store_multi.json");
// save every 10s
setInterval(() => {
  store?.writeToFile("./baileys_store_multi.json");
}, 10_000);

// start a connection
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth_info");
  // fetch latest version of WA Web
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      /** caching makes the store faster to send/recv messages */
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterMap,
    generateHighQualityLinkPreview: true,
    // implement to handle retries
    getMessage: async (key) => {
      if (store) {
        const msg = await store.loadMessage(key.remoteJid!, key.id!);
        return msg?.message || undefined;
      }

      // only if store is present
      return {
        conversation: "hello",
      };
    },
  });

  store?.bind(sock.ev);

  const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
    await sock.presenceSubscribe(jid);
    await delay(500);

    await sock.sendPresenceUpdate("composing", jid);
    await delay(2000);

    await sock.sendPresenceUpdate("paused", jid);

    await sock.sendMessage(jid, msg);
  };

  // the process function lets you process all events that just occurred
  // efficiently in a batch
  sock.ev.process(
    // events is a map for event name => event data
    async (events) => {
      // something about the connection changed
      // maybe it closed, or we received all offline message or connection opened
      if (events["connection.update"]) {
        const update = events["connection.update"];
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
          // reconnect if not logged out
          if (
            (lastDisconnect?.error as Boom)?.output?.statusCode !==
            DisconnectReason.loggedOut
          ) {
            startSock();
          } else {
            console.log("Connection closed. You are logged out.");
          }
        }

        console.log("connection update", update);
      }

      // credentials updated -- save them
      if (events["creds.update"]) {
        await saveCreds();
      }

      if (events.call) {
        console.log("recv call event", events.call);
      }

      // history received
      if (events["messaging-history.set"]) {
        const { chats, contacts, messages, isLatest } =
          events["messaging-history.set"];
        console.log(
          `recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest})`
        );
      }

      // received a new message
      if (events["messages.upsert"]) {
        const upsert = events["messages.upsert"];
        // console.log('recv messages ', JSON.stringify(upsert, undefined, 2))
        var message = upsert.messages[0].message?.conversation;
        console.log("message", message);
        var pushName = upsert.messages[0].pushName;

        if (upsert.type === "notify") {
          for (const msg of upsert.messages) {
            if (!msg.key.fromMe && doReplies) {
              var first = message!.substring(0, message!.indexOf(" "));
              var notFirst = message!.substring(message!.indexOf(" ") + 1);
              if (first == ".wikipedia") {
                axios
                  .get(
                    `https://id.wikipedia.org/w/api.php?action=query&format=json&list=search&formatversion=latest&srsearch=${notFirst}&srlimit=1&srprop=snippet&origin=*`
                  )
                  .then(async (res) => {
                    console.log("res", res.data);
                    var desc = res.data.query.search[0].snippet;
                    var url =
                      "https://id.wikipedia.org/?curid=" +
                      res.data.query.search[0].pageid;
                    await sock!.readMessages([msg.key]);
                    await sendMessageWTyping(
                      { text: `baca disini ${url}` },
                      msg.key.remoteJid!
                    );
                  })
                  .catch((err) => {
                    console.log("Error: ", err.message);
                  });
              }
              if (
                message?.toLowerCase() == "nama saya siapa?" ||
                message?.toLowerCase() == "who am i?"
              ) {
                await sock!.readMessages([msg.key]);
                await sendMessageWTyping(
                  { text: `Namamu ${pushName}` },
                  msg.key.remoteJid!
                );
              }
              for (const [key, value] of Object.entries(msgRes)) {
                console.log(key, value);
                if (message?.toLowerCase() == key) {
                  console.log("replying to", msg.key.remoteJid);
                  await sock!.readMessages([msg.key]);
                  await sendMessageWTyping(
                    { text: `${value}` },
                    msg.key.remoteJid!
                  );
                  break;
                }
              }
            }
          }
        }
      }

      // messages updated like status delivered, message deleted etc.
      if (events["messages.update"]) {
        console.log(events["messages.update"]);
      }

      if (events["message-receipt.update"]) {
        console.log(events["message-receipt.update"]);
      }

      if (events["messages.reaction"]) {
        console.log(events["messages.reaction"]);
      }

      if (events["presence.update"]) {
        console.log(events["presence.update"]);
      }

      if (events["chats.update"]) {
        console.log(events["chats.update"]);
      }

      if (events["contacts.update"]) {
        for (const contact of events["contacts.update"]) {
          if (typeof contact.imgUrl !== "undefined") {
            const newUrl =
              contact.imgUrl === null
                ? null
                : await sock!.profilePictureUrl(contact.id!);
            console.log(
              `contact ${contact.id} has a new profile pic: ${newUrl}`
            );
          }
        }
      }

      if (events["chats.delete"]) {
        console.log("chats deleted ", events["chats.delete"]);
      }
    }
  );

  return sock;
};

startSock();
