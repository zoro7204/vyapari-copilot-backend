const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { appendTransaction, getAllTransactions } = require('./database'); // We'll use this to manage users

const router = express.Router();

// A placeholder for our JWT secret key. We'll move this to the .env file later.
const JWT_SECRET = 'your-super-secret-key-that-is-long-and-random';

// =======================================================
//  API ENDPOINT TO REGISTER A NEW USER
// =======================================================
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 1. Check for required fields
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Please provide name, email, and password.' });
    }

    // 2. Check if a user with this email already exists
    const allUsers = (await getAllTransactions()).filter(tx => tx.type === 'User');
    const existingUser = allUsers.find(user => user.email === email);
    if (existingUser) {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    // 3. Hash the password for security
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 4. Create the new user object
    const newUser = {
      type: 'User', // We'll use the 'type' field to distinguish users from sales
      name,
      email,
      password: hashedPassword, // Store the secure hash, not the plain password
    };

    // 5. Save the new user to the database
    const savedUser = await appendTransaction(newUser);

    res.status(201).json({ 
      message: 'User registered successfully!',
      userId: savedUser.id 
    });

  } catch (error) {
    console.error('Error during user registration:', error);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// =======================================================
//  API ENDPOINT TO LOG IN A USER
// =======================================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Check for required fields
    if (!email || !password) {
      return res.status(400).json({ error: 'Please provide both email and password.' });
    }

    // 2. Find the user by email
    const allUsers = (await getAllTransactions()).filter(tx => tx.type === 'User');
    const user = allUsers.find(u => u.email === email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' }); // Use a generic error
    }

    // 3. Compare the provided password with the stored hash
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' }); // Use a generic error
    }

    // 4. If password is correct, create a secure token (JWT)
    const payload = { 
      user: {
        id: user.id,
        name: user.name,
        email: user.email
      }
    };

    jwt.sign(
      payload,
      JWT_SECRET,
      { expiresIn: '7d' }, // Token will be valid for 7 days
      (err, token) => {
        if (err) throw err;
        // 5. Send the token back to the frontend
        res.json({ token }); 
      }
    );

  } catch (error) {
    console.error('Error during user login:', error);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

module.exports = router;