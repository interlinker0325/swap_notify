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

// Function to send message with retry logic for rate limiting
async function sendMessageWithRetry(message, options, retryCount = 0) {
  const maxRetries = 3;
  try {
    return await bot.sendMessage(CHAT_ID, message, options);
  } catch (error) {
    if (error.code === 429 && retryCount < maxRetries) {
      // Extract retry delay from error message (e.g., "retry after 26")
      const retryMatch = error.message.match(/retry after (\d+)/);
      const retryDelay = retryMatch ? parseInt(retryMatch[1]) * 1000 : 5000; // Default 5 seconds
      
      console.log(`Rate limited. Waiting ${retryDelay/1000} seconds before retry ${retryCount + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      
      return await sendMessageWithRetry(message, options, retryCount + 1);
    }
    throw error; // Re-throw if not rate limit error or max retries reached
  }
}

// Function to send existing addresses with inline remove button
async function sendExistingAddresses(addresses) {
  if (addresses.length === 0) return;
  
  try {
    console.log(`Sending ${addresses.length} existing addresses to Telegram...`);

    const batchSize = 10;
    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(addresses.length / batchSize);
      
      // Create message with all addresses in this batch
      let message = `📋 **Existing Addresses - Batch ${batchNumber}/${totalBatches} (${i + 1}-${i + batch.length}/${addresses.length}):**\n\n`;
      
      // Create inline keyboard with remove buttons for each address in the batch
      const keyboard = [];
      batch.forEach((addr, index) => {
        message += `${i + index + 1}. \`${addr}\`\n`;
        // Add remove button for each address (2 buttons per row for better layout)
        if (index % 2 === 0) {
          keyboard.push([{ text: `❌ Remove ${i + index + 1}`, callback_data: `remove:${addr}` }]);
        } else {
          keyboard[keyboard.length - 1].push({ text: `❌ Remove ${i + index + 1}`, callback_data: `remove:${addr}` });
        }
      });
      
      try {
        await sendMessageWithRetry(message, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      } catch (msgError) {
        console.error(`Error sending batch ${batchNumber}:`, msgError.message);
        // Continue with next batch even if one fails
      }
      
      if (i + batchSize < addresses.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Only 1 second between batches
      }
      // Progress logging
      console.log(`Progress: Sent batch ${batchNumber}/${totalBatches} (${Math.min(i + batchSize, addresses.length)}/${addresses.length} addresses)`);
    }
    console.log(`✅ Finished sending all ${addresses.length} addresses in ${Math.ceil(addresses.length / batchSize)} batches`);
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
      // Send notification for new addresses with inline remove button
      for (const addr of newAddresses) {
        const msg = `🆕 New wallet address added:\n\`${addr}\``;
        try {
          await sendMessageWithRetry(msg, {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '❌ Remove Address', callback_data: `remove:${addr}` }]]
            }
          });
        } catch (error) {
          console.error(`Error sending new address notification:`, error.message);
        }
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

// Handle "Remove Address" button press
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const data = callbackQuery.data;

  if (data.startsWith('remove:')) {
    const addrToRemove = data.split(':')[1];
    let addresses = await readAddresses();

    if (addresses.includes(addrToRemove)) {
      addresses = addresses.filter(a => a !== addrToRemove);
      await writeAddresses(addresses);

      // Update known addresses
      knownAddresses = new Set(addresses);

      // Delete the Telegram message with the address
      await bot.deleteMessage(chatId, messageId);

      // Confirm removal with user
      await bot.answerCallbackQuery(callbackQuery.id, { text: `Address ${addrToRemove} removed.` });
    } else {
      await bot.answerCallbackQuery(callbackQuery.id, { text: 'Address not found or already removed.' });
    }
  }
});

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
