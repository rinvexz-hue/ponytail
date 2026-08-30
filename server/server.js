import 'dotenv/config';
import express from 'express';
import ccxt from 'ccxt';

const app = express();
const port = process.env.PORT || 3000;
const exchange = new ccxt.binance();

app.get('/ticker/:base/:quote', async (req, res) => {
  try {
    const ticker = await exchange.fetchTicker(`${req.params.base}/${req.params.quote}`);
    res.json(ticker);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
