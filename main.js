const fs = require('fs-extra');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = '7334231114:AAGrC14W0ppD8sAc2cRvGQ09_s8Zrge5Ess';   //client
// const BOT_TOKEN = '8153609450:AAHKxB6c_8YnBvPtKh3SOhQwGkrPOCaY8MQ';
const CHAT_ID = '-4968787628';    //client
// const CHAT_ID = '6579613865';
const addressesFile = '../swap_address.txt';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Read addresses from file, one per line
async function readAddresses() {
  try {
    const data = await fs.readFile(addressesFile, 'utf8');
    return data.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  } catch (error) {
    console.error('Error reading addresses file:', error.message);
    return [];
  }
}

// Keep track of last known addresses in memory
let knownAddresses = new Set();

// Function to send existing addresses
async function sendExistingAddresses(addresses) {
  if (addresses.length === 0) return;
  
  try {
    let message = `📋 **Existing Addresses (${addresses.length} total):**\n\n`;
    addresses.forEach((addr, index) => {
      message += `${index + 1}. \`${addr}\`\n`;
    });
    
    await bot.sendMessage(CHAT_ID, message, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error sending existing addresses:', error.message);
  }
}

// Initialize bot and load existing addresses
(async () => {
  try {
    const addresses = await readAddresses();
    knownAddresses = new Set(addresses);
    console.log(`Bot started. Monitoring ${addresses.length} addresses in ${addressesFile}`);
    
    // Send startup notification
    if (addresses.length > 0) {
      await bot.sendMessage(CHAT_ID, `🤖 Bot started! Currently monitoring ${addresses.length} wallet addresses.\n\nSending existing addresses...`);
      
      // Send all existing addresses
      await sendExistingAddresses(addresses);
    } else {
      await bot.sendMessage(CHAT_ID, `🤖 Bot started! No addresses found in ${addressesFile}.`);
    }
  } catch (error) {
    console.error('Error initializing bot:', error.message);
  }
})();

// Watch file for changes
const watcher = chokidar.watch(addressesFile);

watcher.on('change', async () => {
  try {
    console.log(`File changed: ${addressesFile}`);
    const currentAddresses = new Set(await readAddresses());
    
    // Find new addresses (exists in current, but not in known)
    const newAddresses = [...currentAddresses].filter(x => !knownAddresses.has(x));
    
    if (newAddresses.length > 0) {
      console.log(`Found ${newAddresses.length} new addresses`);
      // Send notification for new addresses
      for (const addr of newAddresses) {
        const msg = `🆕 New wallet address added:\n\`${addr}\``;
        await bot.sendMessage(CHAT_ID, msg, {
          parse_mode: 'Markdown'
        });
      }
    }
    
    // Update known addresses set
    knownAddresses = currentAddresses;
    
    if (newAddresses.length > 0) {
      console.log(`Updated monitoring: ${currentAddresses.size} total addresses`);
    }
    
  } catch (error) {
    console.error('Error handling file change:', error.message);
  }
});

// Note: Remove button functionality removed

// Start command for bot info
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 Hi! I monitor \`${addressesFile}\` and notify about new wallet addresses.\n\nCurrently monitoring ${knownAddresses.size} addresses.`, {
    parse_mode: 'Markdown'
  });
});

// Error handling for bot
bot.on('error', (error) => {
  console.error('Bot error:', error.message);
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});
