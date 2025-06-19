import { ethers, Contract, JsonRpcProvider } from "ethers";
import express from "express";
import cors from "cors";
import fs from "fs-extra";
import IUniswapV3PoolABI from "./artifacts/IUniswapV3PoolAbi.json" assert { type: "json" };

// Configuration
const providerUrl = "https://bnb-mainnet.g.alchemy.com/v2/ABiHuR-8MHnojsrXqqV_tAnPKJSZyUbN";
const poolAddress = "0x104bab30b2983df47dd504114353B0A73bF663CE";
const dataFilePath = "./priceData.json";
const PORT = 3001;

// Initialize price data storage
const priceData = {
  latestPrice: null,
  history: [],
  lastUpdated: null,
  ohlc: {
    "5m": [],
    "15m": [],
    "30m": [],
    "1h": [],
    "24h": []
  }
};

// Initialize express app
const app = express();
app.use(cors()); // Enable CORS for all routes
app.use(express.json());

// Create or load existing data file
const initializeDataFile = async () => {
  try {
    if (await fs.pathExists(dataFilePath)) {
      const data = await fs.readJson(dataFilePath);
      Object.assign(priceData, data);
      console.log("Loaded existing price data");
    } else {
      await fs.writeJson(dataFilePath, priceData);
      console.log("Created new price data file");
    }
  } catch (error) {
    console.error("Error initializing data file:", error);
  }
};

// Fetch the latest price from Uniswap pool
const fetchLatestPrice = async () => {
  try {
    const provider = new JsonRpcProvider(providerUrl);
    const poolContract = new Contract(poolAddress, IUniswapV3PoolABI.abi, provider);
    const slot0 = await poolContract.slot0();
    const sqrtPriceX96 = slot0.sqrtPriceX96;
    const price = (Number(sqrtPriceX96) ** 2) / 2 ** 192;
    return price;
  } catch (error) { 
    console.error("Error fetching price:", error);
    return null;
  }
};

// Get interval prices data
const getIntervalPrices = (minutes, limit = 10) => {
  const now = Date.now();
  const cutoffTime = now - (minutes * 60 * 1000);

  // Filter price history to the specified interval
  const filteredData = priceData.history
    .filter(item => item.timestamp >= cutoffTime)
    .map(item => ({
      price: item.price,
      timestamp: item.timestamp
    }));

  // If we have more data points than the limit, sample them
  if (filteredData.length > limit) {
    const result = [];
    const step = Math.floor(filteredData.length / limit);

    // Take evenly distributed samples
    for (let i = 0; i < limit - 1; i++) {
      result.push(filteredData[i * step]);
    }

    // Always include the most recent data point
    result.push(filteredData[filteredData.length - 1]);

    return result;
  }

  return filteredData;
};

// Clean up old price history to prevent memory issues
const cleanupOldData = () => {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000 + 60 * 1000); // 24 hours + 1 minute buffer
  priceData.history = priceData.history.filter(item => item.timestamp >= oneDayAgo);

  // Cleanup old OHLC data as well
  // For 24h candles, keep last 30 days worth
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  priceData.ohlc["24h"] = priceData.ohlc["24h"].filter(candle => candle.timestamp >= thirtyDaysAgo);

  // For 1h candles, keep last 7 days worth
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  priceData.ohlc["1h"] = priceData.ohlc["1h"].filter(candle => candle.timestamp >= sevenDaysAgo);

  // For other timeframes, we already limit by count in updateOHLCData
};

// Save price data to file
const saveDataToFile = async () => {
  try {
    await fs.writeJson(dataFilePath, priceData);
  } catch (error) {
    console.error("Error saving data to file:", error);
  }
};

// Process OHLC data for each interval
const updateOHLCData = (price, timestamp) => {
  const intervals = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000
  };

  Object.entries(intervals).forEach(([interval, ms]) => {
    const currentOHLC = priceData.ohlc[interval];

    // If no candles exist or the last candle is complete, create a new one
    if (currentOHLC.length === 0 ||
        timestamp >= currentOHLC[currentOHLC.length - 1].timestamp + ms) {

      // Calculate the candle start time (rounded down to interval boundary)
      const roundedTimestamp = Math.floor(timestamp / ms) * ms;

      currentOHLC.push({
        timestamp: roundedTimestamp,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1 // Simple count of updates
      });
    } else {
      // Update the current candle
      const currentCandle = currentOHLC[currentOHLC.length - 1];
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
      currentCandle.volume += 1;
    }

    // Limit the number of candles to keep memory usage reasonable
    // Keep approximately 100 candles per timeframe
    const maxCandles = {
      "5m": 100,
      "15m": 100,
      "30m": 100,
      "1h": 100,
      "24h": 100
    };

    if (currentOHLC.length > maxCandles[interval]) {
      priceData.ohlc[interval] = currentOHLC.slice(-maxCandles[interval]);
    }
  });
};

// Main price update function
const updatePrice = async () => {
  const price = await fetchLatestPrice();

  if (price !== null) {
    const now = Date.now();
    priceData.latestPrice = price;
    priceData.lastUpdated = now;

    // Add to history
    priceData.history.push({
      price,
      timestamp: now
    });

    // Update OHLC data
    updateOHLCData(price, now);

    // Clean up old data
    cleanupOldData();

    // Save to file (every minute to avoid excessive disk writes)
    if (now % (60 * 1000) < 1000) {
      await saveDataToFile();
    }

    console.log("Updated price:", price);
  } else {
    console.log("Failed to fetch the latest price");
  }
};

// API Endpoints
app.get("/api/price", (req, res) => {
  res.json({
    latest: priceData.latestPrice,
    lastUpdated: priceData.lastUpdated
  });
});

app.get("/api/price/latest", (req, res) => {
  res.json({
    latest: priceData.latestPrice,
    lastUpdated: priceData.lastUpdated
  });
});

// Add a dedicated endpoint to get all OHLC data
app.get("/api/price/ohlc/all", (req, res) => {
  res.json({
    ohlc: priceData.ohlc,
    lastUpdated: priceData.lastUpdated
  });
});

// New endpoint specifically for OHLC data by interval
app.get("/api/price/ohlc/:interval", (req, res) => {
  const interval = req.params.interval;
  let intervalKey = null;

  // Map interval parameter to key
  if (interval === "5" || interval === "5m") intervalKey = "5m";
  else if (interval === "15" || interval === "15m") intervalKey = "15m";
  else if (interval === "30" || interval === "30m") intervalKey = "30m";
  else if (interval === "60" || interval === "1" || interval === "1h") intervalKey = "1h";
  else if (interval === "1440" || interval === "24" || interval === "24h") intervalKey = "24h";

  if (intervalKey && priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
    res.json({
      interval: intervalKey,
      ohlc: priceData.ohlc[intervalKey],
      lastUpdated: priceData.lastUpdated
    });
  } else {
    res.status(400).json({
      error: "Invalid interval or no data available. Use 5m, 15m, 30m, 1h, or 24h"
    });
  }
});

// Endpoint with parameter must come after specific routes
app.get("/api/price/:interval", (req, res) => {
  const interval = req.params.interval;
  let intervalKey = null;

  // Map interval parameter to key
  if (interval === "5" || interval === "5m") intervalKey = "5m";
  else if (interval === "15" || interval === "15m") intervalKey = "15m";
  else if (interval === "30" || interval === "30m") intervalKey = "30m";
  else if (interval === "60" || interval === "1" || interval === "1h") intervalKey = "1h";
  else if (interval === "1440" || interval === "24" || interval === "24h") intervalKey = "24h";

  if (intervalKey) {
    // Use OHLC data if available, otherwise fall back to the old method
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      res.json({
        interval: intervalKey,
        ohlc: priceData.ohlc[intervalKey],
        lastUpdated: priceData.lastUpdated
      });
    } else {
      // Fall back to legacy data method
      let minutes = intervalKey === "24h" ? 1440 :
                  intervalKey === "1h" ? 60 :
                  parseInt(intervalKey);

      const intervalData = getIntervalPrices(minutes);

      // Calculate simple stats
      let avg = 0;
      let min = intervalData.length > 0 ? intervalData[0].price : 0;
      let max = 0;

      if (intervalData.length > 0) {
        const sum = intervalData.reduce((acc, item) => acc + item.price, 0);
        avg = sum / intervalData.length;

        intervalData.forEach(item => {
          if (item.price < min) min = item.price;
          if (item.price > max) max = item.price;
        });
      }

      res.json({
        interval: intervalKey,
        dataPoints: intervalData,
        stats: {
          count: intervalData.length,
          avg,
          min,
          max
        },
        lastUpdated: priceData.lastUpdated
      });
    }
  } else {
    res.status(400).json({ error: "Invalid interval. Use 5m, 15m, 30m, 1h, or 24h" });
  }
});

// Define fixed-path routes before parameter routes
app.get("/api/price/all", (req, res) => {
  const intervalKeys = ["5m", "15m", "30m", "1h", "24h"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      // Use OHLC data
      result[intervalKey] = priceData.ohlc[intervalKey];
    } else {
      // Fall back to legacy method
      const minutes = intervalKey === "24h" ? 1440 :
                      intervalKey === "1h" ? 60 :
                      parseInt(intervalKey);
      result[intervalKey] = getIntervalPrices(minutes);
    }
  });

  res.json({
    intervals: result,
    lastUpdated: priceData.lastUpdated
  });
});

app.get("/api/price/intervals/all", (req, res) => {
  const intervalKeys = ["5m", "15m", "30m", "1h", "24h"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      // Use OHLC data
      result[intervalKey] = priceData.ohlc[intervalKey];
    } else {
      // Fall back to legacy method
      const minutes = intervalKey === "24h" ? 1440 :
                      intervalKey === "1h" ? 60 :
                      parseInt(intervalKey);
      result[intervalKey] = getIntervalPrices(minutes);
    }
  });

  res.json({
    intervals: result,
    lastUpdated: priceData.lastUpdated
  });
});

// Initialize and start the app
const init = async () => {
  // Initialize data file
  await initializeDataFile();
  
  // Start price update interval
  setInterval(updatePrice, 1000);
  
  // Start API server
  app.listen(PORT, () => {
    console.log(`Price API server running on port ${PORT}`);
  });
};

init().catch(error => {
  console.error("Initialization error:", error);
});
