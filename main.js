require('dotenv').config();
const fs = require('fs-extra');
const chokidar = require('chokidar');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const addressesFile = '../swap_address.txt';
const processedStoreFile = './processed_addresses.json';

// Check if environment variables are loaded
if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ Error: Missing environment variables!');
  console.error('Please create a .env file with:');
  console.error('BOT_TOKEN=your_bot_token_here');
  console.error('CHAT_ID=your_chat_id_here');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------------------------------------------
// Telegram send queue with rate limiting/backoff
// ---------------------------------------------
const SEND_INTERVAL_MS = 1100; // ~1 message/sec per chat to be safe
let sendQueue = [];
let isSending = false;
let backoffUntil = 0; // timestamp ms until which we pause due to 429

function enqueueMessage(chatId, text, options = {}) {
  sendQueue.push({ chatId, text, options });
  processSendQueue();
}

async function processSendQueue() {
  if (isSending) return;
  isSending = true;
  try {
    while (sendQueue.length > 0) {
      const now = Date.now();
      if (now < backoffUntil) {
        const waitMs = backoffUntil - now;
        await delay(waitMs);
      }

      const item = sendQueue.shift();
      try {
        await bot.sendMessage(item.chatId, item.text, item.options);
      } catch (err) {
        // Handle 429 Too Many Requests
        const is429 = err && err.response && err.response.body && err.response.body.parameters && typeof err.response.body.parameters.retry_after === 'number';
        if (is429) {
          const retryAfterSec = err.response.body.parameters.retry_after;
          const retryMs = Math.max(1000, retryAfterSec * 1000);
          backoffUntil = Date.now() + retryMs;
          // Put the item back to the front of the queue and wait
          sendQueue.unshift(item);
          console.error(`Rate limited by Telegram. Backing off for ${retryAfterSec}s.`);
          continue;
        }
        console.error('Error sending message:', err.message || err);
      }
      await delay(SEND_INTERVAL_MS);
    }
  } finally {
    isSending = false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
let isInitialized = false;
let processedAddresses = new Set(); // persisted across restarts

async function loadProcessedAddresses() {
  try {
    const exists = await fs.pathExists(processedStoreFile);
    if (!exists) return new Set();
    const data = await fs.readFile(processedStoreFile, 'utf8');
    const arr = JSON.parse(data);
    if (Array.isArray(arr)) return new Set(arr);
    return new Set();
  } catch (e) {
    console.error('Error loading processed addresses store:', e.message);
    return new Set();
  }
}

async function saveProcessedAddresses(addressesSet) {
  try {
    const arr = Array.from(addressesSet);
    await fs.writeFile(processedStoreFile, JSON.stringify(arr));
  } catch (e) {
    console.error('Error saving processed addresses store:', e.message);
  }
}



// Initialize bot and load existing addresses
(async () => {
  try {
    const addresses = await readAddresses();
    knownAddresses = new Set(addresses);
    // Load previously processed addresses; if first run, initialize with current to avoid flood
    processedAddresses = await loadProcessedAddresses();
    if (processedAddresses.size === 0 && knownAddresses.size > 0) {
      processedAddresses = new Set(knownAddresses);
      await saveProcessedAddresses(processedAddresses);
    }
    console.log(`Bot started. Monitoring ${addresses.length} addresses in ${addressesFile}`);
    
    // Send simple startup notification without sending all addresses
    await bot.sendMessage(CHAT_ID, `🤖 Bot started! Currently monitoring ${addresses.length} wallet addresses.\n\nMonitoring for new addresses...`);
    // Mark initialization complete and start watching the file AFTER initial load
    isInitialized = true;
    const watcher = chokidar.watch(addressesFile);
    // Debounce rapid successive changes to coalesce them
    let changeTimer = null;
    watcher.on('change', () => {
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(onAddressesFileChange, 1000);
    });
  } catch (error) {
    console.error('Error initializing bot:', error.message);
  }
})();

// Handle file changes for addresses AFTER initialization
async function onAddressesFileChange() {
  if (!isInitialized) return;
  try {
    console.log(`File changed: ${addressesFile}`);
    const currentAddresses = new Set(await readAddresses());
    
    // Find new addresses (exists in current, but not in known)
    const newAddresses = [...currentAddresses].filter(x => !knownAddresses.has(x) && !processedAddresses.has(x));
    
    if (newAddresses.length > 0) {
      console.log(`Found ${newAddresses.length} new addresses`);
      // For large batches, send a summary instead of spamming one-by-one
      const LARGE_BATCH_THRESHOLD = 50;
      if (newAddresses.length >= LARGE_BATCH_THRESHOLD) {
        const preview = newAddresses.slice(0, 20).map(a => `- ${a}`).join('\n');
        const remainder = newAddresses.length - Math.min(20, newAddresses.length);
        const summary = `🆕 Detected ${newAddresses.length} new wallet addresses.\n\nFirst ${Math.min(20, newAddresses.length)}:\n\n\`\n${preview}\n\`\n${remainder > 0 ? `\n…and ${remainder} more.` : ''}`;
        enqueueMessage(CHAT_ID, summary, { parse_mode: 'Markdown' });
      } else {
        // For small batches, send individually but via the rate-limited queue
        for (const addr of newAddresses) {
          const msg = `🆕 New wallet address added:\n\`${addr}\``;
          enqueueMessage(CHAT_ID, msg, { parse_mode: 'Markdown' });
        }
      }
    }
    
    // Update known addresses set
    knownAddresses = currentAddresses;
    // Mark newly notified addresses as processed and persist
    for (const addr of newAddresses) processedAddresses.add(addr);
    if (newAddresses.length > 0) await saveProcessedAddresses(processedAddresses);
    
    if (newAddresses.length > 0) {
      console.log(`Updated monitoring: ${currentAddresses.size} total addresses`);
    }
    
  } catch (error) {
    console.error('Error handling file change:', error.message);
  }
}


// Start command for bot info
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 Hi! I monitor \`${addressesFile}\` and notify about new wallet addresses.\n\nCurrently monitoring ${knownAddresses.size} addresses.\n\n**Commands:**\n\`/remove <address>\` - Remove an address from monitoring`, {
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
      
      await bot.sendMessage(chatId, `✅ Address removed successfully:\n\`${addressToRemove}\`\n\nNow monitoring ${addresses.length} addresses.`, {
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