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
    if (!itemName || !quantitySold) { 
        return { alertMessage: null }; 
    }

    const lowerCaseItemName = itemName.trim().toLowerCase();
    const inventoryRef = db.collection('inventory');

    try {
        const snapshot = await inventoryRef.get();
        if (snapshot.empty) {
            console.log(`Inventory is empty. Cannot update stock for "${itemName}".`);
            return { alertMessage: null };
        }

        // Find the document by comparing lowercase names in our code
        const itemDoc = snapshot.docs.find(doc => 
            doc.data().itemName.trim().toLowerCase() === lowerCaseItemName
        );

        if (!itemDoc) {
            console.log(`Item "${itemName}" not found with a case-insensitive search.`);
            return { alertMessage: null };
        }

        const itemData = itemDoc.data();
        const currentQuantity = itemData.quantity;
        const lowStockThreshold = itemData.lowStockThreshold || 10;
        const newQuantity = currentQuantity - parseInt(quantitySold, 10);

        let alertMessage = null;
        if (newQuantity <= lowStockThreshold && currentQuantity > lowStockThreshold) {
            alertMessage = `⚠️ LOW STOCK ALERT: Only ${newQuantity} units of '${itemData.itemName}' remaining.`;
        }

        await itemDoc.ref.update({ 
          quantity: newQuantity,
          lastSoldDate: new Date().toISOString()
        });

        console.log(`Stock for "${itemData.itemName}" updated to ${newQuantity}.`);
        return { alertMessage };

    } catch (err) {
        console.error('ERROR updating stock:', err);
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
        fileStream.pipe(csv({ mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/\s+/g, '')  }))
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
async function syncInventoryFromCSV(inventoryData) {
  const inventoryRef = db.collection('inventory');
  const batch = db.batch();

  // 1. Get all current inventory items from Firestore
  const snapshot = await inventoryRef.get();
  const existingInventoryMap = new Map();
  snapshot.docs.forEach(doc => {
    // Store existing items in a map for quick lookups, using lowercase name as the key
    const data = doc.data();
    existingInventoryMap.set(data.itemName.trim().toLowerCase(), { id: doc.id, ...data });
  });

  let newItemsCount = 0;
  let updatedItemsCount = 0;

  // 2. Loop through each item from the uploaded CSV file
  inventoryData.forEach(csvItem => {
    const itemName = csvItem.itemname?.trim();
    if (!itemName) return; // Skip rows without an item name

    const lowerCaseItemName = itemName.toLowerCase();
    const existingItem = existingInventoryMap.get(lowerCaseItemName);

    if (existingItem) {
      // --- ITEM EXISTS: UPDATE IT ---
      const docRef = inventoryRef.doc(existingItem.id);
      const newQuantity = (existingItem.quantity || 0) + (parseInt(csvItem.quantity, 10) || 0);

      // We only update the quantity. We could update other fields too if we wanted.
      batch.update(docRef, { quantity: newQuantity });
      updatedItemsCount++;

    } else {
      // --- ITEM IS NEW: CREATE IT ---
      const newItem = {
        itemName: itemName,
        category: csvItem.category || 'Uncategorized',
        quantity: parseInt(csvItem.quantity, 10) || 0,
        costPrice: parseFloat(csvItem.costprice) || 0,
        sellingPrice: parseFloat(csvItem.sellingprice) || 0,
        lowStockThreshold: parseInt(csvItem.lowstockthreshold, 10) || 10,
        createdAt: new Date().toISOString()
      };
      const docRef = inventoryRef.doc(); // Create a new document reference
      batch.set(docRef, newItem);
      newItemsCount++;
    }
  });

  // 3. Commit all the changes at once
  await batch.commit();

  const summary = `Inventory sync complete. ${newItemsCount} new items added, ${updatedItemsCount} items updated.`;
  console.log(summary);
  return { success: true, message: summary, count: inventoryData.length };
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