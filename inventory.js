// inventory.js - FINAL VERSION with /lowstock Report

const csv = require('csv-parser');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK (unchanged)
try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
} catch (error) {
  console.error("Firebase Admin initialization error:", error.message);
}

const db = admin.firestore();

// updateStock function is unchanged
async function updateStock(itemName, quantitySold) {
    if (!itemName || !quantitySold) { return { alertMessage: null }; }
    const inventoryRef = db.collection('inventory');
    try {
        const querySnapshot = await inventoryRef.where('itemName', '==', itemName).limit(1).get();
        if (querySnapshot.empty) {
            console.log(`Item "${itemName}" not found in Firestore inventory.`);
            return { alertMessage: null };
        }
        const itemDoc = querySnapshot.docs[0];
        const itemData = itemDoc.data();
        const currentQuantity = itemData.quantity;
        const lowStockThreshold = itemData.lowStockThreshold || 10;
        const newQuantity = currentQuantity - parseInt(quantitySold, 10);
        let alertMessage = null;
        if (newQuantity <= lowStockThreshold && currentQuantity > lowStockThreshold) {
            alertMessage = `⚠️ LOW STOCK ALERT: Only ${newQuantity} units of '${itemName}' remaining (Threshold is ${lowStockThreshold}). Time to reorder.`;
        }
        await itemDoc.ref.update({ quantity: newQuantity });
        console.log(`Firestore Stock for "${itemName}" updated from ${currentQuantity} to ${newQuantity}.`);
        return { alertMessage };
    } catch (err) {
        console.error('ERROR updating Firestore stock:', err);
        return { alertMessage: null };
    }
}

// processInventoryFile function is unchanged
async function processInventoryFile(fileId) { /* ... unchanged ... */ 
    const fileInfoUrl = `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getFile?file_id=${fileId}`;
    const fileInfoResponse = await fetch(fileInfoUrl);
    const fileInfo = await fileInfoResponse.json();
    if (!fileInfo.ok) {
        console.error("Failed to get file info from Telegram:", fileInfo);
        return { error: "Could not get file info from Telegram." };
    }
    const filePath = fileInfo.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${filePath}`;
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) { return { error: "Could not download the file." }; }
    const results = [];
    const fileStream = fileResponse.body;
    return new Promise((resolve, reject) => {
        fileStream.pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase() }))
            .on('data', (data) => results.push(data))
            .on('end', () => {
                console.log('CSV file successfully processed.');
                resolve({ data: results });
            })
            .on('error', (error) => {
                console.error('Error parsing CSV:', error);
                reject({ error: 'Failed to parse CSV file.' });
            });
    });
}

// syncInventoryFromCSV function is unchanged
async function syncInventoryFromCSV(inventoryData) { /* ... unchanged ... */ 
    const inventoryRef = db.collection('inventory');
    const batch = db.batch();
    const snapshot = await inventoryRef.get();
    snapshot.docs.forEach(doc => { batch.delete(doc.ref); });
    console.log('Cleared old inventory.');
    inventoryData.forEach(item => {
        const itemName = item.itemname;
        const quantity = parseInt(item.quantity, 10) || 0;
        const costPrice = parseFloat(item.costprice) || 0;
        const lowStockThreshold = parseInt(item.lowstockthreshold, 10) || 10;
        if (itemName) {
            const docRef = inventoryRef.doc();
            batch.set(docRef, {
                itemName: itemName,
                quantity: quantity,
                costPrice: costPrice,
                lowStockThreshold: lowStockThreshold
            });
        }
    });
    await batch.commit();
    console.log(`Inventory sync complete. ${inventoryData.length} items synced.`);
    return { success: true, count: inventoryData.length };
}

// getItemDetails function is unchanged
async function getItemDetails(itemName) { /* ... unchanged ... */ 
    if (!itemName) return null;
    const inventoryRef = db.collection('inventory');
    try {
        const querySnapshot = await inventoryRef.where('itemName', '==', itemName).limit(1).get();
        if (querySnapshot.empty) {
            console.log(`Item "${itemName}" not found in Firestore for cost price lookup.`);
            return null;
        }
        const itemData = querySnapshot.docs[0].data();
        return { costPrice: itemData.costPrice || 0, quantity: itemData.quantity || 0, };
    } catch (error) {
        console.error('Error getting item details from Firestore:', error);
        return null;
    }
}

async function getLowStockItems() {
    const inventoryRef = db.collection('inventory');
    try {
        const snapshot = await inventoryRef.get();
        if (snapshot.empty) {
            return "Your inventory is empty.";
        }

        const lowStockItems = [];
        snapshot.docs.forEach(doc => {
            const item = doc.data();
            const threshold = item.lowStockThreshold || 10;
            if (item.quantity <= threshold) {
                // Use the new, cleaner format for each item
                lowStockItems.push(`*${item.itemName}*\n  - Current Stock: ${item.quantity}\n  - Reorder Point: ${threshold}`);
            }
        });

        if (lowStockItems.length === 0) {
            return "✅ All items are well stocked at the moment.";
        }

        // Build the new, more professional report message
        let report = "*Vyapari Copilot - On-Demand Stock Alert* 📈\n\n";
        report += "As requested, here are the items currently at or below their reorder threshold:\n\n";
        report += lowStockItems.join('\n\n'); // Add extra space between items
        report += "\n\nPlease plan your reorders accordingly.";

        return report;

    } catch (error) {
        console.error("Error getting low stock items:", error);
        return "Sorry, an error occurred while fetching the low stock report.";
    }
}

// --- UPDATED EXPORTS ---
module.exports = { updateStock, processInventoryFile, syncInventoryFromCSV, getItemDetails, getLowStockItems };

async function getDeadStockItems(saleTransactions) {
  // 1. Get all sales from the last 30 days
  const now = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(now.getDate() - 30);
  
  const recentSales = saleTransactions.filter(tx => new Date(tx.id) >= thirtyDaysAgo);

  // 2. Create a list of items that HAVE sold recently
  const recentlySoldItems = new Set();
  recentSales.forEach(sale => {
      const itemName = sale.items?.[0]?.name || sale.item;
      if (itemName) {
          recentlySoldItems.add(itemName.trim().toLowerCase());
      }
  });

  // 3. Get all items from your master inventory in Firestore
  const inventorySnapshot = await db.collection('inventory').get();
  if (inventorySnapshot.empty) {
    return []; // Return empty if no inventory exists
  }
  
  // 4. Compare the lists to find what HASN'T sold
  const deadStock = [];
  inventorySnapshot.docs.forEach(doc => {
      const itemData = doc.data();
      const itemName = itemData.itemName;
      if (itemName && !recentlySoldItems.has(itemName.trim().toLowerCase())) {
          deadStock.push({
              id: doc.id,
              ...itemData
          });
      }
  });

  return deadStock;
}

// At the bottom of inventory.js, update your module.exports
module.exports = { 
  updateStock, 
  processInventoryFile, 
  syncInventoryFromCSV, 
  getItemDetails, 
  getLowStockItems,
  getDeadStockItems // <-- Add this new function
};