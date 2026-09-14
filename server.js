const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 10000,
  pingInterval: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

const SHAPE_COUNT = 28; // должно совпадать с SHAPES.length на клиенте
const COLORS = [
  '#ff4757', '#ffa502', '#ffdd59', '#2ed573',
  '#1e90ff', '#a55eea', '#ff6b81', '#00d2d3'
];

const waiting = [];

const ri = (n) => Math.floor(Math.random() * n);

function genSequence(count) {
  const seq = [];
  for (let i = 0; i < count; i++) {
    const triple = [];
    for (let j = 0; j < 3; j++) {
      triple.push({
        s: ri(SHAPE_COUNT),
        c: COLORS[ri(COLORS.length)]
      });
    }
    seq.push(triple);
  }
  return seq;
}

io.on('connection', (socket) => {
  socket.data.inGame = false;

  socket.on('findMatch', () => {
    if (socket.data.inGame) return;

    // если игрок уже в очереди — убираем
    const idx = waiting.indexOf(socket);
    if (idx >= 0) waiting.splice(idx, 1);

    if (waiting.length > 0) {
      const opp = waiting.shift();
      const roomId = 'room_' + socket.id;

      socket.join(roomId);
      opp.join(roomId);

      socket.data.room = roomId;
      socket.data.opponent = opp.id;
      socket.data.inGame = true;

      opp.data.room = roomId;
      opp.data.opponent = socket.id;
      opp.data.inGame = true;

      const sequence = genSequence(300);

      socket.emit('matchFound', { sequence, playerIndex: 0 });
      opp.emit('matchFound', { sequence, playerIndex: 1 });

      console.log(`Match: ${socket.id} vs ${opp.id}`);
    } else {
      waiting.push(socket);
      socket.emit('waiting');
    }
  });

  socket.on('progress', (data) => {
    if (socket.data.opponent) {
      io.to(socket.data.opponent).emit('oppProgress', {
        score: data.score | 0
      });
    }
  });

  socket.on('gameOver', () => {
    if (!socket.data.inGame) return;
    socket.data.inGame = false;
    if (socket.data.opponent) {
      io.to(socket.data.opponent).emit('youWon');
      socket.emit('youLost');
    } else {
      socket.emit('youLost');
    }
  });

  socket.on('disconnect', () => {
    const idx = waiting.indexOf(socket);
    if (idx >= 0) waiting.splice(idx, 1);

    if (socket.data.opponent) {
      io.to(socket.data.opponent).emit('oppLeft');
      socket.data.opponent = null;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Block Blast Duel running on http://localhost:${PORT}`);
});
