import {useEffect, useRef, useState} from 'react';
import {io} from 'socket.io-client';

const socket = io('http://localhost:3000');

function App() {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [playerName, setPlayerName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [players, setPlayers] = useState([]);
  const [myId, setMyId] = useState(socket.id ?? null);
  const [drawer, setDrawer] = useState({ id: null, name: null });
  const [timeLeft, setTimeLeft] = useState(0);
  const [phase, setPhase] = useState('idle');
  const [wordInput, setWordInput] = useState('');
  const [guessInput, setGuessInput] = useState('');
  const [feed, setFeed] = useState([]);
  const feedIdRef = useRef(0);

  const isDrawer = myId !== null && myId === drawer.id;
  const canDraw = isDrawer && phase === 'drawing';
  const canGuess = !isDrawer && (phase === 'drawing' || phase === 'guessing-only');

  const getContext = () => {
    return canvasRef.current.getContext('2d');
  };

  const addFeedEntry = (entry) => {
    feedIdRef.current += 1;
    setFeed((f) => [...f, { id: feedIdRef.current, ...entry }]);
  };

  useEffect(() => {
    socket.on('connect',()=>{
      console.log('connected to server:', socket.id);
      setMyId(socket.id);
    });

    socket.on('draw-start', ({ x, y }) => {
      if (!canvasRef.current) return;
      const ctx = getContext();
      ctx.beginPath();
      ctx.moveTo(x, y);
    });

    socket.on('draw-move', ({ x, y }) => {
      if (!canvasRef.current) return;
      const ctx = getContext();
      ctx.lineTo(x, y);
      ctx.stroke();
    });

    socket.on('player-list', (playerNames) => {
      setPlayers(playerNames);
    });

    socket.on('drawer-changed', (newDrawer) => {
      setDrawer(newDrawer);
      setIsDrawing(false);
    });

    socket.on('timer-tick', (secondsLeft) => {
      setTimeLeft(secondsLeft);
    });

    socket.on('clear-canvas', () => {
      if (!canvasRef.current) return;
      const ctx = getContext();
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    });

    socket.on('phase-changed', ({ phase: newPhase }) => {
      setPhase(newPhase);
    });

    socket.on('guess-message', ({ name, text }) => {
      addFeedEntry({ type: 'guess', name, text });
    });

    socket.on('round-ended', ({ reason, word, winnerName }) => {
      const message = reason === 'correct'
        ? `${winnerName} guessed it correctly! The word was "${word}".`
        : `Time's up! The word was "${word}".`;
      addFeedEntry({ type: 'system', message });
      setWordInput('');
      setGuessInput('');
    });

    return () => {
      socket.off('connect');
      socket.off('draw-start');
      socket.off('draw-move');
      socket.off('player-list');
      socket.off('drawer-changed');
      socket.off('timer-tick');
      socket.off('clear-canvas');
      socket.off('phase-changed');
      socket.off('guess-message');
      socket.off('round-ended');
    };
  }, []);

  const startDrawing = (e) => {
    const ctx = getContext();
    const {offsetX, offsetY} = e.nativeEvent;
    ctx.beginPath();
    ctx.moveTo(offsetX, offsetY);
    setIsDrawing(true);
    socket.emit('draw-start', { x: offsetX, y: offsetY });
  };

  const draw = (e) => {
    if (!isDrawing) return;
    const ctx = getContext();
    const {offsetX, offsetY} = e.nativeEvent;
    ctx.lineTo(offsetX, offsetY);
    ctx.stroke();
    socket.emit('draw-move', { x: offsetX, y: offsetY });
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const handleJoin = (e) => {
    e.preventDefault();
    if (!playerName || !roomCode) return;
    socket.emit('join-room', { roomCode, playerName });
    setHasJoined(true);
  };

  const handleSubmitWord = (e) => {
    e.preventDefault();
    const trimmed = wordInput.trim();
    if (!trimmed) return;
    socket.emit('submit-word', { word: trimmed });
    setWordInput('');
  };

  const handleSubmitGuess = (e) => {
    e.preventDefault();
    const trimmed = guessInput.trim();
    if (!trimmed) return;
    socket.emit('submit-guess', { text: trimmed });
    setGuessInput('');
  };

  const renderStatus = () => {
    if (phase === 'awaiting-word') {
      return isDrawer
        ? 'Choose a secret word to start your turn!'
        : `Waiting for ${drawer.name} to choose a word...`;
    }
    if (phase === 'guessing-only') {
      return isDrawer
        ? "Time's almost up — drawing is locked!"
        : `Drawing locked — last chance to guess ${drawer.name}'s word!`;
    }
    if (phase === 'drawing') {
      return isDrawer ? 'Your turn to draw!' : `${drawer.name} is drawing — you're guessing`;
    }
    return 'Waiting for more players to join...';
  };

  if (!hasJoined) {
    return (
      <div>
        <h1>Sketch</h1>
        <form onSubmit={handleJoin}>
          <input
            placeholder="Your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <input
            placeholder="Room code"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
          />
          <button type="submit">Join Room</button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '1rem' }}>
      <div>
        <h1>Sketch</h1>
        <p>{renderStatus()}</p>
        {(phase === 'drawing' || phase === 'guessing-only') && <p>Time left: {timeLeft}s</p>}
        {isDrawer && phase === 'awaiting-word' && (
          <form onSubmit={handleSubmitWord}>
            <input
              placeholder="Type your secret word"
              value={wordInput}
              onChange={(e) => setWordInput(e.target.value)}
            />
            <button type="submit">Start Drawing</button>
          </form>
        )}
        {canGuess && (
          <form onSubmit={handleSubmitGuess}>
            <input
              placeholder="Type your guess"
              value={guessInput}
              onChange={(e) => setGuessInput(e.target.value)}
            />
            <button type="submit">Guess</button>
          </form>
        )}
        <canvas
          ref={canvasRef}
          width={800}
          height={600}
          style={{
            border: '1px solid black',
            backgroundColor: '#ffffff',
            cursor: canDraw ? 'crosshair' : 'not-allowed',
          }}
          onMouseDown={canDraw ? startDrawing : undefined}
          onMouseMove={canDraw ? draw : undefined}
          onMouseUp={canDraw ? stopDrawing : undefined}
          onMouseLeave={canDraw ? stopDrawing : undefined}
        />
        <div style={{ border: '1px solid #ccc', height: 200, overflowY: 'auto', padding: '0.5rem', textAlign: 'left' }}>
          {feed.map((entry) => (
            <p key={entry.id} style={{ margin: '0.25rem 0', fontStyle: entry.type === 'system' ? 'italic' : 'normal' }}>
              {entry.type === 'system' ? entry.message : `${entry.name}: ${entry.text}`}
            </p>
          ))}
        </div>
      </div>
      <div>
        <h2>Players</h2>
        <ul>
          {players.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
      </div>
    </div>

  );
}
export default App;
