const { getAllTransactions } = require('./database'); // Use our new DB engine
const moment = require('moment-timezone');

async function getSummary(dateArg = 'today') {
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
    return "❌ Invalid date format. Please use YYYY-MM-DD or 'yesterday'.";
  }
  const targetDateString = targetDate.format('YYYY-MM-DD');

  // --- Data fetching from new DB ---
  const allTransactions = await getAllTransactions();
  if (allTransactions.length === 0) return `No data found for ${targetDateString}.`;

  let totalSales = 0;
  let totalExpenses = 0;

  // --- Process transaction objects instead of rows ---
  for (const tx of allTransactions) {
    // The transaction ID is the ISO timestamp string
    if (tx.id.startsWith(targetDateString)) {
      if (tx.type === 'Sale') {
        totalSales += (tx.grossAmount - tx.discount);
      } else if (tx.type === 'Expense') {
        // We need to ensure expenses in the new DB have a 'total' property
        totalExpenses += tx.total || 0; 
      }
    }
  }

  const profit = totalSales - totalExpenses;

  // The final output string is unchanged
  return `🧾 Summary for ${targetDateString}:\n✅ Sales: ₹${totalSales}\n💸 Expenses: ₹${totalExpenses}\n💰 Net Profit: ₹${profit}`;
}

module.exports = { getSummary };