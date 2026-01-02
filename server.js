require('dotenv').config();


const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const quizRoutes = require('./routes/quizRoutes');
const authRoutes = require('./routes/authRoutes');


const app = express();
app.use(cors({
  origin:[
    'http://localhost:3000',
    'https://quiz-frontend-mnq4.onrender.com'
  ]
}));
app.use(express.json());

const {PORT, MONGO_URI} = require('./config')


mongoose
  .connect(MONGO_URI)
  .then(() => console.log('[MONGO] Connected'))
  .catch((err) => {
    console.error('[MONGO] Connection failed', err);
    process.exit(1);
  });


app.use('/api/auth', authRoutes);
app.use('/api/quiz', quizRoutes);

app.get('/health', (req, res) =>{
  res.json({ ok:true });
});



app.listen(PORT, () => {
  console.log(`[BOOT] Sever running on port ${PORT}`)
});