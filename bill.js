const { getLastSaleTransaction } = require('./database'); // Use our new DB engine
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const admin = require('firebase-admin');

const db = admin.firestore();

// getShopProfile function is unchanged
async function getShopProfile(shopId) {
    try {
        const docRef = db.collection('shops').doc(shopId);
        const docSnap = await docRef.get();
        if (docSnap.exists) { return docSnap.data(); }
        return null;
    } catch (error) {
        console.error("Error getting shop profile:", error);
        return null;
    }
}

async function generateBillPdf(entryByUser) {
  return new Promise(async (resolve, reject) => {
    try {
      // THE FIX: Get the last sale object from Replit DB
      const lastSale = await getLastSaleTransaction(entryByUser);

      if (!lastSale) {
        return resolve({ error: `No recent sale found for user "${entryByUser}".` });
      }

      const shopProfile = await getShopProfile('bagodi-main');
      if (!shopProfile) {
        return resolve({ error: "Shop profile data could not be loaded." });
      }

      const pdfPath = path.join(__dirname, `bill-${Date.now()}.pdf`);
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      // Use properties from the lastSale object
      const finalTotal = lastSale.grossAmount - lastSale.discount;
      const date = lastSale.id.split('T')[0]; // Get date from the transaction ID

      doc.fontSize(20).text(shopProfile.shopName, { align: 'center' });
      doc.fontSize(10).text(shopProfile.address, { align: 'center' });
      doc.fontSize(10).text(`GSTIN: ${shopProfile.gstNumber}`, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(12).text(`Bill To: ${lastSale.customerName || 'N/A'}`, { continued: true });
      doc.text(`Date: ${date}`, { align: 'right' });
      doc.text(`Phone: ${lastSale.customerPhone || 'N/A'}`);
      doc.moveDown(2);
      doc.text('----------------------------------------------------------');
      doc.fontSize(12).font('Helvetica-Bold').text('Item', 50, doc.y, { continued: true });
      doc.text('Qty', 280, doc.y, { continued: true });
      doc.text('Rate', 350, doc.y, { continued: true });
      doc.text('Amount', 0, doc.y, { align: 'right' });
      doc.font('Helvetica').text('----------------------------------------------------------');
      doc.moveDown();
      doc.fontSize(12).text(lastSale.item, 50, doc.y, { continued: true });
      doc.text(lastSale.qty, 280, doc.y, { continued: true });
      doc.text(`₹${lastSale.rate}`, 350, doc.y, { continued: true });
      doc.text(`₹${lastSale.grossAmount}`, 0, doc.y, { align: 'right' });
      doc.moveDown();
      doc.text('----------------------------------------------------------');
      doc.moveDown();
      doc.fontSize(12).text(`Subtotal:`, { width: 465, align: 'right' });
      doc.text(`₹${lastSale.grossAmount}`, { align: 'right' });
      if (lastSale.discount > 0) {
          doc.text(`Discount:`, { width: 465, align: 'right' });
          doc.text(`-₹${lastSale.discount}`, { align: 'right' });
      }
      doc.font('Helvetica-Bold').text(`TOTAL:`, { width: 465, align: 'right' });
      doc.font('Helvetica-Bold').text(`₹${finalTotal}`, { align: 'right' });
      doc.end();

      stream.on('finish', () => resolve({ filePath: pdfPath }));
      stream.on('error', (err) => reject({ error: "Failed to save the PDF file." }));

    } catch (error) {
      console.error("Error generating PDF bill:", error);
      resolve({ error: "An error occurred while generating the PDF." });
    }
  });
}

module.exports = { generateBillPdf };