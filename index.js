require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const FormData = require('form-data');
const { parseMessage } = require('./parser');
const moment = require('moment-timezone');
const authRoutes = require('./auth');
const Papa = require('papaparse');
const HELP_MESSAGE = `
Hello! Here's how to use the Vyapari Copilot bot:

*To Log a Sale:*
\`/sale <qty> <item> [@] <price> [for <name>] [@<phone>] [less <discount>]\`
*This command is flexible. The parts in [ ] are optional.*

*Example 1 (Rate per item):*
\`/sale 2 jeans @ 1400 for Suresh @9876543210 less 10%\`

*Example 2 (Total price):*
\`/sale 1 saree 5200 for Priya\`

---

*To Log an Expense:*
\`/expense <amount> <reason> [#<category>]\`
*Example:* \`/expense 500 Chai and snacks #food\`

---

*Other Commands:*
\`/summary\` - Get today's summary
\`/summary yesterday\` - Get yesterday's summary
\`/summary YYYY-MM-DD\` - Get summary for a specific date
\`/bill\` - Generate a PDF bill for the last sale
\`/lowstock\` - Get an instant report of low stock items
`;

// --- DATABASE & HELPERS (UPGRADED) ---
const { 
  initializeDb,
  appendTransaction, 
  getAllTransactions, 
  deleteTransaction, 
  updateTransaction, 
  getTransactionById 
} = require('./database');
const { getSummary } = require('./summary');
const { updateStock, processInventoryFile, syncInventoryFromCSV, getItemDetails, getLowStockItems } = require('./inventory');
const { generateBillPdf } = require('./bill');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendMessage(chatId, text) { /* ... unchanged ... */ 
    await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
    });
}
async function sendDocument(chatId, filePath, caption = '') { /* ... unchanged ... */ 
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('document', fs.createReadStream(filePath));
    const response = await fetch(`${TELEGRAM_API}/sendDocument`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders()
    });
    const result = await response.json();
    if (!result.ok) {
        console.error('Telegram API Error:', result);
        throw new Error('Failed to send document to Telegram.');
    }
    return result;
}
function calculateDiscount(totalPrice, discountValue) {
  // This new line safely converts any input (number or text) to a string
  const discountStr = String(discountValue || '0');

  if (!discountStr) {
    return { amount: 0, finalPrice: totalPrice };
  }

  let amount = 0;
  if (discountStr.includes('%')) {
    const percentage = parseFloat(discountStr.replace('%', ''));
    if (!isNaN(percentage)) {
      amount = Math.round(totalPrice * (percentage / 100));
    }
  } else {
    amount = parseFloat(discountStr.replace(/rs/i, ''));
  }

  if (isNaN(amount)) amount = 0;

  return { amount: amount, finalPrice: totalPrice - amount };
}

// In index.js, add this line before the app.get('/api/summary', ...)
app.use('/api/auth', authRoutes);

// =======================================================
//  API ENDPOINT FOR THE WEB DASHBOARD (Upgraded for Replit DB)
// =======================================================
app.get('/api/summary', async (req, res) => {
  try {
    console.log('API call received: /api/summary');
    const dateArg = req.query.date || 'today';

    // --- Date logic (unchanged) ---
    let targetDate;
    const now = moment().tz("Asia/Kolkata");

    if (dateArg === 'today') {
        targetDate = now;
    } else if (dateArg === 'yesterday') {
        targetDate = now.subtract(1, 'days');
    } else {
        targetDate = moment.tz(dateArg, "YYYY-MM-DD", "Asia/Kolkata");
    }

    if (!targetDate.isValid()) {
      return res.status(400).json({ error: "Invalid date format." });
    }
    const targetDateString = targetDate.format('YYYY-MM-DD');

    // --- THE FIX: Get data from our new database ---
    const allTransactions = await getAllTransactions();

    let totalSales = 0;
    let totalExpenses = 0;

    // --- Loop through transaction objects ---
    for (const tx of allTransactions) {
      // The transaction ID is the ISO timestamp string, which starts with YYYY-MM-DD
      if (tx.id.startsWith(targetDateString)) {
        if (tx.type === 'Sale') {
          // Use properties from the transaction object
          totalSales += (tx.grossAmount - tx.discount);
        } else if (tx.type === 'Expense') {
          // Expenses have a 'total' property
          totalExpenses += tx.total || 0;
        }
      }
    }

    const profit = totalSales - totalExpenses;
    const jsonData = { totalSales, totalExpenses, profit };

    console.log('Sending summary data to dashboard:', jsonData);
    res.json(jsonData);

  } catch (error) {
    console.error('API Error in /api/summary:', error);
    res.status(500).json({ error: 'Failed to retrieve summary data.' });
  }
});
// =======================================================
//  API ENDPOINT FOR ORDERS (Upgraded for Replit DB)
// =======================================================
app.get('/api/orders', async (req, res) => {
  try {
    console.log('API call received: /api/orders');

    // THE FIX 1: Get data from our new database
    const allTransactions = await getAllTransactions();

    // Filter the results to only include 'Sale' transactions
    const saleTransactions = allTransactions.filter(tx => tx.type === 'Sale');

    // THE FIX 2: Map transaction objects to the format the frontend needs
    const orders = saleTransactions.map(tx => ({
      id: tx.id, // The DB key is now the permanent ID
      customer: {
        name: tx.customerName || 'N/A',
        phone: tx.customerPhone || 'N/A',
      },
      items: `${tx.qty} x ${tx.item}`,
      grossAmount: tx.grossAmount || 0,
      amount: (tx.grossAmount || 0) - (tx.discount || 0),
      discount: tx.discount || 0,
      discountString: tx.discountString || '',
      costPrice: tx.costPrice || 0,
      profit: tx.profit || 0,
      status: tx.status || 'Confirmed',
      date: tx.id.split('T')[0], // Get the date from the ISO timestamp ID
    }));

    console.log(`Found and sending ${orders.length} orders.`);
    res.json(orders);

  } catch (error) {
    console.error('API Error in /api/orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders data.' });
  }
});
// =======================================================
//  API ENDPOINT FOR CUSTOMERS (Upgraded for Replit DB)
// =======================================================
app.get('/api/customers', async (req, res) => {
  try {
    console.log('API call received: /api/customers');

    // THE FIX 1: Get data from our new database
    const allTransactions = await getAllTransactions();
    const customersMap = {};

    // Loop through transaction objects
    for (const tx of allTransactions) {
      // Process only 'Sale' transactions that have a customer name
      if (tx.type === 'Sale' && tx.customerName) {

        const saleAmount = (tx.grossAmount || 0) - (tx.discount || 0);
        const key = tx.customerPhone || tx.customerName.trim().toLowerCase();

        if (!customersMap[key]) {
          customersMap[key] = {
            id: key,
            name: tx.customerName,
            phone: tx.customerPhone || 'N/A',
            email: 'N/A',
            address: 'N/A',
            totalOrders: 0,
            totalSpent: 0,
            since: '2025', // Placeholder
          };
        }

        customersMap[key].totalOrders += 1;
        customersMap[key].totalSpent += saleAmount;
      }
    }

    const customers = Object.values(customersMap);

    console.log(`Found and sending ${customers.length} unique customers.`);
    res.json(customers);

  } catch (error) {
    console.error('API Error in /api/customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers data.' });
  }
});

// =======================================================
//  API ENDPOINT FOR EXPENSES
// =======================================================
app.get('/api/expenses', async (req, res) => {
  try {
    console.log('API call received: /api/expenses');

    // 1. Get all transactions from our database
    const allTransactions = await getAllTransactions();

    // 2. Filter the results to only include 'Expense' transactions
    const expenseTransactions = allTransactions.filter(tx => tx.type === 'Expense');

    // 3. Map the data to a clean format for the frontend
    const expenses = expenseTransactions.map(tx => ({
      id: tx.id,
      expenseId: tx.expenseId, 
      item: tx.item,
      category: tx.category || 'Uncategorized',
      amount: tx.total,
      date: tx.id.split('T')[0], // Get date from the ISO timestamp ID
    }));

    console.log(`Found and sending ${expenses.length} expenses.`);
    res.json(expenses);

  } catch (error) {
    console.error('API Error in /api/expenses:', error);
    res.status(500).json({ error: 'Failed to fetch expenses data.' });
  }
});

// =======================================================
//  API ENDPOINT TO CREATE A NEW EXPENSE (with Expense ID)
// =======================================================
app.post('/api/expenses', async (req, res) => {
  try {
    const { item, category, amount } = req.body;
    console.log('API POST call received for new expense:', req.body);

    if (!item || !amount) {
      return res.status(400).json({ error: 'Item/Reason and Amount are required.' });
    }

    // --- NEW LOGIC TO CREATE HUMAN-READABLE ID ---
    const allTransactions = await getAllTransactions();
    const expenseCount = allTransactions.filter(tx => tx.type === 'Expense').length;
    const expenseId = `EXP-${String(expenseCount + 1).padStart(3, '0')}`;
    // ---------------------------------------------

    const transactionData = {
      type: 'Expense',
      expenseId: expenseId, // <-- ADD THE NEW ID
      item: item,
      category: category || 'Uncategorized',
      total: parseFloat(amount),
      entryBy: 'Dashboard'
    };

    await appendTransaction(transactionData);

    res.status(201).json({ message: 'Expense created successfully!' });

  } catch (error)
    {
    console.error('API Error in POST /api/expenses:', error);
    res.status(500).json({ error: 'Failed to create the new expense.' });
  }
});

// =======================================================
//  API ENDPOINT TO DELETE AN EXPENSE
// =======================================================
app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`API DELETE call received for expense ID: ${id}`);
    
    await deleteTransaction(id);

    res.status(200).json({ message: `Expense ${id} deleted successfully.` });

  } catch (error) {
    console.error(`API Error in DELETE /api/expenses/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to delete the expense.' });
  }
});

// =======================================================
//  API ENDPOINT TO UPDATE AN EXPENSE
// =======================================================
app.patch('/api/expenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body; // e.g., { item, category, amount }
    console.log(`API PATCH call received for expense ID: ${id}`, updatedData);

    if (!updatedData.item || !updatedData.amount) {
      return res.status(400).json({ error: 'Item/Reason and Amount are required.' });
    }

    // Our database function needs the 'total' property for expenses
    const dataToUpdate = {
        item: updatedData.item,
        category: updatedData.category || 'Uncategorized',
        total: parseFloat(updatedData.amount)
    };

    await updateTransaction(id, dataToUpdate);

    res.status(200).json({ message: `Expense ${id} updated successfully.` });

  } catch (error) {
    console.error(`API Error in PATCH /api/expenses/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update the expense.' });
  }
});

// =======================================================
//  API ENDPOINT TO DOWNLOAD EXPENSES AS CSV
// =======================================================
app.get('/api/expenses/csv', async (req, res) => {
  try {
    console.log('API call received: /api/expenses/csv');

    // 1. Get all expense transactions
    const allTransactions = await getAllTransactions();
    const expenseTransactions = allTransactions.filter(tx => tx.type === 'Expense');

    // 2. Map to a clean format for the CSV
    const expensesForCsv = expenseTransactions.map(tx => ({
      'Expense ID': tx.expenseId || 'N/A',
      'Date': tx.id.split('T')[0],
      'Item/Reason': tx.item,
      'Category': tx.category || 'Uncategorized',
      'Amount': tx.total,
    }));

    // 3. Convert JSON to CSV using papaparse
    const csv = Papa.unparse(expensesForCsv);

    // 4. Set headers to tell the browser to download the file
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${new Date().toISOString().split('T')[0]}.csv"`);
    
    // 5. Send the CSV data
    res.status(200).send(csv);

  } catch (error) {
    console.error('API Error in /api/expenses/csv:', error);
    res.status(500).json({ error: 'Failed to generate CSV file.' });
  }
});

// =======================================================
//  API ENDPOINT TO CREATE A NEW ORDER (using Replit DB)
// =======================================================
app.post('/api/orders', async (req, res) => {
  try {
    const orderDataFromForm = req.body;
    console.log('API POST call received with data:', orderDataFromForm);

    // --- Calculations (largely unchanged) ---
    const itemDetails = await getItemDetails(orderDataFromForm.item.trim().toLowerCase());
    if (!itemDetails) {
      return res.status(404).json({ error: `Item "${orderDataFromForm.item}" not found.` });
    }
    const originalTotalPrice = parseFloat(orderDataFromForm.rate) * parseInt(orderDataFromForm.qty, 10);
    const totalCostPrice = itemDetails.costPrice * parseInt(orderDataFromForm.qty, 10);

    let discountAmount = 0;
    const discountStr = String(orderDataFromForm.discount || '0').trim();
    if (discountStr.endsWith('%')) {
      const percentage = parseFloat(discountStr.slice(0, -1));
      if (!isNaN(percentage)) {
        discountAmount = Math.round(originalTotalPrice * (percentage / 100));
      }
    } else {
      const flatAmount = parseFloat(discountStr);
      if (!isNaN(flatAmount)) {
        discountAmount = flatAmount;
      }
    }
    const finalSellingPrice = originalTotalPrice - discountAmount;
    const profit = finalSellingPrice - totalCostPrice;

    // --- Create the Transaction Object for Replit DB ---
    const transactionData = {
      type: 'Sale',
      item: orderDataFromForm.item,
      qty: orderDataFromForm.qty,
      rate: orderDataFromForm.rate,
      grossAmount: originalTotalPrice,
      discount: discountAmount,
      discountString: discountStr,
      costPrice: totalCostPrice,
      profit: profit,
      status: 'Confirmed',
      customerName: orderDataFromForm.customerName || '',
      customerPhone: orderDataFromForm.customerPhone || '',
      entryBy: 'Dashboard'
    };

    // 4. Append to the new database and update stock
    await appendTransaction(transactionData);
    await updateStock(orderDataFromForm.item.trim().toLowerCase(), orderDataFromForm.qty);

    res.status(201).json({ message: 'Order created successfully in Replit DB!' });

  } catch (error) {
    console.error('API Error in POST /api/orders:', error);
    res.status(500).json({ error: 'Failed to create the new order.' });
  }
});
// =======================================================
//  API ENDPOINT TO DELETE AN ORDER (Upgraded for Replit DB)
// =======================================================
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params; // The ID is now the Replit DB key (timestamp)
    console.log(`API DELETE call received for order ID: ${id}`);

    // --- Important: Add stock back to inventory ---
    // First, get the order details before we delete it
    const orderToDelete = await getTransactionById(id); 
    if (orderToDelete && orderToDelete.type === 'Sale') {
        const itemName = orderToDelete.item;
        const qtySold = parseInt(orderToDelete.qty, 10);
        // We "sell" a negative quantity to add the stock back
        await updateStock(itemName.trim().toLowerCase(), -qtySold); 
        console.log(`Added ${qtySold} units of ${itemName} back to stock.`);
    }
    // ---------------------------------------------

    // Now, delete the transaction from the database
    await deleteTransaction(id);

    res.status(200).json({ message: `Order ${id} deleted successfully.` });

  } catch (error) {
    console.error(`API Error in DELETE /api/orders/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to delete the order.' });
  }
});
// =======================================================
//  API ENDPOINT TO UPDATE AN ORDER'S STATUS (Upgraded for Replit DB)
// =======================================================
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params; // The ID is now the Replit DB key (timestamp)
    const { newStatus } = req.body;

    if (!newStatus) {
      return res.status(400).json({ error: 'A new status is required.' });
    }

    // Use our new database function to update the transaction
    await updateTransaction(id, { status: newStatus });

    console.log(`Updated status for ${id} to ${newStatus}`);
    res.status(200).json({ message: `Order ${id} status updated to ${newStatus}.` });

  } catch (error) {
    console.error(`API Error in PATCH /api/orders/${req.params.id}/status:`, error);
    res.status(500).json({ error: 'Failed to update order status.' });
  }
});

// =======================================================
//  TELEGRAM BOT WEBHOOK (Upgraded for Replit DB)
// =======================================================
app.post(`/webhook`, async (req, res) => {
  // --- Message and file handling (unchanged) ---
  const message = req.body.message;
  console.log(JSON.stringify(req.body, null, 2));
  if (!message) { return res.sendStatus(200); }
  const chatId = message.chat.id;
  if (message.document) { 
    // ... your existing file upload logic remains exactly the same
    return res.sendStatus(200);
  }
  if (!message.text) { return res.sendStatus(200); }
  // ---------------------------------------------

  const text = message.text;
  const user = message.from;
  const entryBy = user.first_name || user.username;

  try {
    const parsedData = parseMessage(text);

    // --- Command handling (summary, bill, lowstock) is unchanged ---
    if (parsedData.error) {
      await sendMessage(chatId, parsedData.error);
    } else if (parsedData.command === 'summary') {
      const summaryText = await getSummary(parsedData.dateArg);
      await sendMessage(chatId, summaryText);
    } else if (parsedData.command === 'bill') {
      const billResult = await generateBillPdf(entryBy);
      if (billResult.error) {
          await sendMessage(chatId, `❌ ${billResult.error}`);
      } else {
          await sendDocument(chatId, billResult.filePath, 'Here is your bill.');
          fs.unlinkSync(billResult.filePath);
      }
    } else if (parsedData.command === 'lowstock') {
      const lowStockText = await getLowStockItems();
      await sendMessage(chatId, lowStockText);

      // In the /webhook function in index.js, add this block
    } else if (parsedData.command === 'help') {
      await sendMessage(chatId, HELP_MESSAGE, { parse_mode: 'Markdown' });

    // --- THE FIX: Upgraded Sale & Expense Logic ---
    } else if (parsedData.type === 'Sale') {
      const itemDetails = await getItemDetails(parsedData.item);
      if (!itemDetails) { throw new Error(`Item "${parsedData.item}" not found in inventory.`); }

      const discountInfo = calculateDiscount(parsedData.total, parsedData.discount);

      const transactionData = {
          type: 'Sale',
          item: parsedData.item,
          qty: parsedData.qty,
          rate: parsedData.rate,
          grossAmount: parsedData.total,
          discount: discountInfo.amount,
          discountString: parsedData.discount,
          costPrice: itemDetails.costPrice * parsedData.qty,
          profit: discountInfo.finalPrice - (itemDetails.costPrice * parsedData.qty),
          status: 'Confirmed',
          customerName: parsedData.customerName || '',
          customerPhone: parsedData.customerPhone || '',
          entryBy: entryBy
      };

      await appendTransaction(transactionData);
      const stockResult = await updateStock(parsedData.item, parsedData.qty);

      await sendMessage(chatId, `✅ Logged! Sale: ₹${discountInfo.finalPrice} (Profit: ₹${transactionData.profit})`);
      if (stockResult && stockResult.alertMessage) {
          await sendMessage(chatId, stockResult.alertMessage);
      }
    } else { // Handle Expenses
      const transactionData = {
          type: 'Expense',
          item: parsedData.item,
          category: parsedData.category || '',
          total: parsedData.total,
          entryBy: entryBy
      };
      await appendTransaction(transactionData);
      await sendMessage(chatId, `✅ Logged! Expense: ₹${parsedData.total}`);
    }
  } catch (error) {
    console.error("Error processing message:", error);
    await sendMessage(chatId, `❌ Oops! Something went wrong. ${error.message}`);
  }
  res.sendStatus(200);
});

// This function will start our server after the database is ready
async function startServer() {
  await initializeDb(); // Wait for the DB to be initialized
  const port = 3000;
  app.listen(port, () => {
    console.log(`✅ Server is running on http://localhost:${port}`);
  });
}

startServer(); // Call the function to start everything