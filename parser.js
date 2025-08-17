// parser.js - FINAL VERSION with /lowstock command

function parseMessage(text) {
    const saleRegex = /^\/sale\s+(\d+)\s+([\w\s]+?)\s+(@)?\s*(\d+)(.*)$/i;
    const expenseRegex = /^\/expense\s+(\d+)\s+([\w\s]+?)(?:\s+#(\w+))?$/i;
    const summaryRegex = /^\/summary(?:\s+(yesterday|[\d-]+))?$/i;
    const billRegex = /^\/bill$/i;
    const lowstockRegex = /^\/lowstock$/i; // <-- NEW REGEX
    const helpRegex = /^\/help$/i;

    let match;

    if (text.match(helpRegex)) {
    return { command: 'help' };
}

    if ((match = text.match(saleRegex))) {
    const [, qtyStr, item, atSymbol, priceStr, extras] = match;
    const qty = parseInt(qtyStr);
    const price = parseInt(priceStr);

    let total, rate;

    // Check if the '@' symbol was found by the regex
    if (atSymbol) {
        // If '@' exists, the price is the RATE
        rate = price;
        total = qty * rate;
    } else {
        // If no '@', the price is the TOTAL
        total = price;
        rate = total / qty;
    }

    let discount = null, customerPhone = null, customerName = null;
    if (extras) {
        const discountMatch = extras.match(/less\s+(\d+%?|\d+rs)/i);
        if (discountMatch) discount = discountMatch[1];
        const phoneMatch = extras.match(/@(\d{7,15})/);
        if (phoneMatch) customerPhone = phoneMatch[1];
        const nameMatch = extras.match(/for\s+([\w\s]+)/i);
        if (nameMatch) {
            let name = nameMatch[1];
            if (discountMatch) name = name.replace(discountMatch[0], '');
            if (phoneMatch) name = name.replace(phoneMatch[0], '');
            customerName = name.trim();
        }
    }
    return {
        command: 'sale', type: 'Sale', qty: qty,
        item: item.trim().toLowerCase(), total: total, // Use calculated total
        discount: discount ? discount.trim() : null,
        rate: rate, // Use calculated rate
        customerPhone: customerPhone ? customerPhone.trim() : null,
        customerName: customerName ? customerName.trim() : null,
    };
}

    if ((match = text.match(expenseRegex))) {
        const [, total, item, category] = match;
        return {
            command: 'expense', type: 'Expense', item: item.trim(),
            total: parseInt(total), category: category ? category.trim().toLowerCase() : null
        };
    }

    if ((match = text.match(summaryRegex))) {
        const [, dateArg] = match;
        return { 
            command: 'summary',
            dateArg: dateArg ? dateArg.trim().toLowerCase() : 'today'
        };
    }

    if (text.match(billRegex)) {
        return { command: 'bill' };
    }

    // --- NEW LOGIC BLOCK ---
    if (text.match(lowstockRegex)) {
        return { command: 'lowstock' };
    }

    // --- UPDATED HELP TEXT ---
    return { error: "❌ Invalid format. Use:\n/help for instructions....\n/sale ...\n/expense ...\n/summary ...\n/bill\n/lowstock" };
}

module.exports = { parseMessage };