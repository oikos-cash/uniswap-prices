import { ethers, Contract, JsonRpcProvider } from "ethers";
import express from "express";
import cors from "cors";
import fs from "fs-extra";
import IUniswapV3PoolABI from "./artifacts/IUniswapV3PoolAbi.json" assert { type: "json" };

// Configuration
const providerUrl = "https://bsc-dataseed.bnbchain.org";
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
    "12h": [],
    "24h": [],
    "1w": [],
    "1M": []
  }
};

// Initialize express app
const app = express();
app.use(cors()); // Enable CORS for all routes
app.use(express.json());

// Backfill historical OHLC data from existing price history
const backfillHistoricalOHLC = () => {
  if (priceData.history.length === 0) return;

  const intervals = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1M": 30 * 24 * 60 * 60 * 1000
  };

  // Only backfill if OHLC arrays are empty or very small
  Object.entries(intervals).forEach(([interval, ms]) => {
    if (priceData.ohlc[interval] && priceData.ohlc[interval].length >= 2) {
      return; // Skip if we already have sufficient data
    }

    // Clear existing data for clean backfill
    priceData.ohlc[interval] = [];

    // Process each historical price point
    priceData.history.forEach(historyItem => {
      const { price, timestamp } = historyItem;
      const currentOHLC = priceData.ohlc[interval];

      // Calculate the candle start time (rounded down to interval boundary)
      const roundedTimestamp = Math.floor(timestamp / ms) * ms;

      // If no candles exist or the last candle is for a different time period, create a new one
      if (currentOHLC.length === 0 || 
          currentOHLC[currentOHLC.length - 1].timestamp !== roundedTimestamp) {
        
        currentOHLC.push({
          timestamp: roundedTimestamp,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 1
        });
      } else {
        // Update the current candle
        const currentCandle = currentOHLC[currentOHLC.length - 1];
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;
        currentCandle.volume += 1;
      }
    });

    console.log(`Backfilled ${priceData.ohlc[interval].length} candles for ${interval} interval`);
  });
};

// Create or load existing data file
const initializeDataFile = async () => {
  try {
    if (await fs.pathExists(dataFilePath)) {
      const data = await fs.readJson(dataFilePath);
      Object.assign(priceData, data);
      
      // Ensure all OHLC intervals exist (for backward compatibility)
      if (!priceData.ohlc["12h"]) priceData.ohlc["12h"] = [];
      if (!priceData.ohlc["1w"]) priceData.ohlc["1w"] = [];
      if (!priceData.ohlc["1M"]) priceData.ohlc["1M"] = [];
      
      // Backfill historical OHLC data from price history
      backfillHistoricalOHLC();
      
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
  let filteredData = priceData.history
    .filter(item => item.timestamp >= cutoffTime)
    .map(item => ({
      price: item.price,
      timestamp: item.timestamp
    }));

  // For longer intervals (1w, 1M), if no data in time window, use all available data
  if (filteredData.length === 0 && (minutes >= 10080)) { // 1w = 10080 minutes
    filteredData = priceData.history
      .map(item => ({
        price: item.price,
        timestamp: item.timestamp
      }));
  }

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

  // For 1w candles, keep last 2 years worth
  const twoYearsAgo = Date.now() - (2 * 365 * 24 * 60 * 60 * 1000);
  priceData.ohlc["1w"] = priceData.ohlc["1w"].filter(candle => candle.timestamp >= twoYearsAgo);

  // For 1M candles, keep last 10 years worth
  const tenYearsAgo = Date.now() - (10 * 365 * 24 * 60 * 60 * 1000);
  priceData.ohlc["1M"] = priceData.ohlc["1M"].filter(candle => candle.timestamp >= tenYearsAgo);

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
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1M": 30 * 24 * 60 * 60 * 1000
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
      "12h": 100,
      "24h": 100,
      "1w": 100,
      "1M": 100
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

// Helper function to validate and map interval parameter
const mapInterval = (interval) => {
  if (interval === "5" || interval === "5m") return "5m";
  else if (interval === "15" || interval === "15m") return "15m";
  else if (interval === "30" || interval === "30m") return "30m";
  else if (interval === "60" || interval === "1" || interval === "1h" || interval === "1hour") return "1h";
  else if (interval === "720" || interval === "12" || interval === "12h") return "12h";
  else if (interval === "1440" || interval === "24" || interval === "24h") return "24h";
  else if (interval === "1w" || interval === "week") return "1w";
  else if (interval === "1M" || interval === "month") return "1M";
  return null;
};

// Helper function to filter OHLC data by timestamp range
const filterOHLCByTimeRange = (ohlcData, fromTimestamp, toTimestamp) => {
  if (!ohlcData || ohlcData.length === 0) return [];
  
  return ohlcData.filter(candle => {
    const candleTime = candle.timestamp;
    const afterFrom = !fromTimestamp || candleTime >= fromTimestamp;
    const beforeTo = !toTimestamp || candleTime <= toTimestamp;
    return afterFrom && beforeTo;
  });
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

// New time-based query endpoint
app.get("/api/price/query", (req, res) => {
  const { from_timestamp, to_timestamp, interval } = req.query;
  
  // Validate required parameters
  if (!interval) {
    return res.status(400).json({
      error: "Missing required parameter: interval",
      validIntervals: ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Map and validate interval
  const intervalKey = mapInterval(interval);
  if (!intervalKey) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Parse timestamps
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  // Validate timestamp range
  if (fromTimestamp && toTimestamp && fromTimestamp > toTimestamp) {
    return res.status(400).json({
      error: "from_timestamp cannot be greater than to_timestamp"
    });
  }
  
  // Get OHLC data for the interval
  const ohlcData = priceData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range
  const filteredData = filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp);
  
  res.json({
    interval: intervalKey,
    from_timestamp: fromTimestamp,
    to_timestamp: toTimestamp,
    count: filteredData.length,
    ohlc: filteredData,
    lastUpdated: priceData.lastUpdated
  });
});

// OHLC endpoint with query parameters for interval and time filtering
app.get("/api/price/ohlc", (req, res) => {
  const { interval, from_timestamp, to_timestamp } = req.query;
  
  // Validate required parameters
  if (!interval) {
    return res.status(400).json({
      error: "Missing required parameter: interval",
      validIntervals: ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Map and validate interval
  const intervalKey = mapInterval(interval);
  if (!intervalKey) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Parse timestamps
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  // Validate timestamp range
  if (fromTimestamp && toTimestamp && fromTimestamp > toTimestamp) {
    return res.status(400).json({
      error: "from_timestamp cannot be greater than to_timestamp"
    });
  }
  
  // Get OHLC data for the interval
  const ohlcData = priceData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range
  const filteredData = filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp);
  
  res.json({
    interval: intervalKey,
    from_timestamp: fromTimestamp,
    to_timestamp: toTimestamp,
    count: filteredData.length,
    ohlc: filteredData,
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

// Enhanced OHLC endpoint with optional time filtering
app.get("/api/price/ohlc/:interval", (req, res) => {
  const interval = req.params.interval;
  const { from_timestamp, to_timestamp } = req.query;
  
  const intervalKey = mapInterval(interval);
  
  if (!intervalKey) {
    return res.status(400).json({
      error: "Invalid interval parameter",
      provided: interval,
      validIntervals: ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"]
    });
  }
  
  // Parse timestamps if provided
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  const ohlcData = priceData.ohlc[intervalKey] || [];
  
  // Filter data by timestamp range if timestamps are provided
  const filteredData = (fromTimestamp || toTimestamp) ? 
    filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp) : 
    ohlcData;

  if (filteredData.length > 0) {
    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      count: filteredData.length,
      ohlc: filteredData,
      lastUpdated: priceData.lastUpdated
    });
  } else {
    res.status(404).json({
      error: "No data available for the specified interval and time range",
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp
    });
  }
});

// Legacy endpoint for backward compatibility
app.get("/api/price/:interval", (req, res) => {
  const interval = req.params.interval;
  const { from_timestamp, to_timestamp } = req.query;
  
  const intervalKey = mapInterval(interval);

  if (!intervalKey) {
    return res.status(400).json({ 
      error: "Invalid interval. Use 5m, 15m, 30m, 1h, 12h, 24h, 1w, or 1M" 
    });
  }

  // Parse timestamps if provided
  let fromTimestamp = null;
  let toTimestamp = null;
  
  if (from_timestamp) {
    fromTimestamp = parseInt(from_timestamp);
    if (isNaN(fromTimestamp)) {
      return res.status(400).json({
        error: "Invalid from_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }
  
  if (to_timestamp) {
    toTimestamp = parseInt(to_timestamp);
    if (isNaN(toTimestamp)) {
      return res.status(400).json({
        error: "Invalid to_timestamp parameter. Must be a valid Unix timestamp in milliseconds."
      });
    }
  }

  // Use OHLC data if available, otherwise fall back to the old method
  if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
    const ohlcData = priceData.ohlc[intervalKey];
    
    // Filter data by timestamp range if timestamps are provided
    const filteredData = (fromTimestamp || toTimestamp) ? 
      filterOHLCByTimeRange(ohlcData, fromTimestamp, toTimestamp) : 
      ohlcData;
    
    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      count: filteredData.length,
      ohlc: filteredData,
      lastUpdated: priceData.lastUpdated
    });
  } else {
    // Fall back to legacy data method
    let minutes = intervalKey === "24h" ? 1440 :
                intervalKey === "1h" ? 60 :
                intervalKey === "12h" ? 720 :
                intervalKey === "1w" ? 10080 :
                intervalKey === "1M" ? 43200 :
                parseInt(intervalKey);

    const intervalData = getIntervalPrices(minutes);
    
    // Filter legacy data by timestamp if provided
    let filteredData = intervalData;
    if (fromTimestamp || toTimestamp) {
      filteredData = intervalData.filter(item => {
        const afterFrom = !fromTimestamp || item.timestamp >= fromTimestamp;
        const beforeTo = !toTimestamp || item.timestamp <= toTimestamp;
        return afterFrom && beforeTo;
      });
    }

    // Calculate simple stats
    let avg = 0;
    let min = filteredData.length > 0 ? filteredData[0].price : 0;
    let max = 0;

    if (filteredData.length > 0) {
      const sum = filteredData.reduce((acc, item) => acc + item.price, 0);
      avg = sum / filteredData.length;

      filteredData.forEach(item => {
        if (item.price < min) min = item.price;
        if (item.price > max) max = item.price;
      });
    }

    res.json({
      interval: intervalKey,
      from_timestamp: fromTimestamp,
      to_timestamp: toTimestamp,
      dataPoints: filteredData,
      stats: {
        count: filteredData.length,
        avg,
        min,
        max
      },
      lastUpdated: priceData.lastUpdated
    });
  }
});

// Define fixed-path routes before parameter routes
app.get("/api/price/all", (req, res) => {
  const intervalKeys = ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      // Use OHLC data
      result[intervalKey] = priceData.ohlc[intervalKey];
    } else {
      // Fall back to legacy method
      const minutes = intervalKey === "24h" ? 1440 :
                      intervalKey === "1h" ? 60 :
                      intervalKey === "12h" ? 720 :
                      intervalKey === "1w" ? 10080 :
                      intervalKey === "1M" ? 43200 :
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
  const intervalKeys = ["5m", "15m", "30m", "1h", "12h", "24h", "1w", "1M"];
  const result = {};

  intervalKeys.forEach(intervalKey => {
    if (priceData.ohlc[intervalKey] && priceData.ohlc[intervalKey].length > 0) {
      // Use OHLC data
      result[intervalKey] = priceData.ohlc[intervalKey];
    } else {
      // Fall back to legacy method
      const minutes = intervalKey === "24h" ? 1440 :
                      intervalKey === "1h" ? 60 :
                      intervalKey === "12h" ? 720 :
                      intervalKey === "1w" ? 10080 :
                      intervalKey === "1M" ? 43200 :
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
