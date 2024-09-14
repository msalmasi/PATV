const {
  Client,
  Collection,
  Partials,
  Events,
  GatewayIntentBits,
} = require("discord.js");
const { token } = require("./config.json");
const blackjack = require("discord-blackjack")
const axios = require("axios");
require("dotenv").config();
const { findOrCreateDiscordUser, findUserBalance } = require("../discord-bot/userUtils"); // Helper function to find or create user

// Create a new Discord client instance
const client = new Client({
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildScheduledEvents,
    ],
  });

    const prefix = "!"

bjp = "";
pb = "";
hr = [""];

function printBalance(balance) {
    console.log(balance);
    pb = balance;
}

    client.on("ready", () => {
      console.log("Bot has logged in!")
    })

async function deal(message, wamount, user) {
                    let game = await blackjack(message, {transition: "edit"})
        const damount = 2*wamount
        const bjamount = 1.5*wamount
        const wbjamount = parseInt(bjamount)+parseInt(wamount)
        const lbjamount = parseInt(bjamount)-parseInt(wamount)
        const insamount = 0.5*wamount
        const inswin = wamount - insamount
        const insloss = -wamount - insamount
        const lossins = parseInt(wamount) + parseInt(insamount)
        const wagerResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/wager`, {
            userId: user.userId,  // Ensure you have user.userId from your findOrCreateUser function
            wager: wamount,
            password: process.env.BOT_TOKEN
        });
        
        if (wagerResponse.data.success) {
            console.log("Bet deducted from " + user.username);
        } else {
            message.channel.send(`${message.author}, there was an issue placing your wager.`);
            return;
        }
        switch (game.result) {
                case 'WIN':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const WinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,  // Make sure to store the blackjackId from the wager response
                        userId: user.userId,
                        payout: 2 * wamount,
                        result: "WIN",
                        pvalue: yval,  // Player value
                        dvalue: dval,  // Dealer value
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (WinResultResponse.data.success) {
                        message.channel.send(`${message.author} won PAT ${wamount} with ${yval}! Dealer had ${dval}.`);
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'TIE':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const TieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (TieResultResponse.data.success) {
                        message.channel.send(`${message.author} tied with a total of ${yval}!`);
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'LOSE':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const LoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (LoseResultResponse.data.success) {
                        message.channel.send(`${message.author} lost PAT ${wamount} with ${yval}! Dealer had ${dval}.`);
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const DoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (DoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} won PAT ${damount} with ${yval}! Dealer had ${dval}.`);
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const DoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -wamount,
                        result: "DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (DoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} lost PAT ${damount} with ${yval}! Dealer had ${dval}.`);
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const DoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (DoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} tied with ${yval}!`);
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -wamount,
                        result: "SPLIT LOSE-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${2*wamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT WIN-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*wamount}). First hand wins PAT ${wamount} with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT WIN-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand wins PAT ${wamount} with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT LOSE-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand wins PAT ${wamount} with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT TIE-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand wins PAT ${wamount} with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT TIE-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand ties with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT WIN-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand wins PAT ${wamount} with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "SPLIT TIE-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${wamount}). First hand ties with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "SPLIT LOSE-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${wamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2.5*wamount,
                        result: "SPLIT TIE-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${bjamount}). First hand ties with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2.5*wamount,
                        result: "SPLIT BLACKJACK-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${bjamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3.5*wamount,
                        result: "SPLIT BLACKJACK-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wbjamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3.5*wamount,
                        result: "SPLIT WIN-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wbjamount}). First hand wins PAT ${wamount} with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 1.5*wamount,
                        result: "SPLIT BLACKJACK-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${lbjamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 1.5*wamount,
                        result: "SPLIT LOSE-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${lbjamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT BLACKJACK-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${bjamount+bjamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;

                case "SPLIT DOUBLE LOSE-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -2*wamount,
                        result: "SPLIT DOUBLE LOSE-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${3*wamount}). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT DOUBLE WIN-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${3*wamount}). First hand wins PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT DOUBLE WIN-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand wins PAT ${damount} (double) with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "SPLIT DOUBLE LOSE-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${wamount}). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT DOUBLE TIE-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand ties (double) with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT DOUBLE TIE-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand ties (double) with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT DOUBLE WIN-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*wamount}). First hand wins PAT ${2*wamount} (double) with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "SPLIT DOUBLE TIE-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${wamount}). First hand ties (double) with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -wamount,
                        result: "SPLIT DOUBLE LOSE-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${2*wamount}). First hand loses PAT ${2*wamount} (double) with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2.5*wamount,
                        result: "SPLIT DOUBLE TIE-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${bjamount}). First hand ties (double) with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*bjamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand ties with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 5*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${4*wamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand wins PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4.5*wamount,
                        result: "SPLIT DOUBLE WIN-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${3.5*wamount}). First hand wins PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*wamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand loses PAT ${wamount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0.5*wamount,
                        result: "SPLIT DOUBLE LOSE-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${0.5*wamount}). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 5.5*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${3*bjamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand wins PAT ${bjamount} (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -2*wamount,
                        result: "SPLIT LOSE-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${3*wamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT WIN-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${3*wamount}). First hand wins with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "SPLIT WIN-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${wamount}). First hand wins PAT ${wamount} with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT LOSE-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand wins PAT ${damount} with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT TIE-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand ties with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT TIE-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${damount}). First hand ties with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT WIN-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand wins PAT ${wamount} with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -wamount,
                        result: "SPLIT TIE-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${damount}). First hand ties with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0,
                        result: "SPLIT LOSE-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${wamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT TIE-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitTieDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT TIE-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitTieDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*bjamount}). First hand ties with a total of ${yval}! Second hand wins PAT ${bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2.5*wamount,
                        result: "SPLIT BLACKJACK-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${bjamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4.5*wamount,
                        result: "SPLIT BLACKJACK-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${3.5*wamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT WIN-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitWinDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 5*wamount,
                        result: "SPLIT WIN-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitWinDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${4*wamount}). First hand wins PAT ${wamount} with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0.5*wamount,
                        result: "SPLIT BLACKJACK-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${0.5*wamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT LOSE-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitLoseDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT LOSE-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitLoseDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*wamount}). First hand loses PAT ${wamount} with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT BLACKJACK-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitBlackjackDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 5.5*wamount,
                        result: "SPLIT BLACKJACK-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitBlackjackDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${3*bjamount}). First hand wins PAT ${bjamount} (blackjack) with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -3*wamount,
                        result: "SPLIT DOUBLE LOSE-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${4*wamount}). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 5*wamount,
                        result: "SPLIT DOUBLE WIN-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${4*wamount}). First hand wins PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT DOUBLE WIN-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand wins PAT ${damount} (double) with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT DOUBLE LOSE-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "SPLIT DOUBLE TIE-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Push). First hand ties (double) with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT DOUBLE TIE-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${damount}). First hand ties (double) with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 3*wamount,
                        result: "SPLIT DOUBLE WIN-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${damount}). First hand wins PAT ${damount} (double) with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -wamount,
                        result: "SPLIT DOUBLE TIE-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${damount}). First hand ties (double) with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -wamount,
                        result: "SPLIT DOUBLE LOSE-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Loss: PAT ${damount}). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE TIE-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleTieDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT DOUBLE TIE-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleTieDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*bjamount}). First hand ties (double) with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-DOUBLE TIE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackDoubleTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 4*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-DOUBLE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackDoubleTieResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${2*bjamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand ties (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-DOUBLE WIN":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackDoubleWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 6*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-DOUBLE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackDoubleWinResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${5*wamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand wins PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE WIN-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleWinDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 6*wamount,
                        result: "SPLIT DOUBLE WIN-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleWinDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${5*wamount}). First hand wins PAT ${2*wamount} (double) with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-DOUBLE LOSE":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackDoubleLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-DOUBLE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackDoubleLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand loses PAT ${damount} (double) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE LOSE-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleLoseDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2*wamount,
                        result: "SPLIT DOUBLE LOSE-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleLoseDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${wamount}). First hand loses PAT ${damount} (double) with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case "SPLIT DOUBLE BLACKJACK-DOUBLE BLACKJACK":
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var yval2 = game.ycard2.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const SplitDoubleBlackjackDoubleBlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 7*wamount,
                        result: "SPLIT DOUBLE BLACKJACK-DOUBLE BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (SplitDoubleBlackjackDoubleBlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} split (Gain: PAT ${6*wamount}). First hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval}! Second hand wins PAT ${2*bjamount} (double) (blackjack) with a total of ${yval2}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'BLACKJACK':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const BlackjackResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 2.5*wamount,
                        result: "BLACKJACK",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (BlackjackResultResponse.data.success) {
                        message.channel.send(`${message.author} won PAT ${bjamount} (blackjack) with ${yval}! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'INSURANCE PAYOUT':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const InsurancePayoutResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: wamount,
                        result: "INSURANCE PAYOUT",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (InsurancePayoutResultResponse.data.success) {
                        message.channel.send(`${message.author} received an insurance payout of PAT ${wamount} (Push)! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'INSURANCE WIN':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const InsuranceWinResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 1.5*wamount,
                        result: "INSURANCE WIN",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (InsuranceWinResultResponse.data.success) {
                        message.channel.send(`${message.author} paid PAT ${insamount} for insurance and won PAT ${wamount} with ${yval} (Gain: PAT ${inswin})! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'INSURANCE LOSE':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const InsuranceLoseResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: -0.5*wamount,
                        result: "INSURANCE LOSE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (InsuranceLoseResultResponse.data.success) {
                        message.channel.send(`${message.author} paid PAT ${insamount} for insurance and lost PAT ${wamount} with ${yval} (Loss: PAT ${lossins})! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'INSURANCE TIE':
                    var yval = game.ycard.reduce((accum,item) => accum + item.value, 0)
                    var dval = game.dcard.reduce((accum,item) => accum + item.value, 0)
                    const InsuranceTieResultResponse = await axios.post(process.env.BACKEND_BASE_URL+`/api/blackjack/result`, {
                        blackjackId: wagerResponse.data.blackjackId,
                        userId: user.userId,
                        payout: 0.5*wamount,
                        result: "INSURANCE TIE",
                        pvalue: yval,
                        dvalue: dval,
                        password: process.env.BOT_TOKEN
                    });
                    
                    if (InsuranceTieResultResponse.data.success) {
                        message.channel.send(`${message.author} paid PAT ${insamount} for insurance and tied with ${yval} (Loss: PAT ${insamount})! Dealer had ${dval}.`)
                    } else {
                        message.channel.send(`${message.author}, there was an issue processing your result.`);
                    }
                    break;
                case 'ERROR':
                    // do whatever you want
                    break;
        
        }
}

client.on("messageCreate", async message => {
    // Ignore bot messages, non-guild messages, and messages without the right prefix
    if (message.author.bot || !message.guild || !message.content.startsWith(prefix)) return;

    // Redirect users if they are using the command in the wrong channel
    else if ((message.content.startsWith(`${prefix}blackjack`) || message.content.startsWith(`${prefix}bj`)) && (message.channel.id != "1192942144458084433")) {
        message.channel.send(`Please use <#1192942144458084433> to play blackjack ${message.author}!`);
    }

    // Handle the blackjack command in the correct channel
    else if ((message.content.startsWith(`${prefix}blackjack`) || message.content.startsWith(`${prefix}bj`)) && (message.channel.id === "1192942144458084433")) {

        const bjMessage = message.content;
        const splitMessage = bjMessage.split(" ");
        const wamount = parseInt(splitMessage[1], 10);  // Wager amount as a number

        if (isNaN(wamount) || wamount <= 0) {
            return message.channel.send(`Please specify a valid wager amount, ${message.author}.`);
        }

        const discordId = message.author.id;
        const displayName = message.author.username;
        const profileImage = message.author.displayAvatarURL();

        try {
            // FUNCTION FOR GETTING USER AND BALANCE
            // Use the findOrCreateDiscordUser function to get the user
            const user = await findOrCreateDiscordUser(discordId, displayName, profileImage);

            if (!user) {
                return message.channel.send(`Error fetching your user data, ${message.author}. Please try again.`);
            }

            // Fetch the user's balance from the backend API
            const balanceResponse = await axios.get(process.env.BACKEND_BASE_URL+`/api/u/${user.username}/balance`);
            const balance = balanceResponse.data.balance;

            if (balance >= wamount) {
                console.log("Bet accepted");

                // Allow larger bets if the user has the special role or bet is below 5000
                if (wamount <= 5000 || message.member.roles.cache.has('1245221366974906409')) {
                    deal(message, wamount, user);  // Start the blackjack game with the user's wager
                } else {
                    message.channel.send(`You can't bet PAT ${wamount}. The maximum bet is PAT 5000 ${message.author}!`);
                }

            } else {
                console.log("Bet rejected");
                message.channel.send(`You're too broke to do that, ${message.author}! Go to https://publicaccess.tv to learn how to get more PAT.`);
            }

        } catch (error) {
            console.error(`Error processing blackjack command for ${message.author}:`, error);
            message.channel.send(`There was an error processing your request, ${message.author}. Please try again.`);
        }
    }
});


     client.login(token)