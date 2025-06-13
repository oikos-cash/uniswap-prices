import { ethers, Contract, JsonRpcProvider } from "ethers";
import express from "express";
import cors from "cors";
import fs from "fs-extra";
import IUniswapV3PoolABI from "./artifacts/IUniswapV3PoolAbi.json" assert { type: "json" };

// Configuration
const providerUrl = "https://testnet-rpc.monad.xyz";
const poolAddress = "0x6cBa988c15F94ec92F015d9501b16312f8DE4c6c";
const dataFilePath = "./priceData.json";
const PORT = 3000;

// Initialize price data storage
const priceData = {
  latestPrice: null,
  history: [],
  lastUpdated: null
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
};

// Save price data to file
const saveDataToFile = async () => {
  try {
    await fs.writeJson(dataFilePath, priceData);
  } catch (error) {
    console.error("Error saving data to file:", error);
  }
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

app.get("/api/price/:interval", (req, res) => {
  const interval = req.params.interval;
  let minutes = 0;

  // Convert interval parameter to minutes
  if (interval === "5") minutes = 5;
  else if (interval === "15") minutes = 15;
  else if (interval === "30") minutes = 30;
  else if (interval === "60" || interval === "1") minutes = 60;
  else if (interval === "1440" || interval === "24") minutes = 1440;

  if (minutes > 0) {
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
      interval: `${minutes}m`,
      dataPoints: intervalData,
      stats: {
        count: intervalData.length,
        avg,
        min,
        max
      },
      lastUpdated: priceData.lastUpdated
    });
  } else {
    res.status(400).json({ error: "Invalid interval. Use 5, 15, 30, 60, or 1440 minutes" });
  }
});

app.get("/api/price/intervals/all", (req, res) => {
  const intervals = [5, 15, 30, 60, 1440];
  const result = {};

  intervals.forEach(minutes => {
    const intervalKey = minutes === 1440 ? "24h" :
                        minutes === 60 ? "1h" :
                        `${minutes}m`;

    result[intervalKey] = getIntervalPrices(minutes);
  });

  res.json({
    intervals: result,
    lastUpdated: priceData.lastUpdated
  });
});

app.get("/api/price/all", (req, res) => {
  const intervals = [5, 15, 30, 60, 1440];
  const result = {};

  intervals.forEach(minutes => {
    const intervalKey = minutes === 1440 ? "24h" :
                        minutes === 60 ? "1h" :
                        `${minutes}m`;

    result[intervalKey] = getIntervalPrices(minutes);
  });

  res.json({
    latest: priceData.latestPrice,
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