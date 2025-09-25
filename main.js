require('dotenv').config();
const fs = require('fs-extra');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const addressesFile = '../swap_address.txt';

// Check if environment variables are loaded
if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ Error: Missing environment variables!');
  console.error('Please create a .env file with:');
  console.error('BOT_TOKEN=your_bot_token_here');
  console.error('CHAT_ID=your_chat_id_here');
  process.exit(1);
}

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

// Write addresses to file
async function writeAddresses(addresses) {
  try {
    await fs.writeFile(addressesFile, addresses.join('\n') + '\n');
    console.log(`Updated ${addressesFile} with ${addresses.length} addresses`);
  } catch (error) {
    console.error('Error writing addresses file:', error.message);
  }
}

// Keep track of last known addresses in memory
let knownAddresses = new Set();

// Initialize bot and load existing addresses
(async () => {
  try {
    const addresses = await readAddresses();
    knownAddresses = new Set(addresses);
    console.log(`Bot started. Monitoring ${addresses.length} addresses in ${addressesFile}`);
    
    // Send simple startup notification without sending all addresses
    await bot.sendMessage(CHAT_ID, `💖 Bot started! Currently monitoring ${addresses.length} wallet addresses.💖\n\n✅✅ Monitoring for new addresses... ✅✅`);

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


// Start command for bot info
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `💘💘 Hi! I monitor \`${addressesFile}\` and notify about new wallet addresses.\n\nCurrently monitoring ${knownAddresses.size} addresses.\n\n**Commands:**\n\`/remove <address>\` - Remove an address from monitoring`, {
    parse_mode: 'Markdown'
  });
});

// Remove command for deleting addresses
bot.onText(/\/remove (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const addressToRemove = match[1].trim();
  
  try {
    let addresses = await readAddresses();
    
    if (addresses.includes(addressToRemove)) {
      addresses = addresses.filter(a => a !== addressToRemove);
      await writeAddresses(addresses);
      
      // Update known addresses
      knownAddresses = new Set(addresses);
      
      await bot.sendMessage(chatId, `⛔ Address removed successfully:\n\`${addressToRemove}\`\n\nNow monitoring ${addresses.length} addresses. ⛔`, {
        parse_mode: 'Markdown'
      });
      
      console.log(`Address removed via Telegram command: ${addressToRemove}`);
    } else {
      await bot.sendMessage(chatId, `❌ Address not found in monitoring list:\n\`${addressToRemove}\``, {
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('Error removing address via command:', error.message);
    await bot.sendMessage(chatId, `❌ Error removing address. Please try again.`);
  }
});

// Error handling for bot
bot.on('error', (error) => {
  console.error('Bot error:', error.message);
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});