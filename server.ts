import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const PORT = 3000;

// Game Constants
const SYMBOLS = ["bau", "cua", "ca", "ga", "tom", "nai"];
const ROUND_TIME = 20; // seconds
const SHAKE_TIME = 5; // seconds
const RESULT_TIME = 5; // seconds

interface Player {
  id: string;
  name: string;
  avatar: string;
  netProfit: number;
  bets: Record<string, number>;
  isReady: boolean;
  lastWin: number;
}

interface GameState {
  status: "BETTING" | "SHAKING" | "RESULT" | "GAME_OVER";
  timer: number;
  results: string[];
  history: string[][];
  players: Player[];
  totalBets: Record<string, number>;
  gmBalance: number;
  isGmSet: boolean;
}

let gameState: GameState = {
  status: "BETTING",
  timer: 0,
  results: [],
  history: [],
  players: [],
  totalBets: {},
  gmBalance: 0,
  isGmSet: false,
};

// Helper to generate random results
function shakeDice() {
  return [
    SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
    SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
    SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
  ];
}

function calculatePayouts() {
  const results = gameState.results;
  const counts: Record<string, number> = {};
  results.forEach((s) => (counts[s] = (counts[s] || 0) + 1));

  let totalPayoutNeeded = 0;
  let totalBetsCollected = 0;

  // First pass: calculate how much we need to pay out
  gameState.players.forEach((player) => {
    let playerWin = 0;
    let playerBet = 0;

    Object.entries(player.bets).forEach(([symbol, amount]) => {
      playerBet += amount;
      if (counts[symbol]) {
        playerWin += (counts[symbol] + 1) * amount;
      }
    });

    totalPayoutNeeded += playerWin;
    totalBetsCollected += playerBet;
  });

  // Check if GM can afford it
  // The GM balance increases by bets collected and decreases by payouts
  const netGmChange = totalBetsCollected - totalPayoutNeeded;
  
  if (gameState.gmBalance + netGmChange < 0) {
    gameState.status = "GAME_OVER";
    return;
  }

  // Second pass: apply the changes
  gameState.players.forEach((player) => {
    let playerWin = 0;
    let playerBet = 0;

    Object.entries(player.bets).forEach(([symbol, amount]) => {
      playerBet += amount;
      if (counts[symbol]) {
        playerWin += (counts[symbol] + 1) * amount;
      }
    });

    player.lastWin = playerWin;
    player.netProfit += (playerWin - playerBet);
    player.bets = {};
    player.isReady = false;
  });

  gameState.gmBalance += netGmChange;
  gameState.totalBets = {};
}

function gameLoop() {
  if (gameState.status === "GAME_OVER") {
    io.emit("gameUpdate", gameState);
    return;
  }

  if (!gameState.isGmSet) {
    io.emit("gameUpdate", gameState);
    return;
  }

  if (gameState.status === "BETTING") {
    const connectedPlayers = gameState.players;
    if (connectedPlayers.length > 0 && connectedPlayers.every(p => p.isReady)) {
      gameState.status = "SHAKING";
      gameState.timer = SHAKE_TIME;
      gameState.results = shakeDice();
    }
  } else if (gameState.timer > 0) {
    gameState.timer--;
  } else {
    if (gameState.status === "SHAKING") {
      calculatePayouts();
      if ((gameState.status as string) !== "GAME_OVER") {
        gameState.status = "RESULT";
        gameState.timer = RESULT_TIME;
        gameState.history.unshift(gameState.results);
        if (gameState.history.length > 10) gameState.history.pop();
      }
    } else if (gameState.status === "RESULT") {
      gameState.status = "BETTING";
      gameState.timer = 0;
      gameState.players.forEach(p => p.lastWin = 0);
    }
  }

  io.emit("gameUpdate", gameState);
}

setInterval(gameLoop, 1000);

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("setGmBalance", (amount: number) => {
    // Only allow setting if not already set or if game is over (to restart)
    if (!gameState.isGmSet || gameState.status === "GAME_OVER") {
      gameState.gmBalance = amount;
      gameState.isGmSet = true;
      gameState.status = "BETTING";
      // Reset players for a new game session if it was game over
      gameState.players.forEach(p => {
        p.netProfit = 0;
        p.bets = {};
        p.isReady = false;
        p.lastWin = 0;
      });
      gameState.history = [];
      io.emit("gameUpdate", gameState);
    }
  });

  socket.on("join", (data: { name: string; avatar: string }) => {
    if (gameState.players.length >= 4) {
      socket.emit("error", "Phòng đã đầy (tối đa 4 người)");
      return;
    }

    const newPlayer: Player = {
      id: socket.id,
      name: data.name || `Người chơi ${gameState.players.length + 1}`,
      avatar: data.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${socket.id}`,
      netProfit: 0, // Start with 0 profit/loss
      bets: {},
      isReady: false,
      lastWin: 0,
    };

    gameState.players.push(newPlayer);
    io.emit("gameUpdate", gameState);
  });

  socket.on("placeBet", (bets: Record<string, number>) => {
    const player = gameState.players.find((p) => p.id === socket.id);
    if (!player || gameState.status !== "BETTING" || player.isReady) return;

    // No balance check anymore - unlimited money
    Object.entries(bets).forEach(([symbol, amount]) => {
      player.bets[symbol] = (player.bets[symbol] || 0) + amount;
      gameState.totalBets[symbol] = (gameState.totalBets[symbol] || 0) + amount;
    });
    
    player.isReady = true;

    io.emit("gameUpdate", gameState);
  });

  socket.on("disconnect", () => {
    gameState.players = gameState.players.filter((p) => p.id !== socket.id);
    io.emit("gameUpdate", gameState);
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
