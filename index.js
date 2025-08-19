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
  getAllExpenses,
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
//  HELPER FUNCTION FOR DASHBOARD ANALYTICS (FINAL POLISHED VERSION)
// =======================================================
async function getDashboardData(period = 'all') {
    const allTransactions = await getAllTransactions();
    const saleTransactions = allTransactions.filter(tx => tx.type === 'Sale');
    const expenseTransactions = allTransactions.filter(tx => tx.type === 'Expense');

    const now = new Date();
    let currentStartDate, currentEndDate, previousStartDate, previousEndDate;

    if (period === 'today') {
        currentStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        currentEndDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        previousStartDate = new Date(new Date(currentStartDate).setDate(currentStartDate.getDate() - 1));
        previousEndDate = currentStartDate;
    } else if (period === 'yesterday') {
        // --- THIS SECTION IS NOW FIXED ---
        currentStartDate = new Date(new Date().setDate(now.getDate() - 1));
        currentStartDate.setHours(0, 0, 0, 0);
        currentEndDate = new Date(new Date(currentStartDate).setDate(currentStartDate.getDate() + 1));
        
        const dayBeforeYesterday = new Date(new Date().setDate(now.getDate() - 2));
        dayBeforeYesterday.setHours(0, 0, 0, 0);
        previousStartDate = dayBeforeYesterday;
        previousEndDate = currentStartDate;
    } else if (period === 'week') {
        const dayOfWeek = now.getDay();
        currentStartDate = new Date(new Date().setDate(now.getDate() - dayOfWeek));
        currentStartDate.setHours(0, 0, 0, 0);
        currentEndDate = new Date(new Date(currentStartDate).setDate(currentStartDate.getDate() + 7));
        previousStartDate = new Date(new Date(currentStartDate).setDate(currentStartDate.getDate() - 7));
        previousEndDate = currentStartDate;
    } else if (period === 'month') {
        currentStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
        currentEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        previousStartDate = new Date(new Date(currentStartDate).setMonth(currentStartDate.getMonth() - 1));
        previousEndDate = currentStartDate;
    } else { // 'all'
        currentStartDate = null;
        currentEndDate = null;
        previousStartDate = null;
        previousEndDate = null;
    }

    const filterByDate = (transactions, start, end) => {
        if (!start || !end) return transactions;
        return transactions.filter(tx => new Date(tx.id) >= start && new Date(tx.id) < end);
    };

    const currentSales = filterByDate(saleTransactions, currentStartDate, currentEndDate);
    const previousSales = filterByDate(saleTransactions, previousStartDate, previousEndDate);
    const currentExpenses = filterByDate(expenseTransactions, currentStartDate, currentEndDate);
    const previousExpenses = filterByDate(expenseTransactions, previousStartDate, previousEndDate);

    const calculateMetrics = (sales, expenses) => {
        const totalRevenue = sales.reduce((sum, sale) => sum + (sale.grossAmount || 0) - (sale.discount || 0), 0);
        const totalCost = sales.reduce((sum, sale) => {
            const firstItem = sale.items && sale.items[0] ? sale.items[0] : {};
            const itemCost = firstItem.costAtSale ? firstItem.costAtSale * (firstItem.qty || 1) : (sale.costPrice || 0);
            return sum + itemCost;
        }, 0);
        const totalExpenses = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
        const netProfit = totalRevenue - totalCost - totalExpenses;
        const totalOrders = sales.length;
        const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
        const newCustomers = new Set(sales.filter(s => s.customerName).map(s => `${s.customerName.toLowerCase().trim()}:${s.customerPhone.replace(/\D/g, '')}`)).size;
        const grossMargin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;
        return { totalRevenue, netProfit, totalExpenses, totalOrders, averageOrderValue, newCustomers, grossMargin };
    };

    const currentMetrics = calculateMetrics(currentSales, currentExpenses);
    const previousMetrics = calculateMetrics(previousSales, previousExpenses);

    const getChange = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return ((current - previous) / previous) * 100;
    };

    // --- Financial Performance Chart Data (Gemini Blueprint Version) ---
    // --- Financial Performance Chart Data (UPGRADED with Hourly View) ---
  const financialPerformanceData = () => {
      const dataMap = new Map();
      const salesToChart = (period === 'today' || period === 'yesterday') ? currentSales : saleTransactions;
      const expensesToChart = (period === 'today' || period === 'yesterday') ? currentExpenses : expenseTransactions;

      // --- NEW: HOURLY LOGIC ---
      if (period === 'today' || period === 'yesterday') {
          // Create 24 hours in the map, from 0 to 23
          for (let i = 0; i < 24; i++) {
              dataMap.set(i, { revenue: null, expenses: null, netProfit: null });
          }

          salesToChart.forEach(sale => {
              const hour = new Date(sale.id).getHours();
              const day = dataMap.get(hour);
              const saleRevenue = (sale.grossAmount || 0) - (sale.discount || 0);
              const firstItem = sale.items && sale.items[0] ? sale.items[0] : {};
              const costOfGoods = firstItem.costAtSale ? firstItem.costAtSale * (firstItem.qty || 1) : (sale.costPrice || 0);
              const saleProfit = saleRevenue - costOfGoods;
              day.revenue = (day.revenue || 0) + saleRevenue;
              day.netProfit = (day.netProfit || 0) + saleProfit;
          });

          expensesToChart.forEach(expense => {
              const hour = new Date(expense.id).getHours();
              const day = dataMap.get(hour);
              const expenseAmount = expense.amount || 0;
              day.expenses = (day.expenses || 0) + expenseAmount;
              day.netProfit = (day.netProfit || 0) - expenseAmount;
          });

          // Format for the chart, only including hours with activity
          return Array.from(dataMap.entries())
              .filter(([hour, values]) => values.revenue !== null || values.expenses !== null)
              .map(([hour, values]) => ({
                  period: `${hour}:00`, // Format as "9:00", "14:00", etc.
                  ...values 
              }));
      }

      // --- DAILY LOGIC (for week, month, all) ---
      // This part remains the same
      [...salesToChart, ...expensesToChart].forEach(tx => {
          const date = new Date(tx.id).toISOString().split('T')[0];
          if (!dataMap.has(date)) {
              dataMap.set(date, { revenue: null, expenses: null, netProfit: null });
          }
      });
      salesToChart.forEach(sale => {
          const date = new Date(sale.id).toISOString().split('T')[0];
          const day = dataMap.get(date);
          const saleRevenue = (sale.grossAmount || 0) - (sale.discount || 0);
          const firstItem = sale.items && sale.items[0] ? sale.items[0] : {};
          const costOfGoods = firstItem.costAtSale ? firstItem.costAtSale * (firstItem.qty || 1) : (sale.costPrice || 0);
          const saleProfit = saleRevenue - costOfGoods;
          day.revenue = (day.revenue || 0) + saleRevenue;
          day.netProfit = (day.netProfit || 0) + saleProfit;
      });
      expensesToChart.forEach(expense => {
          const date = new Date(expense.id).toISOString().split('T')[0];
          const day = dataMap.get(date);
          const expenseAmount = expense.amount || 0;
          day.expenses = (day.expenses || 0) + expenseAmount;
          day.netProfit = (day.netProfit || 0) - expenseAmount;
      });
      return Array.from(dataMap.entries())
          .map(([period, values]) => ({ period, ...values }))
          .sort((a, b) => new Date(a.period) - new Date(b.period));
  };

    // --- Top Selling Products ---
    const topProducts = [...currentSales.reduce((map, sale) => {
        let name = "unknown";
        let displayName = "Unknown";
        let qty = 0;

        // Prioritize the new data format
        if (sale.items && sale.items[0] && sale.items[0].name) {
            name = sale.items[0].name.trim().toLowerCase();
            displayName = sale.items[0].name.trim();
            qty = sale.items[0].qty || 1;
        } 
        // Fallback to the old data format
        else if (sale.item) {
            name = sale.item.trim().toLowerCase();
            displayName = sale.item.trim();
            qty = sale.qty || 1;
        }

        if (name !== "unknown") {
            const revenue = (sale.grossAmount || 0) - (sale.discount || 0);
            const existing = map.get(name) || { name: displayName, quantity: 0, revenue: 0 };
            existing.quantity += qty;
            existing.revenue += revenue;
            map.set(name, existing);
        }
        return map;
    }, new Map()).values()].sort((a,b) => b.revenue - a.revenue).slice(0, 5);

    // --- Actionable Modules ---
    const recentOrders = saleTransactions.sort((a, b) => new Date(b.id) - new Date(a.id)).slice(0, 5).map(o => {
        const firstItem = o.items && o.items[0] ? o.items[0] : {};
        return {
            id: o.orderId,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            totalAmount: (o.grossAmount || 0) - (o.discount || 0),
            status: o.status,
            orderDate: o.id,
            items: o.items || [{ name: o.item, quantity: o.qty, price: o.rate }],
            // ADD THE MISSING PROPERTIES BELOW
            grossAmount: o.grossAmount,
            discount: o.discount,
            discountString: o.discountString,
            costPrice: firstItem.costAtSale ? firstItem.costAtSale * (firstItem.qty || 1) : (o.costPrice || 0),
            profit: o.profit
        };
    });
    // =======================================================
    //  DYNAMIC CUSTOMER SPOTLIGHT LOGIC (SAFER V3)
    // =======================================================
    let customerSpotlight = { name: "N/A", spend: 0, title: "Top Customer" };

    if (currentSales.length > 0) {
        // --- Aggregate all customer data first ---
        const customerData = new Map();
        currentSales.forEach(sale => {
            if (sale.customerName && sale.customerPhone) {
                const key = `${sale.customerName.trim().toLowerCase()}:${sale.customerPhone.replace(/\D/g, '')}`;
                const displayName = sale.customerName.trim();
                const amount = (sale.grossAmount || 0) - (sale.discount || 0);
                const existing = customerData.get(key) || { name: displayName, totalSpend: 0, orderCount: 0, lastPurchase: new Date(0) };
                existing.totalSpend += amount;
                existing.orderCount += 1;
                const saleDate = new Date(sale.id);
                if (saleDate > existing.lastPurchase) {
                    existing.lastPurchase = saleDate;
                }
                customerData.set(key, existing);
            }
        });
        const allCustomers = [...customerData.values()];

        // --- Determine which spotlight to show ---
        const dayOfWeek = new Date().getDay();

        if (dayOfWeek >= 1 && dayOfWeek <= 3) { // Monday, Tuesday, Wednesday
            const spenders = allCustomers.sort((a, b) => b.totalSpend - a.totalSpend);
            // --- SAFETY CHECK ---
            if (spenders.length > 0) {
                customerSpotlight = { name: spenders[0].name, spend: spenders[0].totalSpend, title: `Top Spender` };
            }
        } else if (dayOfWeek >= 4 && dayOfWeek <= 5) { // Thursday, Friday
            const frequentBuyers = allCustomers.sort((a, b) => b.orderCount - a.orderCount);
            // --- SAFETY CHECK ---
            if (frequentBuyers.length > 0) {
                customerSpotlight = { name: frequentBuyers[0].name, spend: frequentBuyers[0].totalSpend, title: `Most Frequent Buyer` };
            }
        } else { // Weekend
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(new Date().getDate() - 30);
            const spenders = allCustomers.sort((a, b) => b.totalSpend - a.totalSpend);
            const vipThreshold = spenders.length > 3 ? spenders[Math.floor(spenders.length / 4)].totalSpend : 0;
            const atRiskVips = spenders.filter(c => c.totalSpend >= vipThreshold && c.lastPurchase < thirtyDaysAgo);
            
            // --- SAFETY CHECK ---
            if (atRiskVips.length > 0) {
                customerSpotlight = { name: atRiskVips[0].name, spend: atRiskVips[0].totalSpend, title: `At-Risk VIP` };
            } else if (spenders.length > 0) { // Fallback to top spender
                customerSpotlight = { name: spenders[0].name, spend: spenders[0].totalSpend, title: `Top Spender` };
            }
        }
    }
    
    const lowStockItems = await getLowStockItems();

    // --- NEW: Opportunities & Risks Module Logic ---
    const opportunitiesAndRisks = [];

    // --- Helper for dynamic period text ---
    let previousPeriodText = 'the previous period';
    if (period === 'today') previousPeriodText = 'yesterday';
    if (period === 'yesterday') previousPeriodText = 'the day before';
    if (period === 'week') previousPeriodText = 'last week';
    if (period === 'month') previousPeriodText = 'last month';

    // ALERT 1: Low Stock (Existing)
    if (lowStockItems && !lowStockItems.startsWith('✅')) {
        opportunitiesAndRisks.push({
            id: 'risk-low-stock',
            type: 'risk',
            severity: 'critical',
            message: `Low stock detected. Check inventory.`
        });
    }

    // ALERT 2 & 3: Revenue Trend (Up and Down)
    const revenueChange = getChange(currentMetrics.totalRevenue, previousMetrics.totalRevenue);
    if (revenueChange > 10) {
        opportunitiesAndRisks.push({
            id: 'opp-revenue-up', type: 'opportunity', severity: 'info',
            message: `Revenue is up ${revenueChange.toFixed(0)}% vs. ${previousPeriodText}!`
        });
    } else if (revenueChange < -10) { // <-- Revenue Down Logic
        opportunitiesAndRisks.push({
            id: 'risk-revenue-down', type: 'risk', severity: 'warning',
            message: `Revenue is down ${Math.abs(revenueChange).toFixed(0)}% vs. ${previousPeriodText}.`
        });
    }
    
    // ALERT 4: Dead Stock (NEW)
    if (period === 'month' || period === 'all') {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);
        
        const recentSales = saleTransactions.filter(tx => new Date(tx.id) >= thirtyDaysAgo);

        // This part is now much safer and handles missing data
        const recentlySoldItems = new Set();
        recentSales.forEach(sale => {
            const itemName = sale.items?.[0]?.name; // Safely access the name
            if (itemName) {
                recentlySoldItems.add(itemName.trim().toLowerCase());
            } else if (sale.item) { // Fallback for very old data
                recentlySoldItems.add(sale.item.trim().toLowerCase());
            }
        });

        const inventorySnapshot = await db.collection('inventory').get();
        inventorySnapshot.docs.forEach(doc => {
            const itemName = doc.data().itemName;
            if (itemName && !recentlySoldItems.has(itemName.trim().toLowerCase())) {
                opportunitiesAndRisks.push({
                    id: `risk-dead-stock-${itemName}`,
                    type: 'risk',
                    severity: 'warning',
                    message: `Dead Stock: The item "${itemName}" has not sold in over 30 days.`
                });
            }
        });
    }

    // --- Assemble Final JSON Object ---
    return {
        kpis: {
            totalRevenue: { value: currentMetrics.totalRevenue, change: getChange(currentMetrics.totalRevenue, previousMetrics.totalRevenue) },
            netProfit: { value: currentMetrics.netProfit, change: getChange(currentMetrics.netProfit, previousMetrics.netProfit) },
            grossMargin: { value: currentMetrics.grossMargin, change: getChange(currentMetrics.grossMargin, previousMetrics.grossMargin) },
            totalExpenses: { value: currentMetrics.totalExpenses, change: getChange(currentMetrics.totalExpenses, previousMetrics.totalExpenses) },
            totalOrders: { value: currentMetrics.totalOrders, change: getChange(currentMetrics.totalOrders, previousMetrics.totalOrders) },
            averageOrderValue: { value: currentMetrics.averageOrderValue, change: getChange(currentMetrics.averageOrderValue, previousMetrics.averageOrderValue) },
            newCustomers: { value: currentMetrics.newCustomers, change: getChange(currentMetrics.newCustomers, previousMetrics.newCustomers) },
        },
        charts: {
            financialPerformance: financialPerformanceData(),
            topProducts: topProducts
        },
        modules: {
            recentOrders: recentOrders,
            opportunitiesAndRisks: opportunitiesAndRisks,
            customerSpotlight: customerSpotlight
        }
    };
}

// =======================================================
//  API ENDPOINT FOR THE WEB DASHBOARD
// =======================================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const period = req.query.period || 'month'; // Default to 'month'
    const dashboardData = await getDashboardData(period);
    res.json(dashboardData);
  } catch (error) {
    console.error('API Error in /api/dashboard:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard data.' });
  }
});

// =======================================================
//  API ENDPOINT FOR INVENTORY
// =======================================================
app.get('/api/inventory', async (req, res) => {
  try {
    const inventorySnapshot = await db.collection('inventory').get();
    
    if (inventorySnapshot.empty) {
      return res.json([]); // Return an empty array if there's no inventory
    }
    
    const inventoryList = inventorySnapshot.docs.map(doc => ({
      id: doc.id, // The unique ID from Firestore
      ...doc.data()
    }));

    console.log(`Found and sending ${inventoryList.length} inventory items.`);
    res.json(inventoryList);

  } catch (error) {
    console.error('API Error in /api/inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory data.' });
  }
});

const multer = require('multer');
const upload = multer({ dest: 'uploads/' }); // Temp folder for uploads

// CREATE a new inventory item
app.post('/api/inventory', async (req, res) => {
  try {
    const newItemData = req.body;
    if (!newItemData.itemName || !newItemData.quantity || !newItemData.costPrice || !newItemData.sellingPrice) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    const docRef = await db.collection('inventory').add(newItemData);
    res.status(201).json({ id: docRef.id, ...newItemData });
  } catch (error) {
    console.error('API Error in POST /api/inventory:', error);
    res.status(500).json({ error: 'Failed to create inventory item.' });
  }
});

// UPDATE an existing inventory item
app.patch('/api/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updatedData = req.body;
    await db.collection('inventory').doc(id).update(updatedData);
    res.status(200).json({ message: `Item ${id} updated successfully.` });
  } catch (error) {
    console.error(`API Error in PATCH /api/inventory/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update inventory item.' });
  }
});

// DELETE an inventory item
app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('inventory').doc(id).delete();
    res.status(200).json({ message: `Item ${id} deleted successfully.` });
  } catch (error) {
    console.error(`API Error in DELETE /api/inventory/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to delete inventory item.' });
  }
});

// DOWNLOAD inventory as CSV
app.get('/api/inventory/csv', async (req, res) => {
    try {
        const inventorySnapshot = await db.collection('inventory').get();
        const inventoryList = inventorySnapshot.docs.map(doc => doc.data());
        
        if (inventoryList.length === 0) {
            return res.status(404).send('No inventory items to export.');
        }

        const csv = Papa.unparse(inventoryList);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
        res.status(200).send(csv);
    } catch (error) {
        console.error('API Error in /api/inventory/csv:', error);
        res.status(500).json({ error: 'Failed to generate inventory CSV.' });
    }
});

// UPLOAD inventory via CSV
app.post('/api/inventory/upload', upload.single('inventoryFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }
        
        const csvFile = fs.readFileSync(req.file.path, 'utf8');
        const parseResult = Papa.parse(csvFile, { header: true, skipEmptyLines: true });
        const inventoryData = parseResult.data;

        // Reuse our existing robust sync function
        const syncResult = await syncInventoryFromCSV(inventoryData);
        
        fs.unlinkSync(req.file.path); // Clean up the temporary file

        res.status(200).json({ message: `${syncResult.count} items synced successfully.` });
    } catch (error) {
        console.error('API Error in /api/inventory/upload:', error);
        res.status(500).json({ error: 'Failed to process CSV file.' });
    }
});

// =======================================================
//  API ENDPOINT FOR ORDERS (UPGRADED to read new format)
// =======================================================
app.get('/api/orders', async (req, res) => {
  try {
    console.log('API call received: /api/orders');
    const allTransactions = await getAllTransactions();
    const saleTransactions = allTransactions.filter(tx => tx.type === 'Sale');

    // UPGRADED LOGIC STARTS HERE
    const orders = saleTransactions.map(tx => {
      // Safely access the first item in the array, if it exists
      const firstItem = tx.items && tx.items[0] ? tx.items[0] : {};

      return {
        id: tx.id,
        orderId: tx.orderId,
        rate: firstItem.price || tx.rate, // Fallback to old format for compatibility
        customer: {
          name: tx.customerName || 'N/A',
          phone: tx.customerPhone || 'N/A',
        },
        // Correctly read from the nested items array
        items: `${firstItem.qty || tx.qty} x ${firstItem.name || tx.item}`,
        grossAmount: tx.grossAmount || 0,
        amount: (tx.grossAmount || 0) - (tx.discount || 0),
        discount: tx.discount || 0,
        discountString: tx.discountString || '',
        // Correctly use the frozen cost from the item
        costPrice: firstItem.costAtSale ? firstItem.costAtSale * (firstItem.qty || 1) : (tx.costPrice || 0),
        profit: tx.profit || 0,
        status: tx.status || 'Confirmed',
        date: tx.id.split('T')[0],
      }
    });

    console.log(`Found and sending ${orders.length} orders.`);
    res.json(orders);

  } catch (error) {
    console.error('API Error in /api/orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders data.' });
  }
});

// ADD THIS ENTIRE NEW FUNCTION
async function calculateGrowthData(period = 'all') {
  const allTransactions = await getAllTransactions();
  const saleTransactions = allTransactions.filter(tx => tx.type === 'Sale');

  const customerFirstPurchase = new Map();

  // First, find the very first purchase date for each unique customer
  for (const sale of saleTransactions) {
    if (sale.customerName) {
      const normalizedPhone = (sale.customerPhone || '').replace(/\D/g, '');
      const customerKey = `${sale.customerName.toLowerCase().trim()}:${normalizedPhone}`;
      const saleDate = new Date(sale.id);

      if (!customerFirstPurchase.has(customerKey) || saleDate < customerFirstPurchase.get(customerKey)) {
        customerFirstPurchase.set(customerKey, saleDate);
      }
    }
  }

  const firstPurchases = Array.from(customerFirstPurchase.values());
  const now = new Date();
  let growthData = [];

  if (period === 'week') {
    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      date.setHours(0, 0, 0, 0);

      const nextDay = new Date(date);
      nextDay.setDate(date.getDate() + 1);

      const newCustomers = firstPurchases.filter(d => d >= date && d < nextDay).length;
      growthData.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        newCustomers
      });
    }
  } else if (period === 'month') {
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      date.setHours(0, 0, 0, 0);
      
      const nextDay = new Date(date);
      nextDay.setDate(date.getDate() + 1);

      const newCustomers = firstPurchases.filter(d => d >= date && d < nextDay).length;
      growthData.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        newCustomers
      });
    }
  } else { // Default to 'all' for the last 6 months
    for (let i = 5; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      
      const newCustomers = firstPurchases.filter(d => d >= date && d < nextMonth).length;
      growthData.push({
        date: date.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
        newCustomers
      });
    }
  }
  return growthData;
}

// =======================================================
//  HELPER FUNCTION FOR CUSTOMER ANALYTICS (FINAL VERSION)
// =======================================================
async function aggregateCustomerData(period = 'all') {
  const allTransactions = await getAllTransactions();
  
  const archivedCustomerKeys = new Set(
    allTransactions
      .filter(tx => tx.type === 'Customer' && tx.status === 'Archived')
      .map(cust => `${cust.name.toLowerCase().trim()}:${cust.phone.replace(/\D/g, '')}`)
  );

  let saleTransactions = allTransactions.filter(tx => tx.type === 'Sale');

  // --- NEW: Filter sales by the requested time period ---
  const now = new Date();
  let startDate;

  if (period === 'today') {
    startDate = new Date(now.setHours(0, 0, 0, 0));
  } else if (period === 'week') {
    const dayOfWeek = now.getDay();
    startDate = new Date(now.setDate(now.getDate() - dayOfWeek));
    startDate.setHours(0, 0, 0, 0);
  } else if (period === 'month') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    startDate.setHours(0, 0, 0, 0);
  }
  
  if (startDate) {
    saleTransactions = saleTransactions.filter(sale => new Date(sale.id) >= startDate);
  }
  // If period is 'all', we don't filter by date.
  // --- END OF NEW LOGIC ---

  const customerData = new Map();

  for (const sale of saleTransactions) {
    if (sale.customerName) {
      const normalizedPhone = (sale.customerPhone || '').replace(/\D/g, '');
      const customerKey = `${sale.customerName.toLowerCase().trim()}:${normalizedPhone}`;

      if (archivedCustomerKeys.has(customerKey)) {
        continue;
      }

      if (!customerData.has(customerKey)) {
        customerData.set(customerKey, {
          name: sale.customerName.trim(), 
          phone: sale.customerPhone || '',
          totalOrders: 0,
          totalSpend: 0,
          firstPurchaseDate: new Date(sale.id), 
          lastPurchaseDate: new Date(0),
        });
      }

      const customer = customerData.get(customerKey);
      customer.totalOrders += 1;
      customer.totalSpend += ((sale.grossAmount || 0) - (sale.discount || 0));
      
      const saleDate = new Date(sale.id);
      if (saleDate > customer.lastPurchaseDate) {
        customer.lastPurchaseDate = saleDate;
      }
      if (saleDate < customer.firstPurchaseDate) {
        customer.firstPurchaseDate = saleDate;
      }
    }
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const finalCustomerList = [...customerData.values()].map(customer => ({
    ...customer,
    id: `${customer.name.toLowerCase().trim()}:${customer.phone.replace(/\D/g, '')}`,
    status: customer.lastPurchaseDate > thirtyDaysAgo ? 'Active' : 'Inactive',
    since: customer.firstPurchaseDate.toLocaleDateString('en-IN', { year: 'numeric', month: 'short' })
  }));
  
  return finalCustomerList;
}

// =======================================================
//  API ENDPOINT FOR CUSTOMERS (Refactored)
// =======================================================
app.get('/api/customers', async (req, res) => {
  try {
    const period = req.query.period || 'all';
    
    // We now call both helper functions
    const customers = await aggregateCustomerData(period);
    const growthData = await calculateGrowthData(period);
    
    console.log(`Found ${customers.length} unique customers and growth data for period: ${period}.`);
    
    // Return a single object with both sets of data
    res.json({ customers, growthData });

  } catch (error) {
    console.error('API Error in /api/customers:', error);
    res.status(500).json({ error: 'Failed to fetch customer data.' });
  }
});
// =======================================================
//  API ENDPOINT FOR A SINGLE CUSTOMER'S DETAILS
// =======================================================
app.get('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // 1. Parse the composite ID to get the name and phone to look for
    const [name, phone] = id.split(':');

    if (!name || !phone) {
      return res.status(400).json({ error: 'Invalid customer ID format.' });
    }

    const allTransactions = await getAllTransactions();
    const saleTransactions = allTransactions.filter(tx => tx.type === 'Sale');

    // 2. Find all orders belonging to this specific customer
    const customerOrders = saleTransactions.filter(sale => {
      if (sale.customerName && sale.customerPhone) {
        const normalizedSalePhone = sale.customerPhone.replace(/\D/g, '');
        const saleName = sale.customerName.toLowerCase().trim();
        // Match against the parsed name and phone
        return saleName === name && normalizedSalePhone === phone;
      }
      return false;
    });

    // 3. If no orders are found, the customer doesn't exist
    if (customerOrders.length === 0) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    // 4. Aggregate stats from the filtered orders
    let lifetimeSpend = 0;
    let firstPurchaseDate = new Date(customerOrders[0].id);
    let lastPurchaseDate = new Date(customerOrders[0].id);

    const orderHistory = customerOrders.map(order => {
      const finalAmount = (order.grossAmount || 0) - (order.discount || 0);
      lifetimeSpend += finalAmount;

      const orderDate = new Date(order.id);
      if (orderDate < firstPurchaseDate) firstPurchaseDate = orderDate;
      if (orderDate > lastPurchaseDate) lastPurchaseDate = orderDate;

      return {
        orderId: order.orderId || 'N/A',
        date: orderDate.toISOString().split('T')[0],
        items: `${order.qty} x ${order.item}`,
        amount: finalAmount,
        status: order.status || 'Confirmed'
      };
    });
    
    // 5. Calculate final derived values
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const customerDetails = {
      name: customerOrders[0].customerName.trim(),
      phone: customerOrders[0].customerPhone,
      status: lastPurchaseDate > thirtyDaysAgo ? 'Active' : 'Inactive',
      since: firstPurchaseDate.toLocaleDateString('en-IN', { year: 'numeric', month: 'short' }),
      lifetimeSpend: lifetimeSpend,
      averageOrderValue: lifetimeSpend / customerOrders.length,
      orderHistory: orderHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()), // Show newest first
    };

    res.json(customerDetails);

  } catch (error) {
    console.error(`API Error in /api/customers/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch customer details.' });
  }
});

// --- Helper function for unique Expense IDs ---
function getNextExpenseId(allExpenses) {
  if (!allExpenses || allExpenses.length === 0) {
    return 'EXP-001';
  }

  const highestIdNum = allExpenses.reduce((maxId, exp) => {
    if (exp.expenseId && exp.expenseId.startsWith('EXP-')) {
      const currentIdNum = parseInt(exp.expenseId.split('-')[1], 10);
      return currentIdNum > maxId ? currentIdNum : maxId;
    }
    return maxId;
  }, 0);

  const nextIdNum = highestIdNum + 1;
  return `EXP-${String(nextIdNum).padStart(3, '0')}`;
}

// --- Helper function for unique Customer IDs ---
function getNextCustomerId(allCustomers) {
  if (!allCustomers || allCustomers.length === 0) {
    return 'CUST-001';
  }

  const highestIdNum = allCustomers.reduce((maxId, cust) => {
    if (cust.customerId && cust.customerId.startsWith('CUST-')) {
      const currentIdNum = parseInt(cust.customerId.split('-')[1], 10);
      return currentIdNum > maxId ? currentIdNum : maxId;
    }
    return maxId;
  }, 0);

  const nextIdNum = highestIdNum + 1;
  return `CUST-${String(nextIdNum).padStart(3, '0')}`;
}

// =======================================================
//  API ENDPOINT TO MANUALLY CREATE A NEW CUSTOMER
// =======================================================
app.post('/api/customers', async (req, res) => {
  try {
    const { name, phone } = req.body;

    // 1. Validate input
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and Phone are required.' });
    }

    const allTransactions = await getAllTransactions();
    const allCustomers = allTransactions.filter(tx => tx.type === 'Customer');

    // 2. Robust duplicate check (using the same normalization as our GET endpoint)
    const normalizedPhone = phone.replace(/\D/g, '');
    const normalizedName = name.toLowerCase().trim();
    const existingCustomer = allCustomers.find(cust => {
      const custPhone = cust.phone.replace(/\D/g, '');
      const custName = cust.name.toLowerCase().trim();
      return custName === normalizedName && custPhone === normalizedPhone;
    });

    if (existingCustomer) {
      return res.status(409).json({ error: 'A customer with this name and phone number already exists.' });
    }

    // 3. Generate a new unique ID
    const newCustomerId = getNextCustomerId(allCustomers);

    // 4. Create and save the new customer object
    const newCustomer = {
      type: 'Customer',
      customerId: newCustomerId,
      name: name.trim(),
      phone: phone,
      status: 'Active', // Default status
    };

    await appendTransaction(newCustomer);

    res.status(201).json({ message: 'Customer created successfully!', customer: newCustomer });

  } catch (error) {
    console.error('API Error in POST /api/customers:', error);
    res.status(500).json({ error: 'Failed to create the new customer.' });
  }
});

// =======================================================
//  API ENDPOINT TO UPDATE A CUSTOMER
// =======================================================
app.patch('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params; // This is the customerId, e.g., "CUST-001"
    const { name, phone } = req.body;

    // 1. Validate input
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and Phone are required.' });
    }

    // 2. Check for duplicates (ensuring we don't conflict with *other* customers)
    const allTransactions = await getAllTransactions();
    const allCustomers = allTransactions.filter(tx => tx.type === 'Customer');

    const normalizedPhone = phone.replace(/\D/g, '');
    const normalizedName = name.toLowerCase().trim();

    // Find if another customer (not the one we're editing) already has this name/phone combo
    const conflictingCustomer = allCustomers.find(cust => {
      if (cust.customerId === id) return false; // Skip the customer we are currently editing
      const custPhone = cust.phone.replace(/\D/g, '');
      const custName = cust.name.toLowerCase().trim();
      return custName === normalizedName && custPhone === normalizedPhone;
    });

    if (conflictingCustomer) {
      return res.status(409).json({ error: 'Another customer with this name and phone already exists.' });
    }
    
    // 3. Prepare the data and update the record using our upgraded function
    const dataToUpdate = {
      name: name.trim(),
      phone,
    };

    const updatedCustomer = await updateTransaction(id, dataToUpdate);

    res.status(200).json({ message: 'Customer updated successfully!', customer: updatedCustomer });

  } catch (error) {
    console.error(`API Error in PATCH /api/customers/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update the customer.' });
  }
});

// =======================================================
//  API ENDPOINT TO "DELETE" (ARCHIVE) A CUSTOMER (UPGRADED)
// =======================================================
app.delete('/api/customers/:id', async (req, res) => {
  try {
    const { id } = req.params; // This is the composite ID, e.g., "saketh:9611709362"
    const [name, phone] = id.split(':');

    if (!name || !phone) {
      return res.status(400).json({ error: 'Invalid customer ID format.' });
    }

    const allTransactions = await getAllTransactions();
    const allCustomers = allTransactions.filter(tx => tx.type === 'Customer');

    // Find if an explicit record for this customer already exists
    const existingCustomer = allCustomers.find(cust => {
      const custPhone = cust.phone.replace(/\D/g, '');
      const custName = cust.name.toLowerCase().trim();
      return custName === name && custPhone === phone;
    });

    if (existingCustomer) {
      // If the customer exists, update their status to Archived
      await updateTransaction(existingCustomer.id, { status: 'Archived' });
      res.status(200).json({ message: `Customer ${existingCustomer.customerId || existingCustomer.name} has been archived.` });
    } else {
      // If the customer does NOT exist, create a new record for them that is already archived
      const newArchivedCustomer = {
        type: 'Customer',
        // We don't need a CUST-ID for these archived stubs
        customerId: null, 
        name: name, // Use the name from the ID
        phone: phone, // Use the phone from the ID
        status: 'Archived',
      };
      await appendTransaction(newArchivedCustomer);
      res.status(200).json({ message: `Customer ${name} has been archived.` });
    }
  } catch (error) {
    console.error(`API Error in DELETE /api/customers/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to archive the customer.' });
  }
});

// =======================================================
//  API ENDPOINT FOR EXPENSES
// =======================================================
app.get('/api/expenses', async (req, res) => {
  try {
    console.log('API call received: /api/expenses');

    // 1. Get all transactions from our database
    const expenseTransactions = await getAllExpenses();

    // 3. Map the data to a clean format for the frontend
    const expenses = expenseTransactions.map(tx => ({
      id: tx.id,
      expenseId: tx.expenseId, 
      item: tx.item,
      category: tx.category || 'Uncategorized',
      amount: tx.amount,
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

    // --- CORRECTED LOGIC TO CREATE UNIQUE ID ---
    const allExpenses = await getAllExpenses();
    const newExpenseId = getNextExpenseId(allExpenses);

    const transactionData = {
     type: 'Expense',
     expenseId: newExpenseId, // Use the new variable
     item: item,
     category: (category || 'Uncategorized').trim().toLowerCase(),
     amount: parseFloat(amount), // Use 'amount' instead of 'total'
     date: new Date().toISOString(), // Add the date
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
       category: (updatedData.category || 'Uncategorized').trim().toLowerCase(), // <-- Fixes case-sensitivity
       amount: parseFloat(updatedData.amount) // <-- Fixes total/amount inconsistency
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

// --- Helper function for unique Order IDs ---
function getNextOrderId(allSales) {
    if (!allSales || allSales.length === 0) {
        return 'ORD-001';
    }
    const highestIdNum = allSales.reduce((maxId, sale) => {
        if (sale.orderId && sale.orderId.startsWith('ORD-')) {
            const currentIdNum = parseInt(sale.orderId.split('-')[1], 10);
            return currentIdNum > maxId ? currentIdNum : maxId;
        }
        return maxId;
    }, 0);
    const nextIdNum = highestIdNum + 1;
    return `ORD-${String(nextIdNum).padStart(3, '0')}`;
}

// =======================================================
//  API ENDPOINT TO CREATE A NEW ORDER 
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

    // --- Get all sales to generate the next unique ID ---
    const allTransactions = await getAllTransactions();
    const allSales = allTransactions.filter(tx => tx.type === 'Sale');
    const newOrderId = getNextOrderId(allSales);

    // --- Create the Transaction Object for Replit DB ---
    // AFTER
  const transactionData = {
    orderId: newOrderId,
    type: 'Sale',
    items: [{
      name: orderDataFromForm.item,
      qty: parseInt(orderDataFromForm.qty, 10),
      price: parseFloat(orderDataFromForm.rate),
      costAtSale: itemDetails.costPrice // Freeze the cost
    }],
    grossAmount: originalTotalPrice,
    discount: discountAmount,
    discountString: discountStr,
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
//  API ENDPOINT TO DELETE AN ORDER 
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
//  API ENDPOINT TO UPDATE AN ORDER (with Recalculation)
// =======================================================
app.patch('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params; // This is the timestamp ID from the database
    const updates = req.body;   // The new data from our edit form

    const existingTransaction = await getTransactionById(id);
    if (!existingTransaction) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    // --- Start Recalculation Logic ---
    const newItemName = updates.item || existingTransaction.item;
    const newQty = parseInt(updates.qty, 10) || existingTransaction.qty;
    const newRate = parseFloat(updates.rate) || existingTransaction.rate;
    const newDiscountString = updates.discount || existingTransaction.discountString;

    // 1. Re-fetch cost price in case the item changed
    const itemDetails = await getItemDetails(newItemName.trim().toLowerCase());
    if (!itemDetails) {
      return res.status(404).json({ error: `Item "${newItemName}" not found in inventory.` });
    }

    // 2. Recalculate all financial figures using our existing helper function
    const newGrossAmount = newRate * newQty;
    const discountInfo = calculateDiscount(newGrossAmount, newDiscountString);
    const newFinalSellingPrice = newGrossAmount - discountInfo.amount;
    const newTotalCostPrice = itemDetails.costPrice * newQty;
    const newProfit = newFinalSellingPrice - newTotalCostPrice;
    // --- End Recalculation Logic ---

    // Merge all changes into a final, correct object
    // AFTER
    const updatedTransaction = {
      ...existingTransaction,
      ...updates, 
      items: [{
        name: newItemName,
        qty: newQty,
        price: newRate,
        costAtSale: itemDetails.costPrice // Freeze the cost on update as well
      }],
      grossAmount: newGrossAmount,
      discount: discountInfo.amount,
      discountString: newDiscountString,
      profit: newProfit
    };

    await updateTransaction(id, updatedTransaction);

    res.status(200).json({ message: 'Order updated successfully with new totals.' });
  } catch (error) {
    console.error(`API Error in PATCH /api/orders/${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to update order.' });
  }
});

// =======================================================
//  API ENDPOINT TO UPDATE AN ORDER'S STATUS 
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

      // AFTER
    const transactionData = {
      type: 'Sale',
      // NEW: Items are now an array
      items: [{
        name: parsedData.item,
        qty: parsedData.qty,
        price: parsedData.rate,
        costAtSale: itemDetails.costPrice // Freeze the cost at the time of sale
        }],
      grossAmount: parsedData.total,
      discount: discountInfo.amount,
      discountString: parsedData.discount,
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