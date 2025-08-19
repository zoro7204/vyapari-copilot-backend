const { JSONFilePreset } = require('lowdb/node');
const moment = require('moment-timezone');

let db;

// This function now initializes the new daily fact tables as well
// REPLACE your existing initializeDb function with this
async function initializeDb() {
  const defaultData = { 
    transactions: [],
    dailySales: [],
    dailyExpenses: [],
    itemSalesDaily: []
  };
  db = await JSONFilePreset('db.json', defaultData);
  
  // --- NEW: Migration logic to handle existing databases ---
  // This ensures our new data arrays exist, even if loading an old db.json file
  db.data.dailySales = db.data.dailySales || [];
  db.data.dailyExpenses = db.data.dailyExpenses || [];
  db.data.itemSalesDaily = db.data.itemSalesDaily || [];
  
  await db.write(); // Save the changes if any were made
  // --- END OF NEW LOGIC ---

  console.log('Local JSON DB initialized with Daily Facts tables.');
}

// =======================================================
//  NEW: THE DAILY FACTS CALCULATION ENGINE
// =======================================================
async function updateDailyFacts(date) {
  await db.read();
  const dateString = moment(date).tz("Asia/Kolkata").format('YYYY-MM-DD');

  const salesForDay = db.data.transactions.filter(tx => 
    tx.type === 'Sale' && 
    moment(tx.id).tz("Asia/Kolkata").format('YYYY-MM-DD') === dateString
  );

  const expensesForDay = db.data.transactions.filter(tx =>
    tx.type === 'Expense' &&
    moment(tx.id).tz("Asia/Kolkata").format('YYYY-MM-DD') === dateString
  );

  // 1. Calculate Daily Sales
  const totalRevenue = salesForDay.reduce((sum, sale) => sum + (sale.grossAmount || 0) - (sale.discount || 0), 0);
  const totalCogs = salesForDay.reduce((sum, sale) => {
    const itemsCogs = sale.items.reduce((itemSum, item) => itemSum + (item.costAtSale || 0) * item.qty, 0);
    return sum + itemsCogs;
  }, 0);

  const dailySaleSummary = {
    date: dateString,
    revenue: totalRevenue,
    cogs: totalCogs,
    grossProfit: totalRevenue - totalCogs,
    orders: salesForDay.length
  };

  const dsIndex = db.data.dailySales.findIndex(d => d.date === dateString);
  if (dsIndex > -1) {
    db.data.dailySales[dsIndex] = dailySaleSummary;
  } else {
    db.data.dailySales.push(dailySaleSummary);
  }

  // 2. Calculate Daily Expenses
  const totalExpenses = expensesForDay.reduce((sum, exp) => sum + (exp.amount || 0), 0);
  const dailyExpenseSummary = { date: dateString, amount: totalExpenses };

  const deIndex = db.data.dailyExpenses.findIndex(d => d.date === dateString);
  if (deIndex > -1) {
    db.data.dailyExpenses[deIndex] = dailyExpenseSummary;
  } else {
    db.data.dailyExpenses.push(dailyExpenseSummary);
  }

  console.log(`Updated daily facts for ${dateString}.`);
  await db.write();
}


// =======================================================
//  UPGRADED DATABASE FUNCTIONS (Now with automatic updates)
// =======================================================

async function appendTransaction(transactionData) {
  await db.read();
  const id = moment().tz("Asia/Kolkata").toISOString();
  const newTransaction = { id, ...transactionData };
  db.data.transactions.push(newTransaction);
  await db.write();
  
  // Automatically update daily facts
  await updateDailyFacts(id);

  console.log(`Saved transaction ${id} and updated facts.`);
  return newTransaction;
}

async function updateTransaction(id, updatedData) {
  await db.read();
  const txIndex = db.data.transactions.findIndex(tx => 
    tx.id === id || tx.orderId === id || tx.expenseId === id || tx.customerId === id
  );

  if (txIndex !== -1) {
    const originalDate = db.data.transactions[txIndex].id;
    db.data.transactions[txIndex] = { ...db.data.transactions[txIndex], ...updatedData };
    await db.write();
    
    // Automatically update daily facts for the original date
    await updateDailyFacts(originalDate);

    console.log(`Updated transaction ${id} and updated facts.`);
    return db.data.transactions[txIndex];
  } else {
    throw new Error(`Transaction with ID ${id} not found.`);
  }
}

async function deleteTransaction(id) {
  await db.read();
  const txIndex = db.data.transactions.findIndex(tx => 
    tx.id === id || tx.orderId === id || tx.expenseId === id
  );

  if (txIndex > -1) {
    const originalDate = db.data.transactions[txIndex].id;
    db.data.transactions.splice(txIndex, 1);
    await db.write();

    // Automatically update daily facts
    await updateDailyFacts(originalDate);

    console.log(`Deleted transaction ${id} and updated facts.`);
  }
}


// Unchanged functions below
async function getAllTransactions() {
  await db.read();
  return db.data.transactions.sort((a, b) => new Date(a.id) - new Date(b.id));
}

async function getTransactionById(id) {
    await db.read();
    return db.data.transactions.find(tx => tx.id === id || tx.orderId === id || tx.expenseId === id);
}

async function getLastSaleTransaction(entryByUser) {
  await db.read();
  const userSales = db.data.transactions
    .filter(tx => tx.type === 'Sale' && tx.entryBy === entryByUser)
    .sort((a, b) => new Date(b.id) - new Date(a.id)); 
  return userSales.length > 0 ? userSales[0] : null;
}

async function getAllExpenses() {
  const allTransactions = await getAllTransactions();
  return allTransactions.filter(tx => tx.type === 'Expense');
}


module.exports = {
  initializeDb,
  appendTransaction,
  getAllTransactions,
  getAllExpenses,
  getTransactionById, 
  getLastSaleTransaction,
  deleteTransaction,
  updateTransaction,
  // NEW: Export the update function in case we need it
  updateDailyFacts
};