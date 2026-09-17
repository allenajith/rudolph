const express = require('express');
const cors = require('cors');
const http = require('http');
const {Server} = require('socket.io');
const app = express();
app.get('/',(req,res)=>{
    res.send('server is running');
});
const server = http.createServer(app);
const io = new Server(server, {cors:{origin: 'http://localhost:5173',},});

const DRAWING_SECONDS = 30;
const GUESSING_ONLY_SECONDS = 10;
const TOTAL_ROUND_SECONDS = DRAWING_SECONDS + GUESSING_ONLY_SECONDS;
const MIN_PLAYERS = 2;

const players = {}; // socket.id -> { name, roomCode }
const rooms = {}; // roomCode -> { playerOrder, currentDrawerId, phase, word, timeLeft, timerId }

function getPlayersInRoom(roomCode) {
    return Object.values(players)
        .filter((p) => p.roomCode === roomCode)
        .map((p) => p.name);
}

function getOrCreateRoom(roomCode) {
    if (!rooms[roomCode]) {
        rooms[roomCode] = {
            playerOrder: [],
            currentDrawerId: null,
            phase: 'idle', // 'idle' | 'awaiting-word' | 'drawing' | 'guessing-only'
            word: null,
            timeLeft: 0,
            timerId: null,
        };
    }
    return rooms[roomCode];
}

function stopTimer(room) {
    if (room.timerId) {
        clearInterval(room.timerId);
        room.timerId = null;
    }
}

function isCurrentDrawer(socket) {
    const room = rooms[socket.data.roomCode];
    return Boolean(room) && room.currentDrawerId === socket.id;
}

function canDraw(socket) {
    const room = rooms[socket.data.roomCode];
    return Boolean(room) && room.phase === 'drawing' && isCurrentDrawer(socket);
}

function emitDrawerChanged(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const drawer = players[room.currentDrawerId];
    io.to(roomCode).emit('drawer-changed', {
        id: room.currentDrawerId,
        name: drawer ? drawer.name : null,
    });
}

function setPhase(roomCode, phase) {
    const room = rooms[roomCode];
    if (!room || room.phase === phase) return;
    room.phase = phase;
    io.to(roomCode).emit('phase-changed', { phase });
}

function startWordPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room || !room.currentDrawerId) return;
    stopTimer(room);
    room.word = null;
    room.timeLeft = 0;
    room.phase = 'awaiting-word';
    io.to(roomCode).emit('clear-canvas');
    emitDrawerChanged(roomCode);
    io.to(roomCode).emit('phase-changed', { phase: room.phase });
    io.to(roomCode).emit('timer-tick', room.timeLeft);
}

function startDrawingPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room || !room.word) return;
    stopTimer(room);
    room.timeLeft = TOTAL_ROUND_SECONDS;
    room.phase = 'drawing';
    io.to(roomCode).emit('clear-canvas');
    io.to(roomCode).emit('phase-changed', { phase: room.phase });
    io.to(roomCode).emit('timer-tick', room.timeLeft);
    room.timerId = setInterval(() => {
        room.timeLeft -= 1;
        io.to(roomCode).emit('timer-tick', room.timeLeft);
        if (room.timeLeft <= 0) {
            endRound(roomCode, { reason: 'timeout' });
            return;
        }
        if (room.timeLeft <= GUESSING_ONLY_SECONDS) {
            setPhase(roomCode, 'guessing-only');
        }
    }, 1000);
}

function endRound(roomCode, { reason, winnerId }) {
    const room = rooms[roomCode];
    if (!room) return;
    stopTimer(room);
    const word = room.word;
    const winner = winnerId ? players[winnerId] : null;
    io.to(roomCode).emit('round-ended', {
        reason,
        word,
        winnerName: winner ? winner.name : null,
    });
    room.word = null;
    nextTurn(roomCode);
}

function nextTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    stopTimer(room);
    if (room.playerOrder.length === 0) {
        room.currentDrawerId = null;
        room.phase = 'idle';
        emitDrawerChanged(roomCode);
        return;
    }
    const currentIndex = room.playerOrder.indexOf(room.currentDrawerId);
    const nextIndex = (currentIndex + 1) % room.playerOrder.length;
    room.currentDrawerId = room.playerOrder[nextIndex];
    startWordPhase(roomCode);
}

io.on('connection',(socket)=>{console.log('a user connected:',socket.id);
    socket.on('test-message',(data)=>{console.log('received from client:',data);
        socket.emit('test-reply','hello from server');
    });
    socket.on('join-room',({ roomCode, playerName })=>{
        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.playerName = playerName;
        players[socket.id] = { name: playerName, roomCode };
        const room = getOrCreateRoom(roomCode);
        room.playerOrder.push(socket.id);
        console.log(`${playerName} (${socket.id}) joined room "${roomCode}"`);
        io.to(roomCode).emit('player-list', getPlayersInRoom(roomCode));
        if (room.phase === 'idle' && room.playerOrder.length >= MIN_PLAYERS) {
            if (!room.currentDrawerId) {
                room.currentDrawerId = room.playerOrder[0];
            }
            startWordPhase(roomCode);
        } else {
            emitDrawerChanged(roomCode);
            socket.emit('phase-changed', { phase: room.phase });
            socket.emit('timer-tick', room.timeLeft);
        }
    });
    socket.on('submit-word', ({ word })=>{
        const room = rooms[socket.data.roomCode];
        if (!room || room.phase !== 'awaiting-word' || !isCurrentDrawer(socket)) return;
        const trimmed = typeof word === 'string' ? word.trim() : '';
        if (!trimmed) return;
        room.word = trimmed;
        startDrawingPhase(socket.data.roomCode);
    });
    socket.on('submit-guess', ({ text })=>{
        const roomCode = socket.data.roomCode;
        const room = rooms[roomCode];
        if (!room || (room.phase !== 'drawing' && room.phase !== 'guessing-only')) return;
        if (isCurrentDrawer(socket)) return;
        const player = players[socket.id];
        if (!player) return;
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) return;
        if (room.word && trimmed.toLowerCase() === room.word.toLowerCase()) {
            endRound(roomCode, { reason: 'correct', winnerId: socket.id });
        } else {
            io.to(roomCode).emit('guess-message', { name: player.name, text: trimmed });
        }
    });
    socket.on('draw-start',(data)=>{
        if (!canDraw(socket)) return;
        socket.to(socket.data.roomCode).emit('draw-start', data);
    });
    socket.on('draw-move',(data)=>{
        if (!canDraw(socket)) return;
        socket.to(socket.data.roomCode).emit('draw-move', data);
    });
    socket.on('disconnect',()=>{
        console.log('user disconnected:',socket.id);
        const { roomCode } = socket.data;
        delete players[socket.id];
        if (roomCode) {
            const room = rooms[roomCode];
            if (room) {
                const idx = room.playerOrder.indexOf(socket.id);
                const wasDrawer = room.currentDrawerId === socket.id;
                room.playerOrder = room.playerOrder.filter((id) => id !== socket.id);
                if (room.playerOrder.length === 0) {
                    stopTimer(room);
                    delete rooms[roomCode];
                } else if (room.playerOrder.length < MIN_PLAYERS) {
                    stopTimer(room);
                    room.currentDrawerId = null;
                    room.phase = 'idle';
                    room.word = null;
                    room.timeLeft = 0;
                    io.to(roomCode).emit('clear-canvas');
                    emitDrawerChanged(roomCode);
                    io.to(roomCode).emit('phase-changed', { phase: room.phase });
                    io.to(roomCode).emit('timer-tick', room.timeLeft);
                } else if (wasDrawer) {
                    room.currentDrawerId = room.playerOrder[idx % room.playerOrder.length];
                    startWordPhase(roomCode);
                }
            }
            io.to(roomCode).emit('player-list', getPlayersInRoom(roomCode));
        }
    })
})
const PORT = 3000;
server.listen(PORT,()=>{console.log(`Server listening on http://localhost:${PORT}`);});
