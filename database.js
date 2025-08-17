// We are using lowdb, a simple local JSON file database
const { JSONFilePreset } = require('lowdb/node');
const moment = require('moment-timezone');

// This is a global variable for our database connection
let db;

// This function initializes the database. We will call it when the server starts.
async function initializeDb() {
  // It will create a db.json file if it doesn't exist
  // and set a default structure with an empty transactions array.
  const defaultData = { transactions: [] };
  db = await JSONFilePreset('db.json', defaultData);
  console.log('Local JSON DB initialized at db.json');
}

/**
 * Adds a new transaction record to the database.
 * Uses a timestamp as a unique ID.
 */
async function appendTransaction(transactionData) {
  await db.read(); // Make sure we have the latest data
  const id = moment().tz("Asia/Kolkata").format();
  const newTransaction = { id, ...transactionData };
  db.data.transactions.push(newTransaction);
  await db.write(); // Save changes to the file
  console.log(`Saved transaction ${id} to local db.json.`);
  return newTransaction;
}

/**
 * Retrieves all transaction records from the database.
 */
async function getAllTransactions() {
  await db.read();
  // Sort by date (oldest first) to ensure consistent order
  return db.data.transactions.sort((a, b) => new Date(a.id) - new Date(b.id));
}

/**
 * Retrieves a single transaction by its ID.
 */
async function getTransactionById(id) {
    await db.read();
    return db.data.transactions.find(tx => tx.id === id);
}

/**
 * Deletes a single transaction by its ID.
 */
async function deleteTransaction(id) {
  await db.read();
  db.data.transactions = db.data.transactions.filter(tx => tx.id !== id);
  await db.write();
  console.log(`Deleted transaction ${id} from db.json.`);
}

/**
 * Updates a single transaction. Merges new data with old data.
 */
async function updateTransaction(id, updatedData) {
  await db.read();
  const txIndex = db.data.transactions.findIndex(tx => tx.id === id);
  if (txIndex !== -1) {
    // Merge the existing transaction with the updated data
    db.data.transactions[txIndex] = { ...db.data.transactions[txIndex], ...updatedData };
    await db.write();
    console.log(`Updated transaction ${id}.`);
  } else {
    console.log(`Could not find transaction ${id} to update.`);
  }
}

/**
 * Retrieves the most recent 'Sale' transaction for a specific user.
 */
async function getLastSaleTransaction(entryByUser) {
  await db.read();
  const userSales = db.data.transactions
    .filter(tx => tx.type === 'Sale' && tx.entryBy === entryByUser)
    .sort((a, b) => new Date(b.id) - new Date(a.id)); // Sort descending (newest first)

  return userSales.length > 0 ? userSales[0] : null;
}

// We need to export the new getTransactionById and initializeDb functions as well
module.exports = {
  initializeDb,
  appendTransaction,
  getAllTransactions,
  getTransactionById, 
  getLastSaleTransaction,
  deleteTransaction,
  updateTransaction
};